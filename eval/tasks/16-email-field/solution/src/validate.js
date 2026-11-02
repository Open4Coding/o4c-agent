export function validateUser(user) {
  const errors = [];
  if (typeof user.name !== 'string' || user.name.trim() === '') errors.push('name is required');
  if (!Number.isInteger(user.age) || user.age < 0) errors.push('age must be a non-negative integer');
  if (typeof user.email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(user.email)) errors.push('email is invalid');
  return errors;
}
