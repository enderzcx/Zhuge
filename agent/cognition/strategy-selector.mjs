/**
 * Manual strategy selector: pick one family/version globally,
 * then expose the eligible compound strategies for the rest of the system.
 */

const GLOBAL_SCOPE = 'global';

const WEI_FAMILY = {
  family_id: 'wei',
  family_name: 'Wei',
  status: 'active',
};

const WEI_VERSION = {
  version_id: 'wei1_0',
  family_id: 'wei',
  version_name: 'Wei1.0',
  status: 'active',
  is_live: 0,
  decision_mode: 'trigger',
  rollout_mode: 'live',
  notes: 'Default live launch of Wei1.0 BTC strategy family.',
};

const WEI2_VERSION = {
  version_id: 'wei2_0',
  family_id: 'wei',
  version_name: 'Wei2.0',
  status: 'active',
  is_live: 0,
  decision_mode: 'target_position',
  rollout_mode: 'live',
  notes: 'Wei2.0 target-position BTC strategy family with time stops and ladder execution.',
};

const WEI_STRATEGIES = [
  {
    strategy_id: 'wei1_probe_long',
    family_id: 'wei',
    version_id: 'wei1_0',
    role: 'probe',
    name: 'Wei1.0 Probe Long',
    description: 'Wei1.0 probe-style BTC long with small size and low leverage.',
    direction: 'long',
    symbols: ['BTCUSDT'],
    timeframe: 'any',
    entry_conditions: [
      { field: 'trend', operator: 'eq', value: 'bullish', description: 'MA trend is bullish', weight: 1 },
      { field: 'market_structure_trend', operator: 'eq', value: 'bullish', description: 'Market structure is bullish', weight: 1 },
      { field: 'rsi_14', operator: 'between', value: 45, value2: 68, description: 'RSI in strong middle zone', weight: 1 },
      { field: 'adx_trending', operator: 'eq', value: true, description: 'Trend strength confirmed', weight: 1 },
    ],
    exit_conditions: [
      { field: 'trend', operator: 'eq', value: 'bearish', description: 'MA trend turns bearish', weight: 1 },
      { field: 'bos_type', operator: 'eq', value: 'bearish', description: 'Bearish break of structure', weight: 1 },
      { field: 'rsi_14', operator: 'gt', value: 74, description: 'Short-term overheat', weight: 1 },
    ],
    sizing: { margin_usdt: 1.5, leverage: 2 },
    risk_params: { sl_pct: 0.02, tp_pct: 0.05, max_hold_minutes: 2880 },
    target: {},
    execution: {},
    status: 'active',
    confidence: 0.82,
  },
  {
    strategy_id: 'wei1_skill_add_long',
    family_id: 'wei',
    version_id: 'wei1_0',
    role: 'skill',
    name: 'Wei1.0 Skill Add Long',
    description: 'Wei1.0 size-up BTC long after trend and structure confirmation.',
    direction: 'long',
    symbols: ['BTCUSDT'],
    timeframe: 'any',
    entry_conditions: [
      { field: 'trend', operator: 'eq', value: 'bullish', description: 'MA trend is bullish', weight: 1 },
      { field: 'bos_type', operator: 'eq', value: 'bullish', description: 'Bullish break of structure', weight: 1 },
      { field: 'bb_position', operator: 'gt', value: 0.8, description: 'Price near upper Bollinger band', weight: 1 },
      { field: 'rsi_14', operator: 'between', value: 55, value2: 72, description: 'Momentum strong but not overheated', weight: 1 },
    ],
    exit_conditions: [
      { field: 'rsi_14', operator: 'gt', value: 78, description: 'Take profit on overheat', weight: 1 },
      { field: 'trend', operator: 'eq', value: 'bearish', description: 'Trend weakens', weight: 1 },
      { field: 'bos_type', operator: 'eq', value: 'bearish', description: 'Structure falls back to bearish', weight: 1 },
    ],
    sizing: { margin_usdt: 3, leverage: 4 },
    risk_params: { sl_pct: 0.018, tp_pct: 0.07, max_hold_minutes: 1440 },
    target: {},
    execution: {},
    status: 'active',
    confidence: 0.88,
  },
  {
    strategy_id: 'wei1_defensive_short',
    family_id: 'wei',
    version_id: 'wei1_0',
    role: 'defensive',
    name: 'Wei1.0 Defensive Short',
    description: 'Wei1.0 defensive BTC short for weakening trend structure.',
    direction: 'short',
    symbols: ['BTCUSDT'],
    timeframe: 'any',
    entry_conditions: [
      { field: 'trend', operator: 'eq', value: 'bearish', description: 'MA trend is bearish', weight: 1 },
      { field: 'market_structure_trend', operator: 'eq', value: 'bearish', description: 'Market structure is bearish', weight: 1 },
      { field: 'adx_trending', operator: 'eq', value: true, description: 'Trend strength confirmed', weight: 1 },
      { field: 'rsi_14', operator: 'between', value: 32, value2: 55, description: 'RSI in bearish middle zone', weight: 1 },
    ],
    exit_conditions: [
      { field: 'bos_type', operator: 'eq', value: 'bullish', description: 'Bullish structure reversal', weight: 1 },
      { field: 'trend', operator: 'eq', value: 'bullish', description: 'Trend recovers', weight: 1 },
      { field: 'rsi_14', operator: 'lt', value: 25, description: 'Oversold compression', weight: 1 },
    ],
    sizing: { margin_usdt: 2, leverage: 3 },
    risk_params: { sl_pct: 0.02, tp_pct: 0.06, max_hold_minutes: 2160 },
    target: {},
    execution: {},
    status: 'active',
    confidence: 0.8,
  },
];

