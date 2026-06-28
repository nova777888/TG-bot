const { Bot } = require('grammy');
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
const { Pool } = require('pg');
const WebSocket = require('ws');

// ============================================================
// Configuration
// ============================================================
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_TG_IDS = (process.env.ADMIN_TG_IDS || '').split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n));
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://ecikviwuxfieryrmfgdq.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KE || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

if (!TELEGRAM_BOT_TOKEN) { console.error('TELEGRAM_BOT_TOKEN required'); process.exit(1); }
if (!ADMIN_TG_IDS.length) { console.error('ADMIN_TG_IDS required'); process.exit(1); }

// ============================================================
// Supabase client (service role for full access)
// ============================================================
const sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
      realtime: { transport: WebSocket }
});

// ============================================================
// Sub-admin in-memory cache
// ============================================================
var subAdminCache = {};
var subAdminCacheTime = 0;

async function ensureSubAdminsTable() {
  // Try using Supabase REST API with service_role key to access sub_admins
  // If table does not exist, sub_admin features are disabled gracefully
  try {
    var { data } = await sb.from('sub_admins').select('id').limit(1);
    console.log('[SUB_ADMIN] Table exists, sub-admin features ready');
    return true;
  } catch (e) {
    console.log('[SUB_ADMIN] Table does not exist - sub-admin features disabled');
    console.log('[SUB_ADMIN] Run this SQL in Supabase SQL Editor:');
    console.log('  CREATE TABLE IF NOT EXISTS public.sub_admins (');
    console.log('    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),');
    console.log("    telegram_id TEXT NOT NULL UNIQUE,");
    console.log("    customer_id UUID REFERENCES public.customers(id) ON DELETE CASCADE,");
    console.log("    created_at TIMESTAMPTZ DEFAULT now(),");
    console.log("    created_by UUID REFERENCES public.customers(id) ON DELETE SET NULL");
    console.log('  );');
    console.log('  ALTER TABLE public.sub_admins ENABLE ROW LEVEL SECURITY;');
    return false;
  }
}

async function refreshSubAdminCache() {
  try {
    var { data } = await sb.from('sub_admins').select('telegram_id, customer_id, created_at');
    if (data) {
      subAdminCache = {};
      for (var i = 0; i < data.length; i++) {
        subAdminCache[data[i].telegram_id] = { customer_id: data[i].customer_id, created_at: data[i].created_at };
      }
    }
    subAdminCacheTime = Date.now();
    console.log('[SUB_ADMIN] Cache refreshed:', Object.keys(subAdminCache).length, 'sub-admins');
  } catch (e) {
    console.log('[SUB_ADMIN] Cache refresh failed:', e.message);
  }
}

async function isSubAdmin(tgId) {
  if (Date.now() - subAdminCacheTime > 60000) await refreshSubAdminCache();
  return !!subAdminCache[String(tgId)];
}

// ============================================================
// Phone helpers
// ============================================================
function normalizePhone(raw) {
  var digits = String(raw || '').replace(/[^0-9]/g, '');
  if (digits.length === 11 && digits.startsWith('0')) digits = '+234' + digits.substring(1);
  else if (digits.length === 10) digits = '+234' + digits;
  else if (digits.length === 13 && digits.startsWith('234')) digits = '+' + digits;
  else if (!digits.startsWith('+')) digits = '+' + digits;
  return digits;
}

function hashPhone(phone) {
  return crypto.createHash('sha256').update(phone).digest('hex');
}

// ============================================================
// In-memory tracking for undo (last credit per chat)
// ============================================================
var lastCredit = {};
// ============================================================
// Bank account linking helpers
// ============================================================
async function getLinkedCustomerIds(customerId) {
  var { data: myBanks } = await sb
    .from("bank_bindings")
    .select("bank_account")
    .eq("customer_id", customerId);
  
  if (!myBanks || myBanks.length === 0) return [];
  
  var bankAccounts = myBanks.map(function(b) { return b.bank_account; });
  
  var { data: linked } = await sb
    .from("bank_bindings")
    .select("customer_id")
    .in("bank_account", bankAccounts)
    .neq("customer_id", customerId);
  
  if (!linked) return [];
  var ids = {};
  linked.forEach(function(l) { ids[l.customer_id] = true; });
  return Object.keys(ids);
}

async function isBankLinkedToReferrer(customerId) {
  var linkedIds = await getLinkedCustomerIds(customerId);
  if (linkedIds.length === 0) return null;
  for (var i = 0; i < linkedIds.length; i++) {
    var { data: linkedCust } = await sb
      .from("customers")
      .select("id, parent_id, name")
      .eq("id", linkedIds[i])
      .maybeSingle();
    if (linkedCust && linkedCust.parent_id) return linkedCust;
  }
  return null;
}




// ============================================================
// Commission helper: ensure a bank account + tx exist for commission chain
// ============================================================
const SYSTEM_BANK_ID = "00000000-0000-0000-0000-000000000999";

async function ensureSystemBankAccount() {
  var { data: existing } = await sb
    .from("bank_accounts")
    .select("id")
    .eq("id", SYSTEM_BANK_ID)
    .maybeSingle();
  if (existing) return SYSTEM_BANK_ID;
  var { error } = await sb.from("bank_accounts").insert({
    id: SYSTEM_BANK_ID,
    account_number_encrypted: "system",
    account_number_hash: "system",
    owner_customer_id: "00000000-0000-0000-0000-000000000000"
  });
  if (error) console.error("[COMMISSION] Failed to create system bank:", error.message);
  return SYSTEM_BANK_ID;
}

function getMonthStr(d) {
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
}
var ENCRYPTION_KEY = Buffer.from(process.env.ENCRYPTION_KEY || '96ad19dd1d302c46aceea0edf9759655090b762f947f81a6107382e9681784a0', 'hex');

function decryptPhone(encrypted) {
  var parts = encrypted.split(':');
  var iv = Buffer.from(parts[0], 'hex');
  var decipher = crypto.createDecipheriv('aes-256-cbc', ENCRYPTION_KEY, iv);
  return decipher.update(parts[1], 'hex', 'utf8') + decipher.final('utf8');
}

function encryptPhone(plain) {
  var iv = crypto.randomBytes(16);
  var cipher = crypto.createCipheriv('aes-256-cbc', ENCRYPTION_KEY, iv);
  var enc = cipher.update(plain, 'utf8', 'hex') + cipher.final('hex');
  return iv.toString('hex') + ':' + enc;

}

