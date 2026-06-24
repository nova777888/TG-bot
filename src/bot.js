const { Bot } = require('grammy');
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
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
    await ctx.reply('⛔ Unauthorized');
    return;
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
    .select('id, name, public_id')
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
bot.hears(/^\/?下发(\d+)$/, async (ctx) => {
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
  lastCredit[chatId] = { amount: amount, customer_id: customer.id, prev_balance: bal ? bal.available_balance : 0 };

  // Build reply — phone display
  var phoneDisplay = '📱 Bound';
  if (customer.phone_encrypted) {
    try {
      var plain = decryptPhone(customer.phone_encrypted);
      if (plain) phoneDisplay = '📱 ' + plain;
    } catch(e) {}
  }

  var reply = '✅ Issued ' + amount + '\n\n✪\ufe0f ' + customer.name + '\n' + phoneDisplay + '\n🔑 ' + (customer.public_id || 'N/A');

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
  reply += '\ncommission: ₦' + totalMonthComm.toFixed(2);
    }if (commissionParts.length > 0) {
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
  if (/^下发\d+$/.test(cmd)) return next();

  // --- /撤回 — undo last credit ---
  if (cmd === '撤回') {
    var chatId = String(ctx.chat.id);
    var last = lastCredit[chatId];

    if (!last) {
      await ctx.reply('Nothing to undo.');
      return;
    }

    var { error: updateErr } = await sb
      .from('customer_balances')
      .update({ available_balance: last.prev_balance, updated_at: new Date().toISOString() })
      .eq('customer_id', last.customer_id);

    if (updateErr) {
      await ctx.reply('❌ Failed to undo: ' + updateErr.message);
      return;
    }

    delete lastCredit[chatId];
    await ctx.reply('↩️ Undid +' + last.amount + ' (balance restored to ' + last.prev_balance + ')');
    return;
  }

  // --- /查账 — show 6-month commission status ---
  if (cmd === '查账') {
    var chatId = String(ctx.chat.id);

    var { data: cust } = await sb
      .from('customers')
      .select('id, name, public_id')
      .eq('telegram_id', chatId)
      .maybeSingle();

    if (!cust) {
      await ctx.reply('No customer bound. Use /vip first.');
      return;
    }

    // Generate last 6 months
    var now = new Date();
    var months = [];
    for (var mi = 0; mi < 6; mi++) {
      var d = new Date(now.getFullYear(), now.getMonth() - mi, 1);
      months.push({ str: getMonthStr(d), dt: d });
    }

    // Query commissions per month
    var lines_out = ['📋 Commission Status\n'];
    for (var mi2 = 0; mi2 < months.length; mi2++) {
      var m = months[mi2];
      var { data: comms } = await sb
        .from('commissions')
        .select('commission, settled')
        .eq('customer_id', cust.id)
        .eq('month', m.str);

      if (!comms || comms.length === 0) continue; // skip months with no commissions

      var totalComm = 0;
      var allSettled = true;
      for (var ci = 0; ci < comms.length; ci++) {
        totalComm += comms[ci].commission;
        if (!comms[ci].settled) allSettled = false;
      }

      var y = m.str.substring(0, 4);
      var mo = parseInt(m.str.substring(5, 7), 10);
      var label = y + '-' + mo + '月';

      // Check if current month
      var isCurrentMonth = (mi2 === 0);
      var state = isCurrentMonth ? '🔒 Locking' : (allSettled ? '✅ Settled' : '⏳ Unsettled');

      // Query advances (transactions with source='advance') for this month
      var { data: advs } = await sb
        .from('transactions')
        .select('amount')
        .eq('customer_id', cust.id)
        .eq('source', 'advance')
        .gte('created_at', m.str + '-01')
        .lt('created_at', getMonthStr(new Date(m.dt.getFullYear(), m.dt.getMonth() + 1, 1)) + '-01');
      var advTotal = 0;
      if (advs) {
        for (var ai = 0; ai < advs.length; ai++) advTotal += advs[ai].amount;
      }
      var advanceYesNo = advTotal > 0 ? 'Yes' : 'No';

      // Amount payable = commission - advance for this month
      var amtPayable = totalComm - advTotal;
      var amtStr = '₦' + amtPayable.toFixed(2);

      lines_out.push(cust.public_id + '  ' + label + '  ' + amtStr + '  ' + state + '  ' + advanceYesNo);
    }

    lines_out.push('\n⚠️ The commission for the current month cannot be settled and must wait until the next month for settlement.');
    await ctx.reply(lines_out.join('\n'));
    return;
  }

  // --- /佣金 — show this month's total commission earned ---
  if (cmd === '佣金') {
    var chatId = String(ctx.chat.id);

    var { data: cust } = await sb
      .from('customers')
      .select('id, name, public_id')
      .eq('telegram_id', chatId)
      .maybeSingle();

    if (!cust) {
      await ctx.reply('No customer bound. Use /vip first.');
      return;
    }

    var thisMonth = getMonthStr(new Date());
    var { data: comms } = await sb
      .from('commissions')
      .select('commission')
      .eq('customer_id', cust.id)
      .eq('month', thisMonth);

    var total = 0;
    if (comms) {
      for (var ci2 = 0; ci2 < comms.length; ci2++) {
        total += comms[ci2].commission;
      }
    }

    await ctx.reply('💰 This month commission: ₦' + total.toFixed(2));
    return;
  }

  // --- /预支 — create an advance record (deduct from commissions) ---
  if (cmd.startsWith('预支 ') && !cmd.startsWith('预支查询')) {
    var advParts = cmd.split(/\s+/);
    var advAmount = parseFloat(advParts[1]);

    if (!advAmount || advAmount <= 0) {
      await ctx.reply('Usage: /预支 5000');
      return;
    }

    var chatId = String(ctx.chat.id);
    var { data: cust } = await sb
      .from('customers')
      .select('id, name, public_id')
      .eq('telegram_id', chatId)
      .maybeSingle();

    if (!cust) {
      await ctx.reply('No customer bound. Use /vip first.');
      return;
    }

    // Insert advance as a transaction with source=advance
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

    // Deduct from customer_balances.available_balance
    var { data: bal } = await sb
      .from('customer_balances')
      .select('*')
      .eq('customer_id', cust.id)
      .maybeSingle();

    if (bal) {
      var newBal = (bal.available_balance || 0) - advAmount;
      if (newBal < 0) newBal = 0;
      await sb.from('customer_balances')
        .update({ available_balance: newBal, updated_at: new Date().toISOString() })
        .eq('id', bal.id);
    }

    var remaining = bal ? (bal.available_balance - advAmount) : 0;
    if (remaining < 0) remaining = 0;
    await ctx.reply('✅ Advance recorded: ₦' + advAmount.toFixed(2) + '\n💰 Remaining: ₦' + remaining.toFixed(2));
    return;
  }

  // --- /预支查询 — show advance records with running payable calculation ---
  if (cmd === '预支查询') {
    var chatId = String(ctx.chat.id);

    var { data: cust } = await sb
      .from('customers')
      .select('id, name, public_id')
      .eq('telegram_id', chatId)
      .maybeSingle();

    if (!cust) {
      await ctx.reply('No customer bound. Use /vip first.');
      return;
    }

    // Get all advances (transactions with source='advance'), ordered by created_at DESC
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

    // Group advances by month to get month total commission
    var lines_out = ['📋 Advance Records\n'];
    // Build month -> total commission map
    var monthComms = {};
    for (var ai2 = 0; ai2 < advances.length; ai2++) {
      var mStr = getMonthStr(new Date(advances[ai2].created_at));
      if (!monthComms[mStr]) {
        var { data: mComms } = await sb
          .from('commissions')
          .select('commission')
          .eq('customer_id', cust.id)
          .eq('month', mStr);
        monthComms[mStr] = 0;
        if (mComms) {
          for (var mci = 0; mci < mComms.length; mci++) monthComms[mStr] += mComms[mci].commission;
        }
      }
    }

    // Calculate running: advances are deducted from earliest commissions
    // First, reverse to chronological order
    var chrons = advances.slice().reverse();
    var runningAdv = 0;
    // For display, show in descending order (newest first) with running calc
    var displayRows = [];
    for (var avi = chrons.length - 1; avi >= 0; avi--) {
      var a = chrons[avi];
      var mS = getMonthStr(new Date(a.created_at));
      var totalCommMonth = monthComms[mS] || 0;
      runningAdv += a.amount;
      var payable = totalCommMonth - runningAdv;
      if (payable < 0) payable = 0;
      var d = new Date(a.created_at);
      var dateStr = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') + ':' + String(d.getSeconds()).padStart(2, '0');
      displayRows.push({
        date: dateStr,
        commission: totalCommMonth,
        advance: a.amount,
        payable: payable,
        remaining: totalCommMonth - runningAdv
      });
    }

    // Display in descending order (newest first)
    lines_out.push(cust.public_id + '  Date  Commission  Advance  Amount Payable');
    for (var dri = 0; dri < displayRows.length; dri++) {
      var r = displayRows[dri];
      var calcStr = r.commission.toFixed(0) + '-' + r.advance.toFixed(0) + '=' + r.payable.toFixed(0);
      lines_out.push(cust.public_id + '  ' + r.date + '  ' + r.commission.toFixed(0) + '  ' + r.advance.toFixed(0) + '  ' + calcStr);
    }

    await ctx.reply(lines_out.join('\n'));
    return;
  }

  // --- /结算 — settle commissions for a specified month (e.g. /结算 2026-5月) ---
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

    var { data: pending, error: fetchErr } = await sb
      .from('commissions')
      .select('id, commission, customer_id')
      .eq('settled', false)
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

  
  // --- /帮助 or /指令 — show all commands ---
  if (cmd === '帮助' || cmd === '指令') {
    await ctx.reply(
      '🤖 Nova 机器人指令\n\n' +
      '/vip +2348012345678 — 绑定 VIP 会员到当前聊天窗\n' +
      '/-vip +2348012345678 — 解除 VIP 会员绑定\n' +
      '/下发1000 — 给当前客户加账\n' +
      '/撤回 — 撤销上一次加账\n' +
      '/查账 — 查看近 6 个月佣金状态 (含预支)\n' +
      '/佣金 — 查看本月赚取佣金总数\n' +
      '/预支 5000 — 创建预支记录并从佣金扣除\n' +
      '/预支查询 — 查看预支记录及应付金额\n' +
      '/结算 2026-5月 — 结算指定月份佣金\n' +
      '/bindbank — 绑定银行账户到当前聊天窗\n' +
      '/fixreferrer — 修正客户的推荐人（管理员）'
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
  if (text.startsWith('/') || /^下发\d+$/.test(text)) return;

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
  // Forcefully reset any existing polling sessions
  await bot.api.deleteWebhook({ drop_pending_updates: true }).catch(() => {});
  // Close any stale getUpdates sessions
  await bot.api.getUpdates({ offset: -1, timeout: 1 }).catch(() => {});
  await bot.api.getUpdates({ offset: -2, timeout: 1 }).catch(() => {});
  bot.start({
    onStart: function(info) {
      console.log('🤖 Nova Bot started as @' + (info.username || 'unknown'));
    }
  });
})();
