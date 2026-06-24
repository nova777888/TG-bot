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

    // 1) Get total commission earned (all months)
    var { data: comms } = await sb
      .from('commissions')
      .select('commission')
      .eq('customer_id', cust.id);
    var totalComm = 0;
    if (comms) {
      for (var aci = 0; aci < comms.length; aci++) totalComm += comms[aci].commission;
    }

    // 2) Get all advance records (newest first)
    var { data: advances, error: advErr } = await sb
      .from('transactions')
      .select('amount, created_at')
      .eq('customer_id', cust.id)
      .eq('source', 'advance')
      .order('created_at', { ascending: false });

    if (advErr) {
      await ctx.reply('❌ Failed: ' + advErr.message);
      return;
    }

    if (!advances || advances.length === 0) {
      await ctx.reply('No advance records.');
      return;
    }

    // 3) Build output: running payable from newest to oldest
    // Sort advances chronologically first for running calc
    var sorted = advances.slice().reverse(); // oldest first
    var runningSum = 0;
    var rowData = [];
    for (var avi = 0; avi < sorted.length; avi++) {
      runningSum += sorted[avi].amount;
      var payable = totalComm - runningSum;
      if (payable < 0) payable = 0;
      var d = new Date(sorted[avi].created_at);
      var ts = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0') + ' ' + String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0') + ':' + String(d.getSeconds()).padStart(2,'0');
      rowData.push({ date: ts, amount: sorted[avi].amount, payable: payable });
    }

    // Display newest first (reverse the rowData)
    rowData.reverse();

    var lines_out = [cust.public_id + '  Date  Commission  Advance  Amount Payable'];
    for (var ri = 0; ri < rowData.length; ri++) {
      var r = rowData[ri];
      var calc = totalComm.toFixed(0) + '-' + r.amount.toFixed(0) + '=' + r.payable.toFixed(0);
      lines_out.push(cust.public_id + '  ' + r.date + '  ' + totalComm.toFixed(0) + '  ' + r.amount.toFixed(0) + '  ' + calc);
    }

    await ctx.reply(lines_out.join('\n'));
    return;
  }if (cmd === '预支查询') {
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

    // Get all advances (transactions with source=advance), newest first
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

    // Get total commissions across all months
    var { data: allComms } = await sb
      .from('commissions')
      .select('commission')
      .eq('customer_id', cust.id);
    var totalCommAll = 0;
    if (allComms) {
      for (var aci = 0; aci < allComms.length; aci++) totalCommAll += allComms[aci].commission;
    }

    // Show each advance with running deduction (from earliest commissions)
    var remainingComm = totalCommAll;
    var lines_out = ['📋 Advance Records\n'];
    lines_out.push(cust.public_id + '  Date  Commission  Advance  Amount Payable');

    // Process newest first (as user requested)
    for (var avi = 0; avi < advances.length; avi++) {
      var a = advances[avi];
      var d = new Date(a.created_at);
      var dateStr = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') + ':' + String(d.getSeconds()).padStart(2, '0');

      // Calculate payable: deduct this advance from remaining commission
      var payable = Math.max(0, remainingComm - a.amount);
      var calcStr = remainingComm.toFixed(0) + '-' + a.amount.toFixed(0) + '=' + payable.toFixed(0);
      lines_out.push(cust.public_id + '  ' + dateStr + '  ' + remainingComm.toFixed(0) + '  ' + a.amount.toFixed(0) + '  ' + calcStr);

      remainingComm = payable; // update for next row
    }

    await ctx.reply(lines_out.join('\n'));
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
      '/预支 — 创建预支记录并从佣金扣除\n' +
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
