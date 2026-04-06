/**
 * System prompt loader — assembles static + dynamic parts.
 *
 * Static (cacheable): base.md + safety.md
 * Dynamic (per-call): compound rules + owner directives + current state
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const PROMPTS_DIR = 'agent/prompts';
const MEMORY_DIR = 'agent/memory';

export function createPromptLoader({ db, pushEngine, dataSources }) {
  // Cache static prompts (read once)
  let _staticCache = null;

  function _loadStatic() {
    if (_staticCache) return _staticCache;
    const load = (f) => {
      const p = join(PROMPTS_DIR, f);
      return existsSync(p) ? readFileSync(p, 'utf-8') : '';
    };
    _staticCache = [load('base.md'), load('safety.md')].filter(Boolean).join('\n\n---\n\n');
    return _staticCache;
  }

  /**
   * Load owner directives from memory file.
   * Returns { directives, isEmpty } so buildSystemPrompt can inject bootstrap when needed.
   */
  function _loadDirectives() {
    const p = join(MEMORY_DIR, 'owner_directives.md');
    if (!existsSync(p)) return { directives: '', isEmpty: true };
    try {
      const content = readFileSync(p, 'utf-8').trim();
      if (!content) return { directives: '', isEmpty: true };
      // Strip headings + template placeholder, check if anything real remains
      const stripped = content.replace(/^#.*$/gm, '').replace(/^.*待用户设定.*$/gm, '').trim();
      const hasEntries = stripped.length > 0;
      return {
        directives: hasEntries ? `\n\n## 老板指令 (最高优先级)\n${content}` : '',
        isEmpty: !hasEntries,
      };
    } catch { return { directives: '', isEmpty: true }; }
  }

  /**
   * Load active compound rules from DB.
   */
  function _loadCompoundRules() {
    try {
      const rules = db.prepare(
        "SELECT description, action, confidence, trade_count FROM compound_rules WHERE status = 'active' ORDER BY confidence DESC LIMIT 10"
      ).all();
      if (rules.length === 0) return '';

      const lines = rules.map(r => {
        const icon = r.action === 'avoid' ? '!' : r.action === 'prefer' ? '+' : '~';
        return `${icon} ${r.description} (${r.trade_count} trades, conf:${(r.confidence * 100).toFixed(0)}%)`;
      });
      return `\n\n## 你的交易认知 (AI 自主复盘产出, 非人工编写)\n${lines.join('\n')}`;
    } catch {
      // Table doesn't exist yet — Phase 2e
      return '';
    }
  }

  /**
   * Load active compound strategies from DB.
   */
  function _loadCompoundStrategies() {
    try {
      const strategies = db.prepare(
        "SELECT strategy_id, name, direction, symbols, confidence, evidence_json FROM compound_strategies WHERE status = 'active' ORDER BY confidence DESC LIMIT 5"
      ).all();
      if (strategies.length === 0) return '';

      const lines = strategies.map(s => {
        const syms = JSON.parse(s.symbols || '[]').join(',') || 'any';
        const ev = JSON.parse(s.evidence_json || '{}');
        const perf = ev.sample_size > 0 ? ` | 胜率${((ev.win_rate || 0) * 100).toFixed(0)}% (${ev.sample_size}笔)` : '';
        return `[${s.direction}] ${s.name} → ${syms} (conf:${(s.confidence * 100).toFixed(0)}%${perf})`;
      });
      return `\n\n## 活跃 AI 策略 (AI 自主生成, 自动执行中)\n${lines.join('\n')}`;
    } catch { return ''; }
  }

  /**
   * Load Crucix delta + TG urgent into prompt (what changed + breaking alerts).
   */
  async function _loadLiveContext() {
    if (!dataSources) return '';
    try {
      const crucix = await dataSources.fetchCrucix();
      if (!crucix) return '';
      const parts = [];

      // Delta — what changed most since last check
      const delta = crucix.delta;
      if (delta?.signals?.new?.length > 0) {
        const signals = delta.signals.new.slice(0, 3).map(s => `- ${s.text?.slice(0, 100) || s.key}`);
        parts.push(`## 最新变化 (delta)\n${signals.join('\n')}`);
      }

      // TG urgent — breaking geopolitical alerts
      const urgent = crucix.tg?.urgent;
      if (urgent?.length > 0) {
        const alerts = urgent.slice(0, 3).map(u => `- [${u.channel}] ${u.text?.slice(0, 100)}`);
        parts.push(`## 实时快讯 (TG urgent)\n${alerts.join('\n')}`);
      }

      return parts.length > 0 ? '\n\n' + parts.join('\n\n') : '';
    } catch { return ''; }
  }

  /**
   * Load recent push context (so agent can answer follow-ups).
   */
  function _loadPushContext() {
    if (!pushEngine) return '';
    try {
      const recent = pushEngine.getRecentContext(3);
      if (recent.length === 0) return '';
      const lines = recent.map(p =>
        `[${p.pushedAt?.split('T')[1]?.slice(0, 5) || '?'}] ${p.level}: ${p.text.slice(0, 100)}`
      );
      return `\n\n## 最近推送 (用户可能追问)\n${lines.join('\n')}`;
    } catch { return ''; }
  }

  /**
   * Load current context (what agent is doing / recent state).
   */
  function _loadContext() {
    const p = join(MEMORY_DIR, 'context.md');
    if (!existsSync(p)) return '';
    try {
      const content = readFileSync(p, 'utf-8').trim();
      return content ? `\n\n## 当前状态\n${content}` : '';
    } catch { return ''; }
  }

  /**
   * Build full system prompt.
   */
  async function buildSystemPrompt() {
    const liveCtx = await _loadLiveContext();
    const { directives, isEmpty } = _loadDirectives();
    const bootstrap = isEmpty
      ? '\n\n## ⚡ 首次启动\n老板指令为空。你是新初始化的操盘手，需要基础约束才能安全运行。\n1. 告知老板你需要设定约束\n2. 引导设定：最大杠杆、单笔最大风险、最大日亏损、偏好策略方向\n3. 用 save_memory 将回答存入 owner_directives.md\n4. 查询余额和持仓，建立初始 context.md\n这是你的第一优先级。'
      : '';
    const parts = [
      _loadStatic(),
      directives,
      bootstrap,
      _loadCompoundRules(),
      _loadCompoundStrategies(),
      liveCtx,
      _loadPushContext(),
      _loadContext(),
    ];
    return parts.filter(Boolean).join('');
  }

  /**
   * Invalidate static cache (for hot-reload of prompt files).
   */
  function invalidateCache() { _staticCache = null; }

  return { buildSystemPrompt, invalidateCache };
}
