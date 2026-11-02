export const CSV_HEADER = 'name,age';

export function toCsvRow(user) {
  return [user.name, user.age].join(',');
}
