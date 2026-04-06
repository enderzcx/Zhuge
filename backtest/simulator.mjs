/**
 * Virtual portfolio simulator for backtesting.
 * Pure in-memory, no API calls, no side effects.
 */

export function createSimulator({ initialBalance = 100, defaultLeverage = 10, maxPositions = 3 } = {}) {
  let balance = initialBalance;
  let peakBalance = initialBalance;
  let maxDrawdown = 0;
  const positions = []; // { id, symbol, side, entryPrice, leverage, margin, sl, tp, openedAt }
  const closedTrades = []; // { ...position, exitPrice, pnl, pnlPct, closedAt, reason }
  let nextId = 1;

  function openPosition({ symbol, side, price, leverage, margin, sl_pct, tp_pct, ts }) {
    if (positions.length >= maxPositions) return null;
    const lev = leverage || defaultLeverage;
    const m = Math.min(margin || balance * 0.05, balance);
    if (m < 0.1 || balance < m) return null;

    const pos = {
      id: nextId++,
      symbol, side, entryPrice: price, leverage: lev, margin: m,
      sl: sl_pct ? (side === 'long' ? price * (1 - sl_pct) : price * (1 + sl_pct)) : null,
      tp: tp_pct ? (side === 'long' ? price * (1 + tp_pct) : price * (1 - tp_pct)) : null,
      openedAt: ts,
    };
    balance -= m;
    positions.push(pos);
    return pos;
  }

  function closePosition(id, price, ts, reason = 'signal') {
    const idx = positions.findIndex(p => p.id === id);
    if (idx === -1) return null;
    const pos = positions.splice(idx, 1)[0];

    const direction = pos.side === 'long' ? 1 : -1;
    const pnlPct = direction * (price - pos.entryPrice) / pos.entryPrice;
    const pnl = pos.margin * pos.leverage * pnlPct;

    balance += pos.margin + pnl;
    if (balance > peakBalance) peakBalance = balance;
    const dd = (peakBalance - balance) / peakBalance;
    if (dd > maxDrawdown) maxDrawdown = dd;

    const trade = { ...pos, exitPrice: price, pnl, pnlPct, closedAt: ts, reason };
    closedTrades.push(trade);
    return trade;
  }

  function checkPositions(price, ts) {
    const triggered = [];
    // Check TP/SL for all open positions (iterate backwards for safe splice)
    for (let i = positions.length - 1; i >= 0; i--) {
      const pos = positions[i];
      if (pos.sl) {
        const slHit = pos.side === 'long' ? price <= pos.sl : price >= pos.sl;
        if (slHit) { triggered.push(closePosition(pos.id, pos.sl, ts, 'stop_loss')); continue; }
      }
      if (pos.tp) {
        const tpHit = pos.side === 'long' ? price >= pos.tp : price <= pos.tp;
        if (tpHit) { triggered.push(closePosition(pos.id, pos.tp, ts, 'take_profit')); continue; }
      }
    }
    return triggered.filter(Boolean);
  }

  function getStats() {
    const wins = closedTrades.filter(t => t.pnl > 0);
    const losses = closedTrades.filter(t => t.pnl <= 0);
    const totalPnl = closedTrades.reduce((s, t) => s + t.pnl, 0);
    const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0;
    const avgLoss = losses.length > 0 ? Math.abs(losses.reduce((s, t) => s + t.pnl, 0) / losses.length) : 0;

    // Sharpe ratio (simplified: daily returns if we had enough data)
    const returns = closedTrades.map(t => t.pnlPct);
    const avgReturn = returns.length > 0 ? returns.reduce((s, r) => s + r, 0) / returns.length : 0;
    const stdDev = returns.length > 1
      ? Math.sqrt(returns.reduce((s, r) => s + (r - avgReturn) ** 2, 0) / (returns.length - 1))
      : 0;
    const sharpe = stdDev > 0 ? avgReturn / stdDev : 0;

    return {
      totalTrades: closedTrades.length,
      wins: wins.length,
      losses: losses.length,
      winRate: closedTrades.length > 0 ? (wins.length / closedTrades.length * 100).toFixed(1) + '%' : 'N/A',
      totalPnl: totalPnl.toFixed(2),
      avgWin: avgWin.toFixed(2),
      avgLoss: avgLoss.toFixed(2),
      profitFactor: avgLoss > 0 ? (avgWin / avgLoss).toFixed(2) : 'Inf',
      maxDrawdown: (maxDrawdown * 100).toFixed(1) + '%',
      finalBalance: balance.toFixed(2),
      returnPct: ((balance - initialBalance) / initialBalance * 100).toFixed(1) + '%',
      sharpeRatio: sharpe.toFixed(2),
      openPositions: positions.length,
    };
  }

  return {
    openPosition, closePosition, checkPositions, getStats,
    get balance() { return balance; },
    get positions() { return [...positions]; },
    get trades() { return [...closedTrades]; },
  };
}
