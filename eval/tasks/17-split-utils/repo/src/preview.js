import { roundTo, truncate } from './utils.js';

export function preview(text, ratio) {
  return `${truncate(text, 10)} (${roundTo(ratio * 100, 1)}%)`;
}
