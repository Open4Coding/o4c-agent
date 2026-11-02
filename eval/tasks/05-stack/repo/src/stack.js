export class Stack {
  #items = [];

  push(value) {
    this.#items.push(value);
    return this;
  }

  pop() {
    if (this.#items.length === 0) throw new Error('pop from empty stack');
    return this.#items.shift();
  }

  peek() {
    return this.#items[this.#items.length];
  }

  get size() {
    return this.#items.length;
  }

  isEmpty() {
    return this.size === 0;
  }
}
