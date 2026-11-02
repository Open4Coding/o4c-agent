import unittest

from shapes import Circle, Rect, Square


class ShapesTest(unittest.TestCase):
    def test_describe(self):
        self.assertEqual(Square(2).describe(), "Square with area 4.00")
        self.assertEqual(Rect(2, 3).describe(), "Rect with area 6.00")

    def test_scaled(self):
        self.assertEqual(Rect(2, 3).scaled(2).area(), 24)
        self.assertAlmostEqual(Circle(1).scaled(3).area(), 28.274, places=3)
        with self.assertRaises(ValueError):
            Square(1).scaled(0)


if __name__ == "__main__":
    unittest.main()
