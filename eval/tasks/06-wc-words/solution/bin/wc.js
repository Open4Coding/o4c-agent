#!/usr/bin/env node
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const words = args.includes('--words');
const file = args.find((a) => a !== '--words');
if (!file) {
  console.error('usage: wc.js [--words] <file>');
  process.exit(2);
}
const text = readFileSync(file, 'utf-8');
if (words) {
  console.log(text.split(/\s+/).filter(Boolean).length);
} else {
  const lines = text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
  console.log(lines);
}
