/**
	* Joins items into an English list: "a", "a and b", "a, b, and c".
	*/
export function formatList(items) {
	if (items.length === 0) {
		return '';
	}
	if (items.length === 1) {
		return items[0];
	}
	if (items.length === 2) {
		return `${items[0]} and ${items[1]}`;
	}
	return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}

export function plural(word, count) {
	return count === 1 ? word : `${word}s`;
}
