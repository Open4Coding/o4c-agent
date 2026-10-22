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
    description:
      'Ask the code index about a symbol or a file. With "name": where that name is defined, ' +
      'what kind of thing it is, and every call site, with a verdict saying how much the answer ' +
      'is worth (ok / low_confidence / absent / degraded). With "path": what that file defines ' +
      'and how many other files reference it. Resolution is by name, not by type, so overloads ' +
      'and interface dispatch are not followed, and only languages with a bundled grammar are ' +
      'covered - an empty answer is reported as such, never as silence.',
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
        from: {
          type: 'string',
          description:
            'Optional: the file the question comes from. When several files define the name, ' +
            'the one in this file is preferred, because lexical scope means that is what the ' +
            'language itself would pick.',
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
        return path ? `${answer}\n  (answered "name"; call again with only "path" for the file outline)` : answer;
      }
      if (path) return await lookup.describeFile(path);

      return 'code_graph needs either "name" (a symbol to look up) or "path" (a file to outline).';
    },
  };
}
