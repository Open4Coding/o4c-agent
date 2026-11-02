#!/usr/bin/env node
import { readFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) {
  console.error('usage: wc.js <file>');
  process.exit(2);
}
const text = readFileSync(file, 'utf-8');
const lines = text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
console.log(lines);
