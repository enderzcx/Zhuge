import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'fs';

/** Atomic write with backup: backs up existing file before overwrite. Prevents data loss on crash/restart. */
export function atomicWrite(filePath, content) {
  // Backup existing file (rotate: keep .bak and .bak2)
  try {
    if (existsSync(filePath)) {
      const bak = filePath + '.bak';
      const bak2 = filePath + '.bak2';
      try { if (existsSync(bak)) renameSync(bak, bak2); } catch {}
      try { copyFileSync(filePath, bak); } catch {}
    }
  } catch {} // backup failure should never block write
  const tmp = filePath + '.tmp';
  writeFileSync(tmp, content, 'utf-8');
  renameSync(tmp, filePath);
}
import { join } from 'path';

export const MEMORY_DIR = 'agent/memory';
export const NOTES_DIRNAME = 'notes';
export const MEMORY_INDEX_FILE = 'MEMORY.md';
export const MEMORY_TYPES = ['user', 'feedback', 'project', 'reference'];

const DEFAULT_MEMORY_INDEX = `# Zhuge Memory Index

Operational files
- [owner_directives.md](owner_directives.md) - hard and soft constraints from the owner
- [context.md](context.md) - short-lived working context, safe to overwrite
- [market_context.md](market_context.md) - optional market snapshot
- [trading_lessons.md](trading_lessons.md) - optional operational lessons

Recallable notes
- Store durable notes under [notes/](notes/)
- Each note should use frontmatter: name, description, type
- Valid types: user, feedback, project, reference
- Keep each index line short; put the detail in the note file
`;

const MAX_INDEX_CHARS = 1800;
const MAX_NOTE_CHARS = 1400;

export function ensureMemoryLayout(memoryDir = MEMORY_DIR) {
  mkdirSync(memoryDir, { recursive: true });
  mkdirSync(join(memoryDir, NOTES_DIRNAME), { recursive: true });

  const indexPath = join(memoryDir, MEMORY_INDEX_FILE);
  if (!existsSync(indexPath)) {
    atomicWrite(indexPath, DEFAULT_MEMORY_INDEX);
  }
}

export function slugify(value = '') {
  const slug = String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug || `memory-${Date.now().toString(36)}`;
}

function normalizeText(value = '') {
  return String(value).toLowerCase();
}

function parseFrontmatter(raw = '') {
  const text = String(raw);
  if (!text.startsWith('---\n') && !text.startsWith('---\r\n')) {
    return { attributes: {}, body: text.trim() };
  }

  const normalized = text.replace(/\r\n/g, '\n');
  const end = normalized.indexOf('\n---\n', 4);
  if (end === -1) {
    return { attributes: {}, body: normalized.trim() };
  }

  const frontmatter = normalized.slice(4, end).trim();
  const body = normalized.slice(end + 5).trim();
  const attributes = {};

  for (const line of frontmatter.split('\n')) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key) attributes[key] = value;
  }

  return { attributes, body };
}

