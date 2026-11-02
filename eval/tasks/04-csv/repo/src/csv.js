/** Splits one CSV line into its fields. */
export function parseCsvLine(line) {
  return line.split(',').map((field) => field.replace(/^"|"$/g, ''));
}
