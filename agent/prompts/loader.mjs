/**
 * System prompt loader - assembles static prompt files plus dynamic memory.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import {
  buildRecallPrompt,
  ensureMemoryLayout,
  MEMORY_DIR,
} from '../memory/recall.mjs';

const PROMPTS_DIR = 'agent/prompts';

export function createPromptLoader({ db, pushEngine, dataSources }) {
  let staticCache = null;

  function loadStatic() {
    if (staticCache) return staticCache;

    const load = file => {
      const path = join(PROMPTS_DIR, file);
      return existsSync(path) ? readFileSync(path, 'utf-8') : '';
    };

    staticCache = [load('base.md'), load('safety.md')]
      .filter(Boolean)
      .join('\n\n---\n\n');
    return staticCache;
  }

  function loadDirectives() {
    const path = join(MEMORY_DIR, 'owner_directives.md');
    if (!existsSync(path)) return { directives: '', isEmpty: true };

    try {
      const content = readFileSync(path, 'utf-8').trim();
      if (!content) return { directives: '', isEmpty: true };

      const meaningfulLines = content
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(line => line && !line.startsWith('#'));

      return {
        directives: meaningfulLines.length
          ? `\n\n## 老板指令 (最高优先级)\n${content}`
          : '',
        isEmpty: meaningfulLines.length === 0,
      };
    } catch {
      return { directives: '', isEmpty: true };
    }
  }

  function loadCompoundRules() {
    try {
      const rules = db
        .prepare(
          "SELECT description, action, confidence, trade_count FROM compound_rules WHERE status = 'active' ORDER BY confidence DESC LIMIT 10",
        )
        .all();

      if (rules.length === 0) return '';

      const lines = rules.map(rule => {
        const icon =
          rule.action === 'avoid' ? '!' : rule.action === 'prefer' ? '+' : '~';
        return `${icon} ${rule.description} (${rule.trade_count} trades, conf:${(
          rule.confidence * 100
        ).toFixed(0)}%)`;
      });

      return `\n\n## 你的交易认知 (AI 复盘产出)\n${lines.join('\n')}`;
    } catch {
      return '';
    }
  }

  function loadCompoundStrategies() {
    try {
      const strategies = db
        .prepare(
          "SELECT strategy_id, name, direction, symbols, confidence, evidence_json FROM compound_strategies WHERE status = 'active' ORDER BY confidence DESC LIMIT 5",
        )
        .all();

      if (strategies.length === 0) return '';

      const lines = strategies.map(strategy => {
        const symbols = JSON.parse(strategy.symbols || '[]').join(',') || 'any';
        const evidence = JSON.parse(strategy.evidence_json || '{}');
        const perf =
          evidence.sample_size > 0
            ? ` | 胜率${((evidence.win_rate || 0) * 100).toFixed(0)}% (${evidence.sample_size}笔)`
            : '';
        return `[${strategy.direction}] ${strategy.name} -> ${symbols} (conf:${(
          strategy.confidence * 100
        ).toFixed(0)}%${perf})`;
      });

      return `\n\n## 活跃 AI 策略\n${lines.join('\n')}`;
    } catch {
      return '';
    }
  }

  async function loadLiveContext() {
    if (!dataSources) return '';

    try {
      const crucix = await dataSources.fetchCrucix();
      if (!crucix) return '';

      const parts = [];
      const deltaSignals = crucix?.delta?.signals?.new || [];
      const urgentAlerts = crucix?.tg?.urgent || [];

      if (deltaSignals.length > 0) {
        parts.push(
          `## 最新变化 (delta)\n${deltaSignals
            .slice(0, 3)
            .map(signal => `- ${signal.text?.slice(0, 100) || signal.key}`)
            .join('\n')}`,
        );
      }

      if (urgentAlerts.length > 0) {
        parts.push(
          `## 实时快讯 (TG urgent)\n${urgentAlerts
            .slice(0, 3)
            .map(alert => `- [${alert.channel}] ${alert.text?.slice(0, 100)}`)
            .join('\n')}`,
        );
      }

      return parts.length ? `\n\n${parts.join('\n\n')}` : '';
    } catch {
      return '';
    }
  }

  function loadPushContext() {
    if (!pushEngine) return '';

    try {
      const recent = pushEngine.getRecentContext(3);
      if (recent.length === 0) return '';

      const lines = recent.map(item => {
        const time = item.pushedAt?.split('T')[1]?.slice(0, 5) || '?';
        return `[${time}] ${item.level}: ${item.text.slice(0, 100)}`;
      });

      return `\n\n## 最近推送 (用户可能追问)\n${lines.join('\n')}`;
    } catch {
      return '';
    }
  }

  function loadCurrentContext() {
    const path = join(MEMORY_DIR, 'context.md');
    if (!existsSync(path)) return '';

    try {
      const content = readFileSync(path, 'utf-8').trim();
      return content ? `\n\n## 当前状态\n${content}` : '';
    } catch {
      return '';
    }
  }

  function loadRecallableMemory(input = {}) {
    return buildRecallPrompt({
      query: input.userMessage || '',
      memoryDir: MEMORY_DIR,
      maxMemories: 3,
    });
  }

  async function buildSystemPrompt(input = {}) {
    ensureMemoryLayout(MEMORY_DIR);

    const liveContext = await loadLiveContext();
    const { directives, isEmpty } = loadDirectives();
    const bootstrap = isEmpty
      ? '\n\n## 首次启动\n老板指令为空。先补齐基础约束，再做任何有风险的动作。\n1. 主动要求老板设定最大杠杆、单笔风险、最大日亏损和偏好策略\n2. 用 add_directive 或 save_memory 写入 owner_directives.md\n3. 查询余额、持仓和关键状态，建立 context.md\n这是你的第一优先级。'
      : '';

    const parts = [
      loadStatic(),
      directives,
      bootstrap,
      loadRecallableMemory(input),
      loadCompoundRules(),
      loadCompoundStrategies(),
      liveContext,
      loadPushContext(),
      loadCurrentContext(),
    ];

    return parts.filter(Boolean).join('');
  }

  function invalidateCache() {
    staticCache = null;
  }

  return { buildSystemPrompt, invalidateCache };
}
