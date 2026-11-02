import { readFile } from 'node:fs';

/** Reads a JSON file and calls back with (err, data). */
export function load(path, callback) {
  readFile(path, 'utf-8', (err, text) => {
    if (err) return callback(err);
    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      return callback(e);
    }
    callback(null, data);
  });
}
