// wipe-commands.js
// Nukes ALL commands: first explicitly deletes any Primary Entry Point (type=4) commands,
// then clears global + every guild's commands.
//
// Why: Discord error 50240 — you can't remove an Entry Point via bulk overwrite. Delete it explicitly.
// Refs: API change & docs.
// - Error 50240 context: https://github.com/discord/discord-api-docs/discussions/7213
// - PrimaryEntryPoint = 4: https://discord.js.org/docs/packages/discord.js/main/ApplicationCommandType%3AEnum
// - Activities auto-create Entry Point: https://discord.com/developers/docs/activities/overview

import fs from 'fs';
import { Client, GatewayIntentBits, REST, Routes } from 'discord.js';

const cfg = JSON.parse(fs.readFileSync(new URL('./config.json', import.meta.url), 'utf8'));
const TOKEN = cfg.token;
const APP_ID = cfg.applicationId;

if (!TOKEN || !APP_ID) throw new Error('token and applicationId are required in config.json');

const rest = new REST({ version: '10' }).setToken(TOKEN);

async function deletePrimaryEntryPointsGlobal() {
    // List global commands
    const cmds = await rest.get(Routes.applicationCommands(APP_ID));
    const primaries = cmds.filter(c => c.type === 4); // PrimaryEntryPoint
    if (!primaries.length) return;

    console.log(`Found ${primaries.length} global PrimaryEntryPoint command(s). Deleting explicitly…`);
    for (const cmd of primaries) {
        try {
            await rest.delete(Routes.applicationCommand(APP_ID, cmd.id));
            console.log(`  ✅ Deleted global Entry Point "${cmd.name}" (${cmd.id})`);
        } catch (e) {
            console.error(`  ❌ Failed to delete global Entry Point ${cmd.id}:`, e?.message ?? e);
        }
    }
}

async function wipeGlobal() {
    console.log('Wiping GLOBAL commands…');
    // After explicit deletes above, this will clear everything else.
    await rest.put(Routes.applicationCommands(APP_ID), { body: [] });
    console.log('✅ Global commands cleared.');
}

async function deletePrimaryEntryPointsInGuild(guildId) {
    const cmds = await rest.get(Routes.applicationGuildCommands(APP_ID, guildId));
    const primaries = cmds.filter(c => c.type === 4);
    if (!primaries.length) return;

    console.log(`  Found ${primaries.length} Entry Point command(s) in guild ${guildId}. Deleting explicitly…`);
    for (const cmd of primaries) {
        try {
            await rest.delete(Routes.applicationGuildCommand(APP_ID, guildId, cmd.id));
            console.log(`    ✅ Deleted Entry Point "${cmd.name}" (${cmd.id}) in ${guildId}`);
        } catch (e) {
            console.error(`    ❌ Failed to delete Entry Point ${cmd.id} in ${guildId}:`, e?.message ?? e);
        }
    }
}

async function wipeAllGuilds() {
    console.log('Logging in to enumerate guilds…');
    const client = new Client({ intents: [GatewayIntentBits.Guilds] });
    await client.login(TOKEN);
    await new Promise(res => client.once('ready', res));

    const guilds = await client.guilds.fetch(); // partials
    console.log(`Found ${guilds.size} guild(s). Wiping guild-scoped commands…`);

    for (const [gid] of guilds) {
        try {
            // Remove any Entry Points first
            await deletePrimaryEntryPointsInGuild(gid);
            // Then wipe the rest
            await rest.put(Routes.applicationGuildCommands(APP_ID, gid), { body: [] });
            console.log(`  ✅ Cleared guild commands in ${gid}`);
        } catch (e) {
            console.error(`  ❌ Failed to clear guild ${gid}:`, e?.message ?? e);
        }
    }
    await client.destroy();
    console.log('✅ Finished wiping guild commands.');
}

try {
    await deletePrimaryEntryPointsGlobal(); // explicit deletes to avoid 50240
    await wipeGlobal();
    await wipeAllGuilds();
    console.log('🧹 Done. Now run: node deploy-commands.js');
} catch (err) {
    console.error('❌ Wipe failed:', err);
    process.exitCode = 1;
}
