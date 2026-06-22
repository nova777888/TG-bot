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
bot.command('vip', async (ctx) => {
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
bot.command('vip', { prefix: '-' }, async (ctx) => {
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

bot.hears(/^下发(\d+)$/, async (ctx) => {
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
  var phoneDisplay = '📱 已绑定';
  if (customer.phone_encrypted) {
    try {
      var plain = decryptPhone(customer.phone_encrypted);
      phoneDisplay = '📱 ' + plain.substring(0, 7) + '****' + plain.substring(plain.length - 4);
    } catch(e) {}
  }

  var reply = '✅ 下发' + amount + '\n\n✪\ufe0f ' + customer.name + '\n' + phoneDisplay + '\n🔑 ' + (customer.public_id || 'N/A');

  // Commission chain: up to 4 levels
  var rates = [0.01, 0.005, 0.003, 0.002];
  var levelNames = ['直推', 'FF', 'FFF', 'Member'];
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
      await sb.from('commissions').insert({
        referrer_id: parent.id,
        amount: commissionAmt,
        status: 'pending',
        created_at: new Date().toISOString()
      });
      commissionParts.push('  ' + levelNames[level] + ' (' + (rates[level] * 100) + '%): +' + commissionAmt.toFixed(2));
    }
    currentParentId = parent.parent_id;
  }

  if (commissionParts.length > 0) {
    reply += '\n━━━━━━━━━━━━━━━━\n🏆 推荐佣金\n' + commissionParts.join('\n');
  }

  reply += '\n📢 让朋友注册时填你的ID: ' + (customer.public_id || 'N/A');

  await ctx.reply(reply);
});


// ============================================================
// /撤回 — undo last credit
// ============================================================
bot.command('撤回', async (ctx) => {
  var chatId = String(ctx.chat.id);
  var last = lastCredit[chatId];

  if (!last) {
    await ctx.reply('Nothing to undo.');
    return;
  }

  // Restore previous balance
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
});

// ============================================================
// /balance — show customer balance
// ============================================================
bot.command('查账', async (ctx) => {
  var chatId = String(ctx.chat.id);

  var { data: customer } = await sb
    .from('customers')
    .select('id, name')
    .eq('telegram_id', chatId)
    .maybeSingle();

  if (!customer) {
    await ctx.reply('No customer bound. Use /vip first.');
    return;
  }

  var { data: bal } = await sb
    .from('customer_balances')
    .select('*')
    .eq('customer_id', customer.id)
    .maybeSingle();

  var balance = bal ? bal.available_balance : 0;
  var earned = bal ? bal.total_earned : 0;

  await ctx.reply('💰 ' + customer.name + '\n🔑 ' + (customer.public_id || 'N/A') + '\nAvailable: ' + balance + '\nTotal Earned: ' + earned);
});

// ============================================================
// /settle — settle last month's pending commissions
// ============================================================
bot.command('结算', async (ctx) => {
  var now = new Date();
  var monthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString();
  var monthEnd = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

  var { data: pending, error: fetchErr } = await sb
    .from('commissions')
    .select('id, amount, referrer_id')
    .eq('status', 'pending')
    .gte('created_at', monthStart)
    .lt('created_at', monthEnd);

  if (fetchErr) {
    await ctx.reply('❌ Failed to query commissions: ' + fetchErr.message);
    return;
  }

  if (!pending || pending.length === 0) {
    await ctx.reply('No pending commissions for last month.');
    return;
  }

  // Update all to settled
  var ids = pending.map(function(r) { return r.id; });
  var { error: updateErr } = await sb
    .from('commissions')
    .update({ status: 'settled' })
    .in('id', ids);

  if (updateErr) {
    await ctx.reply('❌ Settlement failed: ' + updateErr.message);
    return;
  }

  // Update customer_balances.total_earned for each referrer
  var referrerTotals = {};
  pending.forEach(function(c) {
    referrerTotals[c.referrer_id] = (referrerTotals[c.referrer_id] || 0) + c.amount;
  });

  for (var refId in referrerTotals) {
    var amt = referrerTotals[refId];
    var { data: refBal } = await sb
      .from('customer_balances')
      .select('*')
      .eq('customer_id', refId)
      .maybeSingle();

    if (refBal) {
      await sb.from('customer_balances')
        .update({ total_earned: (refBal.total_earned || 0) + amt, updated_at: new Date().toISOString() })
        .eq('id', refBal.id);
    }
  }

  await ctx.reply('✅ Settled ' + pending.length + ' commissions for last month');
});

// ============================================================
// /help
// ============================================================
bot.command('帮助', async (ctx) => {
  await ctx.reply(
    '🤖 Nova Bot Commands\n\n' +
    '/vip +2348012345678 \u2014 Bind VIP customer to this chat\n' +
    '/-vip +2348012345678 \u2014 Unbind VIP from its chat\n' +
    '下发1000 \u2014 Add credit to bound customer\n' +
    '/\u64a4\u56de \u2014 Undo last credit\n' +
    '/\u67e5\u8d26 \u2014 Show customer balance\n' +
    '/\u7ed3\u7b97 \u2014 Settle last month commissions\n' +
    '/\u5e2e\u52a9 \u2014 This help'
  );
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
bot.start({
  onStart: function(info) {
    console.log('🤖 Nova Bot started as @' + (info.username || 'unknown'));
  }
});