const WEI2_EXECUTION = {
  execution_style: 'ladder',
  rung_count: 3,
  size_curve: [0.3, 0.3, 0.4],
  spacing_mode: 'atr_or_bb',
  spacing_multipliers: [0.25, 0.5, 0.9],
  reprice_threshold_bps: 25,
  force_flat_grace_minutes: 15,
};

const WEI2_STRATEGIES = [
  {
    strategy_id: 'wei2_probe_long',
    family_id: 'wei',
    version_id: 'wei2_0',
    role: 'probe',
    name: 'Wei2.0 Probe Long',
    description: 'Wei2.0 base BTC target exposure during confirmed bullish regime.',
    direction: 'long',
    symbols: ['BTCUSDT'],
    timeframe: '1H',
    entry_conditions: [
      { field: 'regime', operator: 'eq', value: 'bullish', description: 'Regime is bullish', weight: 1 },
      { field: 'days_in_regime', operator: 'gte', value: 0.25, description: 'Bullish regime persisted at least 6h', weight: 1 },
      { field: 'overhead_supply_score_90d', operator: 'lt', value: 65, description: 'Overhead supply manageable', weight: 1 },
      { field: 'bars_since_breakdown', operator: 'gt', value: 12, description: 'No recent bearish breakdown', weight: 1 },
    ],
    exit_conditions: [
      { field: 'regime', operator: 'eq', value: 'bearish', description: 'Regime turns bearish', weight: 1 },
      { field: 'overhead_supply_score_90d', operator: 'gt', value: 85, description: 'Overhead supply extreme', weight: 1 },
    ],
    sizing: { leverage: 2 },
    risk_params: { sl_pct: 0.018, tp_pct: 0.05, max_hold_minutes: 2880 },
    target: { target_exposure_pct: 15, priority: 1, max_hold_minutes: 2880 },
    execution: WEI2_EXECUTION,
    status: 'active',
    confidence: 0.84,
  },
  {
    strategy_id: 'wei2_skill_add_long',
    family_id: 'wei',
    version_id: 'wei2_0',
    role: 'skill',
    name: 'Wei2.0 Skill Add Long',
    description: 'Wei2.0 higher BTC target exposure after bullish breakout confirmation.',
    direction: 'long',
    symbols: ['BTCUSDT'],
    timeframe: '1H',
    entry_conditions: [
      { field: 'regime', operator: 'eq', value: 'bullish', description: 'Regime is bullish', weight: 1 },
      { field: 'bars_since_breakout', operator: 'lte', value: 6, description: 'Recent bullish breakout', weight: 1 },
      { field: 'oi_zscore_30d', operator: 'gt', value: 0.2, description: 'Open interest expanding', weight: 1 },
      { field: 'funding_zscore_30d', operator: 'lt', value: 1.5, description: 'Funding not too crowded', weight: 1 },
    ],
    exit_conditions: [
      { field: 'regime', operator: 'eq', value: 'mixed', description: 'Regime loses alignment', weight: 1 },
      { field: 'funding_zscore_30d', operator: 'gt', value: 2.5, description: 'Funding too crowded', weight: 1 },
    ],
    sizing: { leverage: 4 },
    risk_params: { sl_pct: 0.016, tp_pct: 0.07, max_hold_minutes: 1440 },
    target: { target_exposure_pct: 45, priority: 2, max_hold_minutes: 1440 },
    execution: WEI2_EXECUTION,
    status: 'active',
    confidence: 0.9,
  },
  {
    strategy_id: 'wei2_defensive_short',
    family_id: 'wei',
    version_id: 'wei2_0',
    role: 'defensive',
    name: 'Wei2.0 Defensive Short',
    description: 'Wei2.0 defensive BTC short target when regime breaks bearish.',
    direction: 'short',
    symbols: ['BTCUSDT'],
    timeframe: '1H',
    entry_conditions: [
      { field: 'regime', operator: 'eq', value: 'bearish', description: 'Regime is bearish', weight: 1 },
      { field: 'bars_since_breakdown', operator: 'lte', value: 6, description: 'Recent bearish breakdown', weight: 1 },
      { field: 'oi_zscore_30d', operator: 'gt', value: 0.1, description: 'Open interest confirms move', weight: 1 },
      { field: 'days_below_ma_20', operator: 'gte', value: 0.2, description: 'Price stayed below MA20', weight: 1 },
    ],
    exit_conditions: [
      { field: 'regime', operator: 'eq', value: 'bullish', description: 'Regime flips bullish', weight: 1 },
      { field: 'bars_since_breakout', operator: 'lte', value: 3, description: 'Fresh bullish breakout', weight: 1 },
    ],
    sizing: { leverage: 3 },
    risk_params: { sl_pct: 0.02, tp_pct: 0.06, max_hold_minutes: 2160 },
    target: { target_exposure_pct: -20, priority: 3, max_hold_minutes: 2160 },
    execution: WEI2_EXECUTION,
    status: 'active',
    confidence: 0.86,
  },
];

