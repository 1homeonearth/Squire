// src/core/logger.js
const LEVELS = { none: 0, info: 1, verbose: 2 };

function timestamp() {
    const now = new Date();
    return now.toISOString().split('T')[1].split('.')[0];
}

function withTimestamp(fn) {
    return (...args) => {
        fn(`[${timestamp()}]`, ...args);
    };
}

export function createLogger(level = 'info') {
    const cur = LEVELS[level] ?? LEVELS.info;
    const info = withTimestamp(console.log);
    const verbose = withTimestamp(console.log);
    const warn = withTimestamp(console.warn);
    const error = withTimestamp(console.error);

    return {
        info: (...a) => { if (cur >= LEVELS.info) info(...a); },
        verbose: (...a) => { if (cur >= LEVELS.verbose) verbose(...a); },
        warn: (...a) => warn(...a),
        error: (...a) => error(...a)
    };
}
