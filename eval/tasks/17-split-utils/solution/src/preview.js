import { roundTo } from './numbers.js';
import { truncate } from './strings.js';

export function preview(text, ratio) {
  return `${truncate(text, 10)} (${roundTo(ratio * 100, 1)}%)`;
}
