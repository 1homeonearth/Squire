// src/features/rainbow-bridge/index.js
// Two-way channel bridge that keeps messages in sync across servers.

import {
    WebhookClient,
    EmbedBuilder
} from 'discord.js';
import { isYouTubeUrl, prepareForNativeEmbed } from '../../lib/youtube.js';

const RAINBOW = [0xFF0000, 0xFFA500, 0xFFFF00, 0x00FF00, 0x0000FF, 0x800080];

const MAX_CONTENT_LENGTH = 1900;

function trunc(str, max) {
    const value = String(str ?? '');
    return value.length > max ? `${value.slice(0, max - 1)}…` : value;
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

const runtime = {
    config: null,
    logger: null,
    bridges: new Map(),
    channelLookup: new Map(),
    knownWebhookIds: new Set(),
    webhookCache: new Map(),
    messageLinks: new Map(),
    dirty: true
};

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
    if (!guildId || !channelId || !webhookUrl) return null;
    if (!parseWebhookUrl(webhookUrl)) return null;
    return {
        guildId,
        channelId,
        webhookUrl,
        name: entry.name ? String(entry.name) : null
    };
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
        const channels = Array.isArray(rawEntry.channels) ? rawEntry.channels.map(normalizeChannelEntry).filter(Boolean) : [];
        const entry = {
            name: rawEntry.name ? String(rawEntry.name) : String(bridgeId),
            forwardBots: rawEntry.forwardBots === undefined ? undefined : rawEntry.forwardBots !== false,
            channels
        };
        bridges[String(bridgeId)] = entry;
    }

    return {
        forwardBots,
        bridges
    };
}

