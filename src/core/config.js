// src/core/config.js
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.resolve(__dir, '../../config.json');

function safeJSON(str, fallback) {
    try { return JSON.parse(str); } catch { return fallback; }
}

export function loadConfig() {
    // 1) Load file config for local dev
    const fileCfg = fs.existsSync(CONFIG_PATH)
    ? JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
    : {};

    // 2) Overlay env-provided JSON (Actions)
    const envCfg = {
        mapping: process.env.MAPPING_JSON
        ? safeJSON(process.env.MAPPING_JSON, fileCfg.mapping)
        : fileCfg.mapping,
        excludeChannels: process.env.EXCLUDE_CHANNELS_JSON
        ? safeJSON(process.env.EXCLUDE_CHANNELS_JSON, fileCfg.excludeChannels)
        : fileCfg.excludeChannels,
        excludeCategories: process.env.EXCLUDE_CATEGORIES_JSON
        ? safeJSON(process.env.EXCLUDE_CATEGORIES_JSON, fileCfg.excludeCategories)
        : fileCfg.excludeCategories,
    };

    // Merge onto the file config so everything else (token, etc.) still works locally
    return { ...fileCfg, ...envCfg };
}

export function writeConfig(next) {
    // Only writes the file; CI uses env and won't call this.
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2));
}
