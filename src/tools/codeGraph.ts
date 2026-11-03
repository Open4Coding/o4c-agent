import type { Tool } from './types.js';
import type { CodeGraphLookup } from '../graph/toolHook.js';

/**
 * One verb, not twelve.
 *
 * `0000.DECISION.md` step 4 is explicit about this, and it is worth restating because the
 * temptation runs the other way: an index this shape could easily expose a dozen tools
 * (`find_definition`, `find_callers`, `file_outline`, `search_symbols`, ...). Every one of them
 * costs schema tokens on every single request for the life of the session, and the model has to
 * pick correctly between them before it has seen any of their output. One tool with two optional
 * arguments covers both questions the index can actually answer.
 *
 * This is the **pull** surface: the model calls it when it wants to know. `19.Graft.md`'s
 * controlled sweep measured pull at 98% correctness against 93% for pushing an equivalent bundle
 * into the prefix, which is why nothing about the graph is injected ahead of a request.
 *
 * The tool holds no state and knows nothing about indexing - it is a thin front for
 * `CodeGraphComponent`, which owns the store. That keeps `defaultTools` free of a database
 * handle and makes this testable against a stub.
 */
export function createCodeGraphTool(lookup: CodeGraphLookup): Tool {
  return {
    name: 'code_graph',
    // Kept short on purpose (K4b): this text rides on every request, and the eval A/B (K4) measured
    // ~400 tokens a request for the old version against 13 calls in 60 tasks. What the verdicts and
    // the +N markers mean needs no saying here: every answer carries its verdict's own note, and the
    // call-site line opens with its total ("12 call sites: ..."), which is where it gets read.
    description:
      'Look up the code index. "name": where a symbol is defined and its call sites by file, with a ' +
      'verdict (ok / low_confidence / absent / degraded). "path": a file skeleton - definitions with ' +
      'lines and signatures - and how many files reference it. Prefer it to grep for definitions and ' +
      'callers; grep for text that is not a call.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'A symbol to look up, e.g. "resolveCallEdges". Exact, case-sensitive.',
        },
        path: {
          type: 'string',
          description: 'A file to outline instead, relative to the project root.',
        },
        source: {
          type: 'boolean',
          description: 'With "name": also return the definition code (instead of reading the whole file).',
        },
        from: {
          type: 'string',
          description: 'Optional: the file asking; its own definition wins when several files define the name.',
        },
      },
    },
    async execute(input) {
      const name = typeof input.name === 'string' ? input.name.trim() : '';
      const path = typeof input.path === 'string' ? input.path.trim() : '';

      // Both is not an error worth refusing - answer the symbol question, which is the one that
      // needs an index to answer at all, and say which was used so the result is never ambiguous
      // about what it describes.
      if (name) {
        const from = typeof input.from === 'string' && input.from.trim() ? input.from.trim() : undefined;
        const answer = lookup.describeName(name, from);
        const source = input.source === true ? `\n${await lookup.describeSource(name, from)}` : '';
        return path ? `${answer}${source}\n  (answered "name"; call again with only "path" for the file outline)` : `${answer}${source}`;
      }
      if (path) return await lookup.describeFile(path);

      return 'code_graph needs either "name" (a symbol to look up) or "path" (a file to outline).';
    },
  };
}
