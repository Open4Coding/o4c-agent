/**
 * Receiver types for member calls (plan 0006 K1, R11 #6): in `host.status()`, which `status`? If
 * this file says what `host` is - `const host = new McpHost()`, `host: McpHost`, a field
 * `private host: McpHost` or `this.host = new McpHost(...)` (TS/JS), `host = McpHost(...)` or
 * `host: McpHost` (Python) - the call goes to `status` inside class `McpHost`.
 *
 * File-scoped and textual, not a type checker: a name is typed only when every piece of evidence in
 * the file agrees, and a name with conflicting evidence (two `x`s of different classes) is left
 * untyped. That keeps the rule positive-only like the rest of resolution - it can pick a target,
 * never rule one out - and a wrong pick needs two declarations to lie the same way.
 */
const TS_LIKE = new Set(['typescript', 'tsx', 'javascript']);

const CLASS = '([A-Z][A-Za-z0-9_]*)';

/** name (or `this.name` / `self.name` written as `this.name`) -> class, for one file's source. */
export function receiverTypes(source: string, languageId: string): Map<string, string> {
  const seen = new Map<string, Set<string>>();
  const add = (name: string, type: string) => {
    let s = seen.get(name);
    if (!s) seen.set(name, (s = new Set()));
    s.add(type);
  };
  const scan = (re: RegExp, nameGroup: number, typeGroups: number[], prefix = '') => {
    for (const m of source.matchAll(re)) {
      const type = typeGroups.map((g) => m[g]).find(Boolean);
      if (type) add(prefix + m[nameGroup]!, type);
    }
  };
  if (TS_LIKE.has(languageId)) {
    // const host = new McpHost(...)   /   let host: McpHost = ...   /   const host: McpHost = new X()
    scan(new RegExp(`\\b(?:const|let|var)\\s+(\\w+)\\s*(?::\\s*${CLASS}(?:<[^=;]*>)?)?\\s*=\\s*(?:await\\s+)?new\\s+${CLASS}\\b`, 'g'), 1, [2, 3]);
    scan(new RegExp(`\\b(?:const|let|var)\\s+(\\w+)\\s*:\\s*${CLASS}\\b`, 'g'), 1, [2]);
    // A plain reassignment is evidence too - `x = new Other()` must make `x` ambiguous, not stay typed.
    scan(new RegExp(`(?<![.\\w])(\\w+)\\s*=\\s*(?:await\\s+)?new\\s+${CLASS}\\b`, 'g'), 1, [2]);
    // parameters and class fields: (host: McpHost, ...) / private readonly host: McpHost
    scan(new RegExp(`(?:[(,]|\\b(?:private|protected|public|readonly)\\s+)\\s*(?:readonly\\s+)?(\\w+)\\s*\\??:\\s*${CLASS}\\b`, 'g'), 1, [2]);
    scan(new RegExp(`(?:private|protected|public|readonly)\\s+(?:readonly\\s+)?(\\w+)\\s*\\??:\\s*${CLASS}\\b`, 'g'), 1, [2], 'this.');
    scan(new RegExp(`\\bthis\\.(\\w+)\\s*=\\s*new\\s+${CLASS}\\b`, 'g'), 1, [2], 'this.');
  } else if (languageId === 'python') {
    scan(new RegExp(`^\\s*(\\w+)\\s*(?::\\s*${CLASS})?\\s*=\\s*${CLASS}\\(`, 'gm'), 1, [2, 3]);
    scan(new RegExp(`\\bself\\.(\\w+)\\s*(?::\\s*${CLASS})?\\s*=\\s*${CLASS}\\(`, 'g'), 1, [2, 3], 'this.');
    scan(new RegExp(`[(,]\\s*(\\w+)\\s*:\\s*${CLASS}\\b`, 'g'), 1, [2]);
  }
  const out = new Map<string, string>();
  for (const [name, types] of seen) if (types.size === 1) out.set(name, [...types][0]!);
  return out;
}

/** How the receiver is written, normalised: `host`, `this.host` (also for `self.host`), else undefined. */
export function receiverKey(text: string): string | undefined {
  const t = text.trim();
  if (/^[A-Za-z_]\w*$/.test(t)) return t === 'this' || t === 'self' ? undefined : t;
  const m = /^(?:this|self)\.([A-Za-z_]\w*)$/.exec(t);
  return m ? `this.${m[1]}` : undefined;
}

/**
 * The syntax-tree field that holds a member call's receiver, per grammar: JS/TS `object`, Python
 * `object` (on `attribute`), Go `operand` (on `selector_expression`), Rust `value` (on
 * `field_expression`), Java `object` (on `method_invocation`).
 */
export const RECEIVER_FIELDS = ['object', 'operand', 'value'] as const;
