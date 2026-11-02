/** The items on one page. Pages are numbered from 1. */
export function paginate(items, page, size) {
  const start = (page - 1) * size;
  return items.slice(start, start + size);
}

/** How many pages `items` fill at `size` per page. */
export function pageCount(items, size) {
  return Math.ceil(items.length / size);
}
