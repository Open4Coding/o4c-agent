/**
 * The Code Graph's bundled language set - build step 1 of
 * `docs/research/code-graph/0000.DECISION.md`, revised 2026-10-18 against the Stack Overflow
 * top-20 usage ranking (`0002.TOP20-LANGUAGE-POLICY.md`).
 *
 * **Everything loadable is bundled.** The earlier plan shipped seven grammars to keep the
 * install small; that was based on a disk figure mistaken for a download cost. Measured: the
 * full payload is 25.07 MB on disk but **2.26 MB gzipped** - a 10.7x ratio, because WASM parse
 * tables are highly repetitive - and an unused grammar costs *nothing* at runtime because
 * loading is lazy. A ~2 MB download for every common language is the better trade.
 *
 * What is *not* bundled is therefore only what cannot be: SQL and Assembly have no
 * ABI-compatible prebuilt WASM anywhere that was found, and building from source needs a
 * toolchain, which would destroy the zero-native-modules property. There is deliberately no
 * fetch-on-demand path either: fetching is egress and secure mode forbids egress.
 *
 * **ABI compatibility is the real constraint, not size.** Grammars must be built against a
 * runtime this `web-tree-sitter` can load. `tree-sitter-wasms@0.1.13` carries 36 grammars and
 * **every one of them fails to load** under 0.27.1; `@repomix/tree-sitter-wasms@0.1.17` and
 * `@vscode/tree-sitter-wasm@0.3.1` both load cleanly. A size-optimising pass across those
 * payloads silently swapped working grammars for broken ones during this build, including
 * breaking Rust, which is why `codeGraphTags.test.ts` now load-tests every bundled grammar.
 *
 * A language is registered here **only if its tag query extracts references as well as
 * definitions**. A grammar with a definitions-only query yields a graph with nodes and no
 * edges, which is worse than absent because it looks like coverage.
 *
 * Further grammars are reachable by pointing `O4C_WASM_DIR` at a directory - see
 * `grammarPaths.ts`.
 */

/** A language the Code Graph can parse out of the box. */
export interface GraphLanguage {
  /** Stable id. Doubles as the `.wasm` suffix and the `.scm` basename. */
  readonly id: string;
  /** Lower-case file extensions, leading dot included. */
  readonly extensions: readonly string[];
  /**
   * Whether this language's tag query captures `o.f()` differently from `f()`.
   *
   * A property of the bundled **query file**, not of the language, which is why it is recorded
   * here beside the query's basename rather than inferred at resolution. Most of the bundled
   * queries use one capture for every invocation: Java emits `name.reference.method` for both
   * shapes and Python emits `name.reference.call` for both, so for those the stored kind says
   * nothing about the shape and resolution must read nothing into it.
   */
  readonly distinguishesCallShape?: true;
  /**
   * Definition kinds no call can reach: a TypeScript `type` alias or `interface` exists only at
   * compile time, so `f()` never refers to one. Listed per language because it is not true
   * everywhere - Go's `T(x)` is a conversion its query records as a call, and a Python class is
   * called to construct it.
   */
  readonly typeOnlyKinds?: readonly string[];
}

/** A `type` alias, `interface`, `enum` or `namespace` (`module`): none of them can be called. */
const TS_TYPE_ONLY = ['type', 'interface', 'enum', 'module'] as const;

/**
 * The bundled set, ordered by Stack Overflow 2025 usage rank so the list reads as a coverage
 * statement rather than an accident of implementation order.
 *
 * No JSON and no Markdown grammar, on purpose. Neither yields definitions or references, so
 * neither feeds the graph; a Markdown outline is a regex over `^#{1,6} ` and a JSON outline is
 * `JSON.parse` plus a key walk. Shipping grammars for them would be payload for a
 * `read`-projection feature that does not need them.
 *
 * Grammars present in `grammars/wasm/` but deliberately **not** registered, because no tag
 * query exists for them yet: `css`, `html`, `powershell`, `solidity`, `vue`. CSS/HTML need a
 * different extraction model entirely - selector defined -> class/id referenced, not
 * definitions and calls - which is its own design task. Until a query lands, a `.css` file
 * must report `degraded`, never an empty result.
 */
