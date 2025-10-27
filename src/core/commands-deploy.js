// src/core/commands-deploy.js
// Scans feature command definitions and deploys them (guild-scoped by default).
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { REST, Routes } from 'discord.js';
import { loadConfig } from './config.js'; // NOTE: .js extension required in ESM

const __dir = path.dirname(fileURLToPath(import.meta.url));
const FEATURES_DIR = path.resolve(__dir, '../features');

const config = loadConfig();
const rest = new REST({ version: '10' }).setToken(config.token);

async function collectCommands() {
    const cmds = [];
    if (!fs.existsSync(FEATURES_DIR)) return cmds;

    const features = fs.readdirSync(FEATURES_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => path.join(FEATURES_DIR, d.name, 'index.js'))
    .filter(p => fs.existsSync(p));

    for (const f of features) {
        const m = await import(pathToFileUrl(f));
        if (m?.commands?.length) cmds.push(...m.commands.map(c => (c.toJSON ? c.toJSON() : c)));
    }
    return cmds;
}

function pathToFileUrl(p) {
    let full = path.resolve(p);
    if (process.platform === 'win32') full = '/' + full.replace(/\\/g, '/');
    return new URL(`file://${full}`).href;
}

(async () => {
    try {
        const commands = await collectCommands();
        const appId = config.applicationId;
        const guildId = config.loggingServerId; // deploy to logging server for fast iteration
        if (!appId || !guildId) {
            throw new Error('applicationId or loggingServerId missing in config.json');
        }

        console.log(`Deploying ${commands.length} commands to guild ${guildId}…`);
        await rest.put(Routes.applicationGuildCommands(appId, guildId), { body: commands });
        console.log('✅ Done.');
    } catch (e) {
        console.error('❌ deploy error:', e);
        process.exit(1);
    }
})();
