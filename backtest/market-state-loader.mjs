const BITGET_BASE = 'https://api.bitget.com';

function floorTs(ts, timeframe) {
  const minuteMap = { '1H': 3600000, '4H': 14400000, '1D': 86400000, '15m': 900000, '5m': 300000 };
  const step = minuteMap[timeframe] || 3600000;
  return Math.floor(ts / step) * step;
}

async function fetchJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function loadMarketStateHistory(db, symbol, timeframe, startTs, endTs, log) {
  const _log = log || { info() {}, warn() {} };
  const rows = [];
  const source = 'bitget';

  try {
    const fundingUrl = `${BITGET_BASE}/api/v2/mix/market/history-fund-rate?symbol=${symbol}&productType=USDT-FUTURES&pageSize=100`;
    const fundingJson = await fetchJson(fundingUrl);
    const fundingRows = fundingJson?.data || fundingJson?.list || [];
    for (const row of fundingRows) {
      const rawTs = Number(row.fundingTime || row.ts || row.time || 0);
      const ts = floorTs(rawTs, timeframe);
      if (!ts || ts < startTs || ts > endTs) continue;
      rows.push({
        pair: symbol,
        timeframe,
        ts,
        funding_rate: Number(row.fundingRate || row.rate || 0),
        source,
      });
    }
  } catch (err) {
    _log.warn('market_state_funding_load_failed', { symbol, error: err.message });
  }

  if (rows.length) {
    const upsert = db.prepare(`
      INSERT INTO market_state_history (pair, timeframe, ts, mark_price, index_price, open_interest, funding_rate, basis_bps, oi_change_24h, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(pair, timeframe, ts) DO UPDATE SET
        mark_price = COALESCE(excluded.mark_price, market_state_history.mark_price),
        index_price = COALESCE(excluded.index_price, market_state_history.index_price),
        open_interest = COALESCE(excluded.open_interest, market_state_history.open_interest),
        funding_rate = COALESCE(excluded.funding_rate, market_state_history.funding_rate),
        basis_bps = COALESCE(excluded.basis_bps, market_state_history.basis_bps),
        oi_change_24h = COALESCE(excluded.oi_change_24h, market_state_history.oi_change_24h),
        source = excluded.source
    `);
    const tx = db.transaction((items) => {
      for (const row of items) {
        upsert.run(
          row.pair,
          row.timeframe,
          row.ts,
          row.mark_price ?? null,
          row.index_price ?? null,
          row.open_interest ?? null,
          row.funding_rate ?? null,
          row.basis_bps ?? null,
          row.oi_change_24h ?? null,
          row.source || source
        );
      }
    });
    tx(rows);
  }

  return { loaded: rows.length };
}

export async function fetchCurrentMarketState({ db, bitgetClient, symbol, timeframe = '1H', log } = {}) {
  const _log = log || { info() {}, warn() {} };
  const ts = floorTs(Date.now(), timeframe);
  let ticker = {};
  let fundingRate = null;
  let openInterest = null;
  try {
    ticker = await bitgetClient.bitgetRequest('GET', `/api/v2/mix/market/ticker?symbol=${symbol}&productType=USDT-FUTURES`);
    ticker = Array.isArray(ticker) ? ticker[0] : ticker;
  } catch (err) {
    _log.warn('market_state_ticker_failed', { symbol, error: err.message });
  }
  try {
    const oi = await bitgetClient.bitgetRequest('GET', `/api/v2/mix/market/open-interest?symbol=${symbol}&productType=USDT-FUTURES`);
    const payload = Array.isArray(oi) ? oi[0] : oi;
    openInterest = Number(payload?.openInterest || payload?.amount || 0);
  } catch (err) {
    _log.warn('market_state_oi_failed', { symbol, error: err.message });
  }
  try {
    const funding = await bitgetClient.bitgetRequest('GET', `/api/v2/mix/market/current-fund-rate?symbol=${symbol}&productType=USDT-FUTURES`);
    const payload = Array.isArray(funding) ? funding[0] : funding;
    fundingRate = Number(payload?.fundingRate || payload?.rate || 0);
  } catch (err) {
    _log.warn('market_state_current_funding_failed', { symbol, error: err.message });
  }

  const markPrice = Number(ticker?.markPrice || ticker?.markPr || ticker?.lastPr || 0);
  const indexPrice = Number(ticker?.indexPrice || ticker?.indexPr || ticker?.lastPr || 0);
  const basisBps = indexPrice > 0 ? Number((((markPrice - indexPrice) / indexPrice) * 10000).toFixed(2)) : 0;
  const prev = db.prepare(
    'SELECT open_interest FROM market_state_history WHERE pair = ? AND timeframe = ? ORDER BY ts DESC LIMIT 24'
  ).all(symbol, timeframe);
  const oldOi = Number(prev[prev.length - 1]?.open_interest || 0);
  const oiChange24h = oldOi > 0 && openInterest ? Number((((openInterest - oldOi) / oldOi) * 100).toFixed(2)) : 0;

  db.prepare(`
    INSERT INTO market_state_history (pair, timeframe, ts, mark_price, index_price, open_interest, funding_rate, basis_bps, oi_change_24h, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'bitget_live')
    ON CONFLICT(pair, timeframe, ts) DO UPDATE SET
      mark_price = excluded.mark_price,
      index_price = excluded.index_price,
      open_interest = excluded.open_interest,
      funding_rate = excluded.funding_rate,
      basis_bps = excluded.basis_bps,
      oi_change_24h = excluded.oi_change_24h,
      source = excluded.source
  `).run(symbol, timeframe, ts, markPrice || null, indexPrice || null, openInterest || null, fundingRate || null, basisBps, oiChange24h);

  return {
    pair: symbol,
    timeframe,
    ts,
    mark_price: markPrice || 0,
    index_price: indexPrice || 0,
    open_interest: openInterest || 0,
    funding_rate: fundingRate || 0,
    basis_bps: basisBps || 0,
    oi_change_24h: oiChange24h || 0,
    source: 'bitget_live',
  };
}
