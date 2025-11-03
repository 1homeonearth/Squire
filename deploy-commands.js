// deploy-commands.js
// Registers ONE slash command: /setup
// Uses "devGuildId" from config.json (optional) for instant guild-scoped deploy during dev.
// Otherwise, registers globally.
//
// Docs: Global vs guild scopes & registration endpoints. :contentReference[oaicite:0]{index=0}

import fs from 'fs';
import { REST, Routes, PermissionFlagsBits } from 'discord.js';

const cfg = JSON.parse(fs.readFileSync(new URL('./config.json', import.meta.url), 'utf8'));
const TOKEN = cfg.token;
const APP_ID = cfg.applicationId;
const DEV_GUILD_ID = cfg.devGuildId || null;

if (!TOKEN || !APP_ID) {
    throw new Error('token and applicationId are required in config.json');
}

const MANAGE_GUILD = String(PermissionFlagsBits.ManageGuild);

const commands = [
    {
        name: 'setup',
        description: 'Open the interactive setup panel',
        default_member_permissions: MANAGE_GUILD,
        dm_permission: false
    },
    {
        name: 'xp',
        description: 'Manage member experience points',
        default_member_permissions: MANAGE_GUILD,
        dm_permission: false,
        options: [
            {
                type: 1,
                name: 'set',
                description: "Set a member's experience to an exact value",
                options: [
                    {
                        type: 6,
                        name: 'member',
                        description: 'Member to update',
                        required: true
                    },
                    {
                        type: 4,
                        name: 'amount',
                        description: 'Exact XP amount to set (0 or greater)',
                        required: true,
                        min_value: 0
                    }
                ]
            }
        ]
    }
];

const rest = new REST({ version: '10' }).setToken(TOKEN);

async function main() {
    console.log('Registering application (/) commands...');
    if (DEV_GUILD_ID) {
        // Fast dev: overwrite commands in one guild (appears instantly). :contentReference[oaicite:1]{index=1}
        await rest.put(Routes.applicationGuildCommands(APP_ID, DEV_GUILD_ID), { body: commands });
        console.log(`✅ Guild commands registered in ${DEV_GUILD_ID} (dev mode).`);
    } else {
        // Global: overwrite all global commands with just /setup (may take some time to fan out). :contentReference[oaicite:2]{index=2}
        await rest.put(Routes.applicationCommands(APP_ID), { body: commands });
        console.log('✅ Global commands registered: /setup');
    }
}

main().catch(err => {
    console.error('❌ Failed to register commands:', err);
    process.exitCode = 1;
});