const WEI2_RULES = [
  {
    rule_id: 'wei2_reduce_in_compression',
    family_id: 'wei',
    version_id: 'wei2_0',
    scope: 'version',
    description: 'Reduce Wei2.0 target and leverage when BTC enters compression.',
    action: 'adjust_target',
    trade_count: 0,
    confidence: 0.71,
    status: 'active',
    param_changes: {
      conditions: [
        { field: 'bb_width', operator: 'lt', value: 0.05, description: 'BB width compressed', weight: 1 },
        { field: 'adx', operator: 'lt', value: 20, description: 'ADX weak', weight: 1 },
      ],
      changes: {
        target_exposure_pct_scale: 0.6,
        leverage_cap: 2,
      },
    },
  },
  {
    rule_id: 'wei2_size_up_after_break',
    family_id: 'wei',
    version_id: 'wei2_0',
    scope: 'version',
    description: 'Allow slightly larger Wei2.0 target after aligned bullish structure break.',
    action: 'adjust_target',
    trade_count: 0,
    confidence: 0.75,
    status: 'active',
    param_changes: {
      conditions: [
        { field: 'regime', operator: 'eq', value: 'bullish', description: 'Bullish regime', weight: 1 },
        { field: 'bars_since_breakout', operator: 'lte', value: 4, description: 'Recent breakout', weight: 1 },
      ],
      changes: {
        target_exposure_pct_delta: 10,
        leverage_cap: 5,
      },
    },
  },
  {
    rule_id: 'wei2_reduce_when_overheated',
    family_id: 'wei',
    version_id: 'wei2_0',
    scope: 'version',
    description: 'Trim Wei2.0 long target when funding and overhead supply are overheated.',
    action: 'adjust_target',
    trade_count: 0,
    confidence: 0.73,
    status: 'active',
    param_changes: {
      conditions: [
        { field: 'funding_zscore_30d', operator: 'gt', value: 1.8, description: 'Funding elevated', weight: 1 },
        { field: 'overhead_supply_score_90d', operator: 'gt', value: 75, description: 'Overhead supply heavy', weight: 1 },
      ],
      changes: {
        target_exposure_pct_delta: -10,
        tp_pct: 0.04,
      },
    },
  },
];

