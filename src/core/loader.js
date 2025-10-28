// src/core/loader.js
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const FEATURES_DIR = path.resolve(__dir, '../features');

export async function loadFeatures(ctx) {
    // Discover /features/*/index.js files
    const entries = fs.readdirSync(FEATURES_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => ({
        dir: d.name,
        file: path.join(FEATURES_DIR, d.name, 'index.js')
    }))
    .filter(entry => fs.existsSync(entry.file));

    if (entries.length === 0) {
        ctx.logger.warn('No features found in /src/features');
        return;
    }

    const ordered = orderEntries(entries, ctx.config);

    for (const { file } of ordered) {
        try {
            const mod = await import(pathToFileUrl(file));
            if (typeof mod.init !== 'function') {
                ctx.logger.warn(`[loader] ${file} has no exported init() — skipping`);
                continue;
            }
            await mod.init(ctx);
            ctx.logger.info(`[loader] loaded feature from ${file}`);
        } catch (e) {
            ctx.logger.error(`[loader] failed to load ${file}:`, e?.message ?? e);
        }
    }
}

function pathToFileUrl(p) {
    let full = path.resolve(p);
    if (process.platform === 'win32') full = '/' + full.replace(/\\/g, '/');
    return new URL(`file://${full}`).href;
}

function orderEntries(entries, config) {
    const desiredOrder = Array.isArray(config?.featureOrder)
        ? config.featureOrder.map(String)
        : [];
    if (!desiredOrder.length) {
        return entries.slice().sort((a, b) => a.dir.localeCompare(b.dir));
    }

    const priority = new Map();
    desiredOrder.forEach((name, idx) => {
        const key = String(name).trim();
        if (!key) return;
        if (!priority.has(key)) priority.set(key, idx);
    });

    return entries.slice().sort((a, b) => {
        const ai = priority.has(a.dir) ? priority.get(a.dir) : Number.MAX_SAFE_INTEGER;
        const bi = priority.has(b.dir) ? priority.get(b.dir) : Number.MAX_SAFE_INTEGER;
        if (ai !== bi) return ai - bi;
        return a.dir.localeCompare(b.dir);
    });
}
