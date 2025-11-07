// src/features/global-ban/index.js
// Provides the /ban command to propagate bans across all managed servers.

import {
    SlashCommandBuilder,
    PermissionFlagsBits
} from 'discord.js';

function normalizeId(value) {
    if (!value && value !== 0) return null;
    const str = String(value).trim();
    return str.length ? str : null;
}

export function collectTargetGuildIds(config, client, invokedGuildId) {
    const ids = new Set();

    const add = (value) => {
        const normalized = normalizeId(value);
        if (normalized) {
            ids.add(normalized);
        }
    };

    if (Array.isArray(config?.mainServerIds)) {
        for (const id of config.mainServerIds) add(id);
    }

    if (config?.mapping && typeof config.mapping === 'object') {
        for (const id of Object.keys(config.mapping)) add(id);
    }

    add(config?.loggingServerId);

    if (client?.guilds?.cache) {
        for (const [id] of client.guilds.cache) {
            add(id);
        }
    }

    add(invokedGuildId);

    return [...ids];
}

function clampAuditReason(reason) {
    const MAX_LENGTH = 512;
    if (reason.length <= MAX_LENGTH) return reason;
    return `${reason.slice(0, MAX_LENGTH - 1)}…`;
}

function buildAuditReason(actor, baseReason) {
    const tag = actor?.tag ?? actor?.username ?? actor?.id ?? 'unknown';
    const actorId = actor?.id ?? 'unknown';
    const prefix = `[Global Ban] Requested by ${tag} (${actorId})`;
    const suffix = baseReason ? ` — ${baseReason}` : '';
    return clampAuditReason(`${prefix}${suffix}`);
}

async function fetchGuild(client, guildId) {
    let guild = client.guilds.cache.get(guildId);
    if (guild) return guild;
    try {
        guild = await client.guilds.fetch(guildId);
        return guild;
    } catch {
        return null;
    }
}

async function ensureSelfMember(guild, client) {
    if (!guild) return null;
    if (guild.members?.me) return guild.members.me;
    if (typeof guild.members?.fetchMe === 'function') {
        try {
            return await guild.members.fetchMe();
        } catch {}
    }
    if (client?.user?.id && typeof guild.members?.fetch === 'function') {
        try {
            return await guild.members.fetch(client.user.id);
        } catch {}
    }
    return null;
}

async function isAlreadyBanned(guild, userId, logger) {
    if (!guild?.bans) return false;
    try {
        const existing = await guild.bans.fetch(userId);
        return Boolean(existing);
    } catch (err) {
        const code = err?.code ?? err?.rawError?.code ?? null;
        if (code === 10026) {
            // Unknown Ban: user not banned.
            return false;
        }
        logger?.debug?.(`[global-ban] Unable to inspect bans in ${guild.id}: ${err?.message ?? err}`);
        return false;
    }
}

async function banUserInGuild({ client, guildId, targetId, targetTag, auditReason, logger }) {
    const result = {
        guildId,
        guildName: guildId,
        status: 'failed',
        error: 'Bot is not a member of this server.'
    };

    const guild = await fetchGuild(client, guildId);
    if (!guild) {
        logger?.warn?.(`[global-ban] Skipping guild ${guildId} — bot is not present.`);
        return result;
    }

    result.guildName = guild.name ?? guildId;
    result.error = 'Missing Ban Members permission.';

    const selfMember = await ensureSelfMember(guild, client);
    if (selfMember && !selfMember.permissions.has(PermissionFlagsBits.BanMembers)) {
        logger?.warn?.(`[global-ban] Missing Ban Members permission in ${guild.name ?? guildId}.`);
        return result;
    }

    try {
        if (await isAlreadyBanned(guild, targetId, logger)) {
            logger?.info?.(`[global-ban] ${targetTag} (${targetId}) already banned in ${guild.name ?? guildId}.`);
            return { ...result, status: 'already', error: null };
        }
    } catch {}

    try {
        await guild.members.ban(targetId, { reason: auditReason, deleteMessageSeconds: 0 });
        logger?.info?.(`[global-ban] Banned ${targetTag} (${targetId}) in ${guild.name ?? guildId}.`);
        return { ...result, status: 'banned', error: null };
    } catch (err) {
        const message = err?.message ?? String(err ?? 'Unknown error');
        logger?.warn?.(`[global-ban] Failed to ban ${targetTag} (${targetId}) in ${guild.name ?? guildId}: ${message}`);
        return { ...result, status: 'failed', error: message };
    }
}

