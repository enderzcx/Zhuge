/**
 * Trade tools — Bitget CEX operations via TG agent.
 *   positions, balance, open_trade, close_trade, pause_trading, resume_trading
 */

export function createTradeTools({ bitgetClient, bitgetExec, db, config }) {
  const { bitgetRequest } = bitgetClient;

  const TOOL_DEFS = [
    {
      name: 'positions',
      description: '当前 Bitget 持仓 + 未实现 PnL',
      parameters: { type: 'object', properties: {}, required: [] },
      requiresConfirmation: false,
    },
    {
      name: 'balance',
      description: 'Bitget 账户余额 + 可用保证金',
      parameters: { type: 'object', properties: {}, required: [] },
      requiresConfirmation: false,
    },
    {
      name: 'open_trade',
      description: '开仓 (需要用户确认)',
      parameters: {
        type: 'object',
        properties: {
          symbol: { type: 'string', description: '交易对 (如 ETHUSDT)' },
          side: { type: 'string', enum: ['buy', 'sell'], description: '方向' },
          size: { type: 'number', description: 'USDT 保证金金额' },
          leverage: { type: 'number', description: '杠杆倍数 (默认10)' },
        },
        required: ['symbol', 'side'],
      },
      requiresConfirmation: true,
      isDestructive: true,
    },
    {
      name: 'close_trade',
      description: '平仓 (需要用户确认)',
      parameters: {
        type: 'object',
        properties: {
          symbol: { type: 'string', description: '交易对' },
          side: { type: 'string', description: '持仓方向 (平仓方向相反)' },
        },
        required: ['symbol'],
      },
      requiresConfirmation: true,
      isDestructive: true,
    },
    {
      name: 'pause_trading',
      description: '暂停自动交易 (pipeline 继续分析但不开仓)',
      parameters: { type: 'object', properties: {}, required: [] },
      requiresConfirmation: true,
    },
    {
      name: 'resume_trading',
      description: '恢复自动交易',
      parameters: { type: 'object', properties: {}, required: [] },
      requiresConfirmation: true,
    },
  ];

  // Trading pause state
  let _paused = false;

  const EXECUTORS = {
    async positions() {
      try {
        const res = await bitgetRequest('GET', '/api/v2/mix/position/all-position', {
          productType: 'USDT-FUTURES',
        });
        const positions = res?.data || [];
        if (positions.length === 0) return '当前无持仓';
        return positions.map(p => {
          const pnl = parseFloat(p.unrealizedPL || 0);
          const margin = parseFloat(p.margin || 0);
          const pnlPct = margin > 0 ? ((pnl / margin) * 100).toFixed(1) : '0';
          return `${p.symbol} ${p.holdSide} ${p.leverage}x | 数量:${p.total} | 均价:${p.averageOpenPrice} | 未实现PnL:${pnl.toFixed(2)} USDT (${pnlPct}%) | 保证金:${margin.toFixed(2)}`;
        }).join('\n');
      } catch (err) {
        return `Error: ${err.message}`;
      }
    },

    async balance() {
      try {
        const res = await bitgetRequest('GET', '/api/v2/mix/account/accounts', {
          productType: 'USDT-FUTURES',
        });
        const accounts = res?.data || [];
        if (accounts.length === 0) return 'No account data';
        const a = accounts[0];
        return [
          `总权益: ${parseFloat(a.usdtEquity || 0).toFixed(2)} USDT`,
          `可用: ${parseFloat(a.crossedMaxAvailable || a.available || 0).toFixed(2)} USDT`,
          `已用保证金: ${parseFloat(a.crossedUsed || a.locked || 0).toFixed(2)} USDT`,
          `未实现PnL: ${parseFloat(a.unrealizedPL || 0).toFixed(2)} USDT`,
        ].join('\n');
      } catch (err) {
        return `Error: ${err.message}`;
      }
    },

    async open_trade({ symbol, side, size, leverage }) {
      if (_paused) return 'Error: 自动交易已暂停，请先 resume_trading';
      if (!symbol || !side) return 'Error: symbol and side are required';
      const margin = size || config.MOMENTUM?.margin_per_trade || 2.5;
      const lev = leverage || config.MOMENTUM?.leverage || 10;

      try {
        // This is a simplified version — full logic in bitget/executor.mjs
        const holdSide = side === 'buy' ? 'long' : 'short';
        const result = await bitgetExec.executeBitgetTrade({
          recommended_action: side === 'buy' ? 'strong_buy' : 'strong_sell',
          symbol: symbol.replace('USDT', ''),
          confidence: 80,
        }, `tg_manual_${Date.now()}`);
        return result ? JSON.stringify(result) : `已提交 ${symbol} ${holdSide} ${lev}x 开仓请求`;
      } catch (err) {
        return `Error: ${err.message}`;
      }
    },

    async close_trade({ symbol, side }) {
      if (!symbol) return 'Error: symbol is required';
      try {
        // Find active position
        const res = await bitgetRequest('GET', '/api/v2/mix/position/all-position', {
          productType: 'USDT-FUTURES',
        });
        const pos = (res?.data || []).find(p =>
          p.symbol?.includes(symbol.replace('USDT', ''))
        );
        if (!pos) return `没有找到 ${symbol} 的持仓`;

        // Flash close
        const closeRes = await bitgetRequest('POST', '/api/v2/mix/order/close-positions', {
          productType: 'USDT-FUTURES',
          symbol: pos.symbol,
          holdSide: pos.holdSide,
        });
        const pnl = parseFloat(pos.unrealizedPL || 0);
        return `已平仓 ${pos.symbol} ${pos.holdSide} | PnL: ${pnl.toFixed(2)} USDT`;
      } catch (err) {
        return `Error: ${err.message}`;
      }
    },

    async pause_trading() {
      _paused = true;
      return '自动交易已暂停。分析仍在继续，但不会开新仓。';
    },

    async resume_trading() {
      _paused = false;
      return '自动交易已恢复。';
    },
  };

  return { TOOL_DEFS, EXECUTORS, isPaused: () => _paused };
}
