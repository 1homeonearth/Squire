// src/lib/display.js
// Shared display helpers used across modules for consistent formatting.

export function formatAsBlockQuote(text) {
    if (!text) {
        return '';
    }
    return String(text)
        .split(/\r?\n/)
        .map((line) => `> ${line}`)
        .join('\n');
}
