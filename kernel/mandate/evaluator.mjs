/**
 * Safe expression evaluator for mandate constraints.
 *
 * Supports a minimal subset:
 *   - Comparisons: <, <=, >, >=, ==, !=
 *   - Logical: &&, ||, !
 *   - Membership: `x in [a, b, c]` or `x in varName`
 *   - Literals: numbers, strings (single/double quoted), booleans, null
 *   - Variables: resolved from a context object
 *   - Parentheses for grouping
 *
 * NO eval(), NO new Function(). Pure tokenizer + recursive descent parser.
 */

/** Token types. */
const T = {
  NUMBER: 'NUMBER',
  STRING: 'STRING',
  BOOL: 'BOOL',
  NULL: 'NULL',
  IDENT: 'IDENT',
  OP: 'OP',
  LPAREN: 'LPAREN',
  RPAREN: 'RPAREN',
  LBRACKET: 'LBRACKET',
  RBRACKET: 'RBRACKET',
  COMMA: 'COMMA',
  NOT: 'NOT',
  IN: 'IN',
  EOF: 'EOF',
};

/**
 * Tokenize an expression string.
 * @param {string} expr
 * @returns {Array<{ type: string, value: any }>}
 */
function tokenize(expr) {
  const tokens = [];
  let i = 0;

  while (i < expr.length) {
    // Skip whitespace
    if (/\s/.test(expr[i])) { i++; continue; }

    // Two-char operators
    const two = expr.slice(i, i + 2);
    if (['<=', '>=', '==', '!=', '&&', '||'].includes(two)) {
      tokens.push({ type: T.OP, value: two });
      i += 2;
      continue;
    }

    // Single-char operators
    if ('<>'.includes(expr[i])) {
      tokens.push({ type: T.OP, value: expr[i] });
      i++;
      continue;
    }

    // Parens, brackets, comma, not
    if (expr[i] === '(') { tokens.push({ type: T.LPAREN }); i++; continue; }
    if (expr[i] === ')') { tokens.push({ type: T.RPAREN }); i++; continue; }
    if (expr[i] === '[') { tokens.push({ type: T.LBRACKET }); i++; continue; }
    if (expr[i] === ']') { tokens.push({ type: T.RBRACKET }); i++; continue; }
    if (expr[i] === ',') { tokens.push({ type: T.COMMA }); i++; continue; }
    if (expr[i] === '!') { tokens.push({ type: T.NOT }); i++; continue; }

    // Numbers (including negative with leading -)
    if (/[0-9]/.test(expr[i]) || (expr[i] === '-' && i + 1 < expr.length && /[0-9]/.test(expr[i + 1]) && (tokens.length === 0 || [T.OP, T.LPAREN, T.LBRACKET, T.COMMA].includes(tokens[tokens.length - 1].type)))) {
      let num = '';
      if (expr[i] === '-') { num += '-'; i++; }
      while (i < expr.length && /[0-9.]/.test(expr[i])) { num += expr[i]; i++; }
      tokens.push({ type: T.NUMBER, value: parseFloat(num) });
      continue;
    }

    // Strings
    if (expr[i] === '"' || expr[i] === "'") {
      const quote = expr[i];
      i++;
      let str = '';
      while (i < expr.length && expr[i] !== quote) { str += expr[i]; i++; }
      i++; // closing quote
      tokens.push({ type: T.STRING, value: str });
      continue;
    }

    // Identifiers, keywords (true, false, null, in)
    if (/[a-zA-Z_]/.test(expr[i])) {
      let id = '';
      while (i < expr.length && /[a-zA-Z0-9_.]/.test(expr[i])) { id += expr[i]; i++; }
      if (id === 'true') tokens.push({ type: T.BOOL, value: true });
      else if (id === 'false') tokens.push({ type: T.BOOL, value: false });
      else if (id === 'null') tokens.push({ type: T.NULL, value: null });
      else if (id === 'in') tokens.push({ type: T.IN });
      else tokens.push({ type: T.IDENT, value: id });
      continue;
    }

    throw new Error(`Unexpected character '${expr[i]}' at position ${i}`);
  }

  tokens.push({ type: T.EOF });
  return tokens;
}

/**
 * Resolve a dotted identifier from context.
 * e.g. 'mandate.allowed_instruments' → context.mandate.allowed_instruments
 * @param {string} path
 * @param {object} ctx
 * @returns {*}
 */
