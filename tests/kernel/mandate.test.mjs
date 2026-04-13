import { describe, it, expect, beforeEach } from 'vitest';
import { createMandateGate } from '../../kernel/mandate/gate.mjs';
import { evaluate, interpolate } from '../../kernel/mandate/evaluator.mjs';

describe('Evaluator', () => {
  it('evaluates simple comparisons', () => {
    expect(evaluate('x < 10', { x: 5 })).toBe(true);
    expect(evaluate('x < 10', { x: 15 })).toBe(false);
    expect(evaluate('x <= 10', { x: 10 })).toBe(true);
    expect(evaluate('x > 0.05', { x: 0.1 })).toBe(true);
    expect(evaluate('x >= 0.1', { x: 0.1 })).toBe(true);
    expect(evaluate('x == 42', { x: 42 })).toBe(true);
    expect(evaluate('x != 42', { x: 43 })).toBe(true);
  });

  it('evaluates logical operators', () => {
    expect(evaluate('a > 0 && b > 0', { a: 1, b: 2 })).toBe(true);
    expect(evaluate('a > 0 && b > 0', { a: 1, b: -1 })).toBe(false);
    expect(evaluate('a > 0 || b > 0', { a: -1, b: 2 })).toBe(true);
    expect(evaluate('!false', {})).toBe(true);
  });

  it('evaluates "in" operator with array', () => {
    expect(evaluate("instrument in ['BTC-USDT', 'ETH-USDT']", { instrument: 'BTC-USDT' })).toBe(true);
    expect(evaluate("instrument in ['BTC-USDT', 'ETH-USDT']", { instrument: 'DOGE-USDT' })).toBe(false);
  });

  it('evaluates "in" with variable array', () => {
    expect(evaluate('instrument in allowed', { instrument: 'BTC-USDT', allowed: ['BTC-USDT', 'ETH-USDT'] })).toBe(true);
    expect(evaluate('instrument in allowed', { instrument: 'DOGE', allowed: ['BTC', 'ETH'] })).toBe(false);
  });

  it('evaluates dotted paths', () => {
    expect(evaluate('mandate.max_leverage >= leverage', {
      mandate: { max_leverage: 10 },
      leverage: 5,
    })).toBe(true);
  });

  it('evaluates parenthesized expressions', () => {
    expect(evaluate('(a > 0) && (b < 10)', { a: 1, b: 5 })).toBe(true);
  });

  it('handles string comparisons', () => {
    expect(evaluate("status == 'active'", { status: 'active' })).toBe(true);
    expect(evaluate("status != 'retired'", { status: 'active' })).toBe(true);
  });

  it('handles boolean and null literals', () => {
    expect(evaluate('x == true', { x: true })).toBe(true);
    expect(evaluate('x == null', { x: null })).toBe(true);
  });

  it('handles negative numbers in arrays', () => {
    expect(evaluate('x in [-1, 0, 1]', { x: -1 })).toBe(true);
    expect(evaluate('x in [-0.01, 0, 0.01]', { x: -0.01 })).toBe(true);
    expect(evaluate('x in [1, -1]', { x: -1 })).toBe(true);
  });

  it('throws on invalid expression', () => {
    expect(() => evaluate('x @@ y', { x: 1, y: 2 })).toThrow();
  });
});

describe('interpolate', () => {
  it('replaces simple variables', () => {
    expect(interpolate('position {pct}% > limit', { pct: 15 }))
      .toBe('position 15% > limit');
  });

  it('replaces dotted paths', () => {
    expect(interpolate('max is {mandate.cap}', { mandate: { cap: 10 } }))
      .toBe('max is 10');
  });

  it('preserves unresolved placeholders', () => {
    expect(interpolate('{foo} is {bar}', { foo: 'A' }))
      .toBe('A is {bar}');
  });
});

