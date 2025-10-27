// src/core/commands-deploy.js
// Deploys slash commands to one guild (fast iteration).
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { REST, Routes } from 'discord.js';
import { loadConfig } from './config.js';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const FEATURES_DIR = path.resolve(__dir, '../features');

function requireEnv(name) {
    const v = process.env[name];
    return (v && String(v).trim().length > 0) ? v.trim() : null;
}

function listFeatureCommandFiles() {
    if (!fs.existsSync(FEATURES_DIR)) return [];
    const dirs = fs.readdirSync(FEATURES_DIR, { withFileTypes: true }).filter(d => d.isDirectory());
    return dirs
    .map(d => path.join(FEATURES_DIR, d.name, 'index.js'))
    .filter(p => fs.existsSync(p));
}

async function collectCommands() {
    const files = listFeatureCommandFiles();
    const out = [];
    for (const file of files) {
        const mod = await import(pathToFileURL(file).href);
        if (mod?.commands?.length) {
            for (const c of mod.commands) out.push(c.toJSON ? c.toJSON() : c);
        }
    }
    return out;
}

(async () => {
    try {
        // Load config file (for local dev) and overlay CI env
        const cfg = loadConfig();

        const token  = requireEnv('DISCORD_TOKEN')      || cfg.token;
        const appId  = requireEnv('APPLICATION_ID')     || cfg.applicationId;
        const guildId= requireEnv('LOGGING_SERVER_ID')  || cfg.loggingServerId;

        if (!token)  throw new Error('Missing DISCORD_TOKEN (Secret)');
        if (!appId)  throw new Error('Missing APPLICATION_ID (Variable or config.json)');
        if (!guildId)throw new Error('Missing LOGGING_SERVER_ID (Variable or config.json)');

        const commands = await collectCommands();

        console.log(`Deploying ${commands.length} command(s) to guild ${guildId}…`);
        if (commands.length) {
            console.log('Commands:', commands.map(c => c.name).join(', '));
        }

        const rest = new REST({ version: '10' }).setToken(token);
        await rest.put(Routes.applicationGuildCommands(appId, guildId), { body: commands });

        console.log('✅ Slash commands deployed successfully.');
    } catch (e) {
        console.error('❌ deploy error:', e?.message ?? e);
        process.exit(1);
    }
})();
