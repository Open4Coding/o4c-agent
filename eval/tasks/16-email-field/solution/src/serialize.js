export const CSV_HEADER = 'name,age,email';

export function toCsvRow(user) {
  return [user.name, user.age, user.email].join(',');
}
