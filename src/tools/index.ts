import type { Tool } from './types.js';
import { readFileTool } from './readFile.js';
import { writeFileTool } from './writeFile.js';
import { runShellTool } from './runShell.js';

export const defaultTools: Tool[] = [readFileTool, writeFileTool, runShellTool];

export type { Tool } from './types.js';