describe('MandateGate', () => {
  let gate;

  beforeEach(() => {
    gate = createMandateGate();
  });

  it('passes when no constraints loaded', () => {
    const result = gate.check('trader', 'open_position', {});
    expect(result.pass).toBe(true);
  });

  it('loads and enforces a require constraint', () => {
    gate.load('trader', [{
      id: 'max_position_pct',
      when: { action: 'open_position' },
      require: 'position_pct <= 0.10',
      veto_message: 'position {position_pct} > 10%',
    }]);

    // Should pass
    const pass = gate.check('trader', 'open_position', { position_pct: 0.05 });
    expect(pass.pass).toBe(true);

    // Should veto
    const veto = gate.check('trader', 'open_position', { position_pct: 0.15 });
    expect(veto.pass).toBe(false);
    expect(veto.vetoed_by.id).toBe('max_position_pct');
    expect(veto.vetoed_by.message).toContain('0.15');
  });

  it('enforces unconditional veto', () => {
    gate.load('trader', [{
      id: 'no_reverse',
      when: { action: 'open_position', side: 'opposite' },
      veto: true,
      veto_message: 'reverse open forbidden',
    }]);

    const veto = gate.check('trader', 'open_position', { side: 'opposite' });
    expect(veto.pass).toBe(false);
    expect(veto.vetoed_by.id).toBe('no_reverse');
  });

  it('skips constraints that do not match "when"', () => {
    gate.load('trader', [{
      id: 'only_open',
      when: { action: 'open_position' },
      require: 'false',
      veto_message: 'blocked',
    }]);

    // Different action should pass
    const result = gate.check('trader', 'close_position', {});
    expect(result.pass).toBe(true);
  });

  it('checks multiple constraints in order', () => {
    gate.load('trader', [
      { id: 'rule1', when: { action: 'open_position' }, require: 'x > 0', veto_message: 'x must be positive' },
      { id: 'rule2', when: { action: 'open_position' }, require: 'y > 0', veto_message: 'y must be positive' },
    ]);

    // First rule fails → returns that veto
    const veto = gate.check('trader', 'open_position', { x: -1, y: 5 });
    expect(veto.pass).toBe(false);
    expect(veto.vetoed_by.id).toBe('rule1');
  });

  it('isolates harness namespaces', () => {
    gate.load('trader', [{ id: 'r1', when: { action: 'trade' }, require: 'false', veto_message: 'no' }]);
    gate.load('am', [{ id: 'r2', when: { action: 'rebalance' }, require: 'true', veto_message: 'no' }]);

    // Trader rules don't affect AM
    expect(gate.check('am', 'rebalance', {}).pass).toBe(true);
    expect(gate.check('trader', 'trade', {}).pass).toBe(false);
  });

  it('fail-closed on eval error', () => {
    gate.load('trader', [{
      id: 'bad_expr',
      when: { action: 'x' },
      require: 'invalid @@ syntax',
      veto_message: 'eval error',
    }]);

    const result = gate.check('trader', 'x', {});
    expect(result.pass).toBe(false);
    expect(result.warnings).toBeDefined();
    expect(result.warnings[0]).toContain('eval error');
  });

  it('rejects invalid constraints', () => {
    expect(() => gate.load('x', [{ id: 'no_when' }])).toThrow('when');
    expect(() => gate.load('x', [{ when: {} }])).toThrow('id');
  });

  it('listRules returns loaded constraints', () => {
    gate.load('trader', [
      { id: 'a', when: { action: 'x' }, require: 'true', veto_message: 'msg' },
    ]);
    expect(gate.listRules('trader')).toHaveLength(1);
    expect(gate.listRules('am')).toHaveLength(0);
  });

  it('hasRules checks correctly', () => {
    expect(gate.hasRules('trader')).toBe(false);
    gate.load('trader', [{ id: 'a', when: { action: 'x' }, require: 'true', veto_message: 'm' }]);
    expect(gate.hasRules('trader')).toBe(true);
  });
});
