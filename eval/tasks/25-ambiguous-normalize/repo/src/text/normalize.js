/** Text with runs of whitespace collapsed to one space and trimmed. Keeps a trailing slash. */
export function normalize(text) {
  return text.replace(/\s+/g, ' ').trim();
}
