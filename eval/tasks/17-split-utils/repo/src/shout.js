import * as utils from './utils.js';

export function shout(s) {
  return `${utils.capitalize(s)}!`;
}

export function percent(x) {
  return utils.roundTo(utils.clamp(x, 0, 1) * 100, 0);
}
