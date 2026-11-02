import { load } from './store.js';

/** The names in a people file, sorted. */
export async function sortedNames(path) {
  const people = await load(path);
  return people.map((p) => p.name).sort();
}
