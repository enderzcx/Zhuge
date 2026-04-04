/**
 * Structured JSON-lines logger with daily rotation and 7-day retention.
 * Drop-in replacement for console.log in pipeline modules.
 */

import { appendFileSync, mkdirSync, readdirSync, unlinkSync } from 'fs';
import { join } from 'path';

const LOG_DIR = 'data/logs';
const RETENTION_DAYS = 7;
const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };

export function createLogger(opts = {}) {
  const minLevel = LEVELS[opts.level || 'info'] || 1;
  mkdirSync(LOG_DIR, { recursive: true });

  function getFilePath() {
    const date = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    return join(LOG_DIR, `${date}.jsonl`);
  }

  function write(level, event, data = {}) {
    if (LEVELS[level] < minLevel) return;

    const entry = {
      ts: new Date().toISOString(),
      level,
      event,
      ...data,
    };

    // Console output (keep existing behavior)
    const prefix = data.module ? `[${data.module}]` : '';
    if (level === 'error') {
      console.error(`${prefix} ${event}`, data.error || '');
    } else if (level === 'warn') {
      console.warn(`${prefix} ${event}`);
    } else {
      console.log(`${prefix} ${event}`);
    }

    // File output
    try {
      appendFileSync(getFilePath(), JSON.stringify(entry) + '\n');
    } catch {}
  }

  const log = {
    debug: (event, data) => write('debug', event, data),
    info:  (event, data) => write('info', event, data),
    warn:  (event, data) => write('warn', event, data),
    error: (event, data) => write('error', event, data),
  };

  /**
   * Read recent log entries, optionally filtered.
   * @param {object} opts - { limit, level, module, since }
   * @returns {object[]}
   */
  function readLogs({ limit = 50, level, module, since } = {}) {
    const files = readdirSync(LOG_DIR)
      .filter(f => f.endsWith('.jsonl'))
      .sort()
      .reverse();

    const results = [];
    for (const file of files) {
      try {
        const lines = require('fs')
          .readFileSync(join(LOG_DIR, file), 'utf-8')
          .split('\n')
          .filter(Boolean)
          .reverse();

        for (const line of lines) {
          if (results.length >= limit) break;
          try {
            const entry = JSON.parse(line);
            if (level && entry.level !== level) continue;
            if (module && entry.module !== module) continue;
            if (since && new Date(entry.ts) < new Date(since)) continue;
            results.push(entry);
          } catch {}
        }
      } catch {}
      if (results.length >= limit) break;
    }
    return results;
  }

  // Prune old log files (run on startup + daily)
  function prune() {
    try {
      const files = readdirSync(LOG_DIR).filter(f => f.endsWith('.jsonl')).sort();
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - RETENTION_DAYS);
      const cutoffStr = cutoff.toISOString().split('T')[0];

      for (const file of files) {
        const dateStr = file.replace('.jsonl', '');
        if (dateStr < cutoffStr) {
          unlinkSync(join(LOG_DIR, file));
          console.log(`[logger] Pruned old log: ${file}`);
        }
      }
    } catch {}
  }

  prune();
  const pruneTimer = setInterval(prune, 24 * 60 * 60 * 1000);

  function stop() { clearInterval(pruneTimer); }

  return { log, readLogs, stop };
}
