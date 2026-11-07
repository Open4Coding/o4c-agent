// Reference solution: the rename, in every file under src/ that has the old name.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const files = execFileSync('git', ['grep', '-l', '-w', 'PauseableEmitter', '--', 'src'], { encoding: 'utf-8' }).split('\n').filter(Boolean);
for (const f of files) writeFileSync(f, readFileSync(f, 'utf-8').replace(/\bPauseableEmitter\b/g, 'PausableEmitter'));
