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
    .map(d => path.join(FEATURES_DIR, d.name, 'index.js'))
    .filter(p => fs.existsSync(p));

    if (entries.length === 0) {
        ctx.logger.warn('No features found in /src/features');
        return;
    }

    for (const file of entries) {
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