function resolve(path, ctx) {
  const parts = path.split('.');
  let val = ctx;
  for (const p of parts) {
    if (val == null || typeof val !== 'object') return undefined;
    val = val[p];
  }
  return val;
}

/**
 * Recursive descent parser + evaluator.
 */
class Parser {
  constructor(tokens, ctx) {
    this.tokens = tokens;
    this.ctx = ctx;
    this.pos = 0;
  }

  peek() { return this.tokens[this.pos]; }
  advance() { return this.tokens[this.pos++]; }

  expect(type) {
    const tok = this.advance();
    if (tok.type !== type) throw new Error(`Expected ${type}, got ${tok.type}`);
    return tok;
  }

  /** Entry: parse a full expression. */
  parse() {
    const result = this.parseOr();
    if (this.peek().type !== T.EOF) {
      throw new Error(`Unexpected token: ${JSON.stringify(this.peek())}`);
    }
    return result;
  }

  /** ||  */
  parseOr() {
    let left = this.parseAnd();
    while (this.peek().type === T.OP && this.peek().value === '||') {
      this.advance();
      const right = this.parseAnd();
      left = left || right;
    }
    return left;
  }

  /** &&  */
  parseAnd() {
    let left = this.parseNot();
    while (this.peek().type === T.OP && this.peek().value === '&&') {
      this.advance();
      const right = this.parseNot();
      left = left && right;
    }
    return left;
  }

  /** ! (unary not) */
  parseNot() {
    if (this.peek().type === T.NOT) {
      this.advance();
      return !this.parseNot();
    }
    return this.parseComparison();
  }

  /** <, <=, >, >=, ==, != and 'in' */
  parseComparison() {
    let left = this.parseAtom();

    // Handle 'in' operator
    if (this.peek().type === T.IN) {
      this.advance();
      const right = this.parseAtom();
      if (Array.isArray(right)) return right.includes(left);
      if (typeof right === 'string') return right.includes(left);
      return false;
    }

    if (this.peek().type === T.OP && ['<', '<=', '>', '>=', '==', '!='].includes(this.peek().value)) {
      const op = this.advance().value;
      const right = this.parseAtom();
      switch (op) {
        case '<':  return left < right;
        case '<=': return left <= right;
        case '>':  return left > right;
        case '>=': return left >= right;
        case '==': return left == right;
        case '!=': return left != right;
      }
    }

    return left;
  }

  /** Atoms: literals, identifiers, parenthesized expressions, arrays */
  parseAtom() {
    const tok = this.peek();

    if (tok.type === T.NUMBER) { this.advance(); return tok.value; }
    if (tok.type === T.STRING) { this.advance(); return tok.value; }
    if (tok.type === T.BOOL)   { this.advance(); return tok.value; }
    if (tok.type === T.NULL)   { this.advance(); return tok.value; }

    if (tok.type === T.IDENT) {
      this.advance();
      return resolve(tok.value, this.ctx);
    }

    if (tok.type === T.LPAREN) {
      this.advance();
      const val = this.parseOr();
      this.expect(T.RPAREN);
      return val;
    }

    if (tok.type === T.LBRACKET) {
      this.advance();
      const items = [];
      while (this.peek().type !== T.RBRACKET) {
        items.push(this.parseOr());
        if (this.peek().type === T.COMMA) this.advance();
      }
      this.expect(T.RBRACKET);
      return items;
    }

    throw new Error(`Unexpected token: ${JSON.stringify(tok)}`);
  }
}

/**
 * Evaluate a constraint expression against a context.
 * @param {string} expr - e.g. 'position_pct <= 0.10'
 * @param {object} ctx - variable context
 * @returns {boolean}
 */
export function evaluate(expr, ctx) {
  const tokens = tokenize(expr);
  const parser = new Parser(tokens, ctx);
  return !!parser.parse();
}

/**
 * Interpolate template variables in a message string.
 * @param {string} template - e.g. 'position {position_pct} > 10%'
 * @param {object} ctx
 * @returns {string}
 */
export function interpolate(template, ctx) {
  return template.replace(/\{([a-zA-Z0-9_.]+)\}/g, (_, key) => {
    const val = resolve(key, ctx);
    return val !== undefined ? String(val) : `{${key}}`;
  });
}
