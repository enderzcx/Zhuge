/**
 * Signal scoring engine: historical accuracy tracking + source weight management.
 */

export function createSignalScoring({ db }) {
  const { insertSignalScore } = db;

  function findCandlePrice(pair, isoTime) {
    const row = db.prepare('SELECT close FROM candles WHERE pair = ? AND ts_start <= ? ORDER BY ts_start DESC LIMIT 1').get(pair, isoTime);
    return row?.close || null;
  }

  function isActionCorrect(action, priceBefore, priceAfter) {
    if (!priceBefore || !priceAfter) return null;
    const change = (priceAfter - priceBefore) / priceBefore;
    if (action === 'strong_buy' || action === 'increase_exposure') return change > 0 ? 1 : 0;
    if (action === 'strong_sell' || action === 'reduce_exposure') return change < 0 ? 1 : 0;
    if (action === 'hold') return Math.abs(change) < 0.01 ? 1 : 0; // <1% = hold was correct
    return null;
  }

  function scoreHistoricalSignals() {
    // Score crypto analyses older than 4h that haven't been scored yet
    const unscored = db.prepare(`
      SELECT id, recommended_action, confidence, created_at
      FROM analysis
      WHERE mode = 'crypto'
        AND id NOT IN (SELECT analysis_id FROM signal_scores)
        AND created_at < datetime('now', '-4 hours')
      ORDER BY created_at DESC
      LIMIT 20
    `).all();

    if (unscored.length === 0) return;

    let scored = 0;
    for (const a of unscored) {
      const ts = new Date(a.created_at).getTime();
      const pair = 'ETH-USDT'; // primary trading pair

      const priceAt = findCandlePrice(pair, a.created_at);
      const price15m = findCandlePrice(pair, new Date(ts + 15 * 60 * 1000).toISOString());
      const price1h = findCandlePrice(pair, new Date(ts + 60 * 60 * 1000).toISOString());
      const price4h = findCandlePrice(pair, new Date(ts + 4 * 60 * 60 * 1000).toISOString());

      if (!priceAt) continue; // No candle data for this period

      const correct15m = isActionCorrect(a.recommended_action, priceAt, price15m);
      const correct1h = isActionCorrect(a.recommended_action, priceAt, price1h);
      const correct4h = isActionCorrect(a.recommended_action, priceAt, price4h);

      try {
        insertSignalScore.run(a.id, a.recommended_action, a.confidence, priceAt, price15m, price1h, price4h, correct15m, correct1h, correct4h);
        scored++;
      } catch {}
    }

    if (scored > 0) console.log(`[SignalScore] Scored ${scored} historical signals`);

    // Expire old lessons
    try {
      db.prepare("UPDATE lessons SET active = 0 WHERE expires_at IS NOT NULL AND expires_at < datetime('now')").run();
    } catch {}
  }

  // --- Source Score Tracking ---

  function updateSourceScores() {
    const period = new Date().toISOString().slice(0, 7); // '2026-03'
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

    // Aggregate signal_scores from last 30 days
    const stats = db.prepare(`
      SELECT COUNT(*) as total,
        SUM(CASE WHEN correct_1h = 1 THEN 1 ELSE 0 END) as correct
      FROM signal_scores WHERE scored_at > ?
    `).get(since);

    if (!stats || stats.total < 5) return; // Need minimum data

    // For now we track aggregate signal accuracy as "analyst_combined"
    // When we add per-source attribution (Phase 4.5+), this becomes per-source
    const sources = [
      { name: 'analyst_combined', total: stats.total, correct: stats.correct },
    ];

    for (const s of sources) {
      const accuracy = s.total > 0 ? s.correct / s.total : 0;
      // Auto-downgrade sources with accuracy < 40%: use raw accuracy as weight (max 0.4)
      // Normal range: 0.5 + accuracy (50% acc → 1.0x, 80% → 1.3x)
      const weight = accuracy < 0.40 ? accuracy : (0.5 + accuracy);
      try {
        db.prepare(`
          INSERT INTO source_scores (source_name, period, total_signals, correct_signals, accuracy, weight, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(source_name, period) DO UPDATE SET
            total_signals = ?, correct_signals = ?, accuracy = ?, weight = ?, updated_at = ?
        `).run(s.name, period, s.total, s.correct, accuracy, weight, new Date().toISOString(),
          s.total, s.correct, accuracy, weight, new Date().toISOString());
      } catch {}
    }
  }

  function getSourceWeights() {
    const period = new Date().toISOString().slice(0, 7);
    const rows = db.prepare('SELECT source_name, accuracy, weight FROM source_scores WHERE period = ?').all(period);
    return rows.length > 0 ? rows : [{ source_name: 'analyst_combined', accuracy: 0, weight: 1.0 }];
  }

  return { scoreHistoricalSignals, updateSourceScores, getSourceWeights };
}
