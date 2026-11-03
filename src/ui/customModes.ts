import { MODES, type Mode } from './modePolicy.js';

/**
 * Custom modes (plan 0006 G10): a mode of the user's own, on top of a built-in one -
 *
 *   "modes": [
 *     { "name": "review", "base": "plan", "note": "Review only: report findings, change nothing." },
 *     { "name": "docs", "base": "acceptEdits", "note": "Only touch Markdown files.", "tools": ["read_file", "write_file", "edit_file", "grep_files", "glob_files"] }
 *   ]
 *
 * `base` decides what is allowed and what asks first, exactly as that built-in mode does; `note` is
 * added to the mode's instruction to the model; `tools`, when given, is the only tools the model
 * may use in this mode. Tab cycles the built-in five, then these; `/mode <name>` picks one. The
 * active one is remembered (config `customMode`) so the per-turn reload keeps it.
 */
export interface CustomMode {
  name: string;
  base: Mode;
  note?: string;
  tools?: string[];
  color?: string;
}

export const CUSTOM_MODE_KEY = 'customMode';

export function parseCustomModes(raw: unknown): { modes: CustomMode[]; problems: string[] } {
  const modes: CustomMode[] = [];
  const problems: string[] = [];
  if (raw === undefined) return { modes, problems };
  if (!Array.isArray(raw)) return { modes, problems: ['"modes" must be a list of { name, base, note?, tools? }.'] };
  const builtIn = new Set(MODES.map((m) => m.mode as string));
  const builtInLabels = new Set(MODES.map((m) => m.label.toLowerCase()));
  raw.forEach((m, i) => {
    const o = (m && typeof m === 'object' ? m : {}) as Record<string, unknown>;
    const name = typeof o.name === 'string' ? o.name.trim().toLowerCase() : '';
    if (!/^[a-z][a-z0-9-]*$/.test(name)) return void problems.push(`modes[${i}]: "name" must be a simple word (letters, digits, -).`);
    if (builtIn.has(name) || builtInLabels.has(name)) return void problems.push(`modes[${i}]: "${name}" is a built-in mode's name.`);
    if (modes.some((x) => x.name === name)) return void problems.push(`modes[${i}]: "${name}" is defined twice.`);
    if (typeof o.base !== 'string' || !builtIn.has(o.base)) return void problems.push(`modes[${i}] "${name}": "base" must be one of ${[...builtIn].join(', ')}.`);
    const tools = Array.isArray(o.tools) ? o.tools.filter((t): t is string => typeof t === 'string') : undefined;
    modes.push({
      name,
      base: o.base as Mode,
      ...(typeof o.note === 'string' && o.note.trim() ? { note: o.note.trim() } : {}),
      ...(tools && tools.length ? { tools } : {}),
      ...(typeof o.color === 'string' ? { color: o.color } : {}),
    });
  });
  return { modes, problems };
}

let defined: CustomMode[] = [];
let initial: string | undefined;

/** Set by cli.ts at startup: the modes from config, and the one that was active last time. */
export function setCustomModes(modes: CustomMode[], activeName?: string): void {
  defined = modes;
  initial = activeName && modes.some((m) => m.name === activeName) ? activeName : undefined;
}

export function customModes(): readonly CustomMode[] {
  return defined;
}

export function initialCustomMode(): CustomMode | undefined {
  return defined.find((m) => m.name === initial);
}

export function findCustomMode(name: string): CustomMode | undefined {
  return defined.find((m) => m.name === name.trim().toLowerCase());
}

/** The Tab order: each built-in mode, then each custom one. */
export function modeCycle(): { mode: Mode; custom?: CustomMode }[] {
  return [...MODES.map((m) => ({ mode: m.mode })), ...defined.map((c) => ({ mode: c.base, custom: c }))];
}

export function nextInCycle(mode: Mode, custom: CustomMode | undefined): { mode: Mode; custom?: CustomMode } {
  const cycle = modeCycle();
  const i = cycle.findIndex((e) => (custom ? e.custom?.name === custom.name : !e.custom && e.mode === mode));
  return cycle[(i + 1) % cycle.length]!;
}

/** Why `toolName` is off-limits in this custom mode, or undefined. */
export function customModeGate(custom: CustomMode | undefined, toolName: string): string | undefined {
  if (!custom?.tools || custom.tools.includes(toolName)) return undefined;
  return `the "${custom.name}" mode allows only ${custom.tools.join(', ')}`;
}

/** The base mode's instruction with the custom note after it. */
export function withCustomNote(base: string | undefined, custom: CustomMode | undefined): string | undefined {
  if (!custom?.note) return base;
  const note = `Mode "${custom.name}": ${custom.note}`;
  return base ? `${base}\n\n${note}` : note;
}