// ============================================================
// Bot setup
// ============================================================
var bot = new Bot(TELEGRAM_BOT_TOKEN);

// Auth: only admin can use this bot
// Global error handler
bot.catch((err) => {
  console.error('[BOT_ERROR]', err.message || err);
});

bot.use(async (ctx, next) => {
  var userId = ctx.from && ctx.from.id;
  if (!ADMIN_TG_IDS.includes(userId)) {
    var isSub = await isSubAdmin(String(userId));
    if (!isSub) {
      await ctx.reply('⛔ Unauthorized');
      return;
    }
  }
  await next();
});

// ============================================================
// /vip +2348012345678 — bind customer to this chat
// ============================================================
// Simple ping test
bot.hears(/^\/?ping(?:@\w+)?$/, async (ctx) => {
  await ctx.reply('pong!');
});

bot.hears(/^\/?vip(?:@\w+)?(?:\s+(.+))?$/, async (ctx) => {
  var args = ctx.message.text.split(' ').slice(1).join(' ').trim();
  if (!args) {
    await ctx.reply('Usage: /vip +2348012345678');
    return;
  }

  var normalized = normalizePhone(args);
  var hash = hashPhone(normalized);
  var chatId = String(ctx.chat.id);

  var { data: customer } = await sb
    .from('customers')
    .select('id, name, phone_hash, public_id')
    .eq('phone_hash', hash)
    .maybeSingle();

  if (!customer) {
    await ctx.reply('❌ Customer not found with phone ' + normalized);
    return;
  }

  // Check if this chat already has a bound customer
  var { data: existingBound } = await sb
    .from('customers')
    .select('id, name, public_id, phone_encrypted')
    .eq('telegram_id', chatId)
    .maybeSingle();

  if (existingBound) {
    await ctx.reply(
      '⚠️ This chat already has a customer bound: ' + existingBound.name + '\n' +
      'Use /-vip +234XXXXXXXXX to unbind first, then /vip again.'
    );
    return;
  }

  // Clear old binding if any, then bind new
  await sb.from('customers').update({ telegram_id: null }).eq('telegram_id', chatId);

  var { error: updateErr } = await sb
    .from('customers')
    .update({ telegram_id: chatId })
    .eq('id', customer.id);

  if (updateErr) {
    await ctx.reply('❌ Failed to bind: ' + updateErr.message);
    return;
  }

  await ctx.reply(
    '✅ Bound to this chat\n' +
    '👤 ' + customer.name + '\n' +
    '📞 ' + normalized + '\n' +
    'Now send 下发1000 or /balance');
});

// ============================================================
// +1000 or 下发1000 — add credit
// ============================================================
// ============================================================
// /-vip +234XXXXXXXXX — unbind a customer from its chat
// ============================================================
bot.hears(/^\/?-vip(?:@\w+)?(?:\s+(.+))?$/, async (ctx) => {
  var args = ctx.message.text.split(' ').slice(1).join(' ').trim();
  if (!args) {
    await ctx.reply('Usage: /-vip +2348012345678');
    return;
  }

  var normalized = normalizePhone(args);
  var hash = hashPhone(normalized);

  var { data: customer } = await sb
    .from('customers')
    .select('id, name, telegram_id')
    .eq('phone_hash', hash)
    .maybeSingle();

  if (!customer) {
    await ctx.reply('❓ Customer not found with phone ' + normalized);
    return;
  }

  if (!customer.telegram_id) {
    await ctx.reply('⚠️ ' + customer.name + ' has no active binding to unbind.');
    return;
  }

  var { error: unbindErr } = await sb
    .from('customers')
    .update({ telegram_id: null })
    .eq('id', customer.id);

  if (unbindErr) {
    await ctx.reply('❓ Failed to unbind: ' + unbindErr.message);
    return;
  }

  var chatId = customer.telegram_id;
  delete lastCredit[chatId];

  await ctx.reply('✅ Unbound ' + customer.name + ' (' + normalized + ') from its chat.');
});



// ============================================================
// /bindbank BANKACCOUNT — bind bank account to current chat
// ============================================================
bot.hears(/^\/?bindbank(?:@\w+)?(?:\s+(.+))?$/, async (ctx) => {
  var args = ctx.message.text.split(" ").slice(1).join(" ").trim();
  if (!args) {
    await ctx.reply("Usage: /bindbank 6222021234567890");
    return;
  }
  var chatId = String(ctx.chat.id);
  var bankAccount = args.replace(/[\s-]/g, "");
  if (bankAccount.length < 8) {
    await ctx.reply("Bank account number too short (min 8 digits)");
    return;
  }
  var { data: customer } = await sb
    .from("customers")
    .select("id, name, public_id")
    .eq("telegram_id", chatId)
    .maybeSingle();
  if (!customer) {
    await ctx.reply("No customer bound. Use /vip +2348012345678 first.");
    return;
  }
  var { data: existingBinding } = await sb
    .from("bank_bindings")
    .select("customer_id")
    .eq("bank_account", bankAccount)
    .maybeSingle();
  if (existingBinding && existingBinding.customer_id !== customer.id) {
    var { data: otherCust } = await sb
      .from("customers")
      .select("name, public_id")
      .eq("id", existingBinding.customer_id)
      .maybeSingle();
    await ctx.reply(
      "\u26a0\ufe0f This bank account is already bound to:\n" +
      "\u272a\ufe0f " + (otherCust ? otherCust.name : "another customer") + "\n" +
      "\ud83d\udd11 " + (otherCust ? otherCust.public_id : "Unknown") + "\n\n" +
      "Both accounts are now linked as the same person."
    );
  }
  if (existingBinding && existingBinding.customer_id === customer.id) {
    await ctx.reply("This bank account is already bound to " + customer.name);
    return;
  }
  var { error: bindErr } = await sb
    .from("bank_bindings")
    .upsert(
      { bank_account: bankAccount, customer_id: customer.id },
      { onConflict: "bank_account" }
    );
  if (bindErr) {
    await ctx.reply("Failed to bind: " + bindErr.message);
    return;
  }
  await ctx.reply(
    "\u2705 Bank account bound\n" +
    "\u272a\ufe0f " + customer.name + "\n" +
    "\ud83c\udfe6 " + bankAccount.substring(0, 4) + "****" + bankAccount.substring(bankAccount.length - 4)
  );
});


