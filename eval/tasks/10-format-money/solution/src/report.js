export function formatMoney(cents) {
  const amount = (cents / 100).toFixed(2);
  const sign = cents < 0 ? '-' : '';
  return `${sign}$${amount.replace('-', '')}`;
}

export function invoiceLine(item) {
  return `${item.name}: ${formatMoney(item.cents)}`;
}

export function totalLine(items) {
  return `Total: ${formatMoney(items.reduce((sum, i) => sum + i.cents, 0))}`;
}

export function refundLine(item) {
  return `Refund ${item.name}: ${formatMoney(-Math.abs(item.cents))}`;
}
