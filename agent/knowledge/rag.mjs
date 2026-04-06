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

const EMBED_MODEL = 'text-embedding-3-small';
const EMBED_DIM = 1536;
const TABLE_NAME = 'knowledge';

export function createRAG({ config, log }) {
  const _log = log || { info() {}, warn() {}, error() {} };
  let db = null;
  let table = null;

  // --- Embedding via OpenAI-compatible API ---

  async function embed(text) {
    const base = config.EMBED_BASE || 'https://api.openai.com/v1';
    const key = config.EMBED_KEY || config.LLM_KEY;
    if (!key) throw new Error('No embedding API key (EMBED_KEY or LLM_KEY)');

    const res = await fetch(`${base}/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
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

  async function search(query, { limit = 5, category } = {}) {
    if (!table) return [];
    try {
      const queryVec = await embed(query);
      let q = table.search(queryVec).limit(limit);
      if (category) q = q.where(`category = '${category}'`);
      const results = await q.toArray();
      return results.map(r => ({
        title: r.title,
        content: r.content,
        category: r.category,
        tags: r.tags,
        source: r.source,
        confidence: r.confidence,
        score: r._distance != null ? +(1 / (1 + r._distance)).toFixed(3) : null, // normalize to 0-1
      }));
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
    if (!table) return;
    try {
      await table.update({ filter: `title = '${title}'`, values: { confidence: delta } });
    } catch (err) {
      _log.warn('rag_confidence_update_failed', { module: 'rag', title, error: err.message });
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

  return { init, add, search, seed, updateConfidence, stats };
}
