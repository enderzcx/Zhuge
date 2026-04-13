/**
 * Kernel Mandate Gate — role-agnostic constraint engine.
 *
 * Harness loads constraints (from YAML/JS objects). Kernel checks them
 * at capability execution time. Veto cannot be overridden by LLM.
 *
 * Usage:
 *   gate.load('trader', [{ id: 'max_pos', when: { action: 'open_position' }, require: 'position_pct <= 0.10', veto_message: '...' }])
 *   gate.check('trader', 'open_position', { position_pct: 0.15 })
 *   → { pass: false, vetoed_by: { id: 'max_pos', message: 'position 0.15 > 10%' } }
 */

import { evaluate, interpolate } from './evaluator.mjs';

/**
 * Validate a constraint definition.
 * @param {object} c
 * @returns {{ ok: boolean, errors: string[] }}
 */
function validateConstraint(c) {
  const errors = [];
  if (!c || typeof c !== 'object') return { ok: false, errors: ['constraint must be an object'] };
  if (typeof c.id !== 'string' || !c.id) errors.push('id is required');
  if (!c.when || typeof c.when !== 'object') errors.push('when must be an object');
  if (!c.require && !c.veto) errors.push('either require or veto must be specified');
  if (c.require && typeof c.require !== 'string') errors.push('require must be a string expression');
  if (typeof c.veto_message !== 'string') errors.push('veto_message is required');
  return { ok: errors.length === 0, errors };
}

/**
 * Check if a context matches a 'when' clause.
 * All keys in `when` must be present and equal in `context`.
 * @param {object} when
 * @param {string} action
 * @param {object} context
 * @returns {boolean}
 */
function matchesWhen(when, action, context) {
  for (const [key, value] of Object.entries(when)) {
    if (key === 'action') {
      if (action !== value) return false;
    } else {
      if (context[key] !== value) return false;
    }
  }
  return true;
}

/**
 * Create a Mandate Gate instance.
 * @returns {MandateGate}
 */
export function createMandateGate() {
  /** @type {Map<string, object[]>} harnessName → constraints[] */
  const rulesets = new Map();

  /**
   * Load constraints for a harness.
   * @param {string} harnessName - e.g. 'trader', 'am'
   * @param {object[]} constraints
   * @throws if any constraint is invalid
   */
  function load(harnessName, constraints) {
    if (!Array.isArray(constraints)) throw new Error('constraints must be an array');

    for (const c of constraints) {
      const { ok, errors } = validateConstraint(c);
      if (!ok) throw new Error(`Invalid constraint '${c?.id}': ${errors.join(', ')}`);
    }

    rulesets.set(harnessName, [...constraints]);
  }

  /**
   * Check an action against loaded constraints.
   *
   * @param {string} harnessName - which harness's rules to check
   * @param {string} action - e.g. 'open_position', 'rebalance'
   * @param {object} context - all variables available for evaluation
   * @returns {{ pass: boolean, vetoed_by?: { id: string, message: string }, warnings?: string[] }}
   */
  function check(harnessName, action, context) {
    const constraints = rulesets.get(harnessName);
    if (!constraints || constraints.length === 0) {
      return { pass: true, warnings: [`no constraints loaded for harness '${harnessName}'`] };
    }

    const warnings = [];

    for (const c of constraints) {
      // Does this constraint apply to this action?
      if (!matchesWhen(c.when, action, context)) continue;

      // Unconditional veto
      if (c.veto === true) {
        return {
          pass: false,
          vetoed_by: {
            id: c.id,
            message: interpolate(c.veto_message, { ...context, action }),
          },
        };
      }

      // Conditional veto (require expression must be truthy)
      if (c.require) {
        try {
          const result = evaluate(c.require, { ...context, action });
          if (!result) {
            return {
              pass: false,
              vetoed_by: {
                id: c.id,
                message: interpolate(c.veto_message, { ...context, action }),
              },
            };
          }
        } catch (err) {
          // Expression eval error → fail-closed (veto)
          warnings.push(`constraint '${c.id}' eval error: ${err.message}`);
          return {
            pass: false,
            vetoed_by: {
              id: c.id,
              message: `Mandate eval error (fail-closed): ${err.message}`,
            },
            warnings,
          };
        }
      }
    }

    return { pass: true, warnings: warnings.length > 0 ? warnings : undefined };
  }

  /**
   * List loaded constraints for a harness.
   * @param {string} harnessName
   * @returns {object[]}
   */
  function listRules(harnessName) {
    return rulesets.get(harnessName) || [];
  }

  /**
   * Check if any constraints are loaded for a harness.
   * @param {string} harnessName
   * @returns {boolean}
   */
  function hasRules(harnessName) {
    const rules = rulesets.get(harnessName);
    return rules ? rules.length > 0 : false;
  }

  return { load, check, listRules, hasRules };
}
