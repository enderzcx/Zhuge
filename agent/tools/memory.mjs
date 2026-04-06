/**
 * Memory tools:
 * - operational files: context/directives/logs
 * - recallable notes: typed, indexed, and auto-recalled into prompts
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { unlinkSync } from 'fs';
import {
  MEMORY_DIR,
  MEMORY_TYPES,
  ensureMemoryLayout,
  listRecallableMemories,
  readRecallableMemory,
  recallMemories,
  saveRecallableMemory,
} from '../memory/recall.mjs';

const OPERATIONAL_FILES = [
  'context.md',
  'trading_lessons.md',
  'owner_directives.md',
  'market_context.md',
  'push_log.md',
  'MEMORY.md',
];

const DIRECTIVE_TEMPLATE = `# Owner Directives

## Hard Constraints

## Soft Constraints

## Strategy Direction
`;

export function createMemoryTools({ log }) {
  const _log = log || { info() {}, warn() {}, error() {} };

  ensureMemoryLayout(MEMORY_DIR);

  const TOOL_DEFS = [
    {
      name: 'save_memory',
      description: 'Write an operational memory file such as context.md or market_context.md.',
      parameters: {
        type: 'object',
        properties: {
          file: {
            type: 'string',
            enum: OPERATIONAL_FILES,
            description: 'Operational memory file to update',
          },
          content: {
            type: 'string',
            description: 'File content to write',
          },
          append: {
            type: 'boolean',
            description: 'Append instead of replacing',
          },
        },
        required: ['file', 'content'],
      },
      requiresConfirmation: false,
    },
    {
      name: 'read_memory',
      description: 'Read an operational memory file such as context.md or owner_directives.md.',
      parameters: {
        type: 'object',
        properties: {
          file: {
            type: 'string',
            enum: OPERATIONAL_FILES,
            description: 'Operational memory file to read',
          },
        },
        required: ['file'],
      },
      requiresConfirmation: false,
    },
    {
      name: 'add_directive',
      description: 'Add a hard or soft owner directive that should shape all future behavior.',
      parameters: {
        type: 'object',
        properties: {
          directive: {
            type: 'string',
            description: 'Directive content',
          },
          type: {
            type: 'string',
            enum: ['hard', 'soft'],
            description: 'hard = never violate, soft = strong default preference',
          },
        },
        required: ['directive'],
      },
      requiresConfirmation: false,
    },
    {
      name: 'list_directives',
      description: 'List all owner directives currently stored.',
      parameters: { type: 'object', properties: {}, required: [] },
      requiresConfirmation: false,
    },
    {
      name: 'save_recallable_memory',
      description: 'Save a long-term typed memory note that can be auto-recalled later.',
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Human-readable memory title',
          },
          description: {
            type: 'string',
            description: 'One-line summary used for future recall',
          },
          type: {
            type: 'string',
            enum: MEMORY_TYPES,
            description: 'Memory type: user, feedback, project, or reference',
          },
          content: {
            type: 'string',
            description: 'Full note body',
          },
          slug: {
            type: 'string',
            description: 'Optional filename slug for notes/<slug>.md',
          },
        },
        required: ['name', 'description', 'type', 'content'],
      },
      requiresConfirmation: false,
    },
    {
      name: 'search_memory',
      description: 'Search long-term memory notes by the current question or topic.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Search query',
          },
          limit: {
            type: 'integer',
            description: 'Maximum number of matches',
          },
        },
        required: ['query'],
      },
      requiresConfirmation: false,
    },
    {
      name: 'read_recallable_memory',
      description: 'Read a saved long-term memory note by slug.',
      parameters: {
        type: 'object',
        properties: {
          slug: {
            type: 'string',
            description: 'Memory slug or notes/<slug>.md path',
          },
        },
        required: ['slug'],
      },
      requiresConfirmation: false,
    },
    {
      name: 'forget_memory',
      description: 'Delete a long-term memory note that is outdated, wrong, or no longer useful.',
      parameters: {
        type: 'object',
        properties: {
          slug: { type: 'string', description: 'Memory slug to delete' },
          reason: { type: 'string', description: 'Why this memory should be forgotten' },
        },
        required: ['slug'],
      },
      requiresConfirmation: true,
    },
    {
      name: 'list_memory_notes',
      description: 'List all saved long-term memory notes with name, type, and last updated time.',
      parameters: { type: 'object', properties: {}, required: [] },
      requiresConfirmation: false,
    },
  ];

  function operationalPath(file) {
    if (!OPERATIONAL_FILES.includes(file)) return null;
    return join(MEMORY_DIR, file);
  }

  function ensureDirectiveFile() {
    const path = join(MEMORY_DIR, 'owner_directives.md');
    if (!existsSync(path)) {
      writeFileSync(path, DIRECTIVE_TEMPLATE, 'utf-8');
    }
    return path;
  }

  const EXECUTORS = {
    async save_memory({ file, content, append }) {
      const path = operationalPath(file);
      if (!path) {
        return { error: `invalid file "${file}"` };
      }

      try {
        const nextContent =
          append && existsSync(path)
            ? `${readFileSync(path, 'utf-8').trimEnd()}\n${String(content).trim()}\n`
            : String(content);
        writeFileSync(path, nextContent, 'utf-8');
        _log.info('memory_saved', {
          module: 'memory',
          file,
          bytes: String(content).length,
        });
        return { ok: true, file, bytes: String(content).length };
      } catch (err) {
        return { error: err.message };
      }
    },

    async read_memory({ file }) {
      const path = operationalPath(file);
      if (!path) {
        return { error: `invalid file "${file}"` };
      }
      if (!existsSync(path)) {
        return { ok: true, file, content: '' };
      }

      try {
        return {
          ok: true,
          file,
          content: readFileSync(path, 'utf-8').slice(0, 3000),
        };
      } catch (err) {
        return { error: err.message };
      }
    },

    async add_directive({ directive, type }) {
      try {
        const path = ensureDirectiveFile();
        const now = new Date().toISOString().slice(0, 10);
        const section =
          type === 'hard' ? '## Hard Constraints' : '## Soft Constraints';
        const label = type === 'hard' ? 'hard' : 'soft';
        const line = `- ${directive} [${label}, ${now}]`;
        const content = readFileSync(path, 'utf-8');
        const idx = content.indexOf(section);

        if (idx === -1) {
          writeFileSync(path, `${content.trimEnd()}\n${line}\n`, 'utf-8');
        } else {
          const nextSection = content.indexOf('\n## ', idx + section.length);
          const insertAt = nextSection === -1 ? content.length : nextSection;
          const updated =
            `${content.slice(0, insertAt).trimEnd()}\n${line}\n${content.slice(insertAt)}`;
          writeFileSync(path, updated, 'utf-8');
        }

        _log.info('directive_added', {
          module: 'memory',
          directive,
          type: label,
        });
        return { ok: true, directive, type: label };
      } catch (err) {
        return { error: err.message };
      }
    },

    async list_directives() {
      const path = ensureDirectiveFile();
      return {
        ok: true,
        content: readFileSync(path, 'utf-8').slice(0, 2000),
      };
    },

    async save_recallable_memory({ slug, name, description, type, content }) {
      try {
        const saved = saveRecallableMemory({
          memoryDir: MEMORY_DIR,
          slug,
          name,
          description,
          type,
          content,
        });
        _log.info('recallable_memory_saved', {
          module: 'memory',
          slug: saved.slug,
          type,
        });
        return { ok: true, ...saved };
      } catch (err) {
        return { error: err.message };
      }
    },

    async search_memory({ query, limit }) {
      try {
        const matches = recallMemories(query, {
          memoryDir: MEMORY_DIR,
          limit: Number.isFinite(limit) ? limit : 5,
        }).map(memory => ({
          slug: memory.slug,
          name: memory.name,
          description: memory.description,
          type: memory.type,
          updatedAt: memory.updatedAt,
          score: Number(memory.score.toFixed(2)),
        }));

        return { ok: true, query, matches };
      } catch (err) {
        return { error: err.message };
      }
    },

    async read_recallable_memory({ slug }) {
      try {
        const memory = readRecallableMemory(slug, { memoryDir: MEMORY_DIR });
        if (!memory) {
          return { error: `memory not found: ${slug}` };
        }
        return {
          ok: true,
          slug: memory.slug,
          name: memory.name,
          description: memory.description,
          type: memory.type,
          updatedAt: memory.updatedAt,
          content: memory.body.slice(0, 3000),
        };
      } catch (err) {
        return { error: err.message };
      }
    },

    async forget_memory({ slug, reason }) {
      if (!slug) return { error: 'slug required' };
      try {
        const memory = readRecallableMemory(slug, { memoryDir: MEMORY_DIR });
        if (!memory) return { error: `memory not found: ${slug}` };
        unlinkSync(memory.filePath);
        _log.info('memory_forgotten', { module: 'memory', slug, reason: reason || 'no reason' });
        return { ok: true, slug, deleted: memory.name };
      } catch (err) {
        return { error: err.message };
      }
    },

    async list_memory_notes() {
      try {
        const notes = listRecallableMemories({ memoryDir: MEMORY_DIR });
        return {
          ok: true,
          count: notes.length,
          notes: notes.map(n => ({
            slug: n.slug,
            name: n.name,
            type: n.type,
            description: n.description,
            updatedAt: n.updatedAt,
          })),
        };
      } catch (err) {
        return { error: err.message };
      }
    },
  };

  return { TOOL_DEFS, EXECUTORS };
}
