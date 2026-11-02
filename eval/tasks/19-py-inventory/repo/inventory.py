class Inventory:
    def __init__(self):
        self.items = {}

    def add(self, name, quantity):
        self.items[name] = self.items.get(name, 0) + quantity

    def remove(self, name, quantity):
        self.items[name] = self.items.get(name, 0) - quantity

    def quantity(self, name):
        return self.items.get(name, 0)
