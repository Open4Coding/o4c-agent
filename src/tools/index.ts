import type { Tool } from './types.js';
import { readFileTool } from './readFile.js';
import { writeFileTool } from './writeFile.js';
import { runShellTool } from './runShell.js';
import { globTool } from './glob.js';
import { grepTool } from './grep.js';

export const defaultTools: Tool[] = [readFileTool, writeFileTool, runShellTool, globTool, grepTool];

export type { Tool } from './types.js';
