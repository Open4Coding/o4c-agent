import { capitalize, clamp } from './utils.js';

export function label(name, score) {
  return `${capitalize(name)}: ${clamp(score, 0, 100)}`;
}
