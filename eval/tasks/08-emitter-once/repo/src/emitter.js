export class Emitter {
  #handlers = new Map();

  on(event, handler) {
    if (!this.#handlers.has(event)) this.#handlers.set(event, []);
    this.#handlers.get(event).push(handler);
    return this;
  }

  off(event, handler) {
    const list = this.#handlers.get(event);
    if (list) this.#handlers.set(event, list.filter((h) => h !== handler));
    return this;
  }

  emit(event, ...args) {
    const list = this.#handlers.get(event) ?? [];
    for (const handler of [...list]) handler(...args);
    return list.length > 0;
  }
}
