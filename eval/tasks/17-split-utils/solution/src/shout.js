import { clamp, roundTo } from './numbers.js';
import { capitalize } from './strings.js';

export function shout(s) {
  return `${capitalize(s)}!`;
}

export function percent(x) {
  return roundTo(clamp(x, 0, 1) * 100, 0);
}
