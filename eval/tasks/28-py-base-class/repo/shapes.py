import math


class Circle:
    def __init__(self, r):
        self.r = r

    def area(self):
        return math.pi * self.r ** 2

    def describe(self):
        return f"{type(self).__name__} with area {self.area():.2f}"

    def scaled(self, factor):
        if factor <= 0:
            raise ValueError("factor must be positive")
        return type(self)(*[v * factor for v in self.dims()])

    def dims(self):
        return [self.r]


class Square:
    def __init__(self, side):
        self.side = side

    def area(self):
        return self.side ** 2

    def describe(self):
        return f"{type(self).__name__} with area {self.area():.2f}"

    def scaled(self, factor):
        if factor <= 0:
            raise ValueError("factor must be positive")
        return type(self)(*[v * factor for v in self.dims()])

    def dims(self):
        return [self.side]


class Rect:
    def __init__(self, w, h):
        self.w = w
        self.h = h

    def area(self):
        return self.w * self.h

    def describe(self):
        return f"{type(self).__name__} with area {self.area():.2f}"

    def scaled(self, factor):
        if factor <= 0:
            raise ValueError("factor must be positive")
        return type(self)(*[v * factor for v in self.dims()])

    def dims(self):
        return [self.w, self.h]
