import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildRecallPrompt,
  ensureMemoryLayout,
  recallMemories,
  saveRecallableMemory,
} from '../agent/memory/recall.mjs';

const tempDirs = [];

function makeMemoryDir() {
  const dir = mkdtempSync(join(tmpdir(), 'trade-agent-memory-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe('recallable memory', () => {
  it('saves typed memory notes and updates MEMORY.md', () => {
    const memoryDir = makeMemoryDir();
    ensureMemoryLayout(memoryDir);

    const saved = saveRecallableMemory({
      memoryDir,
      name: 'Owner risk preference',
      description: 'Owner prefers lower leverage during CPI weeks',
      type: 'feedback',
      content: 'Use lower leverage before CPI and avoid revenge trades after macro surprises.',
    });

    const index = readFileSync(join(memoryDir, 'MEMORY.md'), 'utf-8');
    const note = readFileSync(saved.filePath, 'utf-8');

    expect(saved.relativePath).toMatch(/^notes\//);
    expect(index).toContain(saved.relativePath);
    expect(note).toContain('type: feedback');
    expect(note).toContain('Owner risk preference');
  });

  it('recalls the most relevant memories for a Chinese query', () => {
    const memoryDir = makeMemoryDir();
    ensureMemoryLayout(memoryDir);

    saveRecallableMemory({
      memoryDir,
      name: '老板对 CPI 周的风险偏好',
      description: 'CPI 公布前后要主动降杠杆',
      type: 'feedback',
      content: '老板要求在 CPI 周把杠杆压低，优先保命，不追单。',
    });
    saveRecallableMemory({
      memoryDir,
      name: '参考面板',
      description: 'Grafana 延迟监控面板地址',
      type: 'reference',
      content: '如果排查系统异常，先看 grafana.internal/d/api-latency。',
    });

    const recalled = recallMemories('这周 CPI 要不要降杠杆', {
      memoryDir,
      limit: 2,
    });

    expect(recalled).toHaveLength(1);
    expect(recalled[0].name).toContain('CPI');
  });

  it('builds a prompt section with index and recalled notes', () => {
    const memoryDir = makeMemoryDir();
    ensureMemoryLayout(memoryDir);

    saveRecallableMemory({
      memoryDir,
      name: 'Trade sizing preference',
      description: 'Use smaller size when liquidity is thin',
      type: 'feedback',
      content: 'If liquidity is thin, halve the default size and widen execution patience.',
    });

    const prompt = buildRecallPrompt({
      memoryDir,
      query: 'liquidity is thin today',
      maxMemories: 2,
    });

    expect(prompt).toContain('Memory Index');
    expect(prompt).toContain('Recalled Memory Notes');
    expect(prompt).toContain('Trade sizing preference');
  });
});
