import type { Tool } from './types.js';
import { readFileTool } from './readFile.js';
import { writeFileTool } from './writeFile.js';
import { editFileTool } from './editFile.js';
import { runShellTool } from './runShell.js';
import { globTool } from './glob.js';
import { grepTool } from './grep.js';
import { jobOutputTool } from './jobs.js';
import { askUserTool } from './askUser.js';
import { skillTool } from '../session/skills.js';
import { webFetchTool, webSearchTool } from './web.js';

export const defaultTools: Tool[] = [readFileTool, writeFileTool, editFileTool, runShellTool, globTool, grepTool, jobOutputTool, askUserTool, skillTool, webFetchTool, webSearchTool];

export type { Tool } from './types.js';