// ============================================================
// /fixreferrer +234XXX VIP00000 \u2014 fix a customer\'s referrer (admin)
// ============================================================
bot.hears(/^\/?fixreferrer(?:@\w+)?(?:\s+(.+))?$/, async (ctx) => {
  var parts = ctx.message.text.split(" ").slice(1);
  if (parts.length < 2) {
    await ctx.reply("Usage: /fixreferrer +2348012345678 VIP38420");
    return;
  }
  var normalized = normalizePhone(parts[0]);
  var hash = hashPhone(normalized);
  var refCode = parts[1].toUpperCase();
  var { data: customer } = await sb
    .from("customers")
    .select("id, name, public_id, parent_id, referrer_locked")
    .eq("phone_hash", hash)
    .maybeSingle();
  if (!customer) {
    await ctx.reply("Customer not found with phone " + normalized);
    return;
  }
  var { data: referrer } = await sb
    .from("customers")
    .select("id, name, public_id")
    .eq("public_id", refCode)
    .maybeSingle();
  if (!referrer) {
    await ctx.reply("Referrer ID not found: " + refCode);
    return;
  }
  if (referrer.id === customer.id) {
    await ctx.reply("Cannot set self as referrer");
    return;
  }
  var linkedIds = await getLinkedCustomerIds(customer.id);
  if (linkedIds.includes(referrer.id)) {
    await ctx.reply(
      "\u26a0\ufe0f " + customer.name + " and " + referrer.name + " share bank accounts!\r\n" +
      "They are the same person. Cannot set as referrer."
    );
    return;
  }

  var { error: updateErr } = await sb
    .from("customers")
    .update({ parent_id: referrer.id, referrer_locked: true })
    .eq("id", customer.id);
  if (updateErr) {
    await ctx.reply("Failed: " + updateErr.message);
    return;
  }
  await ctx.reply(
    "\u2705 Referrer corrected\r\n" +
    "\u272a\ufe0f " + customer.name + " (" + normalized + ")\r\n" +
    "Now referred by: " + referrer.name + " (" + refCode + ")"
  );
});
bot.hears(/^\/?下发\s*(\d+)$/, async (ctx) => {
  var chatId = String(ctx.chat.id);
  var amount = parseFloat(ctx.match[1]);

  if (!amount || amount <= 0) return;

  var { data: customer } = await sb
    .from('customers')
    .select('id, name, public_id, parent_id, phone_encrypted')
    .eq('telegram_id', chatId)
    .maybeSingle();

  if (!customer) {
    await ctx.reply('No customer bound. Use /vip +2348012345678 first.');
    return;
  }

  // Get current balance
  var { data: bal } = await sb
    .from('customer_balances')
    .select('*')
    .eq('customer_id', customer.id)
    .maybeSingle();

  var newBalance = (bal ? bal.available_balance : 0) + amount;

  if (bal) {
    await sb.from('customer_balances')
      .update({ available_balance: newBalance, updated_at: new Date().toISOString() })
      .eq('id', bal.id);
  } else {
    await sb.from('customer_balances')
      .insert({ customer_id: customer.id, available_balance: amount, total_earned: 0, total_withdrawn: 0 });
  }

  // Track for undo
  lastCredit[chatId] = { amount: amount, customer_id: customer.id, tx_id: txId, prev_balance: bal ? bal.available_balance : 0 };

  // Build reply — phone display
  var phoneDisplay = '📞 Bound';
  if (customer.phone_encrypted) {
    try {
      var plain = decryptPhone(customer.phone_encrypted);
      if (plain) phoneDisplay = '📞 ' + plain;
    } catch(e) {}
  }

  var reply = '✅ Issued ' + amount + '\n\n👤\ufe0f ' + customer.name + '\n💎 ' + (customer.public_id || 'N/A');

    // Always create a transaction record
  var bankId = await ensureSystemBankAccount();
  var txId = crypto.randomUUID();
  try { await sb.from('transactions').insert({
    id: txId,
    customer_id: customer.id,
    bank_account_id: bankId,
    amount: amount,
    trade_date: new Date().toISOString()
  }); } catch(e) { console.error('[TX] Insert error:', e.message); }

  // Commission chain: up to 4 levels
  var rates = [0.01, 0.005, 0.003, 0.002];
  var levelNames = ['L1', 'L2', 'L3', 'L4'];
  var commissionParts = [];
  var currentParentId = customer.parent_id;

  for (var level = 0; level < 4; level++) {
    if (!currentParentId) break;

    var { data: parent } = await sb
      .from('customers')
      .select('id, parent_id')
      .eq('id', currentParentId)
      .maybeSingle();

    if (!parent) break;

    var commissionAmt = Math.round(amount * rates[level] * 100) / 100;
    if (commissionAmt > 0) {
      try { await sb.from('commissions').insert({
        customer_id: parent.id,
        from_customer_id: customer.id,
        from_transaction_id: txId,
        amount: amount,
        rate: rates[level],
        commission: commissionAmt,
        month: getMonthStr(new Date()),
        settled: false
      }); } catch(e) { console.error('[COMM] Insert error:', e.message); }
      commissionParts.push('  ' + levelNames[level] + ' (' + (rates[level] * 100) + '%): +' + commissionAmt.toFixed(2));
    }
    currentParentId = parent.parent_id;

  } // end for loop
  // Query current month total commission earned
  var thisMonth = getMonthStr(new Date());
  var { data: monthComms } = await sb
    .from('commissions')
    .select('commission')
    .eq('customer_id', customer.id)
    .eq('month', thisMonth);
  var totalMonthComm = 0;
  if (monthComms) {
    for (var mc = 0; mc < monthComms.length; mc++) {
      totalMonthComm += monthComms[mc].commission;
    }
  }
  // Subtract advances for this month
  var { data: advs_2 } = await sb
    .from('transactions')
    .select('amount')
    .eq('customer_id', customer.id)
    .eq('source', 'advance')
    .gte('created_at', thisMonth + '-01')
    .lt('created_at', getMonthStr(new Date(new Date().getFullYear(), new Date().getMonth() + 1, 1)) + '-01');
  var advTotal2 = 0;
  if (advs_2) {
    for (var a2 = 0; a2 < advs_2.length; a2++) advTotal2 += advs_2[a2].amount;
  }
  var netComm = totalMonthComm - advTotal2;
  if (netComm < 0) netComm = 0;
  reply += '\n💰️ commission: ₦' + netComm.toFixed(2);
  if (commissionParts.length > 0) {
    reply += '\n━━━━━━━━━━━━━━━━\n🏆 Referral Commission\n' + commissionParts.join('\n');
  }

  reply += '\n📢 Referral ID: ' + (customer.public_id || 'N/A');

  await ctx.reply(reply);
});


