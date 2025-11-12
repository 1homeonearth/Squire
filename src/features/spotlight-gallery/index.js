// src/features/spotlight-gallery/index.js
// Reaction-driven spotlight gallery that reposts celebrated messages.
import { EmbedBuilder } from 'discord.js';

import { ensureCollection } from '../../core/db.js';
import { isYouTubeUrl, prepareForNativeEmbed } from '../../lib/youtube.js';

export const DEFAULT_THRESHOLD = 3;
export const DEFAULT_EMOJIS = ['⭐'];
const MAX_THRESHOLD = 25;
const MAX_EMOJIS = 5;
const HIGHLIGHT_COLOR = 0xF1C40F;
const COLLECTION_NAME = 'spotlight_gallery_posts';

function clamp(value, min, max) {
    const num = Number.parseInt(value, 10);
    if (Number.isNaN(num)) return min;
    return Math.min(Math.max(num, min), max);
}

function sanitizeSnowflake(value) {
    if (value === undefined || value === null) return null;
    const str = String(value).trim();
    return /^\d{15,25}$/.test(str) ? str : null;
}

function parseBoolean(value, fallback = false) {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase();
        if (!normalized) return fallback;
        if (['1', 'true', 'yes', 'on', 'enable', 'enabled'].includes(normalized)) return true;
        if (['0', 'false', 'no', 'off', 'disable', 'disabled'].includes(normalized)) return false;
    }
    return fallback;
}

function parseEmojiToken(token) {
    if (typeof token !== 'string') return null;
    const trimmed = token.trim();
    if (!trimmed) return null;
    const customMatch = trimmed.match(/^<(a?):([A-Za-z0-9_]{2,32}):(\d{15,25})>$/);
    if (customMatch) {
        const animated = customMatch[1] === 'a';
        const name = customMatch[2];
        const id = customMatch[3];
        return {
            key: `custom:${id}`,
            id,
            name,
            animated,
            display: `<${animated ? 'a' : ''}:${name}:${id}>`
        };
    }
    return {
        key: `unicode:${trimmed}`,
        id: null,
        name: trimmed,
        animated: false,
        display: trimmed
    };
}

export function normalizeEmojiList(input) {
    const values = Array.isArray(input)
        ? input
        : typeof input === 'string'
            ? input.split(/[\n,]+/)
            : [];
    const seen = new Set();
    const result = [];
    for (const value of values) {
        const parsed = parseEmojiToken(value);
        if (!parsed) continue;
        if (seen.has(parsed.key)) continue;
        seen.add(parsed.key);
        result.push(parsed.display);
        if (result.length >= MAX_EMOJIS) break;
    }
    if (!result.length) {
        return DEFAULT_EMOJIS.slice();
    }
    return result;
}

export function normalizeSpotlightGuildConfig(source) {
    const input = source && typeof source === 'object' ? source : {};
    const normalized = {
        enabled: parseBoolean(input.enabled, false),
        channelId: sanitizeSnowflake(input.channelId),
        threshold: clamp(input.threshold ?? DEFAULT_THRESHOLD, 1, MAX_THRESHOLD),
        allowSelf: parseBoolean(input.allowSelf, false),
        emojis: normalizeEmojiList(input.emojis ?? input.emoji ?? input.emojiList ?? input.emojiString)
    };
    if (!normalized.channelId) {
        normalized.channelId = null;
    }
    return normalized;
}

export function normalizeSpotlightConfig(source) {
    const normalized = {};
    if (source && typeof source === 'object') {
        for (const [key, value] of Object.entries(source)) {
            const guildId = sanitizeSnowflake(key);
            if (!guildId) continue;
            normalized[guildId] = normalizeSpotlightGuildConfig(value);
        }
    }
    return normalized;
}

function emojiKeyFromReaction(emoji) {
    if (!emoji) return null;
    if (emoji.id) return `custom:${emoji.id}`;
    if (emoji.name) return `unicode:${emoji.name}`;
    return null;
}

function expandEmojiConfig(list) {
    const entries = Array.isArray(list) ? list : [];
    const keyToDisplay = new Map();
    const keys = new Set();
    for (const value of entries) {
        const parsed = parseEmojiToken(value);
        if (!parsed) continue;
        keys.add(parsed.key);
        keyToDisplay.set(parsed.key, parsed.display);
    }
    return { keys, keyToDisplay };
}

function containsYouTubeLink(content) {
    if (typeof content !== 'string' || !content.trim()) {
        return false;
    }
    return content.split(/\s+/).some(part => isYouTubeUrl(part));
}

function quoteBlock(content, limit = 400) {
    const text = typeof content === 'string' ? content.trim() : '';
    if (!text) return '_No text content_';
    const sanitized = text.replace(/\r\n/g, '\n');
    const truncated = sanitized.length > limit ? `${sanitized.slice(0, limit - 1)}…` : sanitized;
    return truncated
        .split('\n')
        .map(line => line.trim())
        .map(line => (line ? `> ${line}` : '> '))
        .join('\n');
}

