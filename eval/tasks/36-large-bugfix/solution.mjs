// Reference solution: the helper returns -1 again.
import { readFileSync, writeFileSync } from 'node:fs';

const f = 'src/vs/base/common/strings.ts';
const s = readFileSync(f, 'utf-8');
const bug = '\t\t\treturn i;\n\t\t}\n\t}\n\treturn str.length;\n}';
if (!s.includes(bug)) throw new Error('planted bug not found');
writeFileSync(f, s.replace(bug, '\t\t\treturn i;\n\t\t}\n\t}\n\treturn -1;\n}'));
