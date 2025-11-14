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
    let fileCfg = {};
    if (fs.existsSync(CONFIG_PATH)) {
        const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
        try {
            fileCfg = JSON.parse(raw);
        } catch (error) {
            const reason = error?.message ?? error;
            console.error(`[config] Failed to parse config.json at ${CONFIG_PATH}: ${reason}. Using empty defaults.`);
            fileCfg = {};
        }
    }

    // Overlay env for CI
    const over = { ...fileCfg };

    if (process.env.DISCORD_TOKEN)        over.token = process.env.DISCORD_TOKEN;
    if (process.env.APPLICATION_ID)       over.applicationId = process.env.APPLICATION_ID;
    if (process.env.LOGGING_SERVER_ID)    over.loggingServerId = process.env.LOGGING_SERVER_ID;

    if (process.env.MAPPING_JSON)         over.mapping = safeJSON(process.env.MAPPING_JSON, fileCfg.mapping);
    if (process.env.LOGGING_CHANNELS_JSON)over.loggingChannels = safeJSON(process.env.LOGGING_CHANNELS_JSON, fileCfg.loggingChannels);
    if (process.env.MODERATION_LOGGING_JSON) over.moderationLogging = safeJSON(process.env.MODERATION_LOGGING_JSON, fileCfg.moderationLogging);
    if (process.env.EXCLUDE_CHANNELS_JSON)over.excludeChannels = safeJSON(process.env.EXCLUDE_CHANNELS_JSON, fileCfg.excludeChannels);
    if (process.env.EXCLUDE_CATEGORIES_JSON) over.excludeCategories = safeJSON(process.env.EXCLUDE_CATEGORIES_JSON, fileCfg.excludeCategories);
    if (process.env.RAINBOW_BRIDGE_BRIDGES_JSON) {
        const base = over.rainbowBridge && typeof over.rainbowBridge === 'object'
            ? { ...over.rainbowBridge }
            : (fileCfg.rainbowBridge && typeof fileCfg.rainbowBridge === 'object' ? { ...fileCfg.rainbowBridge } : {});
        base.bridges = safeJSON(process.env.RAINBOW_BRIDGE_BRIDGES_JSON, base.bridges);
        over.rainbowBridge = base;
    }
    if (process.env.MAIN_SERVER_IDS_JSON) over.mainServerIds = safeJSON(process.env.MAIN_SERVER_IDS_JSON, fileCfg.mainServerIds);
    if (process.env.WELCOME_CONFIG_JSON)  over.welcome = safeJSON(process.env.WELCOME_CONFIG_JSON, fileCfg.welcome);
    if (process.env.AUTOBAN_CONFIG_JSON)  over.autoban = safeJSON(process.env.AUTOBAN_CONFIG_JSON, fileCfg.autoban);
    if (process.env.AUTOBAN_NOTIFY_CHANNEL_ID) {
        const autobanBase = over.autoban && typeof over.autoban === 'object'
            ? { ...over.autoban }
            : (fileCfg.autoban && typeof fileCfg.autoban === 'object' ? { ...fileCfg.autoban } : {});
        autobanBase.notifyChannelId = process.env.AUTOBAN_NOTIFY_CHANNEL_ID;
        over.autoban = autobanBase;
    }
    if (process.env.AUTOBAN_TEST_ROLE_MAP_JSON) {
        const autobanBase = over.autoban && typeof over.autoban === 'object'
            ? { ...over.autoban }
            : (fileCfg.autoban && typeof fileCfg.autoban === 'object' ? { ...fileCfg.autoban } : {});
        autobanBase.testRoleMap = safeJSON(process.env.AUTOBAN_TEST_ROLE_MAP_JSON, autobanBase.testRoleMap);
        over.autoban = autobanBase;
    }

    if (process.env.MODERATION_ROLE_MAP_JSON) {
        const moderationBase = over.moderationCommands && typeof over.moderationCommands === 'object'
            ? { ...over.moderationCommands }
            : (fileCfg.moderationCommands && typeof fileCfg.moderationCommands === 'object'
                ? { ...fileCfg.moderationCommands }
                : {});
        const fallbackRoleMap = typeof moderationBase.roleMap === 'string'
            ? safeJSON(moderationBase.roleMap, {})
            : moderationBase.roleMap;
        moderationBase.roleMap = safeJSON(process.env.MODERATION_ROLE_MAP_JSON, fallbackRoleMap);
        over.moderationCommands = moderationBase;
    }

    if (typeof over.mapping === 'string') {
        over.mapping = safeJSON(over.mapping, {});
    }

    if (typeof over.loggingChannels === 'string') {
        over.loggingChannels = safeJSON(over.loggingChannels, {});
    }

    if (typeof over.moderationLogging === 'string') {
        over.moderationLogging = safeJSON(over.moderationLogging, {});
    }

    if (!over.autoban || typeof over.autoban !== 'object') {
        over.autoban = fileCfg.autoban && typeof fileCfg.autoban === 'object' ? { ...fileCfg.autoban } : {};
    }

    if (!over.moderationLogging || typeof over.moderationLogging !== 'object') {
        over.moderationLogging = fileCfg.moderationLogging && typeof fileCfg.moderationLogging === 'object'
            ? { ...fileCfg.moderationLogging }
            : {};
    }

    if (!over.moderationCommands || typeof over.moderationCommands !== 'object') {
        over.moderationCommands = fileCfg.moderationCommands && typeof fileCfg.moderationCommands === 'object'
            ? { ...fileCfg.moderationCommands }
            : {};
    }

    if (typeof over.moderationCommands.roleMap === 'string') {
        over.moderationCommands.roleMap = safeJSON(over.moderationCommands.roleMap, {});
    }

    if (!over.moderationCommands.roleMap || typeof over.moderationCommands.roleMap !== 'object') {
        const fileRoleMap = fileCfg.moderationCommands && typeof fileCfg.moderationCommands === 'object'
            ? fileCfg.moderationCommands.roleMap
            : undefined;
        over.moderationCommands.roleMap = fileRoleMap && typeof fileRoleMap === 'object'
            ? { ...fileRoleMap }
            : {};
    }

    if (typeof over.autoban.notifyChannelId === 'string' && !over.autoban.notifyChannelId) {
        delete over.autoban.notifyChannelId;
    }

    if (typeof over.mainServerIds === 'string') {
        over.mainServerIds = safeJSON(over.mainServerIds, []);
    }

    if (typeof over.welcome === 'string') {
        over.welcome = safeJSON(over.welcome, {});
    }

    return over;
}

export function writeConfig(next) {
    const serialized = JSON.stringify(next, null, 2);
    const tmpPath = `${CONFIG_PATH}.tmp-${process.pid}`;
    fs.writeFileSync(tmpPath, serialized, { mode: 0o600 });
    fs.renameSync(tmpPath, CONFIG_PATH);
}
