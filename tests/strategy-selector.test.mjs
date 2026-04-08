import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { createStrategySelector } from '../agent/cognition/strategy-selector.mjs';

function createTestDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE strategy_families (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      family_id TEXT UNIQUE NOT NULL,
      family_name TEXT NOT NULL,
      status TEXT DEFAULT 'active',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE strategy_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      version_id TEXT UNIQUE NOT NULL,
      family_id TEXT NOT NULL,
      version_name TEXT NOT NULL,
      status TEXT DEFAULT 'active',
      is_live INTEGER DEFAULT 0,
      decision_mode TEXT DEFAULT 'trigger',
      rollout_mode TEXT DEFAULT 'live',
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      activated_at TEXT,
      retired_at TEXT
    );

    CREATE TABLE strategy_selector_state (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scope TEXT NOT NULL DEFAULT 'global' UNIQUE,
      selected_family_id TEXT,
      selected_version_id TEXT,
      selection_mode TEXT DEFAULT 'manual',
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE compound_strategies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      strategy_id TEXT UNIQUE NOT NULL,
      family_id TEXT,
      version_id TEXT,
      role TEXT,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      direction TEXT NOT NULL DEFAULT 'long',
      symbols TEXT NOT NULL DEFAULT '[]',
      timeframe TEXT DEFAULT 'any',
      entry_conditions TEXT NOT NULL DEFAULT '[]',
      exit_conditions TEXT NOT NULL DEFAULT '[]',
      sizing_json TEXT NOT NULL DEFAULT '{}',
      risk_params_json TEXT DEFAULT '{}',
      target_json TEXT DEFAULT '{}',
      execution_json TEXT DEFAULT '{}',
      status TEXT DEFAULT 'proposed',
      confidence REAL DEFAULT 0.5,
      evidence_json TEXT DEFAULT '{}',
      source_compound_run INTEGER,
      created_at TEXT DEFAULT (datetime('now')),
      activated_at TEXT,
      retired_at TEXT,
      retired_reason TEXT,
      superseded_by TEXT
    );

    CREATE TABLE compound_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      rule_id TEXT UNIQUE,
      family_id TEXT,
      version_id TEXT,
      scope TEXT DEFAULT 'global',
      description TEXT NOT NULL,
      action TEXT,
      evidence_trade_ids TEXT,
      trade_count INTEGER,
      confidence REAL DEFAULT 0,
      status TEXT DEFAULT 'active',
      param_changes_json TEXT DEFAULT '{}'
    );
  `);
  return db;
}

describe('strategy selector', () => {
  let db;
  let selector;

  beforeEach(() => {
    db = createTestDb();
    selector = createStrategySelector({ db });
  });

  it('returns all active strategies when no selector state exists', () => {
    db.prepare(`
      INSERT INTO compound_strategies
        (strategy_id, family_id, version_id, role, name, description, direction, symbols, entry_conditions, exit_conditions, sizing_json, risk_params_json, status, confidence)
      VALUES
        ('a_one', 'a', 'a1', 'probe', 'A1', 'desc', 'long', '["BTCUSDT"]', '[]', '[]', '{}', '{}', 'active', 0.7),
        ('b_one', 'b', 'b1', 'probe', 'B1', 'desc', 'long', '["ETHUSDT"]', '[]', '[]', '{}', '{}', 'active', 0.8),
        ('c_retired', 'c', 'c1', 'probe', 'C1', 'desc', 'long', '["SOLUSDT"]', '[]', '[]', '{}', '{}', 'retired', 0.9)
    `).run();

    expect(selector.hasSelection()).toBe(false);
    expect(selector.getEligibleStrategyIds()).toEqual(['b_one', 'a_one']);
  });

  it('bootstraps Wei1.0 family, version, strategies, and default selector state', () => {
    selector.bootstrapWei1();

    const state = selector.getSelectionInfo();
    expect(state.state.selected_family_id).toBe('wei');
    expect(state.state.selected_version_id).toBe('wei1_0');
    expect(state.live_version.version_name).toBe('Wei1.0');
    expect(state.eligible_strategy_ids).toEqual([
      'wei1_skill_add_long',
      'wei1_probe_long',
      'wei1_defensive_short',
    ]);

    const rows = db.prepare(
      "SELECT strategy_id, family_id, version_id, role, status FROM compound_strategies WHERE family_id = 'wei' ORDER BY strategy_id"
    ).all();
    expect(rows).toHaveLength(3);
    expect(rows.map(r => r.strategy_id)).toEqual([
      'wei1_defensive_short',
      'wei1_probe_long',
      'wei1_skill_add_long',
    ]);
  });

  it('updates selected version and filters eligible strategies to that version', () => {
    db.prepare(`
      INSERT INTO strategy_families (family_id, family_name, status) VALUES
        ('wei', 'Wei', 'active'),
        ('other', 'Other', 'active')
    `).run();
    db.prepare(`
      INSERT INTO strategy_versions (version_id, family_id, version_name, status, is_live, decision_mode) VALUES
        ('wei1_0', 'wei', 'Wei1.0', 'active', 1, 'trigger'),
        ('other1_0', 'other', 'Other1.0', 'active', 0, 'trigger')
    `).run();
    db.prepare(`
      INSERT INTO compound_strategies
        (strategy_id, family_id, version_id, role, name, description, direction, symbols, entry_conditions, exit_conditions, sizing_json, risk_params_json, status, confidence)
      VALUES
        ('wei_one', 'wei', 'wei1_0', 'probe', 'Wei one', 'desc', 'long', '["BTCUSDT"]', '[]', '[]', '{}', '{}', 'active', 0.7),
        ('other_one', 'other', 'other1_0', 'probe', 'Other one', 'desc', 'long', '["ETHUSDT"]', '[]', '[]', '{}', '{}', 'active', 0.9)
    `).run();

    selector.setSelection({ familyId: 'other', versionId: 'other1_0' });

    expect(selector.hasSelection()).toBe(true);
    expect(selector.getEligibleStrategyIds()).toEqual(['other_one']);
  });

  it('bootstraps Wei1.0 without creating multiple live versions when a selector already exists', () => {
    db.prepare(`
      INSERT INTO strategy_families (family_id, family_name, status) VALUES
        ('other', 'Other', 'active')
    `).run();
    db.prepare(`
      INSERT INTO strategy_versions (version_id, family_id, version_name, status, is_live, decision_mode, activated_at) VALUES
        ('other1_0', 'other', 'Other1.0', 'active', 1, 'trigger', datetime('now'))
    `).run();
    db.prepare(`
      INSERT INTO strategy_selector_state (scope, selected_family_id, selected_version_id, selection_mode, updated_at)
      VALUES ('global', 'other', 'other1_0', 'manual', datetime('now'))
    `).run();

    selector.bootstrapWei1();

    const liveVersions = db.prepare(
      "SELECT version_id FROM strategy_versions WHERE is_live = 1 ORDER BY version_id"
    ).all();
    const state = selector.getSelectionInfo();

    expect(liveVersions).toEqual([{ version_id: 'other1_0' }]);
    expect(state.state.selected_version_id).toBe('other1_0');
    expect(state.live_version.version_id).toBe('other1_0');
  });

  it('bootstraps Wei2.0 and upgrades Wei1.0 selection to target-position mode', () => {
    selector.bootstrapWei1();
    selector.bootstrapWei2();

    const state = selector.getSelectionInfo();
    const version = selector.getSelectedVersion();
    const strategies = selector.getEligibleStrategyIds();
    const rules = selector.getScopedRules();

    expect(state.state.selected_version_id).toBe('wei2_0');
    expect(version.decision_mode).toBe('target_position');
    expect(strategies).toEqual([
      'wei2_skill_add_long',
      'wei2_defensive_short',
      'wei2_probe_long',
    ]);
    expect(rules.some((r) => r.rule_id === 'wei2_reduce_in_compression')).toBe(true);
  });
});
