// src/core/commands-wipe.js
// Usage:
//   node src/core/commands-wipe.js --global
//   node src/core/commands-wipe.js --guild
//
// Deletes application commands one-by-one (avoids bulk “entry point” issues).
// Reads DISCORD_TOKEN/APPLICATION_ID/LOGGING_SERVER_ID from env first,
// then falls back to config.json via loadConfig().

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

const arg = process.argv[2];
if (!arg || !['--global', '--guild'].includes(arg)) {
    console.error('Pass --global or --guild');
    process.exit(1);
}

async function wipeGlobal() {
    const list = await rest.get(Routes.applicationCommands(appId));
    console.log(`Found ${list.length} GLOBAL commands`);
    for (const cmd of list) {
        try {
            await rest.delete(Routes.applicationCommand(appId, cmd.id));
            console.log(`  ✖ deleted ${cmd.name} (${cmd.id})`);
        } catch (e) {
            console.error(`  ! failed ${cmd.name}:`, e?.message ?? e);
        }
    }
}

async function wipeGuild() {
    if (!guildId) throw new Error('Set LOGGING_SERVER_ID (guild id) for --guild');
    const list = await rest.get(Routes.applicationGuildCommands(appId, guildId));
    console.log(`Found ${list.length} GUILD commands`);
    for (const cmd of list) {
        try {
            await rest.delete(Routes.applicationGuildCommand(appId, guildId, cmd.id));
            console.log(`  ✖ deleted ${cmd.name} (${cmd.id})`);
        } catch (e) {
            console.error(`  ! failed ${cmd.name}:`, e?.message ?? e);
        }
    }
}

(async () => {
    if (arg === '--global') await wipeGlobal();
    else await wipeGuild();
})();
