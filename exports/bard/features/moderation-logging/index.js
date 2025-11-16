// src/features/moderation-logging/index.js
// Dedicated moderation logging module that records moderator actions
// and category updates to configured channels in the logging server.

import { AuditLogEvent, ChannelType } from 'discord.js';

function sanitizeChannelId(value) {
    if (!value) return null;
    const trimmed = String(value).trim();
    return /^\d{15,25}$/.test(trimmed) ? trimmed : null;
}

function normalizeModerationLogging(raw) {
    if (!raw || typeof raw !== 'object') {
        return { categoryChannelId: null, actionChannelId: null };
    }
    return {
        categoryChannelId: sanitizeChannelId(raw.categoryChannelId),
        actionChannelId: sanitizeChannelId(raw.actionChannelId)
    };
}

export async function init({ client, config, logger }) {
    let loggingServerId = config.loggingServerId ?? null;
    let moderationLogging = normalizeModerationLogging(config.moderationLogging);

    const loggingGuildCache = { id: null, guild: null };

    function formatUserLabel(user) {
        if (!user) return 'Unknown';
        const id = user.id ?? 'unknown';
        const name = user.tag
            ?? user.globalName
            ?? user.username
            ?? user.displayName
            ?? id;
        return `${name} (${id})`;
    }

    function formatGuildLabel(guild) {
        const id = guild?.id ?? 'unknown';
        const name = guild?.name ?? id;
        return `${name} (${id})`;
    }

    function formatTimestampLabel(timestamp) {
        if (!Number.isFinite(timestamp)) return null;
        const unix = Math.floor(timestamp / 1000);
        if (!Number.isFinite(unix)) return null;
        return `<t:${unix}:f> (<t:${unix}:R>)`;
    }

    function updateLocalConfig(source) {
        try {
            const base = source && typeof source === 'object' ? source : config;
            const nextLoggingServerId = base.loggingServerId || null;
            if (nextLoggingServerId !== loggingServerId) {
                loggingServerId = nextLoggingServerId;
                loggingGuildCache.id = null;
                loggingGuildCache.guild = null;
            }
            moderationLogging = normalizeModerationLogging(base.moderationLogging);
        } catch {}
    }

    async function fetchLoggingGuild() {
        if (!loggingServerId) return null;
        if (loggingGuildCache.id === loggingServerId && loggingGuildCache.guild) {
            return loggingGuildCache.guild;
        }

        let guild = client.guilds.cache.get(loggingServerId) ?? null;
        if (!guild && typeof client.guilds.fetch === 'function') {
            guild = await client.guilds.fetch(loggingServerId).catch(() => null);
        }

        if (guild) {
            loggingGuildCache.id = loggingServerId;
            loggingGuildCache.guild = guild;
        }

        return guild;
    }

    async function resolveLoggingChannel(channelId) {
        if (!channelId) return null;
        const guild = await fetchLoggingGuild();
        if (!guild) return null;

        let channel = guild.channels?.cache?.get(channelId) ?? null;
        if (!channel && typeof guild.channels?.fetch === 'function') {
            channel = await guild.channels.fetch(channelId).catch(() => null);
        }

        if (channel && typeof channel.isTextBased === 'function' && channel.isTextBased()) {
            return channel;
        }
        return null;
    }

    async function sendCategoryLog({ action, guild, category, moderator, reason, extraLines = [] }) {
        const channelId = moderationLogging.categoryChannelId;
        if (!loggingServerId || !channelId) return;

        const channel = await resolveLoggingChannel(channelId);
        if (!channel) return;

        const guildLabel = formatGuildLabel(guild);
        const header = `📁 **${guildLabel}** — ${action} → <#${channelId}>`;
        const categoryLabel = category?.name
            ? `${category.name} (${category.id ?? 'unknown'})`
            : `ID ${category?.id ?? 'unknown'}`;

        const lines = [header, `• Category: ${categoryLabel}`];

        if (moderator) {
            lines.push(`• Moderator: ${formatUserLabel(moderator)}`);
        }
        if (reason) {
            lines.push(`• Reason: ${reason}`);
        }
        if (Array.isArray(extraLines) && extraLines.length) {
            for (const line of extraLines) {
                if (line) {
                    lines.push(line);
                }
            }
        }

        const content = lines.join('\n');
        try {
            await channel.send({ content, allowedMentions: { parse: [] } });
        } catch (err) {
            logger?.warn?.(`[modlog] Failed to send category log to ${channelId}: ${err?.message ?? err}`);
        }
    }

    async function sendActionLog({ action, guild, targetUser, moderator, reason, contextChannel, extraLines = [] }) {
        const channelId = moderationLogging.actionChannelId;
        if (!loggingServerId || !channelId) return;

        const channel = await resolveLoggingChannel(channelId);
        if (!channel) return;

        const guildLabel = formatGuildLabel(guild);
        const header = `🛡️ **${guildLabel}** — ${action} → <#${channelId}>`;
        const lines = [header];

        lines.push(`• Target: ${formatUserLabel(targetUser)}`);
        lines.push(`• Moderator: ${moderator ? formatUserLabel(moderator) : 'Unknown'}`);
        if (contextChannel) {
            lines.push(`• Channel: ${contextChannel}`);
        }
        if (reason) {
            lines.push(`• Reason: ${reason}`);
        }
        if (Array.isArray(extraLines) && extraLines.length) {
            for (const line of extraLines) {
                if (line) {
                    lines.push(line);
                }
            }
        }

        const content = lines.join('\n');
        try {
            await channel.send({ content, allowedMentions: { parse: [] } });
        } catch (err) {
            logger?.warn?.(`[modlog] Failed to send action log to ${channelId}: ${err?.message ?? err}`);
        }
    }

    async function findRecentAuditLogEntry(guild, type, targetId, predicate = null) {
        if (!guild || typeof guild.fetchAuditLogs !== 'function') {
            return null;
        }

        try {
            const logs = await guild.fetchAuditLogs({ limit: 5, type });
            const entries = logs?.entries;
            if (!entries || typeof entries.values !== 'function') {
                return null;
            }

            const now = Date.now();
            for (const entry of entries.values()) {
                if (targetId && entry?.target?.id && entry.target.id !== targetId) continue;
                if (predicate && !predicate(entry)) continue;
                const created = entry?.createdTimestamp;
                if (!Number.isFinite(created) || Math.abs(now - created) > 60_000) {
                    continue;
                }
                return entry;
            }
        } catch (err) {
            logger?.warn?.(`[modlog] Audit log fetch failed in guild ${guild?.id ?? 'unknown'}: ${err?.message ?? err}`);
        }

        return null;
    }

    function summarizeCategoryChange(oldChannel, newChannel) {
        const details = [];
        const oldName = oldChannel?.name ?? null;
        const newName = newChannel?.name ?? null;
        if (oldName && newName && oldName !== newName) {
            details.push(`• Name: ${oldName} → ${newName}`);
        }
        const oldPosition = Number.isFinite(oldChannel?.rawPosition) ? oldChannel.rawPosition : null;
        const newPosition = Number.isFinite(newChannel?.rawPosition) ? newChannel.rawPosition : null;
        if (oldPosition !== null && newPosition !== null && oldPosition !== newPosition) {
            details.push(`• Position: ${oldPosition} → ${newPosition}`);
        }
        const oldPermCount = oldChannel?.permissionOverwrites?.cache?.size ?? 0;
        const newPermCount = newChannel?.permissionOverwrites?.cache?.size ?? 0;
        if (oldPermCount !== newPermCount) {
            details.push('• Permission overwrites updated.');
        }
        return details;
    }

    client.on('squire:configUpdated', (nextConfig) => {
        updateLocalConfig(nextConfig);
    });

    client.on('channelCreate', async (channel) => {
        try {
            if (!channel || channel.type !== ChannelType.GuildCategory) return;
            const guild = channel.guild ?? null;
            if (!guild) return;

            const entry = await findRecentAuditLogEntry(guild, AuditLogEvent.ChannelCreate, channel.id);
            const moderator = entry?.executor ?? null;
            const reason = entry?.reason ?? null;

            await sendCategoryLog({
                action: 'Category created',
                guild,
                category: channel,
                moderator,
                reason
            });
        } catch (err) {
            logger?.warn?.(`[modlog] Failed to record category creation: ${err?.message ?? err}`);
        }
    });

    client.on('channelDelete', async (channel) => {
        try {
            if (!channel || channel.type !== ChannelType.GuildCategory) return;
            const guild = channel.guild ?? null;
            if (!guild) return;

            const entry = await findRecentAuditLogEntry(guild, AuditLogEvent.ChannelDelete, channel.id);
            const moderator = entry?.executor ?? null;
            const reason = entry?.reason ?? null;

            await sendCategoryLog({
                action: 'Category deleted',
                guild,
                category: channel,
                moderator,
                reason
            });
        } catch (err) {
            logger?.warn?.(`[modlog] Failed to record category deletion: ${err?.message ?? err}`);
        }
    });

    client.on('channelUpdate', async (oldChannel, newChannel) => {
        try {
            const wasCategory = oldChannel?.type === ChannelType.GuildCategory;
            const isCategory = newChannel?.type === ChannelType.GuildCategory;
            if (!wasCategory && !isCategory) return;

            const guild = newChannel?.guild ?? oldChannel?.guild ?? null;
            if (!guild) return;

            const targetId = newChannel?.id ?? oldChannel?.id ?? null;
            const entry = await findRecentAuditLogEntry(
                guild,
                AuditLogEvent.ChannelUpdate,
                targetId,
                (candidate) => candidate?.target?.type === ChannelType.GuildCategory
            );
            const moderator = entry?.executor ?? null;
            const reason = entry?.reason ?? null;

            const summaryLines = summarizeCategoryChange(oldChannel, newChannel);
            if (!summaryLines.length && !reason) {
                return;
            }

            await sendCategoryLog({
                action: 'Category updated',
                guild,
                category: newChannel ?? oldChannel,
                moderator,
                reason,
                extraLines: summaryLines
            });
        } catch (err) {
            logger?.warn?.(`[modlog] Failed to record category update: ${err?.message ?? err}`);
        }
    });

    client.on('guildBanAdd', async (ban) => {
        try {
            const guild = ban?.guild ?? null;
            const user = ban?.user ?? null;
            if (!guild || !user) return;

            const entry = await findRecentAuditLogEntry(guild, AuditLogEvent.MemberBanAdd, user.id);
            const moderator = entry?.executor ?? null;
            const reason = entry?.reason ?? ban?.reason ?? null;

            await sendActionLog({
                action: 'Ban',
                guild,
                targetUser: user,
                moderator,
                reason
            });
        } catch (err) {
            logger?.warn?.(`[modlog] Failed to record ban: ${err?.message ?? err}`);
        }
    });

    client.on('guildBanRemove', async (ban) => {
        try {
            const guild = ban?.guild ?? null;
            const user = ban?.user ?? null;
            if (!guild || !user) return;

            const entry = await findRecentAuditLogEntry(guild, AuditLogEvent.MemberBanRemove, user.id);
            const moderator = entry?.executor ?? null;
            const reason = entry?.reason ?? ban?.reason ?? null;

            await sendActionLog({
                action: 'Unban',
                guild,
                targetUser: user,
                moderator,
                reason
            });
        } catch (err) {
            logger?.warn?.(`[modlog] Failed to record unban: ${err?.message ?? err}`);
        }
    });

    client.on('guildMemberRemove', async (member) => {
        try {
            const guild = member?.guild ?? null;
            const user = member?.user ?? null;
            if (!guild || !user) return;

            const entry = await findRecentAuditLogEntry(guild, AuditLogEvent.MemberKick, user.id);
            if (!entry) return;

            const moderator = entry.executor ?? null;
            const reason = entry.reason ?? null;

            await sendActionLog({
                action: 'Kick',
                guild,
                targetUser: user,
                moderator,
                reason
            });
        } catch (err) {
            logger?.warn?.(`[modlog] Failed to record kick: ${err?.message ?? err}`);
        }
    });

    client.on('guildMemberUpdate', async (oldMember, newMember) => {
        try {
            const guild = newMember?.guild ?? oldMember?.guild ?? null;
            if (!guild || !newMember) return;

            const oldTimeout = oldMember?.communicationDisabledUntilTimestamp ?? null;
            const newTimeout = newMember.communicationDisabledUntilTimestamp ?? null;

            if (oldTimeout === newTimeout) return;

            const hasTimeout = Number.isFinite(newTimeout) && newTimeout > Date.now();
            const clearedTimeout = Number.isFinite(oldTimeout) && !Number.isFinite(newTimeout);
            if (!hasTimeout && !clearedTimeout) return;

            const predicate = (entry) => {
                const changes = entry?.changes;
                if (!changes) return true;

                if (typeof changes.values === 'function') {
                    for (const change of changes.values()) {
                        if (change?.key === 'communication_disabled_until') {
                            return true;
                        }
                    }
                    return false;
                }

                if (Array.isArray(changes)) {
                    return changes.some(change => change?.key === 'communication_disabled_until');
                }

                return true;
            };

            const entry = await findRecentAuditLogEntry(guild, AuditLogEvent.MemberUpdate, newMember.id, predicate);
            const moderator = entry?.executor ?? null;
            const reason = entry?.reason ?? null;

            if (hasTimeout) {
                const expires = formatTimestampLabel(newTimeout);
                const extra = expires ? [`• Expires: ${expires}`] : [];
                await sendActionLog({
                    action: 'Timeout applied',
                    guild,
                    targetUser: newMember.user ?? newMember,
                    moderator,
                    reason,
                    extraLines: extra
                });
            } else if (clearedTimeout) {
                await sendActionLog({
                    action: 'Timeout cleared',
                    guild,
                    targetUser: newMember.user ?? newMember,
                    moderator,
                    reason
                });
            }
        } catch (err) {
            logger?.warn?.(`[modlog] Failed to record timeout update: ${err?.message ?? err}`);
        }
    });

    updateLocalConfig(config);
}