// ============================================================

// ============================================================
// Chinese command router — handles all Chinese-text commands
// Uses manual text routing instead of hears to avoid
// grammy/Telegram Unicode regex matching issues
// ============================================================
bot.use(async (ctx, next) => {
  if (!ctx.message || !ctx.message.text) return next();

  var text = ctx.message.text.trim();
  // Normalize: remove leading / and optional @botname suffix
  var cmd = text.replace(/^\/+/, '').replace(/@\w+$/, '');

  // 下发 is handled by its own hears handler below
  if (/^下发\s*\d+$/.test(cmd)) return next();

  // --- /撤回 — undo last credit ---
  if (cmd === '撤回') {
    var chatId = String(ctx.chat.id);
    var last = lastCredit[chatId];

    if (!last) {
      await ctx.reply('Nothing to undo.');
      return;
    }

    var bankId2 = await ensureSystemBankAccount();
    var revId = crypto.randomUUID();

    // Create reversal transaction (negative amount)
    try { await sb.from('transactions').insert({
      id: revId,
      customer_id: last.customer_id,
      bank_account_id: bankId2,
      amount: -last.amount,
      source: 'reversal',
      trade_date: new Date().toISOString()
    }); } catch(e) { console.error('[UNDO] Reversal TX error:', e.message); }

    // Create reversal commissions (negative)
    var { data: custInfo } = await sb.from('customers').select('id, parent_id').eq('id', last.customer_id).maybeSingle();
    if (custInfo) {
      var rates2 = [0.01, 0.005, 0.003, 0.002];
      var curPid2 = custInfo.parent_id;
      for (var lv = 0; lv < 4; lv++) {
        if (!curPid2) break;
        var { data: p2 } = await sb.from('customers').select('id, parent_id').eq('id', curPid2).maybeSingle();
        if (!p2) break;
        var revComm = Math.round(last.amount * rates2[lv] * 100) / 100;
        if (revComm > 0) {
          try { await sb.from('commissions').insert({
            customer_id: p2.id,
            from_customer_id: last.customer_id,
            from_transaction_id: revId,
            amount: -last.amount,
            rate: rates2[lv],
            commission: -revComm,
            month: getMonthStr(new Date()),
            settled: false
          }); } catch(e) { console.error('[UNDO] Reversal commission error:', e.message); }
        }
        curPid2 = p2.parent_id;
      }
    }

    var { error: updateErr } = await sb
      .from('customer_balances')
      .update({ available_balance: last.prev_balance, updated_at: new Date().toISOString() })
      .eq('customer_id', last.customer_id);

    if (updateErr) {
      await ctx.reply('\u2755 Failed to undo: ' + updateErr.message);
      return;
    }

    delete lastCredit[chatId];
    await ctx.reply('↩️ Undid +' + last.amount);
    return;
    return;
  }

  // --- /查账 — show 6-month commission status ---
    if (cmd === '查账') {
    var chatId = String(ctx.chat.id);

    var { data: cust } = await sb
      .from('customers')
      .select('id, name, public_id, phone_encrypted')
      .eq('telegram_id', chatId)
      .maybeSingle();

    if (!cust) {
      await ctx.reply('No customer bound. Use /vip first.');
      return;
    }

    var now = new Date();
    var months = [];
    for (var mi = 0; mi < 6; mi++) {
      var d = new Date(now.getFullYear(), now.getMonth() - mi, 1);
      months.push({ str: getMonthStr(d), dt: d });
    }

    var phoneDisplay = 'N/A';
    if (cust.phone_encrypted) {
      try { phoneDisplay = decryptPhone(cust.phone_encrypted); } catch(e) {}
    }
    function fmtNum(n) {
      return n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    }
    var lines_out = ['💎 ' + cust.public_id + '  |  📞 ' + phoneDisplay];
    lines_out.push('━━━━━━━━━━━━━━━━━━━━━━');
    lines_out.push('📋 Commission Status\n');
    lines_out.push('Month' + ''.padEnd(8) + '        Commission(₦)' + ''.padEnd(5) + 'Status');
    lines_out.push('───────────────────────────────────────');
    for (var mi2 = 0; mi2 < months.length; mi2++) {
      var m = months[mi2];
      var { data: comms } = await sb
        .from('commissions')
        .select('commission, settled')
        .eq('customer_id', cust.id)
        .eq('month', m.str);

      if (!comms || comms.length === 0) continue;

      var totalComm = 0;
      var allSettled = true;
      for (var ci = 0; ci < comms.length; ci++) {
        totalComm += comms[ci].commission;
        if (!comms[ci].settled) allSettled = false;
      }

      var y = m.str.substring(0, 4);
      var mo = parseInt(m.str.substring(5, 7), 10);
      var label = y + '-' + mo + '月';

      var isCurrentMonth = (mi2 === 0);
      var state = isCurrentMonth ? '🔒 Locking' : (allSettled ? '✅ Settled' : '⏳ Unsettled');

      var amtStr = '₦' + fmtNum(totalComm);
      lines_out.push(label.padEnd(13) + amtStr.padStart(18) + '       ' + state);
    }

    lines_out.push('\n⚠️ Current month commission settles next month');
    await ctx.reply(lines_out.join('\n'));
    return;
  }


  if (cmd.startsWith('预支 ') && !cmd.startsWith('预支查询')) {
    var parts = cmd.split(/\s+/);
    var advAmount = parseFloat(parts[1]);

    if (!advAmount || advAmount <= 0) {
      await ctx.reply('Usage: /预支 金额, e.g. /预支 10000');
      return;
    }

    var chatId = String(ctx.chat.id);
    var { data: cust } = await sb
      .from('customers')
      .select('id, name, public_id, phone_encrypted')
      .eq('telegram_id', chatId)
      .maybeSingle();

    if (!cust) {
      await ctx.reply('No customer bound. Use /vip first.');
      return;
    }

    // Record the advance against future commissions
    var { error: insErr } = await sb.from('transactions').insert({
      customer_id: cust.id,
      amount: advAmount,
      source: 'advance',
      bank_account_id: SYSTEM_BANK_ID,
      trade_date: new Date().toISOString(),
      created_at: new Date().toISOString()
    });

    if (insErr) {
      await ctx.reply('❌ Failed to record advance: ' + insErr.message);
      return;
    }

    await ctx.reply('✅ Advance recorded: ₦' + advAmount.toFixed(2) + '\n💳 Deducted from future commissions');
    return;
  }  // --- /预支查询 — show advance records with running payable ---
  if (cmd === '预支查询') {
    var chatId = String(ctx.chat.id);

    var { data: cust } = await sb
      .from('customers')
      .select('id, name, public_id, phone_encrypted')
      .eq('telegram_id', chatId)
      .maybeSingle();

    if (!cust) {
      await ctx.reply('No customer bound. Use /vip first.');
      return;
    }

    // Total commission earned (all time)
    var { data: allComms } = await sb
      .from('commissions')
      .select('commission')
      .eq('customer_id', cust.id);
    var totalComm = 0;
    if (allComms) {
      for (var ci = 0; ci < allComms.length; ci++) totalComm += allComms[ci].commission;
    }

    // All advance records (newest first)
    var { data: advances, error: advErr } = await sb
      .from('transactions')
      .select('amount, created_at')
      .eq('customer_id', cust.id)
      .eq('source', 'advance')
      .order('created_at', { ascending: false });

    if (advErr) {
      await ctx.reply('❌ Failed to query advances: ' + advErr.message);
      return;
    }

    if (!advances || advances.length === 0) {
      await ctx.reply('No advance records found.');
      return;
    }

    // Running payable: sort chronologically, subtract each advance
    var sorted = advances.slice().reverse(); // oldest first
    var runningSum = 0;
    var rows = [];
    for (var i = 0; i < sorted.length; i++) {
      runningSum += sorted[i].amount;
      var payable = totalComm - runningSum;
      if (payable < 0) payable = 0;
      var d = new Date(sorted[i].created_at);
      // Convert UTC to Beijing time (UTC+8)
      var bj = new Date(d.getTime() + 8 * 60 * 60 * 1000);
      var ts = bj.getUTCFullYear() + '-' + String(bj.getUTCMonth()+1).padStart(2,'0') + '-' + String(bj.getUTCDate()).padStart(2,'0') + ' ' + String(bj.getUTCHours()).padStart(2,'0') + ':' + String(bj.getUTCMinutes()).padStart(2,'0') + ':' + String(bj.getUTCSeconds()).padStart(2,'0');
      rows.push({ ts: ts, amt: sorted[i].amount, pay: payable, cum: runningSum });
    }

    // Display newest first
    rows.reverse();

            // Build table with double-space separators
    var out = [];
    var hdr1 = '--' + 'VIPID'.padEnd(12) + '                  ' + '日期'.padEnd(17) + '  ' + '总佣金'.padStart(10) + '  ' + '预支'.padStart(8) + '    ' + '应付金额';
    out.push(hdr1);
    for (var ri = 0; ri < rows.length; ri++) {
      var vipD = cust.public_id.padEnd(12);
      var dateD = rows[ri].ts.padEnd(22);
      var commD = String(totalComm).padStart(10);
      var advD = String(rows[ri].amt).padStart(10);
      var payD = String(rows[ri].pay);
      out.push(vipD + '  ' + dateD + '  ' + commD + '  ' + advD + '      ' + payD);
    }
    await ctx.reply(out.join('\n'));
    return;
  }// --- /结算 — settle commissions for a specified month (e.g. /结算 2026-5月) ---
  if (cmd.startsWith('结算')) {
    // Parse month parameter: /结算 2026-5月
    var parts = text.replace(/^\/+/, '').replace(/@\w+$/, '').split(/\s+/);
    var targetMonth = null;
    if (parts.length >= 2 && parts[1]) {
      var match = parts[1].match(/^(\d{4})\s*[-年]\s*(\d{1,2})\s*月?$/);
      if (match) {
        targetMonth = match[1] + '-' + String(parseInt(match[2])).padStart(2, '0');
      }
    }

    if (!targetMonth) {
      await ctx.reply('Please specify a month, e.g.: /结算 2026-5月');
      return;
    }

    // Get bound customer for this chat
    var chatId = String(ctx.chat.id);
    var { data: boundCust } = await sb
      .from('customers')
      .select('id')
      .eq('telegram_id', chatId)
      .maybeSingle();
    if (!boundCust) {
      await ctx.reply('No customer bound to this chat. Use /vip +2348012345678 first.');
      return;
    }

    var { data: pending, error: fetchErr } = await sb
      .from('commissions')
      .select('id, commission, customer_id')
      .eq('settled', false)
      .eq('customer_id', boundCust.id)
      .eq('month', targetMonth);

    if (fetchErr) {
      await ctx.reply('❌ Failed to query commissions: ' + fetchErr.message);
      return;
    }

    if (!pending || pending.length === 0) {
      await ctx.reply('No pending commissions for ' + targetMonth);
      return;
    }

    var ids = pending.map(function(r) { return r.id; });
    var { error: updateErr } = await sb
      .from('commissions')
      .update({ settled: true, settled_at: new Date().toISOString() })
      .in('id', ids);

    if (updateErr) {
      await ctx.reply('❌ Settlement failed: ' + updateErr.message);
      return;
    }

    var referrerTotals = {};
    pending.forEach(function(c) {
      referrerTotals[c.customer_id] = (referrerTotals[c.customer_id] || 0) + c.commission;
    });

    for (var refId in referrerTotals) {
      if (!referrerTotals.hasOwnProperty(refId)) continue;
      var thisAmt = referrerTotals[refId];
      var { data: refBal } = await sb
        .from('customer_balances')
        .select('*')
        .eq('customer_id', refId)
        .maybeSingle();

      if (refBal) {
        await sb.from('customer_balances')
          .update({ total_earned: (refBal.total_earned || 0) + thisAmt, updated_at: new Date().toISOString() })
          .eq('id', refBal.id);
      }
    }

    await ctx.reply('✅ Settled ' + pending.length + ' commissions for ' + targetMonth);
    return;
  }

  
  // --- /添加管理 — add a sub-admin ---
  if (cmd === '添加管理' || cmd.startsWith('添加管理 ')) {
    if (!ADMIN_TG_IDS.includes(ctx.from.id)) {
      await ctx.reply('⛔ Only main admin can use this');
      return;
    }
    var parts = text.split(/\s+/);
    if (parts.length < 2) {
      await ctx.reply('Usage: /添加管理 +2348012345678');
      return;
    }
    var phoneRaw = parts.slice(1).join('');
    var phone = normalizePhone(phoneRaw);
    var ph = hashPhone(phone);
    var { data: cust } = await sb.from('customers').select('id').eq('phone_hash', ph).maybeSingle();
    if (!cust) {
      await ctx.reply('❌ Customer not found with phone ' + phone);
      return;
    }
    var { data: existing } = await sb.from('sub_admins').select('id').eq('customer_id', cust.id).maybeSingle();
    if (existing) {
      await ctx.reply('⚠️ Already a sub-admin');
      return;
    }
    var { data: custFull } = await sb.from('customers').select('telegram_id').eq('id', cust.id).maybeSingle();
    if (!custFull || !custFull.telegram_id) {
      await ctx.reply('❌ Customer has no telegram_id. Use /vip first.');
      return;
    }
    var { error: insErr } = await sb.from('sub_admins').insert({
      telegram_id: custFull.telegram_id,
      customer_id: cust.id,
      created_by: null
    });
    if (insErr) {
      await ctx.reply('❌ Failed to add sub-admin: ' + insErr.message);
      return;
    }
    await refreshSubAdminCache();
    await ctx.reply('✅ Sub-admin added: ' + phone);
    return;
  }

  // --- /删除管理 — remove a sub-admin ---
  if (cmd === '删除管理' || cmd.startsWith('删除管理 ')) {
    if (!ADMIN_TG_IDS.includes(ctx.from.id)) {
      await ctx.reply('⛔ Only main admin can use this');
      return;
    }
    var parts = text.split(/\s+/);
    if (parts.length < 2) {
      await ctx.reply('Usage: /删除管理 +2348012345678');
      return;
    }
    var phoneRaw = parts.slice(1).join('');
    var phone = normalizePhone(phoneRaw);
    var ph = hashPhone(phone);
    var { data: cust } = await sb.from('customers').select('id').eq('phone_hash', ph).maybeSingle();
    if (!cust) {
      await ctx.reply('❌ Customer not found with phone ' + phone);
      return;
    }
    var { error: delErr } = await sb.from('sub_admins').delete().eq('customer_id', cust.id);
    if (delErr) {
      await ctx.reply('❌ Failed to remove sub-admin: ' + delErr.message);
      return;
    }
    await refreshSubAdminCache();
    await ctx.reply('✅ Sub-admin removed: ' + phone);
    return;
  }

  // --- /查看管理 — list all sub-admins ---
  if (cmd === '查看管理') {
    if (!ADMIN_TG_IDS.includes(ctx.from.id)) {
      await ctx.reply('⛔ Only main admin can use this');
      return;
    }
    var { data: subs } = await sb.from('sub_admins').select('telegram_id, customer_id, created_at');
    if (!subs || subs.length === 0) {
      await ctx.reply('No sub-admins configured.');
      return;
    }
    var lines = []; var n = 1;
    for (var si = 0; si < subs.length; si++) {
      var { data: c } = await sb.from('customers').select('public_id').eq('id', subs[si].customer_id).maybeSingle();
      var pid = c ? c.public_id : '?';
      lines.push(String(n++) + '. ' + pid + ' (TG:' + subs[si].telegram_id + ')');
    }
    await ctx.reply('📋 Sub-admins:\n' + lines.join('\n'));
    return;
  }

  // --- /注册 — register a new customer by phone directly
  if (cmd === '注册' || cmd.startsWith('注册 ')) {
    if (!ADMIN_TG_IDS.includes(ctx.from.id)) {
      await ctx.reply('⛔ Only main admin can use this');
      return;
    }
    var parts = text.split(/\s+/);
    if (parts.length < 2) {
      await ctx.reply('Usage: /注册 +2348012345678');
      return;
    }
    var phoneRaw = parts.slice(1).join('');
    var phone = normalizePhone(phoneRaw);
    var ph = hashPhone(phone);

    // Check if already registered
    var { data: existing } = await sb.from('customers').select('id').eq('phone_hash', ph).maybeSingle();
    if (existing) {
      await ctx.reply('⚠️ Phone ' + phone + ' is already registered');
      return;
    }

    // Generate unique public_id (VIP + 5 random digits)
    var pubId = '';
    var unique = false;
    while (!unique) {
      var digits = '';
      for (var d = 0; d < 5; d++) digits += Math.floor(Math.random() * 10);
      pubId = 'VIP' + digits;
      var { data: check } = await sb.from('customers').select('id').eq('public_id', pubId).maybeSingle();
      if (!check) unique = true;
    }

    var encPhone = encryptPhone(phone);

    var { error: insErr } = await sb.from('customers').insert({
      phone_encrypted: encPhone,
      phone_hash: ph,
      public_id: pubId,
      name: 'User'
    });

    if (insErr) {
      await ctx.reply('❌ Failed to register: ' + insErr.message);
      return;
    }

    await ctx.reply('✅ Registered ' + phone + '\n🔑 ' + pubId + '\nYou can now use /添加管理 ' + phone);
    return;
  }

  // --- /我的信息 — show current customer's info
  if (cmd === '我的信息' || cmd === 'info') {
    var chatId = String(ctx.chat.id);
    var { data: cust } = await sb
      .from('customers')
      .select('id, name, public_id, phone_encrypted, telegram_id, bound_email, email')
      .eq('telegram_id', chatId)
      .maybeSingle();
    if (!cust) {
      await ctx.reply('No customer bound. Use /vip +2348012345678 first.');
      return;
    }
    var phoneDisplay = 'N/A';
    if (cust.phone_encrypted) {
      try {
        phoneDisplay = decryptPhone(cust.phone_encrypted);
      } catch(e) { phoneDisplay = 'Error'; }
    }
    await ctx.reply('📞 Phone: ' + phoneDisplay + '\n💎 VIP ID: ' + cust.public_id + '\n👤 Name: ' + (cust.name || 'N/A') + '\n✉️ Email: ' + (cust.bound_email || cust.email || 'Not bound'));
    return;
  }


  // --- /检查号码 — check if a phone has a referrer ---
  if (cmd === '检查号码' || cmd.startsWith('检查号码 ')) {
    if (!isAdmin(ctx.from.id)) {
      await ctx.reply('⛔ Only admin can use this');
      return;
    }
    var parts = text.split(/\s+/);
    if (parts.length < 2) {
      await ctx.reply('Usage: /检查号码 +2348012345678');
      return;
    }
    var phoneRaw = parts.slice(1).join('');
    var phone = normalizePhone(phoneRaw);
    var ph = hashPhone(phone);
    var { data: cust } = await sb.from('customers').select('id, public_id, parent_id, name').eq('phone_hash', ph).maybeSingle();
    if (!cust) {
      await ctx.reply('❌ Customer not found with phone ' + phone);
      return;
    }
    if (cust.parent_id) {
      var { data: ref } = await sb.from('customers').select('public_id, name').eq('id', cust.parent_id).maybeSingle();
      var refStr = ref ? ref.public_id + ' (' + ref.name + ')' : 'ID:' + cust.parent_id;
      await ctx.reply('✅ ' + cust.public_id + ' ' + phone + '\n⬆ Has referrer: ' + refStr);
    } else {
      await ctx.reply('✅ ' + cust.public_id + ' ' + phone + '\n❌ No referrer. Can be set as agent.');
    }
    return;
  }

  // --- /添加代理 — create an agent with AGTXXXX ID ---
  if (cmd === '添加代理' || cmd.startsWith('添加代理 ')) {
    if (!isAdmin(ctx.from.id)) {
      await ctx.reply('⛔ Only admin can use this');
      return;
    }
    var parts = text.split(/\s+/);
    if (parts.length < 3) {
      await ctx.reply('Usage: /添加代理 +2348012345678 AGT0001');
      return;
    }
    var phoneRaw = parts[1];
    var agentId = parts[2].toUpperCase();
    var phone = normalizePhone(phoneRaw);
    var ph = hashPhone(phone);

    // Validate AGT format
    if (!/^AGT\d{4}$/.test(agentId)) {
      await ctx.reply('❌ Agent ID must be AGT followed by 4 digits (e.g. AGT0001)');
      return;
    }

    // Check if customer exists
    var { data: cust } = await sb.from('customers').select('id, public_id, parent_id').eq('phone_hash', ph).maybeSingle();
    if (!cust) {
      await ctx.reply('❌ Customer not found with phone ' + phone);
      return;
    }

    // Check if agent ID already taken
    var { data: existingAgent } = await sb.from('customers').select('id').eq('agent_id', agentId).maybeSingle();
    if (existingAgent) {
      await ctx.reply('❌ Agent ID ' + agentId + ' already has an owner');
      return;
    }

    // Check if customer has referrer - if so, warn
    if (cust.parent_id) {
      var { data: ref } = await sb.from('customers').select('public_id').eq('id', cust.parent_id).maybeSingle();
      await ctx.reply('⚠️ ' + cust.public_id + ' has referrer ' + (ref ? ref.public_id : '?') + '.\nAs agent owner, they will NOT earn referral commissions from group transactions. Proceed anyway?\nSend /确认代理 ' + phone + ' ' + agentId + ' to confirm.');
      return;
    }

    // No referrer, proceed directly
    var { error: updErr } = await sb.from('customers').update({ is_agent: true, agent_id: agentId, agent_commission_rate: 2.00 }).eq('id', cust.id);
    if (updErr) {
      await ctx.reply('❌ Failed: ' + updErr.message);
      return;
    }
    await ctx.reply('✅ Agent created!\n' + cust.public_id + ' ' + phone + '\n🏦 Agent ID: ' + agentId + '\n💰 Rate: 2% of monthly volume');
    return;
  }

  // --- /确认代理 — confirm agent creation even with referrer ---
  if (cmd === '确认代理' || cmd.startsWith('确认代理 ')) {
    if (!isAdmin(ctx.from.id)) {
      await ctx.reply('⛔ Only admin can use this');
      return;
    }
    var parts = text.split(/\s+/);
    if (parts.length < 3) {
      await ctx.reply('Usage: /确认代理 +2348012345678 AGT0001');
      return;
    }
    var phoneRaw = parts[1];
    var agentId = parts[2].toUpperCase();
    var phone = normalizePhone(phoneRaw);
    var ph = hashPhone(phone);

    var { data: cust } = await sb.from('customers').select('id, public_id').eq('phone_hash', ph).maybeSingle();
    if (!cust) {
      await ctx.reply('❌ Customer not found');
      return;
    }

    var { error: updErr } = await sb.from('customers').update({ is_agent: true, agent_id: agentId, agent_commission_rate: 2.00 }).eq('id', cust.id);
    if (updErr) {
      await ctx.reply('❌ Failed: ' + updErr.message);
      return;
    }
    await ctx.reply('✅ Agent created (with referrer)!\n' + cust.public_id + ' ' + phone + '\n🏦 Agent ID: ' + agentId);
    return;
  }

  // --- /代理报表 — view agent monthly report ---
  if (cmd === '代理报表' || cmd.startsWith('代理报表 ')) {
    if (!isAdmin(ctx.from.id)) {
      await ctx.reply('⛔ Only admin can use this');
      return;
    }
    var parts = text.split(/\s+/);
    var targetMonth = '';
    if (parts.length >= 2) {
      targetMonth = parts[1];
    } else {
      // Default to current month
      var now = new Date();
      var y = now.getFullYear();
      var m = String(now.getMonth() + 1).padStart(2, '0');
      targetMonth = y + '-' + m;
    }

    // If specific agent requested
    if (parts.length >= 3) {
      var agentId = parts[2].toUpperCase();
      var { data: agent } = await sb.from('customers').select('id, public_id, agent_id, agent_commission_rate, phone_encrypted').eq('agent_id', agentId).maybeSingle();
      if (!agent) {
        await ctx.reply('❌ Agent ' + agentId + ' not found');
        return;
      }
      var agentPhone = 'N/A';
      if (agent.phone_encrypted) {
        try { agentPhone = decryptPhone(agent.phone_encrypted); } catch(e) {}
      }
      // Get all transactions from customers under this agent
      var { data: members } = await sb.from('customers').select('id').eq('parent_agent_id', agentId);
      var total = 0;
      if (members && members.length > 0) {
        var memberIds = members.map(function(m) { return m.id; });
        var { data: txns } = await sb.from('transactions').select('amount').in('customer_id', memberIds).gte('created_at', targetMonth + '-01').lt('created_at', targetMonth + '-31');
        if (txns) for (var ti = 0; ti < txns.length; ti++) { if (txns[ti].amount > 0) total += txns[ti].amount; }
      }
      var rate = agent.agent_commission_rate || 2;
      var payable = total * rate / 100;
      await ctx.reply(
        '🏦 Agent Report: ' + agentId + '\n' +
        '📞 ' + agentPhone + '\n' +
        '📅 Month: ' + targetMonth + '\n' +
        '💰 Total Volume: ₦' + Number(total).toLocaleString() + '\n' +
        '📈 Rate: ' + rate + '%\n' +
        '✅ Payable: ₦' + Number(payable).toLocaleString()
      );
      return;
    }

    //     // List all agents
    var { data: agents } = await sb.from('customers').select('id, public_id, agent_id, agent_commission_rate').eq('is_agent', true);
    if (!agents || agents.length === 0) {
      await ctx.reply('No agents found.');
      return;
    }
    var lines = ['\U0001f3e6 Agent Report: ' + targetMonth, ''];
    for (var ai = 0; ai < agents.length; ai++) {
      var ag = agents[ai];
      var { data: members } = await sb.from('customers').select('id').eq('parent_agent_id', ag.agent_id);
      var totalVol = 0;
      if (members && members.length > 0) {
        var memberIds = members.map(function(m) { return m.id; });
        var { data: txns } = await sb.from('transactions').select('amount').in('customer_id', memberIds).gte('created_at', targetMonth + '-01').lt('created_at', targetMonth + '-31');
        if (txns) for (var tj = 0; tj < txns.length; tj++) { if (txns[tj].amount > 0) totalVol += txns[tj].amount; }
      }
      var r = ag.agent_commission_rate || 2;
      lines.push(ag.agent_id + ' ' + ag.public_id + ' | Vol: \u20a6' + Number(totalVol).toLocaleString() + ' | Pay: \u20a6' + Number(totalVol*r/100).toLocaleString());
    }
    await ctx.reply(lines.join('\n'));
    return;
    var lines = ['🏦 Agent Report: ' + targetMonth, ''];
    for (var ai = 0; ai < agents.length; ai++) {
      var ag = agents[ai];
      var { data: txns } = await sb.from('transactions').select('amount').gte('created_at', targetMonth + '-01').lt('created_at', targetMonth + '-31');
      var t = 0;
      if (txns) for (var tj = 0; tj < txns.length; tj++) { if (txns[tj].amount > 0) t += txns[tj].amount; }
      var r = ag.agent_commission_rate || 2;
      lines.push(ag.agent_id + ' ' + ag.public_id + ' | Vol: ₦' + Number(t).toLocaleString() + ' | Pay: ₦' + Number(t*r/100).toLocaleString());
    }
    await ctx.reply(lines.join('\n'));
    return;
  }


  // --- /帮助 or /指令 — show all commands ---
  if (cmd === '帮助' || cmd === '指令') {
    await ctx.reply(
      '🤖 Nova 机器人指令\n\n' +
      '/vip' + ''.padEnd(25) + '— 绑定 VIP 会员到当前聊天窗\n' +
      '/-vip' + ''.padEnd(24) + '— 解除 VIP 会员绑定\n' +
      '/下发' + ''.padEnd(24) + '— 给当前客户加账\n' +
      '/撤回' + ''.padEnd(24) + '— 撤销上一次加账\n' +
      '/查账' + ''.padEnd(24) + '— 查看近 6 个月佣金状态 (含预支)\n' +
      '/预支' + ''.padEnd(24) + '— 创建预支记录并从佣金扣除\n' +
      '/预支查询' + ''.padEnd(20) + '— 查看预支记录及应付金额\n' +
      '/结算' + ''.padEnd(24) + '— 结算指定月份佣金\n' +
      '/注册' + ''.padEnd(24) + '— 直接注册手机号为会员\n' +
      '/我的信息' + ''.padEnd(24) + '— 查看当前绑定客户的信息\n' +
      '/添加管理' + ''.padEnd(20) + '— 添加子管理员\n' +
      '/删除管理' + ''.padEnd(20) + '— 移除子管理员\n' +
      '/查看管理' + ''.padEnd(20) + '— 查看所有子管理员\n' +
      '/bindbank' + ''.padEnd(20) + '— 绑定银行账户到当前聊天窗\n' +
      '/fixreferrer' + ''.padEnd(17) + '— 修正客户的推荐人（管理员）' + '\n' + \n      '/检查号码' + ''.padEnd(18) + '— 查询号码是否有推荐人\n' + \n      '/添加代理' + ''.padEnd(18) + '— 将客户升级为代理\n' + \n      '/代理报表' + ''.padEnd(18) + '— 查看代理月度报表'
    );
    return;
  }

// Not a Chinese command — continue to hears handlers
  return next();
});


