import { evaluateConditions } from './conditions.mjs';

function parseJson(value, fallback = {}) {
  try {
    return JSON.parse(value || JSON.stringify(fallback));
  } catch {
    return fallback;
  }
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function deriveSide(targetExposurePct) {
  if (targetExposurePct > 0) return 'long';
  if (targetExposurePct < 0) return 'short';
  return 'flat';
}

export function evaluateTargetPositionDecision({ strategies, features, rules = [], currentExposurePct = 0, activeTarget = null } = {}) {
  const strategyRows = (strategies || []).map((strategy) => ({
    ...strategy,
    entry_conditions: Array.isArray(strategy.entry_conditions) ? strategy.entry_conditions : parseJson(strategy.entry_conditions, []),
    exit_conditions: Array.isArray(strategy.exit_conditions) ? strategy.exit_conditions : parseJson(strategy.exit_conditions, []),
    risk_params: strategy.risk_params || parseJson(strategy.risk_params_json, {}),
    target: strategy.target || parseJson(strategy.target_json, {}),
    execution: strategy.execution || parseJson(strategy.execution_json, {}),
    sizing: strategy.sizing || parseJson(strategy.sizing_json, {}),
  }));

  const evaluations = strategyRows.map((strategy) => {
    const entry = evaluateConditions(strategy.entry_conditions || [], features, 'and');
    const exit = evaluateConditions(strategy.exit_conditions || [], features, 'or');
    return {
      strategy,
      entry,
      exit,
      matched: entry.met && entry.score >= 0.8 && !exit.met,
      priority: strategy.target?.priority || 0,
    };
  });

  const matched = evaluations
    .filter((row) => row.matched)
    .sort((a, b) => (b.priority - a.priority) || ((b.strategy.confidence || 0) - (a.strategy.confidence || 0)));

  const winner = matched[0] || null;
  let targetExposurePct = winner?.strategy.target?.target_exposure_pct || 0;
  let leverageCap = winner?.sizing?.leverage || 1;
  let tpPct = winner?.risk_params?.tp_pct || null;
  let slPct = winner?.risk_params?.sl_pct || null;
  const appliedRules = [];

  for (const rule of rules || []) {
    const payload = rule.param_changes || {};
    const conditions = payload.conditions || [];
    const changes = payload.changes || payload;
    const result = conditions.length ? evaluateConditions(conditions, features, 'and') : { met: true };
    if (!result.met) continue;

    if (typeof changes.target_exposure_pct_scale === 'number') {
      targetExposurePct *= changes.target_exposure_pct_scale;
    }
    if (typeof changes.target_exposure_pct_delta === 'number') {
      targetExposurePct += changes.target_exposure_pct_delta;
    }
    if (typeof changes.leverage_cap === 'number') {
      leverageCap = Math.min(leverageCap || changes.leverage_cap, changes.leverage_cap);
    }
    if (typeof changes.tp_pct === 'number') tpPct = changes.tp_pct;
    if (typeof changes.sl_pct === 'number') slPct = changes.sl_pct;
    appliedRules.push(rule.rule_id);
  }

  targetExposurePct = Number(clamp(targetExposurePct, -100, 100).toFixed(2));
  const strategyId = winner?.strategy.strategy_id || activeTarget?.strategy_id || null;
  const maxHoldMinutes = winner?.strategy.target?.max_hold_minutes || winner?.risk_params?.max_hold_minutes || null;
  const execution = winner?.strategy.execution || activeTarget?.execution || {};
  const side = deriveSide(targetExposurePct);
  const expiresAt = maxHoldMinutes
    ? new Date(Date.now() + maxHoldMinutes * 60000).toISOString()
    : null;

  return {
    strategy_id: strategyId,
    side,
    target_exposure_pct: targetExposurePct,
    current_exposure_pct: Number(currentExposurePct || 0),
    delta_exposure_pct: Number((targetExposurePct - (currentExposurePct || 0)).toFixed(2)),
    execution_style: execution.execution_style || 'ladder',
    execution,
    params: {
      leverage_cap: leverageCap,
      tp_pct: tpPct,
      sl_pct: slPct,
    },
    max_hold_minutes: maxHoldMinutes,
    expires_at: expiresAt,
    reason: winner
      ? `${winner.strategy.name} matched; rules=${appliedRules.join(',') || 'none'}`
      : `No Wei2.0 strategy matched; target flat; rules=${appliedRules.join(',') || 'none'}`,
    matched: matched.map((row) => ({
      strategy_id: row.strategy.strategy_id,
      priority: row.priority,
      entry_score: row.entry.score,
      exit_met: row.exit.met,
    })),
    applied_rules: appliedRules,
    evaluations,
  };
}