function parseParamChanges(value) {
  try {
    return JSON.parse(value || '{}');
  } catch {
    return {};
  }
}

export function createStrategySelector({ db, log } = {}) {
  const _log = log || { info() {}, warn() {}, error() {} };

  function _getState(scope = GLOBAL_SCOPE) {
    return db.prepare(
      'SELECT scope, selected_family_id, selected_version_id, selection_mode, updated_at FROM strategy_selector_state WHERE scope = ?'
    ).get(scope) || null;
  }

  function getSelectedVersion(scope = GLOBAL_SCOPE) {
    const state = _getState(scope);
    if (!state?.selected_family_id || !state?.selected_version_id) return null;
    return db.prepare(`
      SELECT sv.version_id, sv.family_id, sv.version_name, sv.status, sv.is_live, sv.decision_mode, sv.rollout_mode,
             sf.family_name, sf.status AS family_status
      FROM strategy_versions sv
      JOIN strategy_families sf ON sf.family_id = sv.family_id
      WHERE sv.version_id = ? AND sv.family_id = ?
    `).get(state.selected_version_id, state.selected_family_id) || null;
  }

  function getEligibleStrategies(scope = GLOBAL_SCOPE) {
    const selectedVersion = getSelectedVersion(scope);
    if (selectedVersion?.family_id && selectedVersion?.version_id) {
      return db.prepare(`
        SELECT * FROM compound_strategies
        WHERE status = 'active' AND family_id = ? AND version_id = ?
        ORDER BY confidence DESC, strategy_id ASC
      `).all(selectedVersion.family_id, selectedVersion.version_id);
    }
    return db.prepare(
      "SELECT * FROM compound_strategies WHERE status = 'active' ORDER BY confidence DESC, strategy_id ASC"
    ).all();
  }

  function getEligibleStrategyIds(scope = GLOBAL_SCOPE) {
    return getEligibleStrategies(scope).map((s) => s.strategy_id);
  }

  function hasSelection(scope = GLOBAL_SCOPE) {
    return !!getSelectedVersion(scope);
  }

  function setSelection({ familyId, versionId, selectionMode = 'manual', scope = GLOBAL_SCOPE }) {
    const version = db.prepare(
      'SELECT version_id, family_id FROM strategy_versions WHERE version_id = ?'
    ).get(versionId);
    if (!version) throw new Error(`Unknown strategy version: ${versionId}`);
    if (version.family_id !== familyId) {
      throw new Error(`Version ${versionId} does not belong to family ${familyId}`);
    }
    const versionState = db.prepare(
      'SELECT status FROM strategy_versions WHERE version_id = ?'
    ).get(versionId);
    if (versionState?.status !== 'active') {
      throw new Error(`Version ${versionId} is not active`);
    }

    db.prepare('UPDATE strategy_versions SET is_live = 0 WHERE is_live = 1').run();
    db.prepare(
      "UPDATE strategy_versions SET is_live = 1, activated_at = COALESCE(activated_at, datetime('now')) WHERE version_id = ?"
    ).run(versionId);

    db.prepare(`
      INSERT INTO strategy_selector_state (scope, selected_family_id, selected_version_id, selection_mode, updated_at)
      VALUES (?, ?, ?, ?, datetime('now'))
      ON CONFLICT(scope) DO UPDATE SET
        selected_family_id = excluded.selected_family_id,
        selected_version_id = excluded.selected_version_id,
        selection_mode = excluded.selection_mode,
        updated_at = excluded.updated_at
    `).run(scope, familyId, versionId, selectionMode);

    _log.info('strategy_selector_updated', {
      module: 'strategy_selector',
      scope,
      family_id: familyId,
      version_id: versionId,
      selection_mode: selectionMode,
    });

    return getSelectionInfo(scope);
  }

  function getSelectionInfo(scope = GLOBAL_SCOPE) {
    const state = _getState(scope);
    const selectedVersion = getSelectedVersion(scope);
    const liveVersion = selectedVersion || db.prepare(`
      SELECT sv.version_id, sv.family_id, sv.version_name, sv.status, sv.is_live, sv.decision_mode, sv.rollout_mode,
             sf.family_name
      FROM strategy_versions sv
      JOIN strategy_families sf ON sf.family_id = sv.family_id
      WHERE sv.is_live = 1
      ORDER BY sv.created_at DESC
      LIMIT 1
    `).get() || null;

    return {
      scope,
      state,
      live_version: liveVersion,
      eligible_strategy_ids: getEligibleStrategyIds(scope),
    };
  }

  function listFamilies() {
    const rows = db.prepare(`
      SELECT sf.family_id, sf.family_name, sf.status AS family_status,
             sv.version_id, sv.version_name, sv.status AS version_status,
             sv.is_live, sv.decision_mode, sv.rollout_mode, sv.activated_at, sv.retired_at,
             COUNT(cs.id) AS strategy_count
      FROM strategy_families sf
      LEFT JOIN strategy_versions sv ON sv.family_id = sf.family_id
      LEFT JOIN compound_strategies cs
        ON cs.family_id = sv.family_id AND cs.version_id = sv.version_id
      GROUP BY sf.family_id, sf.family_name, sf.status,
               sv.version_id, sv.version_name, sv.status, sv.is_live, sv.decision_mode, sv.rollout_mode, sv.activated_at, sv.retired_at
      ORDER BY sf.family_id ASC, sv.created_at DESC
    `).all();

    const grouped = [];
    const byFamily = new Map();
    for (const row of rows) {
      if (!byFamily.has(row.family_id)) {
        const family = {
          family_id: row.family_id,
          family_name: row.family_name,
          status: row.family_status,
          versions: [],
        };
        grouped.push(family);
        byFamily.set(row.family_id, family);
      }
      if (row.version_id) {
        byFamily.get(row.family_id).versions.push({
          version_id: row.version_id,
          version_name: row.version_name,
          status: row.version_status,
          is_live: !!row.is_live,
          decision_mode: row.decision_mode || 'trigger',
          rollout_mode: row.rollout_mode,
          activated_at: row.activated_at,
          retired_at: row.retired_at,
          strategy_count: row.strategy_count,
        });
      }
    }
    return grouped;
  }

  function getScopedRules(scope = GLOBAL_SCOPE) {
    const selectedVersion = getSelectedVersion(scope);
    if (!selectedVersion) {
      return db.prepare("SELECT * FROM compound_rules WHERE status = 'active' AND COALESCE(scope, 'global') = 'global' ORDER BY confidence DESC").all()
        .map((row) => ({ ...row, param_changes: parseParamChanges(row.param_changes_json) }));
    }
    return db.prepare(`
      SELECT * FROM compound_rules
      WHERE status = 'active'
        AND (
          COALESCE(scope, 'global') = 'global'
          OR (family_id = ? AND version_id = ?)
        )
      ORDER BY confidence DESC
    `).all(selectedVersion.family_id, selectedVersion.version_id)
      .map((row) => ({ ...row, param_changes: parseParamChanges(row.param_changes_json) }));
  }

  function _insertVersion(version) {
    db.prepare(`
      INSERT OR IGNORE INTO strategy_versions
        (version_id, family_id, version_name, status, is_live, decision_mode, rollout_mode, notes, created_at, activated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    `).run(
      version.version_id,
      version.family_id,
      version.version_name,
      version.status,
      version.is_live,
      version.decision_mode,
      version.rollout_mode,
      version.notes,
    );
  }

  function _insertStrategies(strategies) {
    const insertStrategy = db.prepare(`
      INSERT OR IGNORE INTO compound_strategies
        (strategy_id, family_id, version_id, role, name, description, direction, symbols, timeframe,
         entry_conditions, exit_conditions, sizing_json, risk_params_json, target_json, execution_json,
         status, confidence, evidence_json, activated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', datetime('now'))
    `);
    for (const strategy of strategies) {
      insertStrategy.run(
        strategy.strategy_id,
        strategy.family_id,
        strategy.version_id,
        strategy.role,
        strategy.name,
        strategy.description,
        strategy.direction,
        JSON.stringify(strategy.symbols),
        strategy.timeframe,
        JSON.stringify(strategy.entry_conditions),
        JSON.stringify(strategy.exit_conditions),
        JSON.stringify(strategy.sizing),
        JSON.stringify(strategy.risk_params),
        JSON.stringify(strategy.target || {}),
        JSON.stringify(strategy.execution || {}),
        strategy.status,
        strategy.confidence,
      );
    }
  }

  function bootstrapWei1() {
    db.prepare(`
      INSERT OR IGNORE INTO strategy_families (family_id, family_name, status, created_at, updated_at)
      VALUES (?, ?, ?, datetime('now'), datetime('now'))
    `).run(WEI_FAMILY.family_id, WEI_FAMILY.family_name, WEI_FAMILY.status);
    _insertVersion(WEI_VERSION);
    _insertStrategies(WEI_STRATEGIES);

    if (!_getState(GLOBAL_SCOPE)) {
      setSelection({
        familyId: WEI_FAMILY.family_id,
        versionId: WEI_VERSION.version_id,
        selectionMode: 'manual',
        scope: GLOBAL_SCOPE,
      });
    }

    _log.info('strategy_selector_bootstrap', {
      module: 'strategy_selector',
      family_id: WEI_FAMILY.family_id,
      version_id: WEI_VERSION.version_id,
      strategies: WEI_STRATEGIES.length,
    });
  }

  function bootstrapWei2() {
    db.prepare(`
      INSERT OR IGNORE INTO strategy_families (family_id, family_name, status, created_at, updated_at)
      VALUES (?, ?, ?, datetime('now'), datetime('now'))
    `).run(WEI_FAMILY.family_id, WEI_FAMILY.family_name, WEI_FAMILY.status);

    _insertVersion(WEI2_VERSION);
    _insertStrategies(WEI2_STRATEGIES);

    const insertRule = db.prepare(`
      INSERT INTO compound_rules
        (rule_id, family_id, version_id, scope, description, action, evidence_trade_ids, trade_count, confidence, status, param_changes_json)
      VALUES (?, ?, ?, ?, ?, ?, '', ?, ?, ?, ?)
      ON CONFLICT(rule_id) DO UPDATE SET
        family_id = excluded.family_id,
        version_id = excluded.version_id,
        scope = excluded.scope,
        description = excluded.description,
        action = excluded.action,
        trade_count = excluded.trade_count,
        confidence = excluded.confidence,
        status = excluded.status,
        param_changes_json = excluded.param_changes_json
    `);

    for (const rule of WEI2_RULES) {
      insertRule.run(
        rule.rule_id,
        rule.family_id,
        rule.version_id,
        rule.scope,
        rule.description,
        rule.action,
        rule.trade_count,
        rule.confidence,
        rule.status,
        JSON.stringify(rule.param_changes),
      );
    }

    const state = _getState(GLOBAL_SCOPE);
    if (!state) {
      setSelection({
        familyId: WEI2_VERSION.family_id,
        versionId: WEI2_VERSION.version_id,
        selectionMode: 'manual',
        scope: GLOBAL_SCOPE,
      });
    } else if (state.selected_family_id === 'wei' && state.selected_version_id === 'wei1_0') {
      setSelection({
        familyId: WEI2_VERSION.family_id,
        versionId: WEI2_VERSION.version_id,
        selectionMode: state.selection_mode || 'manual',
        scope: GLOBAL_SCOPE,
      });
    }

    _log.info('strategy_selector_bootstrap_wei2', {
      module: 'strategy_selector',
      family_id: WEI2_VERSION.family_id,
      version_id: WEI2_VERSION.version_id,
      strategies: WEI2_STRATEGIES.length,
      rules: WEI2_RULES.length,
    });
  }

  return {
    GLOBAL_SCOPE,
    bootstrapWei1,
    bootstrapWei2,
    hasSelection,
    getEligibleStrategies,
    getEligibleStrategyIds,
    getSelectedVersion,
    getSelectionInfo,
    getScopedRules,
    listFamilies,
    setSelection,
  };
}
