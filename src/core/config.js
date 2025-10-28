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
    const fileCfg = fs.existsSync(CONFIG_PATH)
    ? JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
    : {};

    // Overlay env for CI
    const over = { ...fileCfg };

    if (process.env.DISCORD_TOKEN)        over.token = process.env.DISCORD_TOKEN;
    if (process.env.APPLICATION_ID)       over.applicationId = process.env.APPLICATION_ID;
    if (process.env.LOGGING_SERVER_ID)    over.loggingServerId = process.env.LOGGING_SERVER_ID;

    if (process.env.MAPPING_JSON)         over.mapping = safeJSON(process.env.MAPPING_JSON, fileCfg.mapping);
    if (process.env.EXCLUDE_CHANNELS_JSON)over.excludeChannels = safeJSON(process.env.EXCLUDE_CHANNELS_JSON, fileCfg.excludeChannels);
    if (process.env.EXCLUDE_CATEGORIES_JSON) over.excludeCategories = safeJSON(process.env.EXCLUDE_CATEGORIES_JSON, fileCfg.excludeCategories);
    if (process.env.AUTOBAN_CONFIG_JSON)  over.autoban = safeJSON(process.env.AUTOBAN_CONFIG_JSON, fileCfg.autoban);

    if (typeof over.mapping === 'string') {
        over.mapping = safeJSON(over.mapping, {});
    }

    if (!over.autoban || typeof over.autoban !== 'object') {
        over.autoban = fileCfg.autoban && typeof fileCfg.autoban === 'object' ? { ...fileCfg.autoban } : {};
    }

    return over;
}

export function writeConfig(next) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2));
}