export const DEFAULT_LANGUAGES: readonly GraphLanguage[] = [
  // rank 1
  { id: 'javascript', extensions: ['.js', '.mjs', '.cjs', '.jsx'], distinguishesCallShape: true },
  // rank 4
  { id: 'python', extensions: ['.py', '.pyi'] },
  // rank 5 - a shell script's call graph really is its command invocations
  { id: 'bash', extensions: ['.sh', '.bash', '.zsh'] },
  // rank 6
  {
    id: 'typescript',
    extensions: ['.ts', '.mts', '.cts'],
    distinguishesCallShape: true,
    typeOnlyKinds: TS_TYPE_ONLY,
  },
  { id: 'tsx', extensions: ['.tsx'], distinguishesCallShape: true, typeOnlyKinds: TS_TYPE_ONLY },
  // rank 7
  // An interface cannot be invoked, and `module` is a namespace.
  { id: 'c_sharp', extensions: ['.cs'], typeOnlyKinds: ['interface', 'module'] },
  // rank 8
  { id: 'java', extensions: ['.java'], typeOnlyKinds: ['interface'] },
  // rank 10 - reference patterns authored here; macros stay invisible.
  // `.h` is deliberately claimed by C++ rather than C: the extension is genuinely ambiguous,
  // and the two failure modes are not symmetric. A C header parsed by the C++ grammar parses
  // cleanly, because C++ is very nearly a superset; a C++ header parsed by the C grammar hits
  // templates, classes and namespaces and collapses into ERROR nodes, yielding no tags at all.
  { id: 'cpp', extensions: ['.cpp', '.cc', '.cxx', '.hpp', '.hh', '.hxx', '.h'] },
  // rank 11
  { id: 'c', extensions: ['.c'] },
  // rank 12
  { id: 'php', extensions: ['.php'] },
  // rank 13
  // `module` is the package name. Not `type` or `interface`: `T(x)` and `I(x)` are conversions.
  { id: 'go', extensions: ['.go'], typeOnlyKinds: ['module'] },
  // rank 14
  // A trait (`interface`) and a `mod`. Not `class`: a tuple struct is constructed as `S(x)`.
  { id: 'rust', extensions: ['.rs'], typeOnlyKinds: ['interface', 'module'] },
  // rank 17
  // `Foo()` reaches a method named Foo, never the module.
  { id: 'ruby', extensions: ['.rb'], typeOnlyKinds: ['module'] },
  // rank 18
  // Not `type`: a Dart typedef can be used to construct.
  { id: 'dart', extensions: ['.dart'], typeOnlyKinds: ['mixin', 'enum'] },
  // rank 20 - reference patterns authored here
  // A protocol (`interface`) cannot be invoked.
  { id: 'swift', extensions: ['.swift'], typeOnlyKinds: ['interface'] },
];

const BY_EXTENSION = new Map<string, GraphLanguage>(
  DEFAULT_LANGUAGES.flatMap((lang) => lang.extensions.map((ext) => [ext, lang] as const)),
);

const BY_ID = new Map<string, GraphLanguage>(DEFAULT_LANGUAGES.map((lang) => [lang.id, lang]));

/**
 * The language for a path, or `undefined` when nothing in the set claims it.
 *
 * `undefined` is a real answer and callers must not read it as "this file has no definitions".
 * An unparseable file makes the graph `degraded` for that file; it does not make it empty. That
 * distinction is the whole reason the four-state verdict exists, and it applies under every
 * grammar-shipping policy - no payload covers every language that exists.
 */
export function languageForPath(path: string): GraphLanguage | undefined {
  const dot = path.lastIndexOf('.');
  if (dot < 0) return undefined;
  return BY_EXTENSION.get(path.slice(dot).toLowerCase());
}

/** The language with this id, or `undefined`. */
export function languageById(id: string): GraphLanguage | undefined {
  return BY_ID.get(id);
}
