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
    if (m?.gold) result.gold = m.gold;
    const e = crucix.energy;
    if (e?.wti) result.wti = e.wti;
    if (e?.natgas) result.natgas = e.natgas;
    const a = crucix.acled;
    if (a) result.conflicts = { events: a.totalEvents, fatalities: a.totalFatalities };
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
    if (m?.gold) parts.push(`Gold: $${m.gold}`);
    const e = crucix.energy;
    if (e?.wti) parts.push(`WTI: $${e.wti}`);
    if (e?.natgas) parts.push(`NatGas: $${e.natgas}`);
    const a = crucix.acled;
    if (a) parts.push(`Conflicts: ${a.totalEvents} events, ${a.totalFatalities} fatalities`);
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

  return { fetchCrucix, fetchNews, compactCrucixObj, compactCrucix, compactNews };
}
