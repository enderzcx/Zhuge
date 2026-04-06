/**
 * Trading-Specific RAG — LanceDB vector store + OpenAI embeddings.
 *
 * Three-layer knowledge architecture:
 *   Layer 1: External knowledge (this module) — strategies, cases, indicators
 *   Layer 2: Compound knowledge (cognition/compound.mjs) — self-discovered patterns
 *   Layer 3: Live context (prompts/loader.mjs) — real-time market data
 *
 * Feedback loop: compound reviews can update knowledge confidence.
 */

import * as lancedb from '@lancedb/lancedb';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

// Local Ollama embedding — zero cost, zero latency, no API key needed
const EMBED_MODEL = 'nomic-embed-text';
const EMBED_DIM = 768;
const TABLE_NAME = 'knowledge';

export function createRAG({ config, log }) {
  const _log = log || { info() {}, warn() {}, error() {} };
  let db = null;
  let table = null;

  // --- Embedding via OpenAI-compatible API ---

  async function embed(text) {
    const base = config.EMBED_BASE || 'http://localhost:11434/v1';

    const res = await fetch(`${base}/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: text.slice(0, 8000), model: EMBED_MODEL }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`Embedding API ${res.status}: ${await res.text().catch(() => '')}`);
    const data = await res.json();
    return data.data?.[0]?.embedding;
  }

  // --- Init ---

  async function init() {
    try {
      db = await lancedb.connect('data/knowledge');
      const tables = await db.tableNames();
      if (tables.includes(TABLE_NAME)) {
        table = await db.openTable(TABLE_NAME);
        _log.info('rag_opened', { module: 'rag', count: await table.countRows() });
      } else {
        _log.info('rag_empty', { module: 'rag', msg: 'No knowledge table yet, will create on first add/seed' });
      }
    } catch (err) {
      _log.error('rag_init_failed', { module: 'rag', error: err.message });
    }
  }

  // --- Add knowledge ---

  async function add({ title, content, category, tags = '', source = 'manual' }) {
    if (!title || !content) throw new Error('title and content required');
    const vector = await embed(`${title} ${content}`);
    const row = {
      title, content, category: category || 'general',
      tags, source, confidence: 50,
      created_at: new Date().toISOString(),
      vector,
    };

    if (!table) {
      table = await db.createTable(TABLE_NAME, [row]);
      _log.info('rag_table_created', { module: 'rag' });
    } else {
      await table.add([row]);
    }
    _log.info('rag_added', { module: 'rag', title, category });
    return { success: true, title };
  }

  // --- Search knowledge ---

  const VALID_CATEGORIES = ['strategy', 'indicator', 'risk_rule', 'case', 'market', 'general'];

  async function search(query, { limit = 5, category } = {}) {
    if (!table) throw new Error('Knowledge store not initialized (Ollama running?)');
    const safeLimit = Math.min(Math.max(limit || 5, 1), 20);
    const queryVec = await embed(query);
    let q = table.search(queryVec).limit(safeLimit);
    if (category && VALID_CATEGORIES.includes(category)) {
      q = q.where(`category = '${category}'`);
    }
    try {
      const results = await q.toArray();
      const mapped = results
        .map(r => ({
          title: r.title,
          content: r.content,
          category: r.category,
          tags: r.tags,
          source: r.source,
          confidence: r.confidence ?? 50,
          score: r._distance != null ? +(1 / (1 + r._distance)).toFixed(3) : null,
        }))
        .filter(r => r.confidence >= 10); // filter out demoted entries
      // Re-sort: vector similarity * confidence weight (higher confidence = higher rank)
      mapped.sort((a, b) => ((b.score || 0) * (b.confidence / 50)) - ((a.score || 0) * (a.confidence / 50)));
      return mapped;
    } catch (err) {
      _log.error('rag_search_failed', { module: 'rag', error: err.message });
      return [];
    }
  }

  // --- Seed from JSON file ---

  async function seed(filePath) {
    if (!existsSync(filePath)) return 0;
    const existing = table ? await table.countRows() : 0;
    if (existing > 0) {
      _log.info('rag_seed_skip', { module: 'rag', existing });
      return 0;
    }

    const items = JSON.parse(readFileSync(filePath, 'utf-8'));
    let count = 0;
    for (const item of items) {
      try {
        await add(item);
        count++;
      } catch (err) {
        _log.warn('rag_seed_item_failed', { module: 'rag', title: item.title, error: err.message });
      }
    }
    _log.info('rag_seeded', { module: 'rag', count, total: items.length });
    return count;
  }

  // --- Update confidence (compound feedback loop) ---

  async function updateConfidence(title, delta) {
    if (!table || !title) return;
    // Clamp delta to ±15 per update (safety: prevent single LLM hallucination from destroying knowledge)
    const safeDelta = Math.min(15, Math.max(-15, delta));
    const escaped = title.replace(/'/g, "''");
    try {
      // Read current confidence, then apply delta
      const rows = await table.search([...Array(EMBED_DIM).fill(0)])
        .where(`title = '${escaped}'`).limit(1).select(['confidence']).toArray();
      const current = rows[0]?.confidence ?? 50;
      const newConf = Math.min(100, Math.max(0, current + safeDelta));
      await table.update({ where: `title = '${escaped}'`, values: { confidence: newConf } });
      _log.info('rag_confidence_updated', { module: 'rag', title, from: current, to: newConf, delta: safeDelta });
    } catch (err) {
      _log.warn('rag_confidence_update_failed', { module: 'rag', title, error: err.message });
    }
  }

  // --- Get all entries (for compound feedback loop) ---

  async function getAll({ limit = 50 } = {}) {
    if (!table) return [];
    try {
      // Use query() for full table scan instead of vector search against zero embedding
      const rows = await table.query().select(['title', 'category', 'confidence', 'tags']).limit(limit).toArray();
      return rows.map(r => ({ title: r.title, category: r.category, confidence: r.confidence ?? 50, tags: r.tags }));
    } catch {
      // Fallback: some LanceDB versions don't support query(), use vector search
      try {
        const rows = await table.search([...Array(EMBED_DIM).fill(0)])
          .limit(limit).select(['title', 'category', 'confidence', 'tags']).toArray();
        return rows.map(r => ({ title: r.title, category: r.category, confidence: r.confidence ?? 50, tags: r.tags }));
      } catch { return []; }
    }
  }

  // --- Stats ---

  async function stats() {
    if (!table) return { count: 0, categories: {} };
    const rows = await table.search([...Array(EMBED_DIM).fill(0)]).limit(10000).select(['category']).toArray();
    const cats = {};
    for (const r of rows) cats[r.category] = (cats[r.category] || 0) + 1;
    return { count: rows.length, categories: cats };
  }

  return { init, add, search, seed, updateConfidence, getAll, stats };
}
