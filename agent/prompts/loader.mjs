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

export function createPromptLoader({ db, pushEngine }) {
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
   */
  function _loadDirectives() {
    const p = join(MEMORY_DIR, 'owner_directives.md');
    if (!existsSync(p)) return '';
    try {
      const content = readFileSync(p, 'utf-8').trim();
      return content ? `\n\n## 老板指令 (最高优先级)\n${content}` : '';
    } catch { return ''; }
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
    const parts = [
      _loadStatic(),
      _loadDirectives(),
      _loadCompoundRules(),
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
