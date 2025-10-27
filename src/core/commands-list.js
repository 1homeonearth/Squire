// src/core/commands-list.js
import { REST, Routes } from 'discord.js';
import { loadConfig } from './config.js';

function pick(name, cfgKey) {
    const v = process.env[name];
    if (v && String(v).trim()) return String(v).trim();
    const cfg = loadConfig();
    return cfg?.[cfgKey] ? String(cfg[cfgKey]) : null;
}

const token   = pick('DISCORD_TOKEN', 'token');
const appId   = pick('APPLICATION_ID', 'applicationId');
const guildId = pick('LOGGING_SERVER_ID', 'loggingServerId');

if (!token || !appId) {
    throw new Error('Set DISCORD_TOKEN and APPLICATION_ID (or put token/applicationId in config.json)');
}

const rest = new REST({ version: '10' }).setToken(token);

async function list(path, label) {
    try {
        const items = await rest.get(path);
        console.log(`\n${label}: ${items.length}`);
        for (const c of items) console.log(`- ${c.name} (${c.id})`);
    } catch (e) {
        console.error(`${label} error:`, e?.message ?? e);
    }
}

(async () => {
    await list(Routes.applicationCommands(appId), 'GLOBAL commands'); // may take ~1h to propagate globally
    // Guild commands are instant if your app is in that guild with applications.commands scope
    if (guildId) {
        await list(Routes.applicationGuildCommands(appId, guildId), `GUILD ${guildId} commands`);
    }
})();
