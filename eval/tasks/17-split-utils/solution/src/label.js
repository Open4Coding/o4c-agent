import { clamp } from './numbers.js';
import { capitalize } from './strings.js';

export function label(name, score) {
  return `${capitalize(name)}: ${clamp(score, 0, 100)}`;
}
