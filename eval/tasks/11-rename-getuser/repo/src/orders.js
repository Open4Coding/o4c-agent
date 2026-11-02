import { getUsr } from './users.js';

export function orderSummary(order) {
  const user = getUsr(order.userId);
  return `${user.name} ordered ${order.items.length} item(s)`;
}
