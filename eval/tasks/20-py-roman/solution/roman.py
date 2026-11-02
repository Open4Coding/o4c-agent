NUMERALS = [(1000, "M"), (900, "CM"), (500, "D"), (400, "CD"), (100, "C"), (90, "XC"),
            (50, "L"), (40, "XL"), (10, "X"), (9, "IX"), (5, "V"), (4, "IV"), (1, "I")]


def to_roman(number):
    if not 0 < number < 4000:
        raise ValueError("out of range")
    out = []
    for value, numeral in NUMERALS:
        while number >= value:
            out.append(numeral)
            number -= value
    return "".join(out)


def from_roman(text):
    total, i = 0, 0
    for value, numeral in NUMERALS:
        while text.startswith(numeral, i):
            total += value
            i += len(numeral)
    if not text or i != len(text) or to_roman(total) != text:
        raise ValueError(f"not a roman numeral: {text!r}")
    return total
