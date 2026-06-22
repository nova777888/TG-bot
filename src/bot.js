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
// /add +2348012345678 — bind customer to this chat
// ============================================================
bot.command('vip', async (ctx) => {
  var args = ctx.message.text.split(' ').slice(1).join(' ').trim();
  if (!args) {
    await ctx.reply('Usage: /add +2348012345678');
    return;
  }

  var normalized = normalizePhone(args);
  var hash = hashPhone(normalized);
  var chatId = String(ctx.chat.id);

  var { data: customer } = await sb
    .from('customers')
    .select('id, name, phone_hash')
    .eq('phone_hash', hash)
    .maybeSingle();

  if (!customer) {
    await ctx.reply('❌ Customer not found with phone ' + normalized);
    return;
  }

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
    'Now send +1000 or /balance');
});

// ============================================================
// +1000 or 下发1000 — add credit
// ============================================================
bot.hears(/^[+＋]?(\d+)$/, async (ctx) => {
  var chatId = String(ctx.chat.id);
  var amount = parseFloat(ctx.match[1]);

  if (!amount || amount <= 0) return;

  var { data: customer } = await sb
    .from('customers')
    .select('id, name')
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

  await ctx.reply('✅ +' + amount + '\n👤 ' + customer.name + '\n💰 Balance: ' + newBalance);
});

// Also handle 下发X
bot.hears(/^下发(\d+)$/, async (ctx) => {
  // Same logic as above - reuse by manually triggering
  var amount = parseFloat(ctx.match[1]);
  if (!amount || amount <= 0) return;

  var chatId = String(ctx.chat.id);
  var { data: customer } = await sb
    .from('customers')
    .select('id, name')
    .eq('telegram_id', chatId)
    .maybeSingle();

  if (!customer) {
    await ctx.reply('No customer bound. Use /vip +2348012345678 first.');
    return;
  }

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

  lastCredit[chatId] = { amount: amount, customer_id: customer.id, prev_balance: bal ? bal.available_balance : 0 };

  await ctx.reply('✅ +' + amount + '\n👤 ' + customer.name + '\n💰 Balance: ' + newBalance);
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

  await ctx.reply('💰 ' + customer.name + '\nAvailable: ' + balance + '\nTotal Earned: ' + earned);
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
    '/add +2348012345678 — Bind customer to this chat\n' +
    '+1000 — Add credit to bound customer\n' +
    '下发1000 — Same as +1000\n' +
    '/撤回 — Undo last credit\n' +
    '/balance — Show customer balance\n' +
    '/settle — Settle last month commissions\n' +
    '/help — This help'
  );
});

// ============================================================
// Fallback: remind to bind
// ============================================================
bot.on('message:text', async (ctx) => {
  var text = ctx.message.text.trim();
  // Ignore messages that match commands or +number patterns
  if (text.startsWith('/') || /^[+＋]?\d+$/.test(text) || /^下发\d+$/.test(text)) return;

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
