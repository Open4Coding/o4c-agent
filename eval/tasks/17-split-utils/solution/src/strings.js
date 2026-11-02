export function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function truncate(s, max) {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}