function resolveAuthorName(message) {
    if (message?.member?.displayName) return message.member.displayName;
    if (message?.author?.tag) return message.author.tag;
    if (message?.author?.globalName) return message.author.globalName;
    if (message?.author?.username) return message.author.username;
    return 'Unknown member';
}

function pickFirstImageAttachment(message) {
    if (!message?.attachments) return null;
    for (const attachment of message.attachments.values()) {
        const contentType = attachment.contentType ?? '';
        if (attachment.height || attachment.width || contentType.startsWith('image/')) {
            return attachment.url;
        }
    }
    return null;
}

function listNonImageAttachments(message) {
    if (!message?.attachments) return [];
    const list = [];
    for (const attachment of message.attachments.values()) {
        const contentType = attachment.contentType ?? '';
        if (attachment.height || attachment.width || contentType.startsWith('image/')) continue;
        list.push({ name: attachment.name ?? 'Attachment', url: attachment.url });
    }
    return list.slice(0, 5);
}

function buildHighlightPayload({ message, displayEmoji, count }) {
    const channelMention = `<#${message.channelId}>`;
    const authorMention = message.author ? `<@${message.author.id}>` : resolveAuthorName(message);
    const parts = [
        `${displayEmoji ?? '✨'} Spotlight from ${channelMention} by ${authorMention}`,
        message.url
    ];
    if (containsYouTubeLink(message.content)) {
        parts.push(prepareForNativeEmbed(message.content).trim());
    }
    const content = parts.filter(Boolean).join('\n\n');

    const embed = new EmbedBuilder()
    .setColor(HIGHLIGHT_COLOR)
    .setTitle(resolveAuthorName(message))
    .setDescription(quoteBlock(message.content))
    .addFields({ name: 'Jump to conversation', value: `[Open original message](${message.url})` })
    .setFooter({ text: `${count} ${displayEmoji ?? '✨'}` })
    .setTimestamp(message.editedTimestamp ?? message.createdTimestamp ?? Date.now());

    const avatar = message.author?.displayAvatarURL?.({ size: 128 });
    if (avatar) {
        embed.setThumbnail(avatar);
    }

    const image = pickFirstImageAttachment(message);
    if (image) {
        embed.setImage(image);
    }

    const otherAttachments = listNonImageAttachments(message);
    if (otherAttachments.length) {
        const lines = otherAttachments.map(att => `[${att.name}](${att.url})`);
        embed.addFields({
            name: otherAttachments.length === 1 ? 'Attachment' : 'Attachments',
            value: lines.join('\n')
        });
    }

    return {
        content,
        embeds: [embed],
        allowedMentions: { parse: [] }
    };
}

async function resolveReaction(reaction) {
    let resolved = reaction;
    try {
        if (reaction.partial) {
            resolved = await reaction.fetch();
        }
    } catch {
        return null;
    }
    const message = resolved?.message;
    if (!message) return null;
    try {
        if (message.partial) {
            await message.fetch();
        }
    } catch {
        return null;
    }
    if (!message.guildId) return null;
    return resolved;
}

async function computeQualifiedCount(reaction, { allowSelf }) {
    try {
        const users = await reaction.users.fetch();
        const messageAuthorId = reaction.message?.author?.id ?? null;
        let total = 0;
        for (const user of users.values()) {
            if (!allowSelf && user.id === messageAuthorId) continue;
            total += 1;
        }
        return total;
    } catch {
        const fallback = typeof reaction.count === 'number' ? reaction.count : 0;
        if (allowSelf || !reaction.message?.author?.id) {
            return fallback;
        }
        return Math.max(0, fallback - 1);
    }
}

function cacheKey(guildId, messageId) {
    return `${guildId}:${messageId}`;
}

async function resolveHighlightChannel(message, channelId) {
    if (!channelId) return null;
    const guild = message.guild;
    if (!guild) return null;
    const existing = guild.channels?.cache?.get?.(channelId);
    if (existing?.isTextBased?.()) {
        return existing;
    }
    try {
        const fetched = await guild.channels.fetch(channelId);
        return fetched && fetched.isTextBased?.() ? fetched : null;
    } catch {
        return null;
    }
}