// ============================================================
// Fallback: remind to bind
// ============================================================
bot.on('message:text', async (ctx) => {
  var text = ctx.message.text.trim();
  // Ignore messages that match commands or +number patterns
  if (text.startsWith('/') || /^下发\s*\d+$/.test(text)) return;

  var chatId = String(ctx.chat.id);
  var { data: customer } = await sb
    .from('customers')
    .select('id')
    .eq('telegram_id', chatId)
    .maybeSingle();

  if (!customer) {
    await ctx.reply('Use /vip +2348012345678 to bind a customer to this chat.');
  }
});

// ============================================================
// Start polling (for Railway long-running process)
// ============================================================
// Clear webhook then start
(async () => {
  // Kill webhook & force close any existing polling sessions
  await bot.api.deleteWebhook({ drop_pending_updates: true }).catch(function() {});
  // Initialize sub-admins table
  var tableOk = await ensureSubAdminsTable();
  if (tableOk) await refreshSubAdminCache();
  // Set empty webhook to force-terminate old getUpdates
  await bot.api.setWebhook({ url: '' }).catch(function() {});
  // Wait for Railway to fully terminate the old container
  await new Promise(function(r) { setTimeout(r, 5000); });
  // Start polling with retry
  var maxRetries = 10;
  for (var a = 0; a < maxRetries; a++) {
    try {
      await bot.start({
        drop_pending_updates: true,
        onStart: function(info) {
          console.log('🤖 Nova Bot started as @' + (info.username || 'unknown'));
        }
      });
      return;
    } catch (e) {
      if (e.error_code === 409) {
        console.log('409 conflict, retry ' + (a+1) + '/' + maxRetries);
        await new Promise(function(r) { setTimeout(r, 4000); });
      } else {
        throw e;
      }
    }
  }
  console.error('Failed to start after ' + maxRetries + ' attempts');
})();





















