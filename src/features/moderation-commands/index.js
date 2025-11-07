// src/features/moderation-commands/index.js
// Provides moderation slash commands (ban, unban, kick, timeout) with role-gated access.

import {
    SlashCommandBuilder,
    PermissionFlagsBits
} from 'discord.js';

const TIMEOUT_CHOICES = [
    { name: '10 minutes', value: 600 },
    { name: '1 hour', value: 3_600 },
    { name: '12 hours', value: 43_200 },
    { name: '1 day', value: 86_400 },
    { name: '3 days', value: 259_200 },
    { name: '1 week', value: 604_800 }
];

function normalizeId(value) {
    if (!value && value !== 0) return null;
    const str = String(value).trim();
    return str.length ? str : null;
}

function clampAuditReason(reason) {
    const MAX_LENGTH = 512;
    if (reason.length <= MAX_LENGTH) return reason;
    return `${reason.slice(0, MAX_LENGTH - 1)}…`;
}

function buildAuditReason(actor, baseReason, action) {
    const tag = actor?.tag ?? actor?.username ?? actor?.id ?? 'unknown';
    const actorId = actor?.id ?? 'unknown';
    const prefix = `[Moderation:${action}] Requested by ${tag} (${actorId})`;
    const suffix = baseReason ? ` — ${baseReason}` : '';
    return clampAuditReason(`${prefix}${suffix}`);
}

function getMemberRoleIds(member) {
    if (!member) return [];
    if (Array.isArray(member.roles)) {
        return member.roles.map(String).map(id => id.trim()).filter(Boolean);
    }
    const manager = member.roles;
    if (manager && typeof manager.cache === 'object') {
        return Array.from(manager.cache.keys());
    }
    if (Array.isArray(manager?.data)) {
        return manager.data.map(String).map(id => id.trim()).filter(Boolean);
    }
    return [];
}

function getModerationRoleMap(config) {
    if (!config?.moderationCommands || typeof config.moderationCommands !== 'object') {
        return {};
    }
    const map = config.moderationCommands.roleMap;
    if (!map || typeof map !== 'object') return {};
    const cleaned = {};
    for (const [guildId, values] of Object.entries(map)) {
        const key = normalizeId(guildId);
        if (!key) continue;
        const arr = Array.isArray(values) ? values : [];
        const seen = new Set();
        const next = [];
        for (const value of arr) {
            const normalized = normalizeId(value);
            if (!normalized || seen.has(normalized)) continue;
            seen.add(normalized);
            next.push(normalized);
        }
        cleaned[key] = next;
    }
    return cleaned;
}

function getAllowedRoleIds(config, guildId) {
    const key = normalizeId(guildId);
    if (!key) return [];
    const map = getModerationRoleMap(config);
    return map[key] ?? [];
}

function memberHasAllowedRole(member, allowedRoleIds) {
    if (!allowedRoleIds?.length) return false;
    const memberRoleIds = getMemberRoleIds(member);
    return memberRoleIds.some(id => allowedRoleIds.includes(id));
}

function hasModeratorAccess({ interaction, config }) {
    if (!interaction.inGuild()) {
        return { ok: false, reason: 'Use moderation commands inside a server.' };
    }

    if (interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
        return { ok: true };
    }

    const allowedRoleIds = getAllowedRoleIds(config, interaction.guildId);
    if (!allowedRoleIds.length) {
        const fallback = interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
        if (fallback) {
            return { ok: true };
        }
        return {
            ok: false,
            reason: 'No moderator roles are configured yet. Ask an admin to select them in /setup.'
        };
    }

    if (memberHasAllowedRole(interaction.member, allowedRoleIds)) {
        return { ok: true };
    }

    return {
        ok: false,
        reason: 'Only moderators selected in /setup can use this command.'
    };
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
        logger?.debug?.(`[moderation] Unable to inspect bans in ${guild.id}: ${err?.message ?? err}`);
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
        logger?.warn?.(`[moderation] Skipping guild ${guildId} — bot is not present.`);
        return result;
    }

    result.guildName = guild.name ?? guildId;
    result.error = 'Missing Ban Members permission.';

    const selfMember = await ensureSelfMember(guild, client);
    if (selfMember && !selfMember.permissions.has(PermissionFlagsBits.BanMembers)) {
        logger?.warn?.(`[moderation] Missing Ban Members permission in ${guild.name ?? guildId}.`);
        return result;
    }

    try {
        if (await isAlreadyBanned(guild, targetId, logger)) {
            logger?.info?.(`[moderation] ${targetTag} (${targetId}) already banned in ${guild.name ?? guildId}.`);
            return { ...result, status: 'already', error: null };
        }
    } catch {}

    try {
        await guild.members.ban(targetId, { reason: auditReason, deleteMessageSeconds: 0 });
        logger?.info?.(`[moderation] Banned ${targetTag} (${targetId}) in ${guild.name ?? guildId}.`);
        return { ...result, status: 'banned', error: null };
    } catch (err) {
        const message = err?.message ?? String(err ?? 'Unknown error');
        logger?.warn?.(`[moderation] Failed to ban ${targetTag} (${targetId}) in ${guild.name ?? guildId}: ${message}`);
        return { ...result, status: 'failed', error: message };
    }
}