function buildChannelLookup(bridges) {
    const channelMap = new Map();
    for (const [bridgeId, bridge] of bridges.entries()) {
        for (const channelEntry of bridge.channels) {
            const list = channelMap.get(channelEntry.channelId) ?? [];
            list.push({ bridgeId, bridge, channelEntry });
            channelMap.set(channelEntry.channelId, list);
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

            normalized.channels.push({
                guildId: channelEntry.guildId,
                channelId: channelEntry.channelId,
                webhookUrl: channelEntry.webhookUrl,
                webhookId: parsed.id,
                webhookToken: parsed.token,
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
        for (const bridgeId of bridgeMap.keys()) {
            if (!nextBridges.has(bridgeId)) {
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

function buildContextLine(message) {
    const guildName = message.guild?.name ?? message.guildId ?? 'Unknown server';
    const channelName = message.channel?.name ?? message.channelId ?? 'unknown-channel';
    return `**${guildName}** • #${channelName}`;
}

function buildContent(message, { sanitize = false } = {}) {
    const parts = [];
    if (message.content?.length) {
        parts.push(sanitize ? prepareForNativeEmbed(message.content) : message.content);
    }

    const attachmentUrls = Array.from(message.attachments?.values?.() ?? [])
        .map(att => att?.url)
        .filter(Boolean);

    if (attachmentUrls.length) {
        parts.push(attachmentUrls.join('\n'));
    }

    if (message.stickers?.size) {
        const stickerLines = message.stickers.map((sticker) => `🃏 Sticker: ${sticker.name}`).join('\n');
        if (stickerLines) parts.push(stickerLines);
    }

    let combined = parts.join('\n\n');
    if (sanitize) {
        combined = prepareForNativeEmbed(combined);
    }
    return combined.length > MAX_CONTENT_LENGTH
        ? trunc(combined, MAX_CONTENT_LENGTH)
        : combined;
}

function buildEmbed({ bridgeId, bridge, message }) {
    const color = nextColor(bridgeId);
    const embed = new EmbedBuilder()
    .setColor(color)
    .setTimestamp(message.createdTimestamp ?? Date.now())
    .setFooter({
        text: `Bridge: ${bridge.name ?? bridgeId}`.slice(0, 2048)
    });

    const contextLine = buildContextLine(message);
    embed.setDescription(contextLine.slice(0, 4096));

    const media = extractMedia(message);
    if (media.length) {
        const preferred = media.find(url => /\.(gif|mp4|webm)(?:$|\?)/i.test(url)) || media[0];
        embed.setImage(preferred);
    }

    return embed;
}

function resolveUsername(message) {
    const memberName = message.member?.displayName;
    const user = message.author;
    return memberName || user?.globalName || user?.username || 'Unknown member';
}

function resolveAvatar(message) {
    return message.member?.displayAvatarURL?.() || message.author?.displayAvatarURL?.() || null;
}

function prepareSendPayload({ message, bridgeId, bridge }) {
    const hasYouTube = isYouTubeUrl(message.content ?? '');
    const content = buildContent(message, { sanitize: hasYouTube });
    const embed = buildEmbed({ bridgeId, bridge, message });
    const contextLine = buildContextLine(message);
    const payload = {
        username: resolveUsername(message),
        avatarURL: resolveAvatar(message),
        allowedMentions: { parse: [] }
    };

    payload.embeds = [embed];

    if (hasYouTube) {
        const messageBody = content.trim();
        const combined = [contextLine, messageBody].filter(Boolean).join('\n\n').trim();
        if (combined.length) {
            payload.content = combined;
        }
    } else {
        if (content.length) {
            payload.content = content;
        }
    }

    return payload;
}

function prepareEditPayload({ message, bridgeId, bridge }) {
    const hasYouTube = isYouTubeUrl(message.content ?? '');
    const content = buildContent(message, { sanitize: hasYouTube });
    const embed = buildEmbed({ bridgeId, bridge, message });
    const contextLine = buildContextLine(message);
    const payload = {
        allowedMentions: { parse: [] }
    };
    payload.embeds = [embed];
    if (hasYouTube) {
        const messageBody = content.trim();
        const combined = [contextLine, messageBody].filter(Boolean).join('\n\n').trim();
        payload.content = combined.length ? combined : '';
    } else {
        if (content.length) {
            payload.content = content;
        } else {
            payload.content = '';
        }
    }
    return payload;
}

export async function init({ client, config, logger }) {
    runtime.config = config;
    runtime.logger = logger;
    runtime.webhookCache = new Map();
    runtime.messageLinks = new Map();
    runtime.dirty = true;

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

    function cacheForwardedMessage({ originalId, bridgeId, originChannelId, targetChannelId, targetMessageId }) {
        if (!runtime.messageLinks.has(originalId)) {
            runtime.messageLinks.set(originalId, new Map());
        }
        const bridgeMap = runtime.messageLinks.get(originalId);
        if (!bridgeMap.has(bridgeId)) {
            bridgeMap.set(bridgeId, { originChannelId, forwarded: new Map() });
        }
        const record = bridgeMap.get(bridgeId);
        record.forwarded.set(targetChannelId, targetMessageId);
    }

    async function handleMessageCreate(message) {
        try {
            if (!message.guild || !message.channel) return;

            const { bridges, channelLookup, knownWebhookIds } = getActiveState();
            if (!bridges.size) return;
            if (message.webhookId && knownWebhookIds.has(message.webhookId)) return;

            const bridgesForChannel = channelLookup.get(message.channel.id);
            if (!bridgesForChannel || !bridgesForChannel.length) return;

            for (const { bridgeId, bridge } of bridgesForChannel) {
                if (!bridge.forwardBots && message.author?.bot) continue;

                const targets = bridge.channels.filter(ch => ch.channelId !== message.channel.id);
                if (!targets.length) continue;

                const payload = prepareSendPayload({ message, bridgeId, bridge });

                for (const target of targets) {
                    try {
                        const webhook = getWebhookClient(target);
                        const sent = await webhook.send(payload);
                        cacheForwardedMessage({
                            originalId: message.id,
                            bridgeId,
                            originChannelId: message.channel.id,
                            targetChannelId: target.channelId,
                            targetMessageId: sent?.id ?? null
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

    async function handleMessageUpdate(oldMessage, newMessage) {
        try {
            const message = newMessage?.partial ? await newMessage.fetch().catch(() => null) : newMessage;
            if (!message) return;
            if (!runtime.messageLinks.has(message.id)) return;

            const { bridges } = getActiveState();
            const bridgeMap = runtime.messageLinks.get(message.id);
            for (const [bridgeId, record] of bridgeMap.entries()) {
                const bridge = bridges.get(bridgeId);
                if (!bridge) continue;
                const targets = bridge.channels.filter(ch => ch.channelId !== record.originChannelId);
                const payload = prepareEditPayload({ message, bridgeId, bridge });

                for (const target of targets) {
                    const targetMessageId = record.forwarded.get(target.channelId);
                    if (!targetMessageId) continue;
                    try {
                        const webhook = getWebhookClient(target);
                        await webhook.editMessage(targetMessageId, payload);
                    } catch (err) {
                        logger?.warn?.(`[rainbow-bridge] Failed to edit mirrored message ${targetMessageId} in ${target.channelId}: ${err?.message ?? err}`);
                    }
                }
            }
        } catch (err) {
            logger?.error?.(`[rainbow-bridge] messageUpdate error: ${err?.message ?? err}`);
        }
    }

    async function handleMessageDelete(message) {
        try {
            const { knownWebhookIds, bridges } = getActiveState();
            if (message.webhookId && knownWebhookIds.has(message.webhookId)) {
                return; // ignore deletions of mirrored messages to avoid loops
            }
            const messageId = message.id ?? message?.message?.id;
            if (!messageId) return;
            if (!runtime.messageLinks.has(messageId)) return;

            const bridgeMap = runtime.messageLinks.get(messageId);
            runtime.messageLinks.delete(messageId);

            for (const [bridgeId, record] of bridgeMap.entries()) {
                const bridge = bridges.get(bridgeId);
                if (!bridge) continue;
                const targets = bridge.channels.filter(ch => ch.channelId !== record.originChannelId);
                for (const target of targets) {
                    const targetMessageId = record.forwarded.get(target.channelId);
                    if (!targetMessageId) continue;
                    try {
                        const webhook = getWebhookClient(target);
                        await webhook.deleteMessage(targetMessageId).catch(() => {});
                    } catch (err) {
                        logger?.warn?.(`[rainbow-bridge] Failed to delete mirrored message ${targetMessageId} in ${target.channelId}: ${err?.message ?? err}`);
                    }
                }
            }
        } catch (err) {
            logger?.error?.(`[rainbow-bridge] messageDelete error: ${err?.message ?? err}`);
        }
    }

    client.on('messageCreate', handleMessageCreate);
    client.on('messageUpdate', handleMessageUpdate);
    client.on('messageDelete', handleMessageDelete);

    const { bridges, channelLookup } = getActiveState();
    if (bridges.size) {
        logger?.info?.(`[rainbow-bridge] Loaded ${bridges.size} bridge(s) spanning ${channelLookup.size} channels.`);
    } else {
        logger?.info?.('[rainbow-bridge] Rainbow Bridge ready — no bridges configured yet.');
    }
}
