// deploy-commands.js
// Registers ONE slash command: /setup
// Uses "devGuildId" from config.json (optional) for instant guild-scoped deploy during dev.
// Guild-scoped deploys now require the --dev CLI flag or SQUIRE_DEPLOY_DEV env var.
// Otherwise, registers globally even when devGuildId exists.
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
        name: 'ban',
        description: 'Ban a user across all managed servers',
        default_member_permissions: String(PermissionFlagsBits.BanMembers),
        dm_permission: false,
        options: [
            {
                type: 6,
                name: 'user',
                description: 'User to ban across every managed server',
                required: true
            },
            {
                type: 3,
                name: 'reason',
                description: 'Reason to record in audit logs',
                required: false,
                max_length: 512
            }
        ]
    },
    {
        name: 'unban',
        description: 'Remove a ban across all managed servers',
        default_member_permissions: String(PermissionFlagsBits.BanMembers),
        dm_permission: false,
        options: [
            {
                type: 3,
                name: 'user',
                description: 'User ID to unban across every managed server',
                required: true,
                min_length: 15,
                max_length: 25
            },
            {
                type: 3,
                name: 'reason',
                description: 'Reason to record in audit logs',
                required: false,
                max_length: 512
            }
        ]
    },
    {
        name: 'kick',
        description: 'Kick a member from this server',
        default_member_permissions: String(PermissionFlagsBits.KickMembers),
        dm_permission: false,
        options: [
            {
                type: 6,
                name: 'user',
                description: 'Member to kick',
                required: true
            },
            {
                type: 3,
                name: 'reason',
                description: 'Reason to record in audit logs',
                required: false,
                max_length: 512
            }
        ]
    },
    {
        name: 'timeout',
        description: 'Apply a communication timeout to a member',
        default_member_permissions: String(PermissionFlagsBits.ModerateMembers),
        dm_permission: false,
        options: [
            {
                type: 6,
                name: 'user',
                description: 'Member to timeout',
                required: true
            },
            {
                type: 4,
                name: 'duration',
                description: 'How long should the timeout last?',
                required: true,
                choices: [
                    { name: '10 minutes', value: 600 },
                    { name: '1 hour', value: 3600 },
                    { name: '12 hours', value: 43200 },
                    { name: '1 day', value: 86400 },
                    { name: '3 days', value: 259200 },
                    { name: '1 week', value: 604800 }
                ]
            },
            {
                type: 3,
                name: 'reason',
                description: 'Reason to record in audit logs',
                required: false,
                max_length: 512
            }
        ]
    },
    {
        name: 'add',
        description: 'Add a Spotify track or YouTube video to the shared playlist',
        dm_permission: false,
        options: [
            {
                type: 3,
                name: 'link',
                description: 'Paste a Spotify track or YouTube video link.',
                required: true
            }
        ]
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

const cliFlags = new Set(process.argv.slice(2));
const envFlag = String(process.env.SQUIRE_DEPLOY_DEV || '').trim().toLowerCase();
const envRequestedDev = ['1', 'true', 'yes', 'on'].includes(envFlag);
const useDevScope = cliFlags.has('--dev') || envRequestedDev;

async function main() {
    console.log('Registering application (/) commands...');
    if (useDevScope) {
        if (!DEV_GUILD_ID) {
            throw new Error('dev deploy requested but config.json is missing devGuildId');
        }
        // Fast dev: overwrite commands in one guild (appears instantly). :contentReference[oaicite:1]{index=1}
        await rest.put(Routes.applicationGuildCommands(APP_ID, DEV_GUILD_ID), { body: commands });
        console.log(`✅ Guild commands registered in ${DEV_GUILD_ID} (dev mode): ${commands.map(c => `/${c.name}`).join(', ')}`);
    } else {
        // Global: overwrite all global commands (may take some time to fan out). :contentReference[oaicite:2]{index=2}
        await rest.put(Routes.applicationCommands(APP_ID), { body: commands });
        console.log(`✅ Global commands registered: ${commands.map(c => `/${c.name}`).join(', ')}`);
    }
}

main().catch(err => {
    console.error('❌ Failed to register commands:', err);
    process.exitCode = 1;
});
