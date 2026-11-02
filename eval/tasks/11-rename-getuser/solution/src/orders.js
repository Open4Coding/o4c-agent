import { getUser } from './users.js';

export function orderSummary(order) {
  const user = getUser(order.userId);
  return `${user.name} ordered ${order.items.length} item(s)`;
}