function truncate(text, maxChars) {
  const value = String(text || '').trim();
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n...[truncated ${value.length - maxChars} chars]`;
}

function escapeFrontmatterValue(value = '') {
  return String(value).replace(/\r?\n/g, ' ').replace(/:/g, ' -').trim();
}

function readIndex(memoryDir) {
  ensureMemoryLayout(memoryDir);
  const indexPath = join(memoryDir, MEMORY_INDEX_FILE);
  return readFileSync(indexPath, 'utf-8');
}

function walkMarkdownFiles(dir) {
  if (!existsSync(dir)) return [];

  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkMarkdownFiles(fullPath));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.md')) {
      files.push(fullPath);
    }
  }
  return files;
}

function extractTerms(text = '') {
  const normalized = normalizeText(text);
  const terms = new Set(normalized.match(/[a-z0-9_/-]{2,}/g) || []);
  const chineseRuns = normalized.match(/[\u4e00-\u9fff]{2,}/g) || [];

  for (const run of chineseRuns) {
    if (run.length <= 4) {
      terms.add(run);
      continue;
    }
    for (let i = 0; i < run.length - 1; i++) {
      terms.add(run.slice(i, i + 2));
    }
  }

  return [...terms];
}

function recencyScore(mtimeMs) {
  const ageDays = Math.max(0, (Date.now() - mtimeMs) / (24 * 60 * 60 * 1000));
  return Math.max(0, 1.5 - ageDays / 10);
}

function scoreMemory(query, memory) {
  const haystack = normalizeText(
    [
      memory.name,
      memory.description,
      memory.type,
      memory.body.slice(0, 800),
      memory.slug,
    ].join(' '),
  );

  if (!String(query || '').trim()) {
    return recencyScore(memory.mtimeMs);
  }

  const queryTerms = extractTerms(query);
  if (queryTerms.length === 0) {
    return recencyScore(memory.mtimeMs) * 0.5;
  }

  let score = recencyScore(memory.mtimeMs) * 0.5;
  let hits = 0;

  for (const term of queryTerms) {
    if (!haystack.includes(term)) continue;
    hits++;
    score += term.length >= 4 ? 2.5 : 1.25;
  }

  score += hits / queryTerms.length;
  return score;
}

export function listRecallableMemories({ memoryDir = MEMORY_DIR } = {}) {
  ensureMemoryLayout(memoryDir);
  const notesDir = join(memoryDir, NOTES_DIRNAME);

  return walkMarkdownFiles(notesDir)
    .map(filePath => {
      const raw = readFileSync(filePath, 'utf-8');
      const { attributes, body } = parseFrontmatter(raw);
      const stat = statSync(filePath);
      const relativePath = filePath
        .slice(memoryDir.length + 1)
        .replace(/\\/g, '/');
      const slug = relativePath
        .replace(/^notes\//, '')
        .replace(/\.md$/i, '');

      return {
        slug,
        filePath,
        relativePath,
        name: attributes.name || slug,
        description: attributes.description || '',
        type: MEMORY_TYPES.includes(attributes.type) ? attributes.type : 'project',
        body,
        mtimeMs: stat.mtimeMs,
        updatedAt: stat.mtime.toISOString(),
      };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

export function recallMemories(
  query,
  { memoryDir = MEMORY_DIR, limit = 3 } = {},
) {
  const scored = listRecallableMemories({ memoryDir })
    .map(memory => ({ ...memory, score: scoreMemory(query, memory) }))
    .sort((a, b) => b.score - a.score || b.mtimeMs - a.mtimeMs);

  const threshold = String(query || '').trim() ? 1.25 : -Infinity;
  return scored.filter(memory => memory.score >= threshold).slice(0, limit);
}

function upsertIndexEntry(memoryDir, { relativePath, name, description }) {
  const indexPath = join(memoryDir, MEMORY_INDEX_FILE);
  let content = readIndex(memoryDir).trimEnd();
  const entryLine = `- [${name}](${relativePath}) - ${description}`;
  const lines = content.split(/\r?\n/);
  const existingIndex = lines.findIndex(line => line.includes(`(${relativePath})`));

  if (existingIndex >= 0) {
    lines[existingIndex] = entryLine;
  } else {
    lines.push(entryLine);
  }

  content = `${lines.join('\n')}\n`;
  atomicWrite(indexPath, content);
}

export function removeIndexEntry(memoryDir, relativePath) {
  const indexPath = join(memoryDir, MEMORY_INDEX_FILE);
  let content = readIndex(memoryDir);
  const lines = content.split(/\r?\n/);
  const filtered = lines.filter(line => !line.includes(`(${relativePath})`));
  if (filtered.length !== lines.length) {
    atomicWrite(indexPath, filtered.join('\n') + '\n');
  }
}

export function saveRecallableMemory({
  memoryDir = MEMORY_DIR,
  slug,
  name,
  description,
  type = 'project',
  content,
  overwrite = true,
}) {
  ensureMemoryLayout(memoryDir);

  if (!name || !description || !content) {
    throw new Error('name, description, and content are required');
  }
  if (!MEMORY_TYPES.includes(type)) {
    throw new Error(`invalid memory type: ${type}`);
  }

  let cleanSlug = slugify(slug || name);
  let relativePath = `${NOTES_DIRNAME}/${cleanSlug}.md`;
  let filePath = join(memoryDir, relativePath);

  // Slug collision protection: if file exists and overwrite is not explicitly requested,
  // append a timestamp suffix to avoid silently destroying old memory
  if (!overwrite && existsSync(filePath)) {
    throw new Error(`memory already exists: ${cleanSlug}`);
  }
  if (overwrite && existsSync(filePath)) {
    // Check if existing file has a DIFFERENT name in frontmatter — if so, it's a collision, not an update
    try {
      const existing = readFileSync(filePath, 'utf-8');
      const { attributes } = parseFrontmatter(existing);
      if (attributes.name && attributes.name !== escapeFrontmatterValue(name)) {
        // Different memory landed on same slug — disambiguate
        cleanSlug = `${cleanSlug}-${Date.now().toString(36)}`;
        relativePath = `${NOTES_DIRNAME}/${cleanSlug}.md`;
        filePath = join(memoryDir, relativePath);
      }
    } catch {}
  }

  const fileContent = [
    '---',
    `name: ${escapeFrontmatterValue(name)}`,
    `description: ${escapeFrontmatterValue(description)}`,
    `type: ${type}`,
    '---',
    '',
    String(content).trim(),
    '',
  ].join('\n');

  atomicWrite(filePath, fileContent);
  upsertIndexEntry(memoryDir, {
    relativePath: relativePath.replace(/\\/g, '/'),
    name: escapeFrontmatterValue(name),
    description: escapeFrontmatterValue(description),
  });

  return {
    slug: cleanSlug,
    filePath,
    relativePath: relativePath.replace(/\\/g, '/'),
  };
}

export function readRecallableMemory(
  slug,
  { memoryDir = MEMORY_DIR } = {},
) {
  if (!slug) return null;
  ensureMemoryLayout(memoryDir);

  const cleanSlug = slug.replace(/^notes\//, '').replace(/\.md$/i, '');
  const filePath = join(memoryDir, NOTES_DIRNAME, `${cleanSlug}.md`);
  if (!existsSync(filePath)) return null;

  const raw = readFileSync(filePath, 'utf-8');
  const { attributes, body } = parseFrontmatter(raw);
  const stat = statSync(filePath);

  return {
    slug: cleanSlug,
    filePath,
    relativePath: `${NOTES_DIRNAME}/${cleanSlug}.md`,
    name: attributes.name || cleanSlug,
    description: attributes.description || '',
    type: MEMORY_TYPES.includes(attributes.type) ? attributes.type : 'project',
    body,
    updatedAt: stat.mtime.toISOString(),
  };
}

export function buildRecallPrompt({
  query = '',
  memoryDir = MEMORY_DIR,
  maxMemories = 3,
} = {}) {
  ensureMemoryLayout(memoryDir);

  const recalled = recallMemories(query, { memoryDir, limit: maxMemories });

  // Don't inject anything if no notes exist — save tokens for market context
  if (recalled.length === 0) return '';

  const parts = ['## 长期记忆'];

  // Only inject index when there are enough notes to make it useful (>3)
  const allNotes = listRecallableMemories({ memoryDir });
  if (allNotes.length > 3) {
    const indexText = truncate(readIndex(memoryDir), MAX_INDEX_CHARS);
    if (indexText) {
      parts.push('### Memory Index');
      parts.push(indexText);
    }
  }

  parts.push('### Recalled Memory Notes');
  {
    for (const memory of recalled) {
      parts.push(
        [
          `#### ${memory.name}`,
          `type: ${memory.type}`,
          `updated_at: ${memory.updatedAt}`,
          `path: ${memory.relativePath}`,
          truncate(memory.body, MAX_NOTE_CHARS),
        ].join('\n'),
      );
    }
  }

  return parts.join('\n\n');
}