export function formatBanResults(targetLabel, results, { reason } = {}) {
    const lines = [];
    lines.push(`Ban results for **${targetLabel}**:`);
    if (reason) {
        lines.push(`Reason: ${reason}`);
    }

    if (!results?.length) {
        lines.push('No target servers were found to process the ban.');
        return lines.join('\n');
    }

    const successes = results.filter(entry => entry.status === 'banned');
    const already = results.filter(entry => entry.status === 'already');
    const failures = results.filter(entry => entry.status === 'failed');

    const list = (entries, formatter = (entry) => `• ${entry.guildName ?? entry.guildId}`) =>
        entries.map(formatter).join('\n');

    if (successes.length) {
        lines.push(`✅ Banned in ${successes.length} server(s):`);
        lines.push(list(successes));
    }

    if (already.length) {
        lines.push(`ℹ️ Already banned in ${already.length} server(s):`);
        lines.push(list(already));
    }

    if (failures.length) {
        lines.push(`⚠️ Failed in ${failures.length} server(s):`);
        lines.push(list(failures, (entry) => `• ${entry.guildName ?? entry.guildId} — ${entry.error ?? 'Unknown error'}`));
    }

    return lines.join('\n');
}

export const commands = [
    new SlashCommandBuilder()
    .setName('ban')
    .setDescription('Ban a user across all managed servers')
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
    .setDMPermission(false)
    .addUserOption(opt =>
        opt
        .setName('user')
        .setDescription('User to ban across every managed server')
        .setRequired(true)
    )
    .addStringOption(opt =>
        opt
        .setName('reason')
        .setDescription('Reason to record in audit logs')
        .setRequired(false)
        .setMaxLength(512)
    )
];

export function init({ client, config, logger }) {
    let activeConfig = config;

    client.on('squire:configUpdated', (nextConfig) => {
        if (nextConfig && typeof nextConfig === 'object') {
            activeConfig = nextConfig;
        }
    });

    client.on('interactionCreate', async (interaction) => {
        if (!interaction.isChatInputCommand()) return;
        if (interaction.commandName !== 'ban') return;

        if (!interaction.inGuild()) {
            await interaction.reply({
                content: 'Use this command inside a server so permissions can be verified.',
                ephemeral: true
            });
            return;
        }

        if (!interaction.memberPermissions?.has(PermissionFlagsBits.BanMembers)) {
            await interaction.reply({
                content: 'You need the **Ban Members** permission to use this command.',
                ephemeral: true
            });
            return;
        }

        const targetUser = interaction.options.getUser('user', true);
        if (!targetUser || !targetUser.id) {
            await interaction.reply({ content: 'Select a valid user to ban.', ephemeral: true });
            return;
        }

        if (client.user?.id && targetUser.id === client.user.id) {
            await interaction.reply({
                content: 'I cannot ban myself.',
                ephemeral: true
            });
            return;
        }

        const rawReason = interaction.options.getString('reason') ?? '';
        const reason = rawReason.trim();
        const auditReason = buildAuditReason(interaction.user, reason);

        const guildIds = collectTargetGuildIds(activeConfig, client, interaction.guildId);
        if (!guildIds.length) {
            await interaction.reply({
                content: 'No managed servers are configured for cross-server bans yet.',
                ephemeral: true
            });
            return;
        }

        await interaction.deferReply({ ephemeral: true });

        const targetLabel = targetUser.tag ?? targetUser.username ?? targetUser.id;
        const results = [];

        for (const guildId of guildIds) {
            // eslint-disable-next-line no-await-in-loop
            const outcome = await banUserInGuild({
                client,
                guildId,
                targetId: targetUser.id,
                targetTag: targetLabel,
                auditReason,
                logger
            });
            results.push(outcome);
        }

        const summary = formatBanResults(targetLabel, results, { reason });
        await interaction.editReply({
            content: summary,
            allowedMentions: { parse: [] }
        });
    });
}

