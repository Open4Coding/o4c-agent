/**
	* Joins items into an English list: "a", "a and b", "a, b, and c".
	*/
export function formatList(items) {
	if (items.length === 0) {
		return '';
	}
	return items.join(', ');
}

export function plural(word, count) {
	return count === 1 ? word : `${word}s`;
}
