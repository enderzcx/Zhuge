/**
 * Memory tools — read/write agent memory files + owner directives.
 *   save_memory, read_memory, add_directive, list_directives
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';

const MEMORY_DIR = 'agent/memory';
const ALLOWED_FILES = [
  'context.md',
  'trading_lessons.md',
  'owner_directives.md',
  'market_context.md',
  'push_log.md',
  'MEMORY.md',
];

export function createMemoryTools({ log }) {
  const _log = log || { info() {}, warn() {}, error() {} };

  // Ensure memory directory exists
  mkdirSync(MEMORY_DIR, { recursive: true });

  const TOOL_DEFS = [
    {
      name: 'save_memory',
      description: '写入 agent 记忆文件 (context/trading_lessons/market_context/push_log)',
      parameters: {
        type: 'object',
        properties: {
          file: {
            type: 'string',
            enum: ALLOWED_FILES,
            description: '要写入的记忆文件',
          },
          content: { type: 'string', description: '要写入的内容' },
          append: { type: 'boolean', description: '追加模式 (默认覆盖)' },
        },
        required: ['file', 'content'],
      },
      requiresConfirmation: false,
    },
    {
      name: 'read_memory',
      description: '读取 agent 记忆文件',
      parameters: {
        type: 'object',
        properties: {
          file: {
            type: 'string',
            enum: ALLOWED_FILES,
            description: '要读取的记忆文件',
          },
        },
        required: ['file'],
      },
      requiresConfirmation: false,
    },
    {
      name: 'add_directive',
      description: '添加老板指令 (策略约束, 永久生效直到用户修改)',
      parameters: {
        type: 'object',
        properties: {
          directive: { type: 'string', description: '指令内容 (如 "杠杆不超过5x")' },
          type: {
            type: 'string',
            enum: ['hard', 'soft'],
            description: 'hard=永不违反, soft=可建议修改',
          },
        },
        required: ['directive'],
      },
      requiresConfirmation: false,
    },
    {
      name: 'list_directives',
      description: '列出当前所有老板指令',
      parameters: { type: 'object', properties: {}, required: [] },
      requiresConfirmation: false,
    },
  ];

  function _filePath(file) {
    if (!ALLOWED_FILES.includes(file)) return null;
    return join(MEMORY_DIR, file);
  }

  const EXECUTORS = {
    async save_memory({ file, content, append }) {
      const path = _filePath(file);
      if (!path) return `Error: invalid file "${file}". Allowed: ${ALLOWED_FILES.join(', ')}`;
      try {
        if (append) {
          const existing = existsSync(path) ? readFileSync(path, 'utf-8') : '';
          writeFileSync(path, existing + '\n' + content);
        } else {
          writeFileSync(path, content);
        }
        _log.info('memory_saved', { module: 'memory', file, bytes: content.length });
        return `OK: ${file} updated (${content.length} bytes)`;
      } catch (err) {
        return `Error: ${err.message}`;
      }
    },

    async read_memory({ file }) {
      const path = _filePath(file);
      if (!path) return `Error: invalid file "${file}"`;
      if (!existsSync(path)) return `(empty — ${file} not yet created)`;
      try {
        return readFileSync(path, 'utf-8').slice(0, 3000);
      } catch (err) {
        return `Error: ${err.message}`;
      }
    },

    async add_directive({ directive, type }) {
      const path = join(MEMORY_DIR, 'owner_directives.md');
      const now = new Date().toISOString().split('T')[0];
      const level = type === 'hard' ? '硬约束' : '软约束';
      const line = `- ${directive} [${level}, ${now}]`;

      let content = '';
      if (existsSync(path)) {
        content = readFileSync(path, 'utf-8');
      } else {
        content = '# Owner Directives\n\n## 硬约束 (永不违反)\n\n## 软约束 (可建议修改)\n\n## 策略方向\n';
      }

      // Insert into appropriate section
      const section = type === 'hard' ? '## 硬约束' : '## 软约束';
      const sectionIdx = content.indexOf(section);
      if (sectionIdx !== -1) {
        const nextSection = content.indexOf('\n## ', sectionIdx + section.length);
        const insertAt = nextSection !== -1 ? nextSection : content.length;
        content = content.slice(0, insertAt) + line + '\n' + content.slice(insertAt);
      } else {
        content += `\n${line}\n`;
      }

      writeFileSync(path, content);
      _log.info('directive_added', { module: 'memory', directive, type: level });
      return `已添加${level}: ${directive}`;
    },

    async list_directives() {
      const path = join(MEMORY_DIR, 'owner_directives.md');
      if (!existsSync(path)) return '暂无指令';
      return readFileSync(path, 'utf-8').slice(0, 2000);
    },
  };

  return { TOOL_DEFS, EXECUTORS };
}
