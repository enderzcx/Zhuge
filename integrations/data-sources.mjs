/**
 * Data source fetchers: Crucix OSINT engine + OpenNews API.
 */

export function createDataSources(config) {
  async function fetchCrucix() {
    try {
      const res = await fetch(`${config.CRUCIX}/api/data`, { signal: AbortSignal.timeout(10000) });
      return res.ok ? await res.json() : null;
    } catch { return null; }
  }

  async function fetchNews(limit = 15) {
    if (!config.NEWS_TOKEN) return [];
    try {
      const res = await fetch(`${config.NEWS_API}/open/news_search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.NEWS_TOKEN}` },
        body: JSON.stringify({ limit, min_score: 50 }),
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) return [];
      const data = await res.json();
      return data.data || data || [];
    } catch { return []; }
  }

  function compactCrucixObj(crucix) {
    if (!crucix) return null;
    const result = {};
    const m = crucix.markets;
    if (m?.vix) result.vix = m.vix;
    if (m?.crypto?.BTC) result.btc = m.crypto.BTC;
    if (m?.crypto?.ETH) result.eth = m.crypto.ETH;
    if (m?.sp500) result.sp500 = m.sp500;
    if (m?.qqq) result.qqq = m.qqq;           // Nasdaq 100 tech sentiment
    if (m?.dia) result.dia = m.dia;           // Dow Jones Industrial Average — large-cap/blue-chip
    if (m?.iwm) result.iwm = m.iwm;           // Russell 2000 small-cap — risk appetite leading indicator
    if (m?.gold) result.gold = m.gold;
    // Bonds — risk-on/risk-off leading indicator (falls before stocks when risk-off)
    if (m?.tlt) result.tlt = m.tlt;           // 20Y Treasury: falling = rates rising = risk-off
    if (m?.hyg) result.hyg = m.hyg;           // High-yield bond: falling = credit stress
    if (m?.lqd) result.lqd = m.lqd;           // Investment-grade bond: LQD falling = broader credit stress
    const e = crucix.energy;
    if (e?.wti) result.wti = e.wti;
    if (e?.natgas) result.natgas = e.natgas;
    const a = crucix.acled;
    if (a) result.conflicts = { events: a.totalEvents, fatalities: a.totalFatalities };
    // FRED macro — interest rates, CPI, unemployment (most important macro context)
    const fred = crucix.fred;
    if (fred) result.fred = {
      fed_rate: fred.fedFundsRate || fred.fed_rate,
      cpi: fred.cpi || fred.inflationRate,
      unemployment: fred.unemployment || fred.unemploymentRate,
    };
    // GDELT — geopolitical tension index (0-100, higher = more instability)
    const gdelt = crucix.gdelt;
    if (gdelt?.tension !== undefined) result.geo_tension = gdelt.tension;
    else if (gdelt?.score !== undefined) result.geo_tension = gdelt.score;
    // Chokepoints — energy supply chain risk (Hormuz, Suez, Panama)
    const choke = crucix.chokepoints;
    if (choke?.status) result.chokepoints = choke.status;
    else if (choke?.risk) result.chokepoints = choke.risk;
    // Delta — data velocity (what changed most since last check = what matters most)
    const delta = crucix.delta;
    if (delta?.top) result.delta_top = delta.top;
    else if (delta?.changed) result.delta_top = delta.changed;
    const tg = crucix.tg;
    if (tg?.urgent) result.tg_urgent = tg.urgent;
    return result;
  }

  function compactCrucix(crucix) {
    if (!crucix) return 'Crucix: unavailable';
    const parts = [];
    const m = crucix.markets;
    if (m?.vix) parts.push(`VIX: ${m.vix}`);
    if (m?.crypto?.BTC) parts.push(`BTC: $${m.crypto.BTC}`);
    if (m?.crypto?.ETH) parts.push(`ETH: $${m.crypto.ETH}`);
    if (m?.sp500) parts.push(`S&P500: ${m.sp500}`);
    if (m?.qqq) parts.push(`QQQ: ${m.qqq}`);
    if (m?.dia) parts.push(`DIA: ${m.dia}`);
    if (m?.iwm) parts.push(`IWM: ${m.iwm}`);
    if (m?.gold) parts.push(`Gold: $${m.gold}`);
    if (m?.tlt) parts.push(`TLT: ${m.tlt}`);
    if (m?.hyg) parts.push(`HYG: ${m.hyg}`);
    if (m?.lqd) parts.push(`LQD: ${m.lqd}`);
    const e = crucix.energy;
    if (e?.wti) parts.push(`WTI: $${e.wti}`);
    if (e?.natgas) parts.push(`NatGas: $${e.natgas}`);
    const a = crucix.acled;
    if (a) parts.push(`Conflicts: ${a.totalEvents} events, ${a.totalFatalities} fatalities`);
    const fred = crucix.fred;
    if (fred?.fedFundsRate || fred?.fed_rate) parts.push(`Fed rate: ${fred.fedFundsRate || fred.fed_rate}%`);
    if (fred?.cpi || fred?.inflationRate) parts.push(`CPI: ${fred.cpi || fred.inflationRate}%`);
    const gdelt = crucix.gdelt;
    if (gdelt?.tension !== undefined) parts.push(`Geo tension: ${gdelt.tension}`);
    else if (gdelt?.score !== undefined) parts.push(`Geo tension: ${gdelt.score}`);
    const choke = crucix.chokepoints;
    if (choke?.status) parts.push(`Chokepoints: ${choke.status}`);
    const delta = crucix.delta;
    if (delta?.top) parts.push(`Delta: ${delta.top}`);
    const w = crucix.weather;
    if (w?.alerts) parts.push(`Weather alerts: ${w.alerts}`);
    const tg = crucix.tg;
    if (tg?.urgent) parts.push(`TG urgent: ${tg.urgent}`);
    return parts.join(' | ') || 'Crucix: no data';
  }

  function compactNews(news) {
    if (!news?.length) return 'News: none';
    return news.slice(0, 10).map((n, i) => {
      const score = n.score || n.aiRating?.score || '?';
      const signal = n.signal || n.aiRating?.signal || '?';
      const title = (n.title || n.headline || '').slice(0, 120);
      const src = n.source || '?';
      return `${i + 1}. [${signal}|${score}] ${title} (${src})`;
    }).join('\n');
  }

  async function fetchAllNews(crucix, limit = 15) {
    const openNews = await fetchNews(limit);
    const crucixNews = [];
    if (crucix?.news?.items) crucixNews.push(...crucix.news.items);
    else if (Array.isArray(crucix?.newsFeed)) crucixNews.push(...crucix.newsFeed);
    const seen = new Set();
    const merged = [];
    for (const n of [...openNews, ...crucixNews]) {
      const key = n.link || n.url || n.title || '';
      if (!seen.has(key)) { seen.add(key); merged.push(n); }
    }
    return merged.slice(0, limit * 2);
  }

  return { fetchCrucix, fetchNews, fetchAllNews, compactCrucixObj, compactCrucix, compactNews };
}
