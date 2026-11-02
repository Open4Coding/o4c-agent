import { load } from './store.js';

/** Calls back with the names in a people file, sorted. */
export function sortedNames(path, callback) {
  load(path, (err, people) => {
    if (err) return callback(err);
    callback(null, people.map((p) => p.name).sort());
  });
}
