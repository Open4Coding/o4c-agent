const items = new Map();
let nextId = 1;

export function handleCreate(input) {
  if (input.name === undefined) {
    return { ok: false, error: 'name is required' };
  }
  if (input.name.length > 50) {
    return { ok: false, error: 'name is too long' };
  }
  const item = { id: nextId++, name: input.name.trim() };
  items.set(item.id, item);
  return { ok: true, item };
}

export function handleUpdate(id, input) {
  if (!items.has(id)) {
    return { ok: false, error: 'not found' };
  }
  if (input.name === undefined) {
    return { ok: false, error: 'name is required' };
  }
  if (input.name.length > 50) {
    return { ok: false, error: 'name is too long' };
  }
  const item = { ...items.get(id), name: input.name.trim() };
  items.set(id, item);
  return { ok: true, item };
}

export function handleGet(id) {
  return items.has(id) ? { ok: true, item: items.get(id) } : { ok: false, error: 'not found' };
}
