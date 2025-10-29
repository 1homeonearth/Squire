// src/features/auto-bouncer/index.js
// Automatically bans freshly-joined members whose usernames contain
// suspicious keywords (mega/links spam bots, etc.).

import { WebhookClient } from 'discord.js';
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

function timestampContent(message) {
    const unix = Math.floor(Date.now() / 1000);
    const tsTag = `<t:${unix}:f>`;
    if (typeof message === 'string') {
        return `🕒 ${tsTag} • ${message}`;
    }
    if (message && typeof message === 'object') {
        const clone = { ...message };
        if (typeof clone.content === 'string' && clone.content.trim().length) {
            clone.content = `🕒 ${tsTag} • ${clone.content}`;
        } else {
            clone.content = `🕒 ${tsTag}`;
        }
        return clone;
    }
    return `🕒 ${tsTag} • ${String(message ?? '')}`;
}

async function safeNotify(channel, message, logger) {
    if (!channel) return;
    try {
        await channel.send(timestampContent(message));
    } catch (err) {
        logger?.warn?.(`[autoban] Failed to notify in ${channel.id}: ${err?.message ?? err}`);
    }
}

async function safeWebhookNotify(urls, message, logger) {
    const list = Array.isArray(urls) ? urls : urls ? [urls] : [];
    await Promise.all(list.map(async (url) => {
        if (!url) return;
        try {
            const client = new WebhookClient({ url });
            const payload = timestampContent({ content: typeof message === 'string' ? message : message?.content });
            await client.send(typeof payload === 'string' ? { content: payload } : payload);
            client.destroy?.();
        } catch (err) {
            logger?.warn?.(`[autoban] Failed to notify webhook ${truncateWebhook(url)}: ${err?.message ?? err}`);
        }
    }));
}

function truncateWebhook(url) {
    try {
        const u = new URL(url);
        return `${u.host}/${u.pathname.split('/').slice(-2).join('/')}`;
    } catch {
        return typeof url === 'string' && url.length > 40 ? `${url.slice(0, 37)}…` : String(url || 'unknown');
    }
}

export function init({ client, logger, config, db }) {
    if (!config.autoban || typeof config.autoban !== 'object') {
        config.autoban = {};
    }

    const moderationEvents = db ? ensureCollection(db, 'moderation_events', { indices: ['guildId', 'userId', 'type'] }) : null;

    function getConfig() {
        const autobanCfg = config.autoban || {};
        return {
            enabled: autobanCfg.enabled !== false,
            blockedTerms: normaliseTerms(autobanCfg.blockedUsernames || DEFAULT_BLOCKED_TERMS),
            notifyChannelId: typeof autobanCfg.notifyChannelId === 'string' ? autobanCfg.notifyChannelId : null,
            notifyWebhooks: normaliseWebhookUrls(autobanCfg.notifyWebhookUrls ?? autobanCfg.notifyWebhookUrl),
            deleteMessageSeconds: Number.isInteger(autobanCfg.deleteMessageSeconds)
                ? Math.max(0, autobanCfg.deleteMessageSeconds)
                : 0
        };
    }

    const initial = getConfig();
    if (!initial.enabled) {
        logger?.info?.('[autoban] Disabled via config.');
    } else if (!initial.blockedTerms.length) {
        logger?.warn?.('[autoban] No blocked username terms configured; feature will not run until configured.');
    } else {
        logger?.info?.(`[autoban] Watching for ${initial.blockedTerms.length} blocked term(s).`);
    }

    client.on('guildMemberAdd', async (member) => {
        try {
            if (!member.guild) return;

            const cfg = getConfig();
            if (!cfg.enabled) return;

            if (!cfg.blockedTerms.length) return;

            const names = collectCandidateNames(member);
            if (names.length === 0) return;

            const matchedTerm = cfg.blockedTerms.find(term => names.some(name => name.includes(term)));
            if (!matchedTerm) return;

            const reason = `Auto-ban: username contained "${matchedTerm}"`;

            const guildName = member.guild?.name ?? 'Unknown Server';
            const guildId = member.guild?.id ?? 'unknown';

            if (!member.bannable) {
                logger?.warn?.(`[autoban] Lacked permission to ban ${member.user?.tag ?? member.id} in guild ${guildName} (${guildId}): ${reason}`);
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
                if (cfg.notifyChannelId) {
                    const notifyChannel = await resolveLogChannel(member.guild, cfg.notifyChannelId);
                    await safeNotify(
                        notifyChannel,
                        `⚠️ Could not auto-ban **${member.user?.tag ?? member.id}** in **${guildName}** (ID: ${guildId}) — missing permissions.`,
                        logger
                    );
                }
                if (cfg.notifyWebhooks.length) {
                    await safeWebhookNotify(
                        cfg.notifyWebhooks,
                        `⚠️ Could not auto-ban **${member.user?.tag ?? member.id}** in **${guildName}** (ID: ${guildId}) — missing permissions.`,
                        logger
                    );
                }
                return;
            }

            await member.ban({ reason, deleteMessageSeconds: cfg.deleteMessageSeconds });

            logger?.info?.(`[autoban] Banned ${member.user?.tag ?? member.id} (${member.id}) in guild ${guildName} (${guildId}) — matched term "${matchedTerm}".`);

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

            if (cfg.notifyChannelId) {
                const notifyChannel = await resolveLogChannel(member.guild, cfg.notifyChannelId);
                await safeNotify(
                    notifyChannel,
                    `🚫 Auto-banned **${member.user?.tag ?? member.id}** in **${guildName}** (ID: ${guildId}) — username matched "${matchedTerm}".`,
                    logger
                );
            }
            if (cfg.notifyWebhooks.length) {
                await safeWebhookNotify(
                    cfg.notifyWebhooks,
                    `🚫 Auto-banned **${member.user?.tag ?? member.id}** in **${guildName}** (ID: ${guildId}) — username matched "${matchedTerm}".`,
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

function normaliseWebhookUrls(value) {
    if (!value) return [];
    const raw = Array.isArray(value) ? value : [value];
    return raw
        .map(v => typeof v === 'string' ? v.trim() : '')
        .filter(Boolean);
}
