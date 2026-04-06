import { describe, it, expect } from 'vitest';
import { isActionCorrect } from '../market/signals.mjs';

describe('isActionCorrect', () => {
  // Buy actions
  it('strong_buy correct when price goes up', () => {
    expect(isActionCorrect('strong_buy', 100, 105)).toBe(1);
  });
  it('strong_buy incorrect when price goes down', () => {
    expect(isActionCorrect('strong_buy', 100, 95)).toBe(0);
  });
  it('increase_exposure correct when price goes up', () => {
    expect(isActionCorrect('increase_exposure', 100, 101)).toBe(1);
  });
  it('increase_exposure incorrect when price goes down', () => {
    expect(isActionCorrect('increase_exposure', 100, 99)).toBe(0);
  });

  // Sell actions
  it('strong_sell correct when price goes down', () => {
    expect(isActionCorrect('strong_sell', 100, 95)).toBe(1);
  });
  it('strong_sell incorrect when price goes up', () => {
    expect(isActionCorrect('strong_sell', 100, 105)).toBe(0);
  });
  it('reduce_exposure correct when price goes down', () => {
    expect(isActionCorrect('reduce_exposure', 100, 99)).toBe(1);
  });

  // Hold
  it('hold correct when price barely moves (<1%)', () => {
    expect(isActionCorrect('hold', 100, 100.5)).toBe(1);
  });
  it('hold incorrect when price moves >1%', () => {
    expect(isActionCorrect('hold', 100, 102)).toBe(0);
  });

  // Edge cases
  it('returns null for null prices', () => {
    expect(isActionCorrect('strong_buy', null, 100)).toBeNull();
    expect(isActionCorrect('strong_buy', 100, null)).toBeNull();
  });
  it('returns null for unknown action', () => {
    expect(isActionCorrect('unknown_action', 100, 105)).toBeNull();
  });
  it('buy is incorrect when price unchanged (change = 0)', () => {
    expect(isActionCorrect('strong_buy', 100, 100)).toBe(0);
  });
  it('sell is incorrect when price unchanged (change = 0)', () => {
    expect(isActionCorrect('strong_sell', 100, 100)).toBe(0);
  });
});
