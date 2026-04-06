/**
 * Dream Worker — autonomous memory consolidation.
 *
 * Like REM sleep: periodically reviews all memory notes,
 * merges duplicates, resolves contradictions, purges stale,
 * and distills context.md fragments into durable long-term notes.
 *
 * Runs every 2h check, executes if shouldRun() passes (6h cooldown + enough notes).
 * LLM does the cognition; code enforces safety limits.
 */

import { readFileSync, existsSync, unlinkSync } from 'fs';
import { join } from 'path';
import {
  MEMORY_DIR,
  NOTES_DIRNAME,
  listRecallableMemories,
  saveRecallableMemory,
  readRecallableMemory,
  removeIndexEntry,
  atomicWrite,
} from '../memory/recall.mjs';

const DREAM_INTERVAL_MS = 2 * 60 * 60 * 1000; // check every 2h
const MIN_INTERVAL_MS = 6 * 60 * 60 * 1000;   // min 6h between runs
const MIN_NOTES_TO_RUN = 3;                     // don't dream with < 3 notes
const INITIAL_DELAY_MS = 5 * 60 * 1000;         // wait 5min after startup

// Safety caps per dream cycle — prevent LLM hallucination from mass-destroying memory
const MAX_DELETES = 3;
const MAX_MERGES = 3;
const MAX_CREATES = 2;

