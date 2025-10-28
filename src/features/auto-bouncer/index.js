// src/features/auto-bouncer/index.js
// Automatically bans freshly-joined members whose usernames contain
// suspicious keywords (mega/links spam bots, etc.).

import { ensureCollection } from '../../core/db.js';

const DEFAULT_BLOCKED_TERMS = ['mega', 'megas', 'link', 'links'];

function normaliseTerms(terms) {
    return [...new Set(
        (Array.isArray(terms) ? terms : [])
        .map(String)
        .map(s => s.trim().toLowerCase())
        .filter(Boolean)
    )];
}

function collectCandidateNames(member) {
    const names = new Set();
    const user = member.user;
    if (user) {
        if (user.username) names.add(user.username);
        if (user.globalName) names.add(user.globalName);
        if (user.tag && user.tag !== user.username) names.add(user.tag);
    }
    if (member.displayName) names.add(member.displayName);
    if (member.nickname) names.add(member.nickname);
    return [...names].map(n => n.toLowerCase());
}

async function resolveLogChannel(guild, channelId) {
    if (!channelId) return null;
    const existing = guild.channels.cache.get(channelId);
    if (existing && typeof existing.isTextBased === 'function' && existing.isTextBased()) {
        return existing;
    }
    try {
        const fetched = await guild.channels.fetch(channelId);
        if (fetched && typeof fetched.isTextBased === 'function' && fetched.isTextBased()) {
            return fetched;
        }
    } catch {}
    return null;
}

async function safeNotify(channel, message, logger) {
    if (!channel) return;
    try {
        await channel.send(message);
    } catch (err) {
        logger?.warn?.(`[autoban] Failed to notify in ${channel.id}: ${err?.message ?? err}`);
    }
}

export function init({ client, logger, config, db }) {
    const autobanCfg = config.autoban || {};
    const enabled = autobanCfg.enabled !== false;
    if (!enabled) {
        logger?.info?.('[autoban] Disabled via config.');
        return;
    }

    const blockedTerms = normaliseTerms(autobanCfg.blockedUsernames || DEFAULT_BLOCKED_TERMS);
    if (!blockedTerms.length) {
        logger?.warn?.('[autoban] No blocked username terms configured; feature will not run.');
        return;
    }

    const moderationEvents = db ? ensureCollection(db, 'moderation_events', { indices: ['guildId', 'userId', 'type'] }) : null;

    const verifiedRoleIds = new Set(
        Array.isArray(autobanCfg.verifiedRoleIds) ? autobanCfg.verifiedRoleIds.map(String) : []
    );
    const notifyChannelId = typeof autobanCfg.notifyChannelId === 'string' ? autobanCfg.notifyChannelId : null;
    const deleteMessageSeconds = Number.isInteger(autobanCfg.deleteMessageSeconds)
        ? Math.max(0, autobanCfg.deleteMessageSeconds)
        : 0;

    client.on('guildMemberAdd', async (member) => {
        try {
            if (!member.guild) return;

            if (verifiedRoleIds.size > 0 && member.roles?.cache?.some(role => verifiedRoleIds.has(role.id))) {
                return; // already verified
            }

            const names = collectCandidateNames(member);
            if (names.length === 0) return;

            const matchedTerm = blockedTerms.find(term => names.some(name => name.includes(term)));
            if (!matchedTerm) return;

            const reason = `Auto-ban: username contained "${matchedTerm}"`;

            if (!member.bannable) {
                logger?.warn?.(`[autoban] Lacked permission to ban ${member.user?.tag ?? member.id}: ${reason}`);
                moderationEvents?.insert({
                    type: 'autoban',
                    guildId: member.guild?.id ?? null,
                    userId: member.id,
                    matchedTerm,
                    status: 'failed-permission',
                    reason,
                    timestamp: Date.now(),
                    usernameSnapshot: {
                        username: member.user?.username ?? null,
                        globalName: member.user?.globalName ?? null,
                        displayName: member.displayName ?? null
                    }
                });
                if (notifyChannelId) {
                    const notifyChannel = await resolveLogChannel(member.guild, notifyChannelId);
                    await safeNotify(notifyChannel, `⚠️ Could not auto-ban **${member.user?.tag ?? member.id}** — missing permissions.`, logger);
                }
                return;
            }

            await member.ban({ reason, deleteMessageSeconds });

            logger?.info?.(`[autoban] Banned ${member.user?.tag ?? member.id} (${member.id}) — matched term "${matchedTerm}".`);

            moderationEvents?.insert({
                type: 'autoban',
                guildId: member.guild?.id ?? null,
                userId: member.id,
                matchedTerm,
                status: 'banned',
                reason,
                timestamp: Date.now(),
                usernameSnapshot: {
                    username: member.user?.username ?? null,
                    globalName: member.user?.globalName ?? null,
                    displayName: member.displayName ?? null
                }
            });

            if (notifyChannelId) {
                const notifyChannel = await resolveLogChannel(member.guild, notifyChannelId);
                await safeNotify(
                    notifyChannel,
                    `🚫 Auto-banned **${member.user?.tag ?? member.id}** — username matched "${matchedTerm}".`,
                    logger
                );
            }
        } catch (err) {
            logger?.error?.(`[autoban] Failed while processing new member ${member.id}: ${err?.message ?? err}`);
            moderationEvents?.insert({
                type: 'autoban',
                guildId: member.guild?.id ?? null,
                userId: member.id,
                matchedTerm: null,
                status: 'error',
                reason: err?.message ?? String(err ?? 'unknown error'),
                timestamp: Date.now(),
                usernameSnapshot: {
                    username: member.user?.username ?? null,
                    globalName: member.user?.globalName ?? null,
                    displayName: member.displayName ?? null
                }
            });
        }
    });
}
