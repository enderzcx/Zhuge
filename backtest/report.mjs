/**
 * Backtest report generator — human-readable summary of backtest results.
 */

export function generateReport(trades, initialBalance = 100) {
  if (!trades || trades.length === 0) {
    return '回测结果: 0 笔交易 (策略条件在测试期间从未触发)';
  }

  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? Math.abs(losses.reduce((s, t) => s + t.pnl, 0) / losses.length) : 0;

  // Max consecutive losses
  let maxConsecLoss = 0, curConsecLoss = 0;
  for (const t of trades) {
    if (t.pnl <= 0) { curConsecLoss++; maxConsecLoss = Math.max(maxConsecLoss, curConsecLoss); }
    else curConsecLoss = 0;
  }

  // Equity curve & max drawdown
  let equity = initialBalance;
  let peak = initialBalance;
  let maxDD = 0;
  for (const t of trades) {
    equity += t.pnl;
    if (equity > peak) peak = equity;
    const dd = (peak - equity) / peak;
    if (dd > maxDD) maxDD = dd;
  }

  // Average hold time
  const holdTimes = trades.filter(t => t.openedAt && t.closedAt).map(t => t.closedAt - t.openedAt);
  const avgHoldMs = holdTimes.length > 0 ? holdTimes.reduce((s, h) => s + h, 0) / holdTimes.length : 0;
  const avgHoldH = (avgHoldMs / 3600000).toFixed(1);

  // Exit reasons
  const reasons = {};
  for (const t of trades) { reasons[t.reason] = (reasons[t.reason] || 0) + 1; }

  const lines = [
    `回测报告`,
    ``,
    `交易统计`,
    `  总交易: ${trades.length} (${wins.length}胜 ${losses.length}负)`,
    `  胜率: ${(wins.length / trades.length * 100).toFixed(1)}%`,
    `  总 PnL: ${totalPnl.toFixed(2)} USDT (${(totalPnl / initialBalance * 100).toFixed(1)}%)`,
    `  最终余额: ${equity.toFixed(2)} USDT`,
    ``,
    `风险指标`,
    `  最大回撤: ${(maxDD * 100).toFixed(1)}%`,
    `  最大连亏: ${maxConsecLoss} 笔`,
    `  平均盈利: ${avgWin.toFixed(2)} USDT`,
    `  平均亏损: ${avgLoss.toFixed(2)} USDT`,
    `  盈亏比: ${avgLoss > 0 ? (avgWin / avgLoss).toFixed(2) : 'N/A'}`,
    ``,
    `时间`,
    `  平均持仓: ${avgHoldH}h`,
    `  出场原因: ${Object.entries(reasons).map(([r, c]) => `${r}(${c})`).join(', ')}`,
  ];

  return lines.join('\n');
}
