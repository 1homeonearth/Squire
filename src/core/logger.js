// src/core/logger.js
const LEVELS = { none: 0, info: 1, verbose: 2 };

export function createLogger(level = 'info') {
    const cur = LEVELS[level] ?? LEVELS.info;
    return {
        info: (...a) => { if (cur >= LEVELS.info) console.log(...a); },
        verbose: (...a) => { if (cur >= LEVELS.verbose) console.log(...a); },
        warn: (...a) => console.warn(...a),
        error: (...a) => console.error(...a)
    };
}
