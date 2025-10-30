// src/features/logging-forwarder/index.js
// Minimal working forwarder with proper ESM exports:
// - announces online to each mapped webhook
// - forwards text + first image/gif (respects excludes, sampleRate, forwardBots)

import {
    WebhookClient,
    EmbedBuilder
} from 'discord.js';
import { isYouTubeUrl, prepareForNativeEmbed } from '../../lib/youtube.js';
import { formatPollLines } from '../../lib/poll-format.js';

const RAINBOW = [0xFF0000, 0xFFA500, 0xFFFF00, 0x00FF00, 0x0000FF, 0x800080];

// --- helpers ---
const trunc = (s, n) => (s && String(s).length > n ? String(s).slice(0, n - 1) + '…' : String(s || ''));
const sanitizeMentions = (text) => typeof text === 'string'
    ? text.replace(/<(@[!&]?|#)(\d+)>/g, '<$1\u200B$2>')
    : '';
const formatAsBlockQuote = (text) => (text || '').split(/\r?\n/).map((line) => `> ${line}`).join('\n');

async function resolveMemberContext(guild, user) {
    const fallbackName = user?.globalName ?? user?.username ?? user?.id ?? 'Unknown user';
    const fallbackAvatar = typeof user?.displayAvatarURL === 'function' ? user.displayAvatarURL() : null;

    if (!guild || !user) {
        return { displayName: fallbackName, avatarURL: fallbackAvatar };
    }

    let member = null;
    try {
        const cache = guild.members?.cache;
        if (cache && typeof cache.get === 'function') {
            member = cache.get(user.id) ?? null;
        }
        if (!member && typeof guild.members?.fetch === 'function') {
            member = await guild.members.fetch(user.id);
        }
    } catch {}

    const displayName = member?.displayName ?? fallbackName;
    const avatarURL = typeof member?.displayAvatarURL === 'function'
        ? member.displayAvatarURL()
        : fallbackAvatar;

    return { displayName, avatarURL };
}
function resolveCategoryId(channel) {
    try {
        const isThread = typeof channel.isThread === 'function' && channel.isThread();
        if (isThread) return channel.parent?.parentId ?? null;
        return channel.parentId ?? null;
    } catch { return null; }
}
function extractImageLike(msg) {
    const urls = [];
    for (const a of msg.attachments.values()) {
        const n = (a.name || '').toLowerCase();
        const t = (a.contentType || '').toLowerCase();
        const looks =
        t.startsWith('image/') ||
        t.includes('gif') ||
        /\.(png|jpe?g|gif|webp|avif)$/i.test(n);
        if (looks) urls.push(a.url);
    }
    for (const e of msg.embeds ?? []) {
        const ej = e?.toJSON ? e.toJSON() : (e?.data ?? e);
        if (ej?.image?.url) urls.push(ej.image.url);
        if (ej?.thumbnail?.url) urls.push(ej.thumbnail.url);
        if (ej?.video?.url) urls.push(ej.video.url);
        if (ej?.url) urls.push(ej.url);
    }
    return [...new Set(urls)];
}

function formatChannelLabel(channel, fallbackId) {
    if (!channel) {
        return fallbackId ? `**#${fallbackId}**` : '';
    }

    try {
        const isThread = typeof channel.isThread === 'function' && channel.isThread();
        if (isThread) {
            const parentName = channel.parent?.name ?? channel.parentId ?? 'unknown-parent';
            const threadName = channel.name ?? fallbackId ?? 'unknown-thread';
            return `**#${parentName} / #${threadName}**`;
        }
    } catch {}

    const name = channel.name ?? fallbackId;
    return name ? `**#${name}**` : '';
}
function nextColorGen() {
    const perGuild = new Map(); // guildId -> idx
    return (gid) => {
        const i = perGuild.get(gid) ?? -1;
        const ni = (i + 1) % RAINBOW.length;
        perGuild.set(gid, ni);
        return RAINBOW[ni];
    };
}
const nextColor = nextColorGen();

// --- exported feature entrypoint ---
export async function init({ client, config, logger }) {
    let loggingServerId = config.loggingServerId || null;

    client.on('squire:configUpdated', (nextConfig) => {
        try {
            const source = nextConfig && typeof nextConfig === 'object' ? nextConfig : config;
            loggingServerId = source.loggingServerId || null;
        } catch {}
    });

    if (!config.mapping || typeof config.mapping !== 'object') {
        config.mapping = {};
    }
    if (!config.excludeChannels || typeof config.excludeChannels !== 'object') {
        config.excludeChannels = {};
    }
    if (!config.excludeCategories || typeof config.excludeCategories !== 'object') {
        config.excludeCategories = {};
    }

    function getSampleRate() {
        return Number.isFinite(config.sampleRate) ? config.sampleRate : 1.0;
    }

    function shouldForwardBots() {
        return !!config.forwardBots;
    }

    async function forwardReactionEvent(kind, reaction, user) {
        try {
            if (!reaction) return;

            if (reaction.partial && typeof reaction.fetch === 'function') {
                try { await reaction.fetch(); } catch { return; }
            }

            const message = reaction.message;
            if (!message || !message.guild) return;

            if (loggingServerId && message.guild.id === loggingServerId) {
                logger.verbose?.(`[REACTION] server=${message.guild.id} (${message.guild.name}) — skipped: logging server`);
                return;
            }

            if (!shouldForwardBots() && user?.bot) return;

            const gid = message.guild.id;
            const webhookURL = (config.mapping || {})[gid];
            if (!webhookURL) return;

            const channel = message.channel;
            if (!channel) return;

            const excludeChannels = config.excludeChannels || {};
            if ((excludeChannels[gid] || []).includes(channel.id)) return;

            const catId = resolveCategoryId(channel);
            const excludeCategories = config.excludeCategories || {};
            if (catId && (excludeCategories[gid] || []).includes(catId)) return;

            if (Math.random() >= getSampleRate()) return;

            const { displayName, avatarURL } = await resolveMemberContext(message.guild, user);

            const emojiText = typeof reaction.emoji?.toString === 'function'
                ? reaction.emoji.toString()
                : (reaction.emoji?.name ?? 'emoji');

            const actionVerb = kind === 'removed' ? 'removed' : 'added';
            const totalSuffix = Number.isFinite(reaction.count) && reaction.count > 1
                ? ` (×${reaction.count})`
                : '';

            const channelLabel = formatChannelLabel(channel, message.channelId);
            const headerParts = [`${emojiText}${totalSuffix} ${actionVerb}`];
            if (channelLabel) {
                headerParts.push(`in ${channelLabel}`);
            }

            const messageLink = `https://discord.com/channels/${message.guildId}/${message.channelId}/${message.id}`;
            const messageAuthorName = message.member?.displayName
                ?? message.author?.globalName
                ?? message.author?.username
                ?? message.author?.id
                ?? '';

            const preview = sanitizeMentions((message.content || '').trim());
            const previewBlock = preview ? formatAsBlockQuote(trunc(preview, 600)) : '';

            const descriptionParts = [headerParts.join(' '), `by **${displayName}**`];
            if (messageAuthorName) {
                descriptionParts.push(`On message by **${messageAuthorName}**`);
            }
            if (previewBlock) {
                descriptionParts.push(previewBlock);
            }
            descriptionParts.push(`[View message](${messageLink})`);

            const embed = new EmbedBuilder().setColor(nextColor(gid));
            embed.setDescription(descriptionParts.filter(Boolean).join('\n\n'));

            if (!embed.data.description) {
                embed.setDescription('\u200B');
            }

            const payload = {
                username: displayName,
                avatarURL,
                embeds: [embed]
            };

            const wh = new WebhookClient({ url: webhookURL, allowedMentions: { parse: [], repliedUser: false } });
            await wh.send(payload);

            const gname = message.guild?.name ?? gid;
            const cname = channel?.name ?? channel?.id;
            logger.info(`[FWD][reaction] ${gname} #${cname} — ${emojiText} ${actionVerb} by ${displayName}`);
        } catch (error) {
            console.error('[forwarder] messageReaction error:', error?.message ?? error);
        }
    }

    // announce online in each mapped destination webhook when client is ready
    client.once('ready', async () => {
        const entries = Object.entries(config.mapping || {});
        logger.info(`Mapped source servers (${entries.length}):`);
        for (const [id] of entries) {
            let name = client.guilds.cache.get(id)?.name ?? `ID ${id}`;
            if (!client.guilds.cache.has(id)) {
                try { const g = await client.guilds.fetch(id); if (g) name = g.name; } catch {}
            }
            logger.info(`  - ${name} (${id})`);
        }
        for (const [id, url] of entries) {
            try {
                const gname = client.guilds.cache.get(id)?.name ?? id;
                const wh = new WebhookClient({ url, allowedMentions: { parse: [], repliedUser: false } });
                await wh.send({ content: `🛡️ **Squire online** for server **${gname}**` });
                logger.info(`[ONLINE] Announced in server ${gname}`);
            } catch (e) {
                logger.error(`[forwarder] online announce failed for ${id}:`, e?.message ?? e);
            }
        }
    });

    // simple message forwarder (text + first image/gif)
    client.on('messageCreate', async (message) => {
        try {
            if (!message.guild) return;

            // Ignore the logging server as a source, if specified
            if (loggingServerId && message.guild.id === loggingServerId) {
                logger.verbose?.(`[MSG] server=${message.guild.id} (${message.guild.name}) — skipped: logging server`);
                return;
            }

            if (!shouldForwardBots() && message.author.bot) return;
            if (message.webhookId) return; // don't loop

            const gid = message.guild.id;
            const mapping = config.mapping || {};
            const webhookURL = mapping[gid];
            if (!webhookURL) return;

            // exclusions
            const excludeChannels = config.excludeChannels || {};
            const chanEx = excludeChannels[gid] || [];
            if (chanEx.includes(message.channel.id)) return;

            const catId = resolveCategoryId(message.channel);
            const excludeCategories = config.excludeCategories || {};
            const catEx = excludeCategories[gid] || [];
            if (catId && catEx.includes(catId)) return;

            // sampling
            if (Math.random() >= getSampleRate()) return;

            const isNsfw = Boolean('nsfw' in message.channel && message.channel.nsfw === true);

            const usernameForWebhook =
            message.member?.displayName ??
            message.author.globalName ??
            message.author.username;

            const avatarForWebhook =
            message.member?.displayAvatarURL() ??
            message.author.displayAvatarURL();

            const rawContent = message.content || '';
            const hasYouTube = isYouTubeUrl(rawContent);
            const sanitizedContent = hasYouTube ? prepareForNativeEmbed(rawContent) : rawContent;
            const attachmentUrls = Array.from(message.attachments.values()).map(att => att.url).filter(Boolean);
            const channelLabel = formatChannelLabel(message.channel, message.channelId);
            const pollLines = formatPollLines(message.poll);
            const pollText = pollLines.length ? pollLines.join('\n') : '';

            // If NSFW and there are images/gifs, drop the post entirely (avoid empty forwards)
            const media = extractImageLike(message);
            if (isNsfw && media.length > 0) {
                logger.verbose?.(`[MSG] ${message.guild.name} #${message.channel.name} — NSFW with media: dropped`);
                return;
            }

            const color = nextColor(gid);
            const embed = new EmbedBuilder().setColor(color);

            const normalizedContent = (sanitizedContent || '').trim().length
                ? trunc(sanitizedContent, 4096)
                : '';
            const baseDescriptionParts = [];
            if (normalizedContent) {
                baseDescriptionParts.push(trunc(normalizedContent, 4096));
            } else if (channelLabel) {
                baseDescriptionParts.push(trunc(channelLabel, 4096));
            }

            if (pollText) {
                baseDescriptionParts.push(trunc(pollText, 1024));
            }

            const baseDescription = baseDescriptionParts.filter(Boolean).join('\n\n').trim();
            const viewLink = `[View](https://discord.com/channels/${message.guildId}/${message.channelId}/${message.id})`;
            const spacer = baseDescription.length ? '\n\n' : '';
            const maxBaseLength = Math.max(0, 4096 - viewLink.length - spacer.length);
            const safeBase = baseDescription.length ? trunc(baseDescription, maxBaseLength) : '';
            const combinedDescription = `${safeBase}${spacer}${viewLink}`.trim();
            if (combinedDescription.length) {
                embed.setDescription(combinedDescription);
            }

            if (!isNsfw && media.length > 0) {
                const first = media.find(u => /\.(gif|mp4)(?:$|\?)/i.test(u)) || media[0];
                embed.setImage(first);
            }

            if (!embed.data.description && !embed.data.image) {
                embed.setDescription('\u200B');
            }

            const payload = {
                username: usernameForWebhook,
                avatarURL: avatarForWebhook,
                embeds: [embed]
            };

            if (hasYouTube) {
                const parts = [];
                if (channelLabel) parts.push(channelLabel);
                if (sanitizedContent.trim()) parts.push(sanitizedContent.trim());
                if (pollText) parts.push(trunc(pollText, 1500));
                if (attachmentUrls.length) parts.push(attachmentUrls.join('\n'));

                const payloadContent = parts.join('\n\n').trim();
                if (payloadContent.length === 0 && !media.length) return;
                if (payloadContent.length > 0) {
                    payload.content = payloadContent;
                }
            } else {
                const contentParts = [];
                if (channelLabel) contentParts.push(channelLabel);
                if (pollText) contentParts.push(trunc(pollText, 1500));
                if (contentParts.length) {
                    payload.content = contentParts.join('\n\n');
                }
            }

            const wh = new WebhookClient({ url: webhookURL, allowedMentions: { parse: [], repliedUser: false } });
            await wh.send(payload);

            const gname = message.guild?.name ?? gid;
            const cname = message.channel?.name ?? message.channel?.id;
            logger.info(`[FWD] ${gname} #${cname} — by ${usernameForWebhook}`);
        } catch (e) {
            // keep the bot alive
            console.error('[forwarder] messageCreate error:', e?.message ?? e);
        }
    });

    client.on('messageReactionAdd', async (reaction, user) => forwardReactionEvent('added', reaction, user));
    client.on('messageReactionRemove', async (reaction, user) => forwardReactionEvent('removed', reaction, user));

}
