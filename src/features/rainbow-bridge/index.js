// src/features/rainbow-bridge/index.js
// Two-way channel bridge that keeps messages in sync across servers.

import {
    WebhookClient,
    EmbedBuilder,
    SlashCommandBuilder,
    PermissionFlagsBits,
    ChannelType
} from 'discord.js';
import { ensureCollection } from '../../core/db.js';
import { isYouTubeUrl, prepareForNativeEmbed } from '../../lib/youtube.js';
import { formatPollLines } from '../../lib/poll-format.js';

const RAINBOW = [0xFF0000, 0xFFA500, 0xFFFF00, 0x00FF00, 0x0000FF, 0x800080];

const MAX_CONTENT_LENGTH = 1900;

function trunc(str, max) {
    const value = String(str ?? '');
    return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

const sanitizeMentions = (text) => typeof text === 'string'
    ? text.replace(/<(@[!&]?|#)(\d+)>/g, '<$1\u200B$2>')
    : '';

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
    const perBridge = new Map();
    return (bridgeId) => {
        const prev = perBridge.get(bridgeId) ?? -1;
        const next = (prev + 1) % RAINBOW.length;
        perBridge.set(bridgeId, next);
        return RAINBOW[next];
    };
}

const nextColor = nextColorGen();

const LINK_COLLECTION_NAME = 'rainbow_bridge_links';
const DELETE_SUPPRESS_TIMEOUT = 30_000;

const runtime = {
    config: null,
    logger: null,
    bridges: new Map(),
    channelLookup: new Map(),
    knownWebhookIds: new Set(),
    webhookCache: new Map(),
    messageLinks: new Map(),
    reverseMessageLinks: new Map(),
    dirty: true,
    client: null,
    mirroredMessageIds: new Set(),
    threadMirrors: new Map(),
    db: null,
    linkCollection: null,
    suppressedDeletes: new Set()
};

const MAX_THREAD_NAME_LENGTH = 100;

export const commands = [
    new SlashCommandBuilder()
    .setName('bridgepurge')
    .setDescription('Delete recent messages in this bridge and mirror the deletions across linked channels.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .setDMPermission(false)
    .addIntegerOption(opt =>
        opt
        .setName('count')
        .setDescription('Number of recent messages to delete (1-200).')
        .setRequired(true)
        .setMinValue(1)
        .setMaxValue(200)
    )
];

function parseWebhookUrl(url) {
    if (typeof url !== 'string') return null;
    const match = url.match(/\/api\/webhooks\/(\d+)\/([^/?#]+)/);
    if (!match) return null;
    return { id: match[1], token: match[2] };
}

function normalizeChannelEntry(entry) {
    if (!entry || typeof entry !== 'object') return null;
    const guildId = entry.guildId ? String(entry.guildId) : null;
    const channelId = entry.channelId ? String(entry.channelId) : null;
    const webhookUrl = entry.webhookUrl ? String(entry.webhookUrl) : null;
    const threadId = entry.threadId ? String(entry.threadId) : null;
    const parentId = entry.parentId ? String(entry.parentId) : null;
    if (!guildId || !channelId || !webhookUrl) return null;
    if (!parseWebhookUrl(webhookUrl)) return null;
    return {
        guildId,
        channelId,
        webhookUrl,
        threadId,
        parentId,
        name: entry.name ? String(entry.name) : null
    };
}

function normalizeBridgeFormEntry(entry, key) {
    const base = entry && typeof entry === 'object' ? entry : {};
    const guildId = base.guildId ? String(base.guildId) : (key ? String(key) : null);
    if (!guildId) return null;
    const form = {
        guildId,
        channelId: base.channelId ? String(base.channelId) : null,
        threadId: base.threadId ? String(base.threadId) : null,
        parentId: base.parentId ? String(base.parentId) : null,
        webhookUrl: base.webhookUrl ? String(base.webhookUrl) : null,
        name: base.name ? String(base.name) : null
    };
    return form;
}

export function normalizeRainbowBridgeConfig(value) {
    const base = value && typeof value === 'object' ? value : {};
    const forwardBots = base.forwardBots !== false;
    const bridgesRaw = base.bridges && typeof base.bridges === 'object'
        ? base.bridges
        : {};

    const bridges = {};
    for (const [bridgeId, rawEntry] of Object.entries(bridgesRaw)) {
        if (!bridgeId || !rawEntry || typeof rawEntry !== 'object') continue;
        const forms = {};
        const rawForms = rawEntry.forms && typeof rawEntry.forms === 'object'
            ? rawEntry.forms
            : {};

        for (const [formKey, rawForm] of Object.entries(rawForms)) {
            const normalizedForm = normalizeBridgeFormEntry(rawForm, formKey);
            if (!normalizedForm) continue;
            forms[normalizedForm.guildId] = normalizedForm;
        }

        if (Array.isArray(rawEntry.channels)) {
            for (const channelEntry of rawEntry.channels) {
                const normalizedChannel = normalizeChannelEntry(channelEntry);
                if (!normalizedChannel) continue;
                forms[normalizedChannel.guildId] = {
                    guildId: normalizedChannel.guildId,
                    channelId: normalizedChannel.channelId,
                    threadId: normalizedChannel.threadId,
                    parentId: normalizedChannel.parentId,
                    webhookUrl: normalizedChannel.webhookUrl,
                    name: normalizedChannel.name
                };
            }
        }

        const channels = Object.values(forms)
            .map(normalizeChannelEntry)
            .filter(Boolean);
        const entry = {
            name: rawEntry.name ? String(rawEntry.name) : String(bridgeId),
            forwardBots: rawEntry.forwardBots === undefined ? undefined : rawEntry.forwardBots !== false,
            forms,
            channels
        };
        bridges[String(bridgeId)] = entry;
    }

    return {
        forwardBots,
        bridges
    };
}

function getLinkCollection() {
    if (!runtime.db) return null;
    if (!runtime.linkCollection) {
        runtime.linkCollection = ensureCollection(runtime.db, LINK_COLLECTION_NAME, { indices: ['originalId', 'bridgeId'] });
    }
    return runtime.linkCollection;
}

function suppressDeletion(messageId) {
    if (!messageId) return;
    runtime.suppressedDeletes.add(messageId);
    setTimeout(() => runtime.suppressedDeletes.delete(messageId), DELETE_SUPPRESS_TIMEOUT).unref?.();
}

function cleanupForwardMappings(originalId, bridgeId, record) {
    if (!record) return;
    const forwardedValues = record.forwarded instanceof Map
        ? Array.from(record.forwarded.values())
        : [];
    for (const entry of forwardedValues) {
        const targetId = entry?.messageId ?? null;
        if (!targetId) continue;
        runtime.mirroredMessageIds.delete(targetId);
        runtime.reverseMessageLinks.delete(targetId);
    }
    const collection = getLinkCollection();
    if (collection) {
        const existing = collection.findOne({ originalId, bridgeId });
        if (existing) {
            collection.remove(existing);
        }
    }
}

function persistLinkRecord(originalId, bridgeId, record) {
    const collection = getLinkCollection();
    if (!collection || !originalId || !bridgeId || !record) return;

    const forwarded = [];
    if (record.forwarded instanceof Map) {
        for (const value of record.forwarded.values()) {
            if (!value?.messageId || !value?.channelId) continue;
            forwarded.push({
                messageId: value.messageId,
                channelId: value.channelId,
                threadId: value.threadId ?? null
            });
        }
    }

    let doc = collection.findOne({ originalId, bridgeId });
    if (!doc) {
        doc = collection.insert({
            originalId,
            bridgeId,
            originChannelId: record.originChannelId ?? null,
            originParentId: record.originParentId ?? null,
            originThreadId: record.originThreadId ?? null,
            forwarded
        });
        return doc;
    }

    doc.originChannelId = record.originChannelId ?? null;
    doc.originParentId = record.originParentId ?? null;
    doc.originThreadId = record.originThreadId ?? null;
    doc.forwarded = forwarded;
    collection.update(doc);
    return doc;
}

function hydratePersistedLinks() {
    const collection = getLinkCollection();
    if (!collection) return;
    const docs = collection.find() ?? [];
    for (const doc of docs) {
        const originalId = doc?.originalId ? String(doc.originalId) : null;
        const bridgeId = doc?.bridgeId ? String(doc.bridgeId) : null;
        if (!originalId || !bridgeId) continue;

        if (!runtime.messageLinks.has(originalId)) {
            runtime.messageLinks.set(originalId, new Map());
        }
        const forwarded = new Map();
        const list = Array.isArray(doc.forwarded) ? doc.forwarded : [];
        for (const entry of list) {
            const messageId = entry?.messageId ? String(entry.messageId) : null;
            const channelId = entry?.channelId ? String(entry.channelId) : null;
            const threadId = entry?.threadId ? String(entry.threadId) : null;
            if (!messageId || !channelId) continue;
            const key = threadId ?? channelId;
            forwarded.set(key, {
                messageId,
                channelId,
                threadId: threadId ?? null
            });
            runtime.mirroredMessageIds.add(messageId);
            runtime.reverseMessageLinks.set(messageId, {
                originalId,
                bridgeId,
                channelId,
                threadId: threadId ?? null
            });
        }
        const record = {
            originChannelId: doc?.originChannelId ? String(doc.originChannelId) : null,
            originParentId: doc?.originParentId ? String(doc.originParentId) : null,
            originThreadId: doc?.originThreadId ? String(doc.originThreadId) : null,
            forwarded
        };
        runtime.messageLinks.get(originalId).set(bridgeId, record);

        if (record.originThreadId && forwarded.size) {
            for (const value of forwarded.values()) {
                if (!value?.threadId) continue;
                rememberThreadMapping({
                    bridgeId,
                    originThreadId: record.originThreadId,
                    targetChannelId: value.channelId,
                    targetThreadId: value.threadId
                });
            }
        }
    }
}

function buildChannelLookup(bridges) {
    const channelMap = new Map();
    for (const [bridgeId, bridge] of bridges.entries()) {
        for (const channelEntry of bridge.channels) {
            const matchIds = channelEntry.matchIds ?? new Set([channelEntry.channelId]);
            for (const matchId of matchIds) {
                const list = channelMap.get(matchId) ?? [];
                list.push({ bridgeId, bridge, channelEntry });
                channelMap.set(matchId, list);
            }
        }
    }
    return channelMap;
}

function rebuildState() {
    const { config, logger } = runtime;
    if (!config) {
        runtime.bridges = new Map();
        runtime.channelLookup = new Map();
        runtime.knownWebhookIds = new Set();
        runtime.dirty = false;
        return runtime;
    }

    config.rainbowBridge = normalizeRainbowBridgeConfig(config.rainbowBridge);
    const base = config.rainbowBridge ?? {};
    const nextBridges = new Map();
    const knownWebhookIds = new Set();
    const validWebhookKeys = new Set();

    for (const [bridgeId, entry] of Object.entries(base.bridges ?? {})) {
        if (!bridgeId || !entry || typeof entry !== 'object') continue;

        const normalized = {
            id: bridgeId,
            name: entry.name ?? bridgeId,
            forwardBots: entry.forwardBots === undefined
                ? base.forwardBots
                : entry.forwardBots,
            channels: []
        };

        for (const channelEntry of entry.channels ?? []) {
            const parsed = parseWebhookUrl(channelEntry.webhookUrl);
            if (!parsed) {
                logger?.warn?.(`[rainbow-bridge] Skipping channel ${channelEntry.channelId} in bridge ${bridgeId}: invalid webhook URL.`);
                continue;
            }

            const matchIds = new Set();
            if (channelEntry.channelId) matchIds.add(channelEntry.channelId);
            if (channelEntry.threadId) matchIds.add(channelEntry.threadId);
            if (channelEntry.parentId) matchIds.add(channelEntry.parentId);

            normalized.channels.push({
                guildId: channelEntry.guildId,
                channelId: channelEntry.channelId,
                webhookUrl: channelEntry.webhookUrl,
                webhookId: parsed.id,
                webhookToken: parsed.token,
                threadId: channelEntry.threadId ?? null,
                parentId: channelEntry.parentId ?? null,
                matchIds,
                name: channelEntry.name ?? null
            });

            knownWebhookIds.add(parsed.id);
            validWebhookKeys.add(`${parsed.id}:${parsed.token}`);
        }

        if (normalized.channels.length >= 2) {
            nextBridges.set(bridgeId, normalized);
        } else if (normalized.channels.length > 0) {
            logger?.warn?.(`[rainbow-bridge] Bridge ${bridgeId} ignored — it needs at least two linked channels.`);
        }
    }

    runtime.bridges = nextBridges;
    runtime.channelLookup = buildChannelLookup(nextBridges);
    runtime.knownWebhookIds = knownWebhookIds;
    runtime.dirty = false;

    for (const [messageId, bridgeMap] of runtime.messageLinks.entries()) {
        for (const bridgeId of Array.from(bridgeMap.keys())) {
            if (!nextBridges.has(bridgeId)) {
                const record = bridgeMap.get(bridgeId);
                cleanupForwardMappings(messageId, bridgeId, record);
                bridgeMap.delete(bridgeId);
            }
        }
        if (!bridgeMap.size) {
            runtime.messageLinks.delete(messageId);
        }
    }

    for (const key of Array.from(runtime.webhookCache.keys())) {
        if (!validWebhookKeys.has(key)) {
            runtime.webhookCache.delete(key);
        }
    }

    return runtime;
}

function getActiveState() {
    if (runtime.dirty) {
        rebuildState();
    }
    return runtime;
}

export function refresh() {
    if (!runtime.config) {
        return 0;
    }
    runtime.dirty = true;
    const state = rebuildState();
    if (runtime.logger) {
        if (state.bridges.size) {
            runtime.logger.info?.(`[rainbow-bridge] Refreshed ${state.bridges.size} bridge(s) spanning ${state.channelLookup.size} channels.`);
        } else {
            runtime.logger.info?.('[rainbow-bridge] Rainbow Bridge refresh: no bridges configured.');
        }
    }
    return state.bridges.size;
}

function extractMedia(message) {
    const urls = [];
    for (const attachment of message.attachments?.values?.() ?? []) {
        if (!attachment?.url) continue;
        urls.push(attachment.url);
    }
    for (const embed of message.embeds ?? []) {
        const data = embed?.toJSON ? embed.toJSON() : embed?.data ?? embed;
        if (data?.image?.url) urls.push(data.image.url);
        if (data?.thumbnail?.url) urls.push(data.thumbnail.url);
        if (data?.url) urls.push(data.url);
    }
    return [...new Set(urls)];
}

function formatReactionSummary(message) {
    const cache = message?.reactions?.cache ?? message?.reactions ?? null;
    if (!cache || typeof cache.size !== 'number' || cache.size === 0) {
        return '';
    }
    const list = Array.from(cache.values?.() ?? cache.values() ?? []);
    const parts = [];
    for (const entry of list) {
        if (!entry) continue;
        const count = Number(entry.count ?? 0);
        if (!Number.isFinite(count) || count <= 0) continue;
        const emoji = entry.emoji?.toString?.() ?? entry.emoji?.name ?? '';
        if (!emoji) continue;
        parts.push(`${emoji} ×${count}`);
    }
    if (!parts.length) {
        return '';
    }
    const summary = parts.join(' • ');
    return `**Reactions:** ${summary}`;
}

function sanitizeThreadName(name, fallback) {
    const base = typeof name === 'string' && name.trim().length
        ? name.trim()
        : (fallback ?? 'Thread');
    return base.length > MAX_THREAD_NAME_LENGTH
        ? `${base.slice(0, MAX_THREAD_NAME_LENGTH - 1)}…`
        : base;
}

function rememberThreadMapping({ bridgeId, originThreadId, targetChannelId, targetThreadId }) {
    if (!bridgeId || !originThreadId || !targetChannelId || !targetThreadId) return;
    const key = `${bridgeId}:${originThreadId}`;
    if (!runtime.threadMirrors.has(key)) {
        runtime.threadMirrors.set(key, new Map());
    }
    const mapping = runtime.threadMirrors.get(key);
    mapping.set(targetChannelId, targetThreadId);
}

function resolveThreadMapping({ bridgeId, originThreadId, targetChannelId }) {
    if (!bridgeId || !originThreadId || !targetChannelId) return null;
    const key = `${bridgeId}:${originThreadId}`;
    const mapping = runtime.threadMirrors.get(key);
    if (!mapping) return null;
    return mapping.get(targetChannelId) ?? null;
}

async function fetchChannelSafe(id) {
    if (!id) return null;
    const client = runtime.client;
    if (!client) return null;
    const cached = client.channels?.cache?.get?.(id) ?? null;
    if (cached) return cached;
    if (typeof client.channels?.fetch !== 'function') return null;
    try {
        return await client.channels.fetch(id);
    } catch {
        return null;
    }
}

function isThreadChannel(channel) {
    return typeof channel?.isThread === 'function' && channel.isThread();
}

async function fetchMessageFromTarget({ channelId, threadId, messageId }) {
    const lookupId = threadId ?? channelId;
    if (!lookupId || !messageId) return null;
    const channel = await fetchChannelSafe(lookupId);
    if (!channel || typeof channel.isTextBased !== 'function' || !channel.isTextBased()) return null;

    const cache = channel.messages?.cache ?? null;
    if (cache?.get) {
        const cached = cache.get(messageId);
        if (cached) return cached;
    }
    if (typeof channel.messages?.fetch !== 'function') return null;
    try {
        return await channel.messages.fetch(messageId);
    } catch {
        return null;
    }
}

async function deleteOriginalMessageIfPresent({ record, originalId }) {
    if (!record || !originalId) return { success: false };
    const channelId = record.originChannelId ?? null;
    const threadId = record.originThreadId ?? null;
    const message = await fetchMessageFromTarget({ channelId, threadId, messageId: originalId });
    if (!message || typeof message.delete !== 'function') {
        return { success: false };
    }

    try {
        suppressDeletion(originalId);
        await message.delete();
        return { success: true };
    } catch (error) {
        return { success: false, error };
    }
}

async function resolveThreadOptions({ bridgeId, target, message, originThreadId }) {
    const options = { threadId: target.threadId ?? null, threadName: null };
    if (!originThreadId) {
        return options;
    }

    if (options.threadId) {
        return options;
    }

    const mapped = resolveThreadMapping({ bridgeId, originThreadId, targetChannelId: target.channelId });
    if (mapped) {
        options.threadId = mapped;
        return options;
    }

    const channel = await fetchChannelSafe(target.channelId);
    if (!channel) {
        return options;
    }

    if (channel.type === ChannelType.GuildForum) {
        const originChannel = message?.channel ?? null;
        const originName = originChannel?.name ?? message?.thread?.name ?? `Thread ${originThreadId}`;
        options.threadName = sanitizeThreadName(originName, `Thread ${originThreadId}`);
        return options;
    }

    if (isThreadChannel(channel)) {
        options.threadId = channel.id;
    }

    return options;
}

function buildHeaderLine(message) {
    const guildName = message.guild?.name ?? message.guildId ?? 'Unknown server';
    const channelLabel = formatChannelLabel(message.channel, message.channelId);
    const parts = [`**${guildName}**`];
    if (channelLabel) parts.push(channelLabel);
    return parts.filter(Boolean).join(' • ');
}

function buildPresentation({ bridgeId, message }) {
    const rawContent = message.content ?? '';
    const hasYouTube = isYouTubeUrl(rawContent);
    const preparedContent = hasYouTube ? prepareForNativeEmbed(rawContent) : rawContent;
    const trimmedContent = sanitizeMentions((preparedContent || '').trim());
    const normalizedContent = trimmedContent.length ? trunc(trimmedContent, 4096) : '';

    const pollLines = formatPollLines(message.poll);
    const pollCombined = pollLines.length ? pollLines.join('\n') : '';
    const pollForEmbed = pollCombined.length ? sanitizeMentions(trunc(pollCombined, 1024)) : '';
    const pollForContent = pollCombined.length ? sanitizeMentions(trunc(pollCombined, 1500)) : '';

    const stickerLines = message.stickers?.size
        ? message.stickers.map((sticker) => `🃏 Sticker: ${sticker.name}`).join('\n')
        : '';
    const stickersForEmbed = stickerLines.length ? sanitizeMentions(trunc(stickerLines, 1024)) : '';
    const stickersForContent = stickerLines.length ? sanitizeMentions(trunc(stickerLines, 500)) : '';

    const headerLine = buildHeaderLine(message);
    const headerForContent = sanitizeMentions(headerLine);

    const attachmentUrls = Array.from(message.attachments?.values?.() ?? [])
        .map(att => att?.url)
        .filter(Boolean);

    const attachmentsForEmbed = attachmentUrls.length
        ? sanitizeMentions(trunc(attachmentUrls.join('\n'), 1024))
        : '';
    const reactionSummary = formatReactionSummary(message);
    const reactionsForEmbed = reactionSummary ? sanitizeMentions(trunc(reactionSummary, 512)) : '';

    const embedParts = [];
    if (normalizedContent) embedParts.push(normalizedContent);
    if (pollForEmbed) embedParts.push(pollForEmbed);
    if (stickersForEmbed) embedParts.push(stickersForEmbed);
    if (attachmentsForEmbed) embedParts.push(attachmentsForEmbed);
    if (reactionsForEmbed) embedParts.push(reactionsForEmbed);

    const embedDescription = embedParts.join('\n\n').trim();
    const safeDescription = embedDescription.length ? trunc(embedDescription, 4096) : '';

    const embed = new EmbedBuilder()
        .setColor(nextColor(bridgeId));

    if (safeDescription.length) {
        embed.setDescription(safeDescription);
    } else {
        embed.setDescription('\u200B');
    }

    const media = extractMedia(message);
    if (media.length) {
        const preferred = media.find(url => /\.(gif|mp4|webm)(?:$|\?)/i.test(url)) || media[0];
        embed.setImage(preferred);
    }

    return {
        hasYouTube,
        embed,
        headerForContent,
        normalizedContent,
        pollForContent,
        stickersForContent,
        attachmentUrls,
        media
    };
}

function resolveUsername(message) {
    const memberName = message.member?.displayName;
    const user = message.author;
    return memberName || user?.globalName || user?.username || 'Unknown member';
}

function resolveAvatar(message) {
    return message.member?.displayAvatarURL?.() || message.author?.displayAvatarURL?.() || null;
}

function prepareSendPayload({ message, bridgeId }) {
    const presentation = buildPresentation({ bridgeId, message });
    const payload = {
        username: resolveUsername(message),
        avatarURL: resolveAvatar(message),
        allowedMentions: { parse: [] },
        embeds: [presentation.embed]
    };

    if (presentation.hasYouTube) {
        const youtubeContent = presentation.normalizedContent
            ? trunc(presentation.normalizedContent, MAX_CONTENT_LENGTH)
            : '';
        if (youtubeContent.length === 0 && !presentation.media.length) {
            return null;
        }
        if (youtubeContent.length) {
            payload.content = youtubeContent;
        }
    }

    return payload;
}

function prepareEditPayload({ message, bridgeId }) {
    const presentation = buildPresentation({ bridgeId, message });
    const payload = {
        allowedMentions: { parse: [] },
        embeds: [presentation.embed]
    };

    if (presentation.hasYouTube) {
        const youtubeContent = presentation.normalizedContent
            ? trunc(presentation.normalizedContent, MAX_CONTENT_LENGTH)
            : '';
        payload.content = youtubeContent;
    } else {
        payload.content = '';
    }

    return payload;
}

export async function init({ client, config, logger, db }) {
    runtime.config = config;
    runtime.logger = logger;
    runtime.client = client;
    runtime.db = db ?? null;
    runtime.webhookCache = new Map();
    runtime.messageLinks = new Map();
    runtime.reverseMessageLinks = new Map();
    runtime.mirroredMessageIds = new Set();
    runtime.threadMirrors = new Map();
    runtime.linkCollection = null;
    runtime.suppressedDeletes = new Set();
    runtime.dirty = true;

    hydratePersistedLinks();

    config.rainbowBridge = normalizeRainbowBridgeConfig(config.rainbowBridge);
    rebuildState();

    client.on('squire:configUpdated', (nextConfig) => {
        if (!nextConfig || typeof nextConfig !== 'object') return;
        runtime.config = nextConfig;
        runtime.dirty = true;
        rebuildState();
    });

    function getWebhookClient(entry) {
        const key = `${entry.webhookId}:${entry.webhookToken}`;
        if (!runtime.webhookCache.has(key)) {
            runtime.webhookCache.set(key, new WebhookClient({ id: entry.webhookId, token: entry.webhookToken, allowedMentions: { parse: [] } }));
        }
        return runtime.webhookCache.get(key);
    }

    function cacheForwardedMessage({
        originalId,
        bridgeId,
        originChannelId,
        originParentId,
        originThreadId,
        targetChannelId,
        targetMessageId,
        targetThreadId
    }) {
        if (!runtime.messageLinks.has(originalId)) {
            runtime.messageLinks.set(originalId, new Map());
        }
        const bridgeMap = runtime.messageLinks.get(originalId);
        if (!bridgeMap.has(bridgeId)) {
            bridgeMap.set(bridgeId, {
                originChannelId,
                originParentId: originParentId ?? null,
                originThreadId: originThreadId ?? null,
                forwarded: new Map()
            });
        }
        const record = bridgeMap.get(bridgeId);
        if (originParentId && !record.originParentId) {
            record.originParentId = originParentId;
        }
        if (originThreadId && !record.originThreadId) {
            record.originThreadId = originThreadId;
        }
        if (!record.originChannelId) {
            record.originChannelId = originChannelId;
        }
        const key = targetThreadId ?? targetChannelId;
        record.forwarded.set(key, {
            messageId: targetMessageId,
            channelId: targetChannelId,
            threadId: targetThreadId ?? null
        });

        if (targetMessageId) {
            runtime.mirroredMessageIds.add(targetMessageId);
            runtime.reverseMessageLinks.set(targetMessageId, {
                originalId,
                bridgeId,
                channelId: targetChannelId,
                threadId: targetThreadId ?? null
            });
        }
        if (originThreadId && targetThreadId) {
            rememberThreadMapping({
                bridgeId,
                originThreadId,
                targetChannelId,
                targetThreadId
            });
        }

        persistLinkRecord(originalId, bridgeId, record);
    }

    function collectBridgeEntries(message, channelLookup) {
        const ids = new Set();
        const directId = message.channel?.id ?? message.channelId;
        if (directId) ids.add(directId);
        const parentId = message.channel?.parentId ?? message.channel?.parent?.id ?? null;
        if (parentId) ids.add(parentId);
        const results = [];
        const seen = new Set();
        for (const id of ids) {
            if (!id) continue;
            const entries = channelLookup.get(id);
            if (!entries) continue;
            for (const entry of entries) {
                const key = `${entry.bridgeId}:${entry.channelEntry.channelId}`;
                if (seen.has(key)) continue;
                seen.add(key);
                results.push(entry);
            }
        }
        return results;
    }

    function getForwardedRecord(record, target) {
        if (!record?.forwarded) return null;
        const keys = [];
        if (target.threadId) keys.push(target.threadId);
        keys.push(target.channelId);
        for (const key of keys) {
            if (!key) continue;
            if (!record.forwarded.has(key)) continue;
            const value = record.forwarded.get(key);
            if (!value) continue;
            if (typeof value === 'string') {
                return { messageId: value, channelId: key, threadId: target.threadId ?? null };
            }
            if (typeof value === 'object') {
                const messageId = value.messageId ?? value.id ?? null;
                const threadId = value.threadId ?? (target.threadId ?? null);
                const channelId = value.channelId ?? key;
                return { messageId, threadId, channelId };
            }
        }
        return null;
    }

    async function handleMessageCreate(message) {
        try {
            if (!message.guild || !message.channel) return;

            const { bridges, channelLookup, knownWebhookIds } = getActiveState();
            if (!bridges.size) return;
            if (message.webhookId && knownWebhookIds.has(message.webhookId)) return;

            const bridgesForChannel = collectBridgeEntries(message, channelLookup);
            if (!bridgesForChannel || !bridgesForChannel.length) return;

            const originIds = new Set();
            const originChannelId = message.channel?.id ?? message.channelId;
            if (originChannelId) originIds.add(originChannelId);
            const originThreadId = isThreadChannel(message.channel) ? message.channel.id : null;
            const parentId = message.channel?.parentId ?? message.channel?.parent?.id ?? null;
            if (parentId) originIds.add(parentId);

            for (const { bridgeId, bridge } of bridgesForChannel) {
                if (!bridge.forwardBots && message.author?.bot) continue;

                const targets = bridge.channels.filter((ch) => {
                    const matchIds = ch.matchIds ?? new Set([ch.channelId]);
                    for (const id of matchIds) {
                        if (originIds.has(id)) return false;
                    }
                    return true;
                });
                if (!targets.length) continue;

                const payload = prepareSendPayload({ message, bridgeId });
                if (!payload) continue;

                for (const target of targets) {
                    try {
                        const webhook = getWebhookClient(target);
                        const threadOptions = await resolveThreadOptions({
                            bridgeId,
                            target,
                            message,
                            originThreadId
                        });
                        const sendPayload = { ...payload };
                        if (threadOptions.threadId) {
                            sendPayload.threadId = threadOptions.threadId;
                        }
                        if (threadOptions.threadName) {
                            sendPayload.threadName = threadOptions.threadName;
                        }
                        const sent = await webhook.send(sendPayload);
                        const responseThreadId = sent?.channelId ?? sent?.channel?.id ?? threadOptions.threadId ?? target.threadId ?? null;
                        cacheForwardedMessage({
                            originalId: message.id,
                            bridgeId,
                            originChannelId,
                            originParentId: parentId ?? null,
                            originThreadId,
                            targetChannelId: target.channelId,
                            targetMessageId: sent?.id ?? null,
                            targetThreadId: responseThreadId
                        });
                    } catch (err) {
                        logger?.warn?.(`[rainbow-bridge] Failed to forward message ${message.id} to ${target.channelId}: ${err?.message ?? err}`);
                    }
                }
            }
        } catch (err) {
            logger?.error?.(`[rainbow-bridge] messageCreate error: ${err?.message ?? err}`);
        }
    }

    async function syncForwardedMessage(message) {
        if (!message?.id) return;
        if (runtime.mirroredMessageIds.has(message.id)) return;
        if (!runtime.messageLinks.has(message.id)) return;

        const { bridges } = getActiveState();
        const bridgeMap = runtime.messageLinks.get(message.id);
        for (const [bridgeId, record] of bridgeMap.entries()) {
            const bridge = bridges.get(bridgeId);
            if (!bridge) continue;
            const originIds = new Set();
            if (record.originChannelId) originIds.add(record.originChannelId);
            if (record.originParentId) originIds.add(record.originParentId);
            if (record.originThreadId) originIds.add(record.originThreadId);
            const targets = bridge.channels.filter((ch) => {
                const matchIds = ch.matchIds ?? new Set([ch.channelId]);
                for (const id of matchIds) {
                    if (originIds.has(id)) return false;
                }
                return true;
            });
            const payload = prepareEditPayload({ message, bridgeId });

            for (const target of targets) {
                const forwarded = getForwardedRecord(record, target);
                const targetMessageId = forwarded?.messageId ?? null;
                if (!targetMessageId) continue;
                const threadId = forwarded?.threadId ?? target.threadId ?? null;
                try {
                    const webhook = getWebhookClient(target);
                    const editPayload = threadId ? { ...payload, threadId } : payload;
                    await webhook.editMessage(targetMessageId, editPayload);
                } catch (err) {
                    logger?.warn?.(`[rainbow-bridge] Failed to edit mirrored message ${targetMessageId} in ${target.channelId}: ${err?.message ?? err}`);
                }
            }
        }
    }

    async function handleMessageUpdate(oldMessage, newMessage) {
        try {
            const message = newMessage?.partial ? await newMessage.fetch().catch(() => null) : newMessage;
            if (!message) return;
            await syncForwardedMessage(message);
        } catch (err) {
            logger?.error?.(`[rainbow-bridge] messageUpdate error: ${err?.message ?? err}`);
        }
    }

    async function mirrorDeletionForMessage(message) {
        const { bridges } = getActiveState();
        const messageId = message?.id ?? message?.message?.id ?? message;
        if (!messageId) return;

        if (runtime.suppressedDeletes.has(messageId)) {
            runtime.suppressedDeletes.delete(messageId);
            return;
        }

        let originalId = messageId;
        if (!runtime.messageLinks.has(messageId)) {
            const reverseInfo = runtime.reverseMessageLinks.get(messageId);
            if (!reverseInfo) {
                return;
            }
            originalId = reverseInfo.originalId;
        }

        const bridgeMap = runtime.messageLinks.get(originalId);
        if (!bridgeMap?.size) {
            return;
        }

        const entries = Array.from(bridgeMap.entries());
        const originNeedsDeletion = originalId !== messageId;

        if (originNeedsDeletion) {
            let attempted = false;
            for (const [, record] of entries) {
                if (attempted) break;
                if (!record) continue;
                attempted = true;
                const result = await deleteOriginalMessageIfPresent({ record, originalId });
                if (!result?.success) {
                    const errMsg = result?.error?.message ?? result?.error ?? null;
                    if (errMsg) {
                        logger?.warn?.(`[rainbow-bridge] Failed to delete source message ${originalId}: ${errMsg}`);
                    } else {
                        logger?.warn?.(`[rainbow-bridge] Unable to delete source message ${originalId} while mirroring a removal.`);
                    }
                }
            }
        }

        for (const [bridgeId, record] of entries) {
            if (!record) continue;
            const bridge = bridges.get(bridgeId);
            const originIds = new Set();
            if (record.originChannelId) originIds.add(record.originChannelId);
            if (record.originParentId) originIds.add(record.originParentId);
            if (record.originThreadId) originIds.add(record.originThreadId);

            if (!bridge) {
                cleanupForwardMappings(originalId, bridgeId, record);
                bridgeMap.delete(bridgeId);
                continue;
            }

            const targets = bridge.channels.filter((ch) => {
                const matchIds = ch.matchIds ?? new Set([ch.channelId]);
                for (const id of matchIds) {
                    if (originIds.has(id)) return false;
                }
                return true;
            });

            for (const target of targets) {
                const forwarded = getForwardedRecord(record, target);
                const targetMessageId = forwarded?.messageId ?? null;
                if (!targetMessageId || targetMessageId === messageId) continue;
                const threadId = forwarded?.threadId ?? target.threadId ?? null;
                try {
                    const webhook = getWebhookClient(target);
                    suppressDeletion(targetMessageId);
                    if (threadId) {
                        await webhook.deleteMessage(targetMessageId, threadId).catch(() => {});
                    } else {
                        await webhook.deleteMessage(targetMessageId).catch(() => {});
                    }
                } catch (err) {
                    logger?.warn?.(`[rainbow-bridge] Failed to delete mirrored message ${targetMessageId} in ${target.channelId}: ${err?.message ?? err}`);
                }
            }

            cleanupForwardMappings(originalId, bridgeId, record);
            bridgeMap.delete(bridgeId);
        }

        runtime.messageLinks.delete(originalId);
    }

    async function handleMessageDelete(message) {
        try {
            await mirrorDeletionForMessage(message);
        } catch (err) {
            logger?.error?.(`[rainbow-bridge] messageDelete error: ${err?.message ?? err}`);
        }
    }

    async function handleMessageDeleteBulk(messages) {
        try {
            const list = Array.isArray(messages) ? messages : messages?.values?.();
            if (!list) return;
            for (const msg of list) {
                await mirrorDeletionForMessage(msg);
            }
        } catch (err) {
            logger?.error?.(`[rainbow-bridge] messageDeleteBulk error: ${err?.message ?? err}`);
        }
    }

    function getEmojiInfo(emoji) {
        if (!emoji) return null;
        const id = emoji.id ? String(emoji.id) : null;
        const name = emoji.name ?? (typeof emoji.toString === 'function' ? emoji.toString() : null);
        if (!id && !name) return null;
        const reaction = id ? `${name ?? 'emoji'}:${id}` : name;
        return { id, name, reaction };
    }

    function resolveMessageBridgeEntries(messageId) {
        const entries = [];
        if (!messageId) return entries;
        if (runtime.messageLinks.has(messageId)) {
            const map = runtime.messageLinks.get(messageId);
            for (const [bridgeId, record] of map.entries()) {
                entries.push({
                    originId: messageId,
                    bridgeId,
                    record,
                    sourceType: 'origin',
                    sourceForward: null
                });
            }
        }
        if (runtime.reverseMessageLinks.has(messageId)) {
            const reverse = runtime.reverseMessageLinks.get(messageId);
            const map = runtime.messageLinks.get(reverse.originalId);
            const record = map?.get(reverse.bridgeId);
            if (record) {
                const existing = entries.find((entry) => entry.bridgeId === reverse.bridgeId && entry.originId === reverse.originalId);
                if (existing) {
                    existing.sourceType = 'forwarded';
                    existing.sourceForward = reverse;
                } else {
                    entries.push({
                        originId: reverse.originalId,
                        bridgeId: reverse.bridgeId,
                        record,
                        sourceType: 'forwarded',
                        sourceForward: reverse
                    });
                }
            }
        }
        return entries;
    }

    function buildReactionTargets({ record, originId, sourceMessageId, sourceType, sourceForward }) {
        const targets = [];
        const seen = new Set();

        const addTarget = ({ messageId, channelId, threadId }) => {
            if (!messageId || messageId === sourceMessageId) return;
            if (seen.has(messageId)) return;
            if (!channelId && !threadId) return;
            targets.push({
                messageId,
                channelId: channelId ?? null,
                threadId: threadId ?? null
            });
            seen.add(messageId);
        };

        if (sourceType === 'origin') {
            const forwarded = record.forwarded instanceof Map ? record.forwarded.values() : [];
            for (const value of forwarded) {
                if (!value) continue;
                addTarget({
                    messageId: value.messageId ?? null,
                    channelId: value.channelId ?? null,
                    threadId: value.threadId ?? null
                });
            }
            return targets;
        }

        if (record.originChannelId) {
            addTarget({
                messageId: originId,
                channelId: record.originChannelId,
                threadId: record.originThreadId ?? null
            });
        }

        const forwardedValues = record.forwarded instanceof Map ? record.forwarded.values() : [];
        for (const value of forwardedValues) {
            if (!value) continue;
            if (sourceForward && value.messageId === sourceForward.messageId) continue;
            addTarget({
                messageId: value.messageId ?? null,
                channelId: value.channelId ?? null,
                threadId: value.threadId ?? null
            });
        }

        return targets;
    }

    function resolveReactionFromMessage(message, emojiInfo) {
        if (!message?.reactions || !emojiInfo) return null;
        const cache = message.reactions.cache ?? null;
        if (cache?.values) {
            for (const reaction of cache.values()) {
                if (!reaction?.emoji) continue;
                if (emojiInfo.id && reaction.emoji.id === emojiInfo.id) {
                    return reaction;
                }
                if (!emojiInfo.id && reaction.emoji.name === emojiInfo.name) {
                    return reaction;
                }
            }
        }
        if (typeof message.reactions.resolve === 'function') {
            return message.reactions.resolve(emojiInfo.id ?? emojiInfo.reaction ?? emojiInfo.name ?? null) ?? null;
        }
        return null;
    }

    async function applyReactionOperation({ target, emojiInfo, operation }) {
        const message = await fetchMessageFromTarget({
            channelId: target.channelId,
            threadId: target.threadId,
            messageId: target.messageId
        });
        if (!message) return;

        if (operation === 'add') {
            if (!emojiInfo?.reaction) return;
            try {
                await message.react(emojiInfo.reaction);
            } catch (err) {
                runtime.logger?.warn?.(`[rainbow-bridge] Failed to mirror reaction ${emojiInfo.reaction} on ${target.messageId}: ${err?.message ?? err}`);
            }
            return;
        }

        if (operation === 'remove') {
            const botId = runtime.client?.user?.id ?? null;
            if (!botId || !emojiInfo) return;
            const reaction = resolveReactionFromMessage(message, emojiInfo);
            if (!reaction) return;
            try {
                await reaction.users.remove(botId);
            } catch (err) {
                runtime.logger?.warn?.(`[rainbow-bridge] Failed to remove mirrored reaction ${emojiInfo.reaction} on ${target.messageId}: ${err?.message ?? err}`);
            }
            return;
        }

        if (operation === 'clear') {
            const botId = runtime.client?.user?.id ?? null;
            if (!botId) return;
            const cache = message.reactions?.cache ?? null;
            const iterable = cache?.values ? cache.values() : [];
            for (const reaction of iterable) {
                if (!reaction) continue;
                try {
                    await reaction.users.remove(botId);
                } catch {}
            }
        }
    }

    async function mirrorReactionChange({ type, message, emoji }) {
        const entries = resolveMessageBridgeEntries(message?.id);
        if (!entries.length) return;
        const emojiInfo = getEmojiInfo(emoji);
        if ((type === 'add' || type === 'remove' || type === 'removeEmoji') && !emojiInfo) return;

        for (const entry of entries) {
            const targets = buildReactionTargets({
                record: entry.record,
                originId: entry.originId,
                sourceMessageId: message.id,
                sourceType: entry.sourceType,
                sourceForward: entry.sourceForward ?? null
            });
            for (const target of targets) {
                const operation = type === 'add' ? 'add' : 'remove';
                await applyReactionOperation({ target, emojiInfo, operation });
            }
        }
    }

    async function mirrorReactionClear(message) {
        const entries = resolveMessageBridgeEntries(message?.id);
        if (!entries.length) return;
        for (const entry of entries) {
            const targets = buildReactionTargets({
                record: entry.record,
                originId: entry.originId,
                sourceMessageId: message.id,
                sourceType: entry.sourceType,
                sourceForward: entry.sourceForward ?? null
            });
            for (const target of targets) {
                await applyReactionOperation({ target, emojiInfo: null, operation: 'clear' });
            }
        }
    }

    async function handleReactionAdd(reaction, user) {
        try {
            const actorId = user?.id ?? reaction?.userId ?? null;
            if (actorId && runtime.client?.user?.id && actorId === runtime.client.user.id) return;
            const partialMessage = reaction?.message ?? null;
            const message = partialMessage?.partial
                ? await partialMessage.fetch().catch(() => null)
                : partialMessage;
            if (!message) return;
            await mirrorReactionChange({ type: 'add', message, emoji: reaction?.emoji ?? null });
            await syncForwardedMessage(message);
        } catch (err) {
            logger?.error?.(`[rainbow-bridge] messageReactionAdd error: ${err?.message ?? err}`);
        }
    }

    async function handleReactionRemove(reaction, user) {
        try {
            const actorId = user?.id ?? reaction?.userId ?? null;
            if (actorId && runtime.client?.user?.id && actorId === runtime.client.user.id) return;
            const partialMessage = reaction?.message ?? null;
            const message = partialMessage?.partial
                ? await partialMessage.fetch().catch(() => null)
                : partialMessage;
            if (!message) return;
            await mirrorReactionChange({ type: 'remove', message, emoji: reaction?.emoji ?? null });
            await syncForwardedMessage(message);
        } catch (err) {
            logger?.error?.(`[rainbow-bridge] messageReactionRemove error: ${err?.message ?? err}`);
        }
    }

    async function handleReactionRemoveEmoji(reaction) {
        try {
            const partialMessage = reaction?.message ?? null;
            const message = partialMessage?.partial
                ? await partialMessage.fetch().catch(() => null)
                : partialMessage;
            if (!message) return;
            await mirrorReactionChange({ type: 'removeEmoji', message, emoji: reaction?.emoji ?? null });
            await syncForwardedMessage(message);
        } catch (err) {
            logger?.error?.(`[rainbow-bridge] messageReactionRemoveEmoji error: ${err?.message ?? err}`);
        }
    }

    async function handleReactionRemoveAll(message) {
        try {
            const resolved = message?.partial
                ? await message.fetch().catch(() => null)
                : message;
            if (!resolved) return;
            await mirrorReactionClear(resolved);
            await syncForwardedMessage(resolved);
        } catch (err) {
            logger?.error?.(`[rainbow-bridge] messageReactionRemoveAll error: ${err?.message ?? err}`);
        }
    }

    async function handleBridgePurge(interaction) {
        if (!interaction.inGuild?.() && !interaction.guildId) {
            await interaction.reply({ content: 'Run this command inside a server channel.', ephemeral: true }).catch(() => {});
            return;
        }
        if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageMessages)) {
            await interaction.reply({ content: 'You need **Manage Messages** permission to do that.', ephemeral: true }).catch(() => {});
            return;
        }

        const channel = interaction.channel ?? null;
        if (!channel || typeof channel.isTextBased !== 'function' || !channel.isTextBased()) {
            await interaction.reply({ content: 'This command can only run in text-based channels.', ephemeral: true }).catch(() => {});
            return;
        }
        if (channel.type === ChannelType.GuildForum) {
            await interaction.reply({ content: 'Use this command inside a specific post thread, not the forum list.', ephemeral: true }).catch(() => {});
            return;
        }

        const count = interaction.options?.getInteger?.('count', true) ?? 0;
        if (!Number.isInteger(count) || count < 1 || count > 200) {
            await interaction.reply({ content: 'Provide a number between 1 and 200.', ephemeral: true }).catch(() => {});
            return;
        }

        const { channelLookup } = getActiveState();
        const matching = new Set();
        if (channel.id) {
            const direct = channelLookup.get(channel.id) ?? [];
            for (const entry of direct) matching.add(entry.bridgeId);
        }
        const parentId = channel.parentId ?? channel.parent?.id ?? null;
        if (parentId) {
            const parentEntries = channelLookup.get(parentId) ?? [];
            for (const entry of parentEntries) matching.add(entry.bridgeId);
        }
        if (!matching.size) {
            await interaction.reply({ content: 'This channel is not part of any Rainbow Bridge links.', ephemeral: true }).catch(() => {});
            return;
        }

        await interaction.deferReply({ ephemeral: true }).catch(() => {});

        const messagesToDelete = new Map();
        let remaining = count;
        let before = null;
        while (remaining > 0) {
            const fetchLimit = Math.min(remaining, 100);
            if (typeof channel.messages?.fetch !== 'function') break;
            const fetched = await channel.messages.fetch({ limit: fetchLimit, ...(before ? { before } : {}) }).catch(() => null);
            if (!fetched?.size) break;
            for (const [id, msg] of fetched) {
                if (!messagesToDelete.has(id)) {
                    messagesToDelete.set(id, msg);
                }
            }
            remaining -= fetched.size;
            const last = fetched.last();
            before = last?.id ?? null;
            if (!before) break;
        }

        const deletable = [];
        for (const message of messagesToDelete.values()) {
            if (message?.deletable === false) continue;
            deletable.push(message);
        }

        if (!deletable.length) {
            await interaction.editReply({ content: 'No deletable messages were found in the requested range.' }).catch(() => {});
            return;
        }

        try {
            const deleted = await channel.bulkDelete(deletable, true);
            const total = deleted?.size ?? 0;
            await interaction.editReply({
                content: total
                    ? `Deleted ${total} message${total === 1 ? '' : 's'} and mirrored the removals across linked channels.`
                    : 'No messages were deleted (they may be older than 14 days).'
            }).catch(() => {});
        } catch (err) {
            await interaction.editReply({ content: `Failed to delete messages: ${err?.message ?? err}` }).catch(() => {});
        }
    }

    client.on('messageCreate', handleMessageCreate);
    client.on('messageUpdate', handleMessageUpdate);
    client.on('messageDelete', handleMessageDelete);
    client.on('messageDeleteBulk', handleMessageDeleteBulk);
    client.on('messageReactionAdd', handleReactionAdd);
    client.on('messageReactionRemove', handleReactionRemove);
    client.on('messageReactionRemoveAll', handleReactionRemoveAll);
    client.on('messageReactionRemoveEmoji', handleReactionRemoveEmoji);
    client.on('interactionCreate', async (interaction) => {
        if (!interaction?.isChatInputCommand?.()) return;
        if (interaction.commandName !== 'bridgepurge') return;
        await handleBridgePurge(interaction);
    });

    const { bridges, channelLookup } = getActiveState();
    if (bridges.size) {
        logger?.info?.(`[rainbow-bridge] Loaded ${bridges.size} bridge(s) spanning ${channelLookup.size} channels.`);
    } else {
        logger?.info?.('[rainbow-bridge] Rainbow Bridge ready — no bridges configured yet.');
    }
}
