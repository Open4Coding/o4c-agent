/**
 * Tips (plan 0006 E5): one line at the start of a fresh session, a different one each time, about
 * something o4c can do that a user would not find by accident. `/tips off` stops them (config
 * `showTips`). Never shown during a turn.
 */
export const TIPS: readonly string[] = [
  '/undo puts your files back as they were before the last turn - o4c keeps its own checkpoints, your .git is untouched.',
  'Press Enter while the model works to steer it at its next step; Ctrl+Q queues a message for after the turn instead.',
  '/btw asks a side question about the conversation without adding it to the conversation.',
  '/status shows the model, context fill, cache share and every feature that is on, in one screen.',
  '/doctor checks your setup - Node, config files, the server, a real tool call - and says how to fix what fails.',
  '/help <question> searches the o4c docs locally, without asking the model.',
  '/compact <focus> summarizes the older conversation now and keeps what you name in detail.',
  'Ctrl+T makes the model stop thinking and answer now.',
  '/think sets how hard the model thinks - off, low, med, high, xhigh.',
  '/context shows where the tokens of each request go, bucket by bucket.',
  '/memory lists what o4c remembers across sessions; ask the model to "remember" a rule and it will.',
  '/rewind goes back to before any turn - the files, the conversation, or both.',
  '/view-permissions shows your allow/ask/deny rules; "Yes, and always allow" in an approval adds one.',
  '/init drafts an O4C.md from your project\'s own files - commands, layout, languages.',
  'o4c reads AGENTS.md or CLAUDE.md when a project has no O4C.md.',
  'run_shell can start a server in the background; /ps lists background jobs and /kill stops one.',
  '/set-shell picks the shell commands run in - cmd, PowerShell 7, bash.',
  '/review has the model review this session\'s changes, read-only.',
  '/all lists every command, including the hidden ones.',
  'The code_graph tool finds where a function is defined and who calls it, without grepping.',
  '/diff shows what changed in your files during this session.',
  '/reflect proposes lessons from recent finished tasks; you pick which to keep.',
  'Tab cycles the modes: Manual asks before changes, Auto does not, Plan only reads.',
  '/view-prompt shows the exact system prompt o4c sends, section by section.',
  'A .o4cignore file (gitignore syntax) keeps files out of o4c\'s reach.',
  '/queue lets you edit or drop messages waiting to run after the current turn.',
];

export const SHOW_TIPS_KEY = 'showTips';
export const TIP_COUNTER_KEY = 'tipCounter';

/** The tip for this start, rotating through the list. */
export function tipFor(counter: number): string {
  return TIPS[((counter % TIPS.length) + TIPS.length) % TIPS.length]!;
}