async function unbanUserInGuild({ client, guildId, targetId, targetTag, auditReason, logger }) {
    const result = {
        guildId,
        guildName: guildId,
        status: 'failed',
        error: 'Bot is not a member of this server.'
    };

    const guild = await fetchGuild(client, guildId);
    if (!guild) {
        logger?.warn?.(`[moderation] Skipping guild ${guildId} — bot is not present.`);
        return result;
    }

    result.guildName = guild.name ?? guildId;
    result.error = 'Missing Ban Members permission.';

    const selfMember = await ensureSelfMember(guild, client);
    if (selfMember && !selfMember.permissions.has(PermissionFlagsBits.BanMembers)) {
        logger?.warn?.(`[moderation] Missing Ban Members permission in ${guild.name ?? guildId}.`);
        return result;
    }

    try {
        await guild.members.unban(targetId, auditReason ? { reason: auditReason } : {});
        logger?.info?.(`[moderation] Unbanned ${targetTag} (${targetId}) in ${guild.name ?? guildId}.`);
        return { ...result, status: 'unbanned', error: null };
    } catch (err) {
        const code = err?.code ?? err?.rawError?.code ?? null;
        if (code === 10026) {
            logger?.info?.(`[moderation] ${targetTag} (${targetId}) was not banned in ${guild.name ?? guildId}.`);
            return { ...result, status: 'not_found', error: null };
        }
        const message = err?.message ?? String(err ?? 'Unknown error');
        logger?.warn?.(`[moderation] Failed to unban ${targetTag} (${targetId}) in ${guild.name ?? guildId}: ${message}`);
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

export function formatUnbanResults(targetLabel, results, { reason } = {}) {
    const lines = [];
    lines.push(`Unban results for **${targetLabel}**:`);
    if (reason) {
        lines.push(`Reason: ${reason}`);
    }

    if (!results?.length) {
        lines.push('No target servers were found to process the unban.');
        return lines.join('\n');
    }

    const successes = results.filter(entry => entry.status === 'unbanned');
    const missing = results.filter(entry => entry.status === 'not_found');
    const failures = results.filter(entry => entry.status === 'failed');

    const list = (entries, formatter = (entry) => `• ${entry.guildName ?? entry.guildId}`) =>
        entries.map(formatter).join('\n');

    if (successes.length) {
        lines.push(`✅ Unbanned in ${successes.length} server(s):`);
        lines.push(list(successes));
    }

    if (missing.length) {
        lines.push(`ℹ️ Not banned in ${missing.length} server(s):`);
        lines.push(list(missing));
    }

    if (failures.length) {
        lines.push(`⚠️ Failed in ${failures.length} server(s):`);
        lines.push(list(failures, (entry) => `• ${entry.guildName ?? entry.guildId} — ${entry.error ?? 'Unknown error'}`));
    }

    return lines.join('\n');
}

function buildModerationDenyResponse({ interaction, reason }) {
    if (!interaction.deferred && !interaction.replied) {
        return interaction.reply({ content: reason, ephemeral: true });
    }
    return interaction.followUp({ content: reason, ephemeral: true });
}

async function handleBanCommand({ interaction, client, config, logger }) {
    const access = hasModeratorAccess({ interaction, config });
    if (!access.ok) {
        await buildModerationDenyResponse({ interaction, reason: access.reason });
        return;
    }

    if (!interaction.inGuild()) {
        await interaction.reply({
            content: 'Use this command inside a server so permissions can be verified.',
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
    const auditReason = buildAuditReason(interaction.user, reason, 'ban');

    const guildIds = collectTargetGuildIds(config, client, interaction.guildId);
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
}

async function handleUnbanCommand({ interaction, client, config, logger }) {
    const access = hasModeratorAccess({ interaction, config });
    if (!access.ok) {
        await buildModerationDenyResponse({ interaction, reason: access.reason });
        return;
    }

    if (!interaction.inGuild()) {
        await interaction.reply({
            content: 'Use this command inside a server so permissions can be verified.',
            ephemeral: true
        });
        return;
    }

    const targetId = normalizeId(interaction.options.getString('user'));
    if (!targetId) {
        await interaction.reply({ content: 'Provide a valid user ID to unban.', ephemeral: true });
        return;
    }

    if (client.user?.id && targetId === client.user.id) {
        await interaction.reply({
            content: 'I cannot unban myself.',
            ephemeral: true
        });
        return;
    }

    const rawReason = interaction.options.getString('reason') ?? '';
    const reason = rawReason.trim();
    const auditReason = buildAuditReason(interaction.user, reason, 'unban');

    const guildIds = collectTargetGuildIds(config, client, interaction.guildId);
    if (!guildIds.length) {
        await interaction.reply({
            content: 'No managed servers are configured for cross-server unbans yet.',
            ephemeral: true
        });
        return;
    }

    await interaction.deferReply({ ephemeral: true });

    const targetLabel = targetId;
    const results = [];

    for (const guildId of guildIds) {
        const outcome = await unbanUserInGuild({
            client,
            guildId,
            targetId,
            targetTag: targetLabel,
            auditReason,
            logger
        });
        results.push(outcome);
    }

    const summary = formatUnbanResults(targetLabel, results, { reason });
    await interaction.editReply({
        content: summary,
        allowedMentions: { parse: [] }
    });
}

async function fetchMember(interaction, userOption) {
    const member = interaction.options.getMember(userOption);
    if (member) return member;
    if (!interaction.guild) return null;
    const user = interaction.options.getUser(userOption);
    if (!user?.id) return null;
    try {
        return await interaction.guild.members.fetch(user.id);
    } catch {
        return null;
    }
}

async function handleKickCommand({ interaction, config, logger }) {
    const access = hasModeratorAccess({ interaction, config });
    if (!access.ok) {
        await buildModerationDenyResponse({ interaction, reason: access.reason });
        return;
    }

    if (!interaction.inGuild()) {
        await interaction.reply({ content: 'This command only works inside a server.', ephemeral: true });
        return;
    }

    const member = await fetchMember(interaction, 'user');
    if (!member) {
        await interaction.reply({ content: 'That member is not in this server.', ephemeral: true });
        return;
    }

    if (member.id === interaction.user.id) {
        await interaction.reply({ content: 'You cannot kick yourself.', ephemeral: true });
        return;
    }

    if (member.id === interaction.client.user?.id) {
        await interaction.reply({ content: 'I cannot kick myself.', ephemeral: true });
        return;
    }

    const reason = (interaction.options.getString('reason') ?? '').trim();
    const auditReason = buildAuditReason(interaction.user, reason, 'kick');

    try {
        await member.kick(auditReason);
        logger?.info?.(`[moderation] Kicked ${member.user?.tag ?? member.id} (${member.id}) from ${interaction.guild?.name ?? interaction.guildId}.`);
        await interaction.reply({
            content: `Kicked **${member.user?.tag ?? member.id}** from this server.${reason ? ` Reason: ${reason}` : ''}`,
            ephemeral: true
        });
    } catch (err) {
        const message = err?.message ?? String(err ?? 'Unknown error');
        logger?.warn?.(`[moderation] Failed to kick ${member.user?.tag ?? member.id} (${member.id}) in ${interaction.guild?.name ?? interaction.guildId}: ${message}`);
        await interaction.reply({
            content: `I could not kick **${member.user?.tag ?? member.id}**: ${message}`,
            ephemeral: true
        });
    }
}

async function handleTimeoutCommand({ interaction, config, logger }) {
    const access = hasModeratorAccess({ interaction, config });
    if (!access.ok) {
        await buildModerationDenyResponse({ interaction, reason: access.reason });
        return;
    }

    if (!interaction.inGuild()) {
        await interaction.reply({ content: 'This command only works inside a server.', ephemeral: true });
        return;
    }

    const member = await fetchMember(interaction, 'user');
    if (!member) {
        await interaction.reply({ content: 'That member is not in this server.', ephemeral: true });
        return;
    }

    if (member.id === interaction.user.id) {
        await interaction.reply({ content: 'You cannot timeout yourself.', ephemeral: true });
        return;
    }

    if (member.id === interaction.client.user?.id) {
        await interaction.reply({ content: 'I cannot timeout myself.', ephemeral: true });
        return;
    }

    const durationSeconds = interaction.options.getInteger('duration', true);
    const durationMs = durationSeconds * 1000;
    const reason = (interaction.options.getString('reason') ?? '').trim();
    const auditReason = buildAuditReason(interaction.user, reason, 'timeout');

    try {
        await member.timeout(durationMs, auditReason);
        logger?.info?.(`[moderation] Timed out ${member.user?.tag ?? member.id} (${member.id}) in ${interaction.guild?.name ?? interaction.guildId} for ${durationSeconds} seconds.`);
        const minutes = Math.round(durationSeconds / 60);
        const durationLabel = durationSeconds >= 3600
            ? `${(durationSeconds / 3600).toFixed(durationSeconds % 3600 === 0 ? 0 : 1)} hour(s)`
            : `${minutes} minute(s)`;
        await interaction.reply({
            content: `Timed out **${member.user?.tag ?? member.id}** for ${durationLabel}.${reason ? ` Reason: ${reason}` : ''}`,
            ephemeral: true
        });
    } catch (err) {
        const message = err?.message ?? String(err ?? 'Unknown error');
        logger?.warn?.(`[moderation] Failed to timeout ${member.user?.tag ?? member.id} (${member.id}) in ${interaction.guild?.name ?? interaction.guildId}: ${message}`);
        await interaction.reply({
            content: `I could not timeout **${member.user?.tag ?? member.id}**: ${message}`,
            ephemeral: true
        });
    }
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
    ),
    new SlashCommandBuilder()
    .setName('unban')
    .setDescription('Remove a ban across all managed servers')
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
    .setDMPermission(false)
    .addStringOption(opt =>
        opt
        .setName('user')
        .setDescription('User ID to unban across every managed server')
        .setRequired(true)
        .setMinLength(15)
        .setMaxLength(25)
    )
    .addStringOption(opt =>
        opt
        .setName('reason')
        .setDescription('Reason to record in audit logs')
        .setRequired(false)
        .setMaxLength(512)
    ),
    new SlashCommandBuilder()
    .setName('kick')
    .setDescription('Kick a member from this server')
    .setDefaultMemberPermissions(PermissionFlagsBits.KickMembers)
    .setDMPermission(false)
    .addUserOption(opt =>
        opt
        .setName('user')
        .setDescription('Member to kick')
        .setRequired(true)
    )
    .addStringOption(opt =>
        opt
        .setName('reason')
        .setDescription('Reason to record in audit logs')
        .setRequired(false)
        .setMaxLength(512)
    ),
    new SlashCommandBuilder()
    .setName('timeout')
    .setDescription('Apply a communication timeout to a member')
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .setDMPermission(false)
    .addUserOption(opt =>
        opt
        .setName('user')
        .setDescription('Member to timeout')
        .setRequired(true)
    )
    .addIntegerOption(opt => {
        opt
        .setName('duration')
        .setDescription('How long should the timeout last?')
        .setRequired(true);
        for (const choice of TIMEOUT_CHOICES) {
            opt.addChoices({ name: choice.name, value: choice.value });
        }
        return opt;
    })
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

        try {
            switch (interaction.commandName) {
                case 'ban':
                    await handleBanCommand({ interaction, client, config: activeConfig, logger });
                    break;
                case 'unban':
                    await handleUnbanCommand({ interaction, client, config: activeConfig, logger });
                    break;
                case 'kick':
                    await handleKickCommand({ interaction, config: activeConfig, logger });
                    break;
                case 'timeout':
                    await handleTimeoutCommand({ interaction, config: activeConfig, logger });
                    break;
                default:
                    break;
            }
        } catch (err) {
            logger?.error?.(`[moderation] Command error for /${interaction.commandName}: ${err?.message ?? err}`);
            try {
                if (interaction.isRepliable()) {
                    if (interaction.deferred || interaction.replied) {
                        await interaction.followUp({ content: 'Something went wrong handling that command.', ephemeral: true });
                    } else {
                        await interaction.reply({ content: 'Something went wrong handling that command.', ephemeral: true });
                    }
                }
            } catch {}
        }
    });
}

