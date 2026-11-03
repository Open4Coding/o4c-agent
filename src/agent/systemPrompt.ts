/**
 * The system prompt o4c sends (plan 0006 B1): an assembled document of sections, with a model
 * profile choosing how much of it, and in what notation the example is written.
 *
 * It must stay byte-identical for a whole session (A5): anything that can change mid-session (mode,
 * plan, git state, date) goes in a turn note instead. So sections are gated only by things fixed at
 * startup - the session's tool set and the profile - never by mode.
 */

export type PromptProfile = 'default' | 'qwen' | 'small';
export const PROMPT_PROFILES: readonly PromptProfile[] = ['default', 'qwen', 'small'];
export const PROMPT_PROFILE_CONFIG_KEY = 'promptProfile';

/**
 * The profile for a model: config `promptProfile` when it names one, else by model id - Qwen gets
 * an example in its own tool-call notation, a model of under 10B parameters the short prompt.
 */
export function promptProfileFor(modelId: string | undefined, configured?: unknown): PromptProfile {
  if (typeof configured === 'string' && (PROMPT_PROFILES as readonly string[]).includes(configured)) return configured as PromptProfile;
  const id = modelId ?? '';
  if (/(^|[^0-9.])[1-9](\.\d+)?b\b/i.test(id)) return 'small';
  if (/qwen/i.test(id)) return 'qwen';
  return 'default';
}

export interface PromptInput {
  profile: PromptProfile;
  /** Names of the tools this session starts with; lines about other tools are left out. */
  tools: readonly string[];
  /** Environment lines fixed for the session: working directory, platform and shell. */
  environment: readonly string[];
  /** The O4C.md cascade, already resolved (empty when the project is untrusted or has none). */
  projectContext?: string;
  /** G2: the skills listing (one line per skill), fixed for the session. */
  skills?: string;
}

export interface PromptSection {
  name: string;
  text: string;
}

const IDENTITY = `You are o4c, a coding agent working in the user's project through tools. You read and change files and run commands to do what the user asks, then report what you did.`;

const RULES = `# Rules
- Read a file before you change it, and match its existing style, naming and structure.
- Do not assume a library, command or file exists; check first.
- Make the smallest change that does the job. Do not refactor, reformat or add features nobody asked for.
- Do not revert or overwrite changes you did not make unless asked.
- If a tool call is denied, do not get the same effect another way; ask or stop.`;

const WORKFLOW = `# How to work
1. Locate: search for the relevant code and read it before deciding anything.
2. For a bug, find the cause first: reproduce it or point to the exact line.
3. Change the code.
4. Verify: run the project's tests, or the code itself, when there is a way to. Fix what fails.
5. Report briefly what you changed and how you verified it.`;

const REPORTING = `# Reporting
- Never say a test passed or code works unless you ran it in this session and saw it succeed. If you could not verify something, say so.
- If you are stuck or the request is unclear, say so instead of guessing.
- Keep answers short and direct.`;

/** One line per tool, kept only when every tool it names is in the session. */
const TOOL_LINES: ReadonlyArray<{ needs: string[]; text: string }> = [
  { needs: ['read_file', 'grep_files', 'glob_files'], text: 'Look at the project with read_file, grep_files and glob_files, not shell commands such as cat, grep, find or dir.' },
  { needs: ['code_graph'], text: 'To find where a function, class or method is defined or used, ask code_graph before searching the text.' },
  { needs: ['edit_file'], text: 'Change an existing file with edit_file. old_string must match the file exactly, indentation included, and be unique; include a few surrounding lines if needed.' },
  { needs: ['write_file'], text: 'Use write_file only for a new file or a complete rewrite, and always write the whole file - never "..." or "rest unchanged".' },
  { needs: ['run_shell'], text: 'run_shell commands must not wait for input: no editors, pagers or prompts; pass the flags that make a command non-interactive.' },
  { needs: [], text: 'When several reads or searches do not depend on each other, make all of those calls in one response.' },
  { needs: [], text: 'When a tool result says o4c truncated it and gives a file path, read that file with read_file offset/limit only if you need the rest.' },
];

function toolSection(tools: ReadonlySet<string>): string {
  const lines = TOOL_LINES.filter((l) => l.needs.every((n) => tools.has(n))).map((l) => `- ${l.text}`);
  return `# Tools\n${lines.join('\n')}`;
}

/** Qwen writes tool calls in this XML form (its chat template's own); the example shows the rhythm in it. */
function qwenExample(tools: ReadonlySet<string>): string | undefined {
  if (!['run_shell', 'read_file', 'edit_file'].every((n) => tools.has(n))) return undefined;
  const call = (name: string, params: Record<string, string>) =>
    [
      '<tool_call>',
      `<function=${name}>`,
      ...Object.entries(params).flatMap(([k, v]) => [`<parameter=${k}>`, v, '</parameter>']),
      '</function>',
      '</tool_call>',
    ].join('\n');
  return [
    '# Example',
    'user: the tests in test/math.test.js fail',
    'assistant: Running the tests to see the failure.',
    call('run_shell', { command: 'node --test test/math.test.js' }),
    '(result: "expected 5, got 6" in add, src/math.js:3)',
    'assistant: Reading src/math.js.',
    call('read_file', { path: 'src/math.js' }),
    '(result: line 3 is `  return a + b + 1;`)',
    'assistant: add() adds an extra 1. Fixing it.',
    call('edit_file', { path: 'src/math.js', old_string: '  return a + b + 1;', new_string: '  return a + b;' }),
    call('run_shell', { command: 'node --test test/math.test.js' }),
    '(result: all tests pass)',
    'assistant: Fixed add() in src/math.js - it added an extra 1. The tests in test/math.test.js now pass.',
  ].join('\n');
}

const SMALL_RULES = `# Rules
- Read a file before changing it. Make the smallest change that does the job.
- Use read_file, grep_files and glob_files to look around; edit_file to change a file (old_string must match exactly).
- Verify with the project's tests when you can. Never claim something works unless you saw it work.`;

export function promptSections(input: PromptInput): PromptSection[] {
  const tools = new Set(input.tools);
  const sections: PromptSection[] = [{ name: 'identity', text: IDENTITY }];
  if (input.profile === 'small') {
    sections.push({ name: 'rules', text: SMALL_RULES });
  } else {
    sections.push(
      { name: 'rules', text: RULES },
      { name: 'workflow', text: WORKFLOW },
      { name: 'tools', text: toolSection(tools) },
      { name: 'reporting', text: REPORTING },
    );
    const example = input.profile === 'qwen' ? qwenExample(tools) : undefined;
    if (example) sections.push({ name: 'example', text: example });
  }
  if (input.environment.length > 0) sections.push({ name: 'environment', text: `# Environment\n${input.environment.join('\n')}` });
  if (input.skills?.trim()) sections.push({ name: 'skills', text: input.skills });
  if (input.projectContext?.trim()) sections.push({ name: 'project', text: input.projectContext });
  return sections;
}

let built: { profile: PromptProfile; sections: PromptSection[] } | undefined;

export function buildSystemPrompt(input: PromptInput): string {
  const sections = promptSections(input);
  built = { profile: input.profile, sections };
  return sections.map((s) => s.text).join('\n\n');
}

/** The prompt this process built, section by section - for `/view-prompt`. */
export function builtSystemPrompt(): { profile: PromptProfile; sections: PromptSection[] } | undefined {
  return built;
}