export function init(ctx) {
    const { client, logger, config, db } = ctx;
    config.spotlightGallery = normalizeSpotlightConfig(config.spotlightGallery);

    let activeConfig = config;
    let guildConfigs = normalizeSpotlightConfig(config.spotlightGallery);

    const collection = db
        ? ensureCollection(db, COLLECTION_NAME, { indices: ['guildId', 'sourceMessageId'] })
        : null;
    const highlightCache = new Map();

    if (collection) {
        for (const entry of collection.find?.() ?? []) {
            if (!entry?.guildId || !entry?.sourceMessageId) continue;
            highlightCache.set(cacheKey(entry.guildId, entry.sourceMessageId), entry);
        }
    }

    client.on('squire:configUpdated', (nextConfig) => {
        if (nextConfig && typeof nextConfig === 'object') {
            activeConfig = nextConfig;
            guildConfigs = normalizeSpotlightConfig(nextConfig.spotlightGallery);
        }
    });

    client.on('messageReactionAdd', async (reaction, user) => {
        if (user?.bot) return;
        await handleReactionChange(reaction, { logger, guildConfigs, highlightCache, collection, activeConfig });
    });

    client.on('messageReactionRemove', async (reaction) => {
        await handleReactionChange(reaction, { logger, guildConfigs, highlightCache, collection, activeConfig });
    });

    client.on('messageDelete', async (message) => {
        if (!message?.guildId) return;
        const key = cacheKey(message.guildId, message.id);
        const record = highlightCache.get(key);
        if (!record) return;
        try {
            const channel = await resolveHighlightChannel(message, record.highlightChannelId);
            if (!channel) return;
            const highlightMessage = await channel.messages.fetch(record.highlightMessageId);
            await highlightMessage.edit({
                content: `${highlightMessage.content}\n\n*(Original message was deleted.)*`,
                embeds: highlightMessage.embeds,
                allowedMentions: { parse: [] }
            });
        } catch {}
    });

    logger?.info?.('[spotlight] Spotlight gallery ready.');
}

async function handleReactionChange(reaction, ctx) {
    const resolved = await resolveReaction(reaction);
    if (!resolved) return;
    const { logger, guildConfigs, highlightCache, collection, activeConfig } = ctx;
    const message = resolved.message;
    const guildId = message.guildId;

    const configMap = guildConfigs ?? normalizeSpotlightConfig(activeConfig?.spotlightGallery);
    const guildConfig = configMap[guildId] ?? normalizeSpotlightGuildConfig({});

    if (!guildConfig.enabled || !guildConfig.channelId) {
        return;
    }

    if (message.channelId === guildConfig.channelId) {
        return; // avoid highlighting within the spotlight channel
    }

    const { keys, keyToDisplay } = expandEmojiConfig(guildConfig.emojis);
    const key = emojiKeyFromReaction(resolved.emoji);
    if (!key || !keys.has(key)) {
        return;
    }

    const count = await computeQualifiedCount(resolved, { allowSelf: guildConfig.allowSelf });
    const cacheId = cacheKey(guildId, message.id);
    const existing = highlightCache.get(cacheId) ?? collection?.findOne?.({ guildId, sourceMessageId: message.id }) ?? null;
    if (existing && !highlightCache.has(cacheId)) {
        highlightCache.set(cacheId, existing);
    }

    const channel = await resolveHighlightChannel(message, guildConfig.channelId);
    if (!channel) {
        logger?.warn?.(`[spotlight] Highlight channel ${guildConfig.channelId} unavailable in guild ${guildId}.`);
        return;
    }

    if (count < guildConfig.threshold) {
        if (existing?.highlightMessageId) {
            try {
                const highlightMessage = await channel.messages.fetch(existing.highlightMessageId);
                const payload = buildHighlightPayload({
                    message,
                    displayEmoji: keyToDisplay.get(existing.emojiKey ?? key) ?? keyToDisplay.values().next().value ?? '✨',
                    count
                });
                await highlightMessage.edit(payload);
                existing.count = count;
                existing.emojiKey = existing.emojiKey ?? key;
                existing.updatedAt = Date.now();
                collection?.update?.(existing);
                highlightCache.set(cacheId, existing);
            } catch {}
        }
        return;
    }

    const displayEmoji = keyToDisplay.get(key) ?? keyToDisplay.values().next().value ?? '✨';

    if (existing?.highlightMessageId) {
        try {
            const highlightMessage = await channel.messages.fetch(existing.highlightMessageId);
            const payload = buildHighlightPayload({ message, displayEmoji, count });
            await highlightMessage.edit(payload);
            existing.count = count;
            existing.emojiKey = key;
            existing.updatedAt = Date.now();
            collection?.update?.(existing);
            highlightCache.set(cacheId, existing);
        } catch (err) {
            logger?.warn?.(`[spotlight] Failed to update spotlight message ${existing.highlightMessageId}: ${err?.message ?? err}`);
        }
        return;
    }

    try {
        const payload = buildHighlightPayload({ message, displayEmoji, count });
        const highlightMessage = await channel.send(payload);
        const record = {
            guildId,
            sourceMessageId: message.id,
            highlightChannelId: channel.id,
            highlightMessageId: highlightMessage.id,
            emojiKey: key,
            count,
            createdAt: Date.now(),
            updatedAt: Date.now()
        };
        if (collection) {
            const inserted = collection.insert(record);
            highlightCache.set(cacheId, inserted ?? record);
        } else {
            highlightCache.set(cacheId, record);
        }
        logger?.info?.(`[spotlight] Highlighted message ${message.id} in guild ${guildId}.`);
    } catch (err) {
        logger?.warn?.(`[spotlight] Failed to post spotlight for ${message.id}: ${err?.message ?? err}`);
    }
}