export function createDream({ db, llm, log, metrics, onComplete }) {
  const _log = log || { info() {}, warn() {}, error() {} };
  const _m = metrics || { record() {} };
  let _timer = null;
  let _running = false;

  function shouldRun() {
    try {
      const lastRun = db.prepare('SELECT run_at FROM dream_runs ORDER BY id DESC LIMIT 1').get();
      if (lastRun) {
        const elapsed = Date.now() - new Date(lastRun.run_at + 'Z').getTime();
        if (elapsed < MIN_INTERVAL_MS) return false;
      }
      const notes = listRecallableMemories({ memoryDir: MEMORY_DIR });
      return notes.length >= MIN_NOTES_TO_RUN;
    } catch { return false; }
  }

  async function run() {
    if (_running) return null;
    _running = true;
    const start = Date.now();

    try {
      // 1. Collect all memory material
      const notes = listRecallableMemories({ memoryDir: MEMORY_DIR });
      const contextPath = join(MEMORY_DIR, 'context.md');
      const contextContent = existsSync(contextPath) ? readFileSync(contextPath, 'utf-8') : '';
      const directivesPath = join(MEMORY_DIR, 'owner_directives.md');
      const directives = existsSync(directivesPath) ? readFileSync(directivesPath, 'utf-8') : '';

      if (notes.length === 0 && !contextContent) {
        _running = false;
        return null;
      }

      // 2. Build prompt
      const notesSummary = notes.map(n =>
        `[${n.slug}] type:${n.type} name:"${n.name}" desc:"${n.description}" updated:${n.updatedAt}\n${n.body.slice(0, 500)}`
      ).join('\n---\n');

      const prompt = `你是诸葛的记忆管理员。你的工作是整理长期记忆，就像人类睡眠时的 REM 阶段。

当前记忆材料：

## 长期记忆 Notes (${notes.length}条)
${notesSummary || '(empty)'}

## 当前操作上下文 (context.md)
${contextContent.slice(0, 800) || '(empty)'}

## 老板指令 (不可删除/修改)
${directives.slice(0, 400) || '(empty)'}

你的任务：
1. 找出内容重叠的 notes → 合并（保留更完整的 slug，吸收其他的内容）
2. 找出互相矛盾的 notes → 保留有更新数据/更近时间支撑的，删除另一个
3. 找出已过时的 notes（市场条件已变、策略已废弃、信息已过期）→ 删除
4. 从 context.md 中提取值得长期保存的知识（交易偏好、反复出现的 pattern、重要决策）→ 创建新 note

安全限制：最多合并 ${MAX_MERGES} 组、删除 ${MAX_DELETES} 条、创建 ${MAX_CREATES} 条。宁可少做不要过度整理。
不要动 owner_directives 相关的内容。
如果所有记忆都很好不需要整理，可以全部留空。

输出 JSON：
{
  "merge": [{ "keep": "slug-to-keep", "absorb": ["slug-to-delete"], "merged_content": "合并后的完整内容" }],
  "delete": [{ "slug": "slug-to-delete", "reason": "删除原因" }],
  "create": [{ "name": "标题", "description": "一句话描述", "type": "user|feedback|project|reference", "content": "完整内容" }],
  "summary": "中文一句话总结本次整理"
}

只输出 JSON，不要其他文字。`;

      // 3. Call LLM
      const result = await llm([
        { role: 'system', content: '你是记忆整理专家。只输出 JSON。' },
        { role: 'user', content: prompt },
      ], { max_tokens: 1500, timeout: 60000 });

      // 4. Parse
      let actions;
      try {
        const raw = (result.content || result).replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        actions = JSON.parse(raw);
      } catch (err) {
        _log.warn('dream_parse_failed', { module: 'dream', error: err.message });
        _running = false;
        return null;
      }

      // 5. Execute with safety caps
      let merged = 0, deleted = 0, created = 0;
      const backup = { deleted_notes: [], merged_absorbs: [] };

      // Merges
      for (const m of (actions.merge || []).slice(0, MAX_MERGES)) {
        if (!m.keep || !m.absorb?.length || !m.merged_content) continue;
        try {
          // Update the kept note with merged content
          const kept = readRecallableMemory(m.keep, { memoryDir: MEMORY_DIR });
          if (!kept) continue;
          saveRecallableMemory({
            memoryDir: MEMORY_DIR,
            slug: m.keep,
            name: kept.name,
            description: kept.description,
            type: kept.type,
            content: m.merged_content,
            overwrite: true,
          });
          // Delete absorbed notes + clean index
          for (const slug of m.absorb) {
            const absorbed = readRecallableMemory(slug, { memoryDir: MEMORY_DIR });
            if (absorbed) {
              backup.merged_absorbs.push({ slug, name: absorbed.name, body: absorbed.body.slice(0, 300) });
              unlinkSync(absorbed.filePath);
              removeIndexEntry(MEMORY_DIR, `${NOTES_DIRNAME}/${slug}.md`);
            }
          }
          merged++;
          _log.info('dream_merged', { module: 'dream', keep: m.keep, absorbed: m.absorb });
        } catch (err) {
          _log.warn('dream_merge_failed', { module: 'dream', slug: m.keep, error: err.message });
        }
      }

      // Deletes
      for (const d of (actions.delete || []).slice(0, MAX_DELETES)) {
        if (!d.slug) continue;
        try {
          const note = readRecallableMemory(d.slug, { memoryDir: MEMORY_DIR });
          if (!note) continue;
          backup.deleted_notes.push({ slug: d.slug, name: note.name, body: note.body.slice(0, 300), reason: d.reason });
          unlinkSync(note.filePath);
          removeIndexEntry(MEMORY_DIR, `${NOTES_DIRNAME}/${d.slug}.md`);
          deleted++;
          _log.info('dream_deleted', { module: 'dream', slug: d.slug, reason: d.reason });
        } catch (err) {
          _log.warn('dream_delete_failed', { module: 'dream', slug: d.slug, error: err.message });
        }
      }

      // Creates
      for (const c of (actions.create || []).slice(0, MAX_CREATES)) {
        if (!c.name || !c.content) continue;
        try {
          saveRecallableMemory({
            memoryDir: MEMORY_DIR,
            name: c.name,
            description: c.description || c.name,
            type: c.type || 'project',
            content: c.content,
          });
          created++;
          _log.info('dream_created', { module: 'dream', name: c.name });
        } catch (err) {
          _log.warn('dream_create_failed', { module: 'dream', name: c.name, error: err.message });
        }
      }

      // 6. Record run
      const summary = actions.summary || `merged:${merged} deleted:${deleted} created:${created}`;
      try {
        db.prepare(
          'INSERT INTO dream_runs (notes_reviewed, merged, deleted, created, summary, backup_json) VALUES (?, ?, ?, ?, ?, ?)'
        ).run(notes.length, merged, deleted, created, summary, JSON.stringify(backup));
      } catch {}

      _log.info('dream_complete', { module: 'dream', notes: notes.length, merged, deleted, created, duration_ms: Date.now() - start });
      _m.record('dream_run', 1, { notes: notes.length, merged, deleted, created });

      const dreamResult = { notes: notes.length, merged, deleted, created, summary };
    if (onComplete) try { onComplete(dreamResult); } catch {}
    return dreamResult;
    } catch (err) {
      _log.error('dream_error', { module: 'dream', error: err.message });
      return null;
    } finally {
      _running = false;
    }
  }

  function _maybeRun() {
    if (shouldRun()) {
      run().catch(err => _log.error('dream_auto_error', { module: 'dream', error: err.message }));
    }
  }

  function start() {
    // Staggered initial check
    setTimeout(_maybeRun, INITIAL_DELAY_MS);
    _timer = setInterval(_maybeRun, DREAM_INTERVAL_MS);
    _log.info('dream_started', { module: 'dream', check_interval: '2h', min_interval: '6h' });
  }

  function stop() {
    if (_timer) { clearInterval(_timer); _timer = null; }
  }

  return { shouldRun, run, start, stop };
}
