class Inventory:
    def __init__(self):
        self.items = {}

    def add(self, name, quantity):
        self.items[name] = self.items.get(name, 0) + quantity

    def remove(self, name, quantity):
        have = self.items.get(name, 0)
        if quantity > have:
            raise ValueError(f"only {have} {name} in stock")
        if have - quantity == 0:
            del self.items[name]
        else:
            self.items[name] = have - quantity

    def quantity(self, name):
        return self.items.get(name, 0)
