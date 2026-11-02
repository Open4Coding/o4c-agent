export function invoiceLine(item) {
  const amount = (item.cents / 100).toFixed(2);
  const sign = item.cents < 0 ? '-' : '';
  return `${item.name}: ${sign}$${amount.replace('-', '')}`;
}

export function totalLine(items) {
  const cents = items.reduce((sum, i) => sum + i.cents, 0);
  const amount = (cents / 100).toFixed(2);
  const sign = cents < 0 ? '-' : '';
  return `Total: ${sign}$${amount.replace('-', '')}`;
}

export function refundLine(item) {
  const cents = -Math.abs(item.cents);
  const amount = (cents / 100).toFixed(2);
  const sign = cents < 0 ? '-' : '';
  return `Refund ${item.name}: ${sign}$${amount.replace('-', '')}`;
}
