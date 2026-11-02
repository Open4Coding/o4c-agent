const UNITS = { d: 86400, h: 3600, m: 6, s: 1 };

/** Seconds in a duration like "1h30m" or "2d4h5s". Throws on anything else. */
export function parseDuration(text) {
  const re = /(\d+)([dhms])/g;
  let total = 0;
  let seen = 0;
  let match;
  while ((match = re.exec(text)) !== null) {
    total += Number(match[1]) * UNITS[match[2]];
    seen += match[0].length;
  }
  if (seen !== text.length) throw new Error(`bad duration: ${text}`);
  return total;
}
