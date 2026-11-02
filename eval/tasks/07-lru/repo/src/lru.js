/**
 * A least-recently-used cache holding at most `capacity` entries.
 *
 * - get(key): the value, or undefined when absent; counts as a use.
 * - set(key, value): adds or replaces; counts as a use. When that leaves more than `capacity`
 *   entries, the least recently used entry is dropped. Returns the cache.
 * - has(key): true or false; does NOT count as a use.
 * - delete(key): removes the entry; true if there was one.
 * - size: the number of entries (a getter).
 */
export class LRUCache {
  constructor(capacity) {
    throw new Error('not implemented');
  }
}
