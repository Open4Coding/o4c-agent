import { readFile } from 'node:fs/promises';

/** Reads a JSON file. */
export async function load(path) {
  return JSON.parse(await readFile(path, 'utf-8'));
}
