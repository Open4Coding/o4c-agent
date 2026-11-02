/**
 * A URL slug: lower case, only ASCII letters and digits, words joined by single hyphens, no
 * leading or trailing hyphen. Accents are stripped first, so "Crème" becomes "creme".
 */
export function slugify(text) {
  return text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
