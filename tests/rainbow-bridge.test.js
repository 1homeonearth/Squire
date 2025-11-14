import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('discord.js', async () => {
    const actual = await vi.importActual('discord.js');
    class MockWebhookClient {
        static instances = [];
        static messageCounter = 0;

        constructor({ id, token }) {
            this.id = id;
            this.token = token;
            this.sent = [];
            this.edits = [];
            this.deleted = [];
            this.send = vi.fn(async (payload) => {
                this.sent.push(payload);
                MockWebhookClient.messageCounter += 1;
                const generatedThreadId = payload.threadId
                    ?? (payload.threadName ? `mock-thread-${this.id}-${MockWebhookClient.messageCounter}` : null);
                return {
                    id: `mock-${this.id}-${MockWebhookClient.messageCounter}`,
                    channelId: generatedThreadId
                };
            });
            this.editMessage = vi.fn(async (messageId, payload) => {
                this.edits.push({ messageId, payload });
            });
            this.deleteMessage = vi.fn(async (messageId) => {
                this.deleted.push(messageId);
            });
            MockWebhookClient.instances.push(this);
        }
    }

    return { ...actual, WebhookClient: MockWebhookClient };
});

import { WebhookClient, ChannelType, Collection, StickerFormatType } from 'discord.js';
import { init, normalizeRainbowBridgeConfig, refresh } from '../src/features/rainbow-bridge/index.js';
import { pruneBridgeChannels } from '../src/features/rainbow-bridge/setup-helpers.js';
import { createDb } from '../src/core/db.js';

async function createTempDb() {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'squire-rainbow-'));
    const dbPath = path.join(tmp, 'db.json');
    const db = await createDb(dbPath);
    const cleanup = () => new Promise((resolve) => {
        db.close(() => {
            fs.rmSync(tmp, { recursive: true, force: true });
            resolve();
        });
    });
    return { db, cleanup };
}

describe('normalizeRainbowBridgeConfig', () => {
    it('normalizes per-server forms and derives active channels', () => {
        const config = normalizeRainbowBridgeConfig({
            forwardBots: false,
            bridges: {
                alpha: {
                    name: 'Alpha',
                    forms: {
                        '123': {
                            guildId: '123',
                            channelId: 456,
                            webhookUrl: 'https://discord.com/api/webhooks/111/token',
                            name: 'Hallway'
                        },
                        '456': {
                            channelId: '999'
                        }
                    }
                }
            }
        });

        expect(config.forwardBots).toBe(false);
        const bridge = config.bridges.alpha;
        expect(bridge.name).toBe('Alpha');
        expect(bridge.forms['123']).toEqual({
            guildId: '123',
            channelId: '456',
            threadId: null,
            parentId: null,
            webhookUrl: 'https://discord.com/api/webhooks/111/token',
            name: 'Hallway'
        });
        expect(bridge.forms['456']).toEqual({
            guildId: '456',
            channelId: '999',
            threadId: null,
            parentId: null,
            webhookUrl: null,
            name: null
        });
        expect(bridge.channels).toEqual([
            {
                guildId: '123',
                channelId: '456',
                webhookUrl: 'https://discord.com/api/webhooks/111/token',
                threadId: null,
                parentId: null,
                name: 'Hallway'
            }
        ]);
    });

    it('converts legacy channel arrays into form entries', () => {
        const config = normalizeRainbowBridgeConfig({
            bridges: {
                beta: {
                    channels: [
                        {
                            guildId: '789',
                            channelId: '101',
                            webhookUrl: 'https://discord.com/api/webhooks/222/tokenB'
                        }
                    ]
                }
            }
        });

        const bridge = config.bridges.beta;
        expect(bridge.forms['789']).toEqual({
            guildId: '789',
            channelId: '101',
            threadId: null,
            parentId: null,
            webhookUrl: 'https://discord.com/api/webhooks/222/tokenB',
            name: null
        });
        expect(bridge.channels[0]).toMatchObject({
            guildId: '789',
            channelId: '101'
        });
    });
});

describe('pruneBridgeChannels', () => {
    it('removes channels and matching forms when selections overlap', () => {
        const bridge = {
            channels: [
                { guildId: '123', channelId: '456', webhookUrl: 'https://discord.com/api/webhooks/111/tokenA' },
                { guildId: '789', channelId: '000', webhookUrl: 'https://discord.com/api/webhooks/222/tokenB' }
            ],
            forms: {
                '123': { guildId: '123', channelId: '456', webhookUrl: 'https://discord.com/api/webhooks/111/tokenA' },
                '789': { guildId: '789', channelId: '000', webhookUrl: 'https://discord.com/api/webhooks/222/tokenB' }
            }
        };

        const result = pruneBridgeChannels(bridge, new Set(['123:456']));

        expect(result.removed).toBe(1);
        expect(bridge.channels).toEqual([
            { guildId: '789', channelId: '000', webhookUrl: 'https://discord.com/api/webhooks/222/tokenB' }
        ]);
        expect(bridge.forms['123']).toBeUndefined();
        expect(bridge.forms['789']).toBeDefined();
    });

    it('keeps bridge state intact when nothing matches', () => {
        const bridge = {
            channels: [
                { guildId: '123', channelId: '456', webhookUrl: 'https://discord.com/api/webhooks/111/tokenA' }
            ],
            forms: {
                '123': { guildId: '123', channelId: '456', webhookUrl: 'https://discord.com/api/webhooks/111/tokenA' }
            }
        };

        const result = pruneBridgeChannels(bridge, new Set(['999:000']));

        expect(result.removed).toBe(0);
        expect(bridge.channels).toEqual([
            { guildId: '123', channelId: '456', webhookUrl: 'https://discord.com/api/webhooks/111/tokenA' }
        ]);
        expect(bridge.forms['123']).toBeDefined();
    });
});

function makeMessage({
    channelId = 'chan-a',
    guildId = 'guild-1',
    content = 'Hello world',
    id = `msg-${Math.random().toString(36).slice(2)}`,
    webhookId = null,
    stickers = null
} = {}) {
    const stickerCollection = stickers ?? new Collection();
    return {
        id,
        guild: { id: guildId, name: `Guild ${guildId}` },
        channel: { id: channelId, name: `channel-${channelId}` },
        content,
        attachments: new Map(),
        embeds: [],
        stickers: stickerCollection,
        author: { bot: false, username: 'User', id: 'user-1' },
        member: { displayName: 'User', displayAvatarURL: () => null },
        webhookId,
        createdTimestamp: Date.now()
    };
}

function createTestClient() {
    const listeners = new Map();
    const channelCache = new Map();
    const client = {
        on(event, handler) {
            const existing = listeners.get(event) ?? [];
            existing.push(handler);
            listeners.set(event, existing);
        },
        channels: {
            cache: channelCache,
            fetch: vi.fn(async (id) => channelCache.get(id) ?? null)
        },
        user: { id: 'bot-1' }
    };
    const emit = async (event, ...args) => {
        const handlers = listeners.get(event) ?? [];
        for (const handler of handlers) {
            await handler(...args);
        }
    };
    return { client, emit, channelCache };
}

describe('rainbow bridge refresh hook', () => {
    let client;
    let emit;
    let config;
    let logger;

    beforeEach(async () => {
        const setup = createTestClient();
        client = setup.client;
        emit = setup.emit;
        config = { rainbowBridge: { bridges: {} } };
        logger = {
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn()
        };

        WebhookClient.instances.length = 0;
        WebhookClient.messageCounter = 0;

        await init({ client, config, logger });
    });

    it('mirrors messages immediately after refresh updates the config', async () => {
        await emit('messageCreate', makeMessage({ id: 'msg-before' }));
        expect(WebhookClient.instances.length).toBe(0);

        config.rainbowBridge.bridges.test = {
            name: 'Test Bridge',
            channels: [
                { guildId: 'guild-1', channelId: 'chan-a', webhookUrl: 'https://discord.com/api/webhooks/111/tokenA' },
                { guildId: 'guild-2', channelId: 'chan-b', webhookUrl: 'https://discord.com/api/webhooks/222/tokenB' }
            ]
        };
        config.rainbowBridge = normalizeRainbowBridgeConfig(config.rainbowBridge);

        WebhookClient.instances.length = 0;
        WebhookClient.messageCounter = 0;

        refresh();

        await emit('messageCreate', makeMessage({ id: 'msg-after', content: 'Second wave' }));

        expect(WebhookClient.instances.length).toBe(2);
        const targetWebhook = WebhookClient.instances.find(instance => instance.id === '222');
        const originWebhook = WebhookClient.instances.find(instance => instance.id === '111');
        expect(originWebhook?.send).toHaveBeenCalledTimes(1);
        expect(targetWebhook.send).toHaveBeenCalledTimes(1);
        const payload = targetWebhook.send.mock.calls[0]?.[0] ?? {};
        const embedDescription = payload.embeds?.[0]?.data?.description ?? payload.embeds?.[0]?.description ?? '';
        const combined = embedDescription || payload.content || '';
        expect(combined).toContain('Second wave');

        await emit('messageCreate', makeMessage({
            id: 'msg-mirror',
            channelId: 'chan-b',
            guildId: 'guild-2',
            webhookId: '222',
            content: 'Mirrored message'
        }));
        expect(targetWebhook.send).toHaveBeenCalledTimes(1);
    });

    it('deletes the source message before reposting via the bridge webhooks', async () => {
        config.rainbowBridge.bridges.test = {
            name: 'Uniform Bridge',
            channels: [
                { guildId: 'guild-1', channelId: 'chan-a', webhookUrl: 'https://discord.com/api/webhooks/111/tokenA' },
                { guildId: 'guild-2', channelId: 'chan-b', webhookUrl: 'https://discord.com/api/webhooks/222/tokenB' }
            ]
        };
        config.rainbowBridge = normalizeRainbowBridgeConfig(config.rainbowBridge);
        refresh();

        const message = makeMessage({ id: 'local-msg', content: 'Uniform content' });
        message.delete = vi.fn(async () => {});

        await emit('messageCreate', message);

        const remoteWebhook = WebhookClient.instances.find(instance => instance.id === '222');
        const localWebhook = WebhookClient.instances.find(instance => instance.id === '111');

        expect(remoteWebhook?.send).toHaveBeenCalledTimes(1);
        expect(localWebhook?.send).toHaveBeenCalledTimes(1);

        const remotePayload = remoteWebhook.send.mock.calls[0]?.[0] ?? {};
        const localPayload = localWebhook.send.mock.calls[0]?.[0] ?? {};
        expect(remotePayload.content).toBe(localPayload.content);
        expect(remotePayload.embeds).toEqual(localPayload.embeds);
        expect(remotePayload.files).toEqual(localPayload.files);
        expect(message.delete).toHaveBeenCalledTimes(1);

        const deleteCallOrder = message.delete.mock.invocationCallOrder?.[0] ?? Number.POSITIVE_INFINITY;
        const remoteCallOrder = remoteWebhook.send.mock.invocationCallOrder?.[0] ?? Number.POSITIVE_INFINITY;
        const localCallOrder = localWebhook.send.mock.invocationCallOrder?.[0] ?? Number.POSITIVE_INFINITY;
        expect(deleteCallOrder).toBeLessThan(remoteCallOrder);
        expect(deleteCallOrder).toBeLessThan(localCallOrder);
    });

    it('includes reaction summaries and syncs edits when reactions change', async () => {
        config.rainbowBridge.bridges.test = {
            name: 'Test Bridge',
            channels: [
                { guildId: 'guild-1', channelId: 'chan-a', webhookUrl: 'https://discord.com/api/webhooks/111/tokenA' },
                { guildId: 'guild-2', channelId: 'chan-b', webhookUrl: 'https://discord.com/api/webhooks/222/tokenB' }
            ]
        };
        config.rainbowBridge = normalizeRainbowBridgeConfig(config.rainbowBridge);
        refresh();

        const source = makeMessage({ id: 'msg-react', content: 'React to me' });
        source.reactions = {
            cache: new Map([
                ['fire', { count: 3, emoji: { toString: () => '🔥', name: 'fire' } }]
            ])
        };

        await emit('messageCreate', source);

        const bridgeWebhook = WebhookClient.instances.find(instance => instance.id === '222');
        expect(bridgeWebhook).toBeTruthy();
        const sendPayload = bridgeWebhook.send.mock.calls[0]?.[0] ?? {};
        const description = sendPayload.embeds?.[0]?.data?.description ?? sendPayload.embeds?.[0]?.description ?? '';
        expect(description).toContain('**Reactions:** 🔥 ×3');
        expect(description).not.toContain('View message');

        source.reactions.cache.set('fire', { count: 1, emoji: { toString: () => '🔥', name: 'fire' } });
        await emit('messageReactionRemove', { message: source });

        expect(bridgeWebhook.editMessage).toHaveBeenCalledTimes(1);
        const editPayload = bridgeWebhook.editMessage.mock.calls[0]?.[1] ?? {};
        const editDescription = editPayload.embeds?.[0]?.data?.description ?? editPayload.embeds?.[0]?.description ?? '';
        expect(editDescription).toContain('**Reactions:** 🔥 ×1');
    });

    it('replaces user mentions with nicknames in forwarded embeds', async () => {
        config.rainbowBridge.bridges.test = {
            name: 'Mention Bridge',
            channels: [
                { guildId: 'guild-1', channelId: 'chan-a', webhookUrl: 'https://discord.com/api/webhooks/111/tokenA' },
                { guildId: 'guild-2', channelId: 'chan-b', webhookUrl: 'https://discord.com/api/webhooks/222/tokenB' }
            ]
        };
        config.rainbowBridge = normalizeRainbowBridgeConfig(config.rainbowBridge);
        refresh();

        const member = {
            id: '123',
            displayName: 'Cool Kid',
            user: { id: '123', username: 'User123', globalName: 'GlobalUser' },
            displayAvatarURL: () => null
        };

        const message = makeMessage({ content: 'Hey <@123>' });
        message.mentions = {
            members: new Map([[member.id, member]]),
            users: new Map([[member.id, member.user]]),
            roles: new Map(),
            channels: new Map()
        };
        message.guild.members = { cache: new Map([[member.id, member]]) };

        await emit('messageCreate', message);

        const bridgeWebhook = WebhookClient.instances.find(instance => instance.id === '222');
        expect(bridgeWebhook).toBeTruthy();
        const payload = bridgeWebhook.send.mock.calls[0]?.[0] ?? {};
        const description = payload.embeds?.[0]?.data?.description ?? payload.embeds?.[0]?.description ?? '';
        expect(description).toContain('@Cool Kid');
        expect(description).not.toContain('<@');
    });

    it('forwards gif attachments as media while continuing the color rotation', async () => {
        config.rainbowBridge.bridges.test = {
            name: 'Gif Bridge',
            channels: [
                { guildId: 'guild-1', channelId: 'chan-a', webhookUrl: 'https://discord.com/api/webhooks/111/tokenA' },
                { guildId: 'guild-2', channelId: 'chan-b', webhookUrl: 'https://discord.com/api/webhooks/222/tokenB' }
            ]
        };
        config.rainbowBridge = normalizeRainbowBridgeConfig(config.rainbowBridge);
        refresh();

        const gifMessage = makeMessage({ content: '' });
        gifMessage.attachments.set('gif', { url: 'https://cdn.example.com/animated.gif' });

        await emit('messageCreate', gifMessage);

        const bridgeWebhook = WebhookClient.instances.find(instance => instance.id === '222');
        expect(bridgeWebhook).toBeTruthy();
        const gifPayload = bridgeWebhook.send.mock.calls[0]?.[0] ?? {};
        const gifEmbedRaw = gifPayload.embeds?.[0] ?? {};
        const gifEmbed = gifEmbedRaw?.data ?? gifEmbedRaw;
        const gifImageUrl = gifEmbed?.image?.url ?? gifEmbedRaw?.image?.url ?? null;
        expect(gifImageUrl).toBe('https://cdn.example.com/animated.gif');
        expect(gifPayload.content).toContain('animated.gif');
        const gifColor = gifEmbed?.color ?? gifEmbedRaw?.color ?? null;
        expect(gifColor).toBe(0xFF0000);

        const textMessage = makeMessage({ content: 'Hello after gif' });
        await emit('messageCreate', textMessage);

        const textPayload = bridgeWebhook.send.mock.calls[1]?.[0] ?? {};
        const color = textPayload.embeds?.[0]?.data?.color ?? textPayload.embeds?.[0]?.color ?? null;
        expect(color).toBe(0xFFA500);
    });

    it('formats replies with logging-style quoting and attribution', async () => {
        config.rainbowBridge.bridges.test = {
            name: 'Reply Bridge',
            channels: [
                { guildId: 'guild-1', channelId: 'chan-a', webhookUrl: 'https://discord.com/api/webhooks/111/tokenA' },
                { guildId: 'guild-2', channelId: 'chan-b', webhookUrl: 'https://discord.com/api/webhooks/222/tokenB' }
            ]
        };
        config.rainbowBridge = normalizeRainbowBridgeConfig(config.rainbowBridge);
        refresh();

        const referenced = makeMessage({ id: 'msg-ref', content: 'Original message content' });
        referenced.member = { displayName: 'Original Member' };
        referenced.author = { id: 'user-ref', username: 'OriginalUser', globalName: 'Origin' };

        const reply = makeMessage({ content: 'Reply body' });
        reply.reference = { messageId: referenced.id, channelId: referenced.channel.id, guildId: referenced.guild.id };
        reply.fetchReference = vi.fn(async () => referenced);
        reply.mentions = {
            members: new Map(),
            users: new Map(),
            roles: new Map(),
            channels: new Map(),
            repliedUser: referenced.author
        };

        await emit('messageCreate', reply);

        const bridgeWebhook = WebhookClient.instances.find(instance => instance.id === '222');
        expect(bridgeWebhook).toBeTruthy();
        const payload = bridgeWebhook.send.mock.calls[0]?.[0] ?? {};
        const embedRaw = payload.embeds?.[0] ?? {};
        const embedData = embedRaw?.data ?? embedRaw;
        const description = embedData?.description ?? '';
        expect(description).toContain('↩️ Replying to **Original Member**');
        expect(description).toContain('> Original message content');
        expect(description).toContain('View replied message');
        expect(payload.content).toContain('↩️ Replying to **Original Member**');
        expect(payload.content).toContain('> Original message content');
    });

    it('renders stickers as images with attribution', async () => {
        config.rainbowBridge.bridges.test = {
            name: 'Sticker Bridge',
            channels: [
                { guildId: 'guild-1', channelId: 'chan-a', webhookUrl: 'https://discord.com/api/webhooks/111/tokenA' },
                { guildId: 'guild-2', channelId: 'chan-b', webhookUrl: 'https://discord.com/api/webhooks/222/tokenB' }
            ]
        };
        config.rainbowBridge = normalizeRainbowBridgeConfig(config.rainbowBridge);
        refresh();

        const stickers = new Collection([
            ['sticker-1', { id: 'sticker-1', name: 'Party Parrot', format: StickerFormatType.Lottie, url: 'https://cdn.discordapp.com/stickers/sticker-1.json' }]
        ]);
        const stickerMessage = makeMessage({ content: '', stickers });

        await emit('messageCreate', stickerMessage);

        const bridgeWebhook = WebhookClient.instances.find(instance => instance.id === '222');
        expect(bridgeWebhook).toBeTruthy();
        const payload = bridgeWebhook.send.mock.calls[0]?.[0] ?? {};
        const embedRaw = payload.embeds?.[0] ?? {};
        const embedData = embedRaw?.data ?? embedRaw;
        expect(embedData?.image?.url ?? embedRaw?.image?.url).toBe('https://cdn.discordapp.com/stickers/sticker-1.png?size=320');
        const description = embedData?.description ?? '';
        expect(description).toContain('🃏 Sticker: Party Parrot');
    });

    it('retains embed colors when mirrored messages are edited', async () => {
        config.rainbowBridge.bridges.test = {
            name: 'Edit Bridge',
            channels: [
                { guildId: 'guild-1', channelId: 'chan-a', webhookUrl: 'https://discord.com/api/webhooks/111/tokenA' },
                { guildId: 'guild-2', channelId: 'chan-b', webhookUrl: 'https://discord.com/api/webhooks/222/tokenB' }
            ]
        };
        config.rainbowBridge = normalizeRainbowBridgeConfig(config.rainbowBridge);
        refresh();

        const originalMessage = makeMessage({ content: 'Base content' });
        originalMessage.reactions = { cache: new Map() };

        await emit('messageCreate', originalMessage);

        const bridgeWebhook = WebhookClient.instances.find(instance => instance.id === '222');
        expect(bridgeWebhook).toBeTruthy();
        const initialPayload = bridgeWebhook.send.mock.calls[0]?.[0] ?? {};
        const initialColor = initialPayload.embeds?.[0]?.data?.color ?? initialPayload.embeds?.[0]?.color ?? null;
        expect(initialColor).toBe(0xFF0000);

        const sentInfo = await bridgeWebhook.send.mock.results[0]?.value;
        expect(sentInfo?.id).toBeTruthy();

        const updatedMessage = {
            ...originalMessage,
            content: 'Edited content',
            reactions: originalMessage.reactions,
            attachments: originalMessage.attachments,
            embeds: []
        };

        await emit('messageUpdate', originalMessage, updatedMessage);

        expect(bridgeWebhook.editMessage).toHaveBeenCalledTimes(1);
        const editPayload = bridgeWebhook.editMessage.mock.calls[0]?.[1] ?? {};
        const editColor = editPayload.embeds?.[0]?.data?.color ?? editPayload.embeds?.[0]?.color ?? null;
        expect(editColor).toBe(initialColor);
    });

    it('mirrors emoji reactions across linked channels', async () => {
        config.rainbowBridge.bridges.test = {
            name: 'Reaction Bridge',
            channels: [
                { guildId: 'guild-1', channelId: 'chan-a', webhookUrl: 'https://discord.com/api/webhooks/111/tokenA' },
                { guildId: 'guild-2', channelId: 'chan-b', webhookUrl: 'https://discord.com/api/webhooks/222/tokenB' }
            ]
        };
        config.rainbowBridge = normalizeRainbowBridgeConfig(config.rainbowBridge);
        refresh();

        const targetMessage = {
            id: null,
            react: vi.fn(async () => {}),
            reactions: { cache: new Map() }
        };

        const targetChannel = {
            id: 'chan-b',
            isTextBased: () => true,
            messages: {
                cache: new Map(),
                fetch: vi.fn(async (id) => targetChannel.messages.cache.get(id) ?? null)
            }
        };
        client.channels.cache.set('chan-b', targetChannel);

        const originChannel = {
            id: 'chan-a',
            isTextBased: () => true,
            messages: {
                cache: new Map(),
                fetch: vi.fn(async () => null)
            }
        };
        client.channels.cache.set('chan-a', originChannel);

        const source = makeMessage({ id: 'msg-react-target' });
        originChannel.messages.cache.set(source.id, source);

        await emit('messageCreate', source);

        const bridgeWebhook = WebhookClient.instances.find(instance => instance.id === '222');
        expect(bridgeWebhook).toBeTruthy();
        const sendResult = await bridgeWebhook.send.mock.results[0]?.value;
        expect(sendResult?.id).toBeTruthy();
        targetMessage.id = sendResult.id;
        targetChannel.messages.cache.set(targetMessage.id, targetMessage);

        const reaction = {
            message: source,
            emoji: { id: null, name: '👍', toString: () => '👍' }
        };

        await emit('messageReactionAdd', reaction, { id: 'user-2' });

        expect(targetMessage.react).toHaveBeenCalledTimes(1);
        expect(targetMessage.react.mock.calls[0][0]).toBe('👍');

        const removeStub = vi.fn(async () => {});
        targetMessage.reactions.cache.set('thumbs', {
            emoji: { id: null, name: '👍' },
            users: { remove: removeStub }
        });

        await emit('messageReactionRemove', reaction, { id: 'user-2' });

        expect(removeStub).toHaveBeenCalledWith('bot-1');
    });

    it('creates threads when mirroring into forum channels', async () => {
        client.channels.cache.set('forum-1', { id: 'forum-1', type: ChannelType.GuildForum });
        config.rainbowBridge.bridges.test = {
            name: 'Forum Bridge',
            channels: [
                {
                    guildId: 'guild-1',
                    channelId: 'thread-origin',
                    threadId: 'thread-origin',
                    parentId: 'forum-origin',
                    webhookUrl: 'https://discord.com/api/webhooks/111/tokenA'
                },
                {
                    guildId: 'guild-2',
                    channelId: 'forum-1',
                    parentId: 'forum-1',
                    webhookUrl: 'https://discord.com/api/webhooks/222/tokenB'
                }
            ]
        };
        config.rainbowBridge = normalizeRainbowBridgeConfig(config.rainbowBridge);
        refresh();

        const threadChannel = {
            id: 'thread-origin',
            name: 'Origin Thread',
            parentId: 'forum-origin',
            parent: { id: 'forum-origin' },
            isThread: () => true
        };

        const baseMessage = makeMessage({ id: 'thread-msg', channelId: 'thread-origin' });
        baseMessage.channel = threadChannel;

        await emit('messageCreate', baseMessage);

        const targetWebhook = WebhookClient.instances.find(instance => instance.id === '222');
        expect(targetWebhook).toBeTruthy();
        const firstPayload = targetWebhook.send.mock.calls[0]?.[0] ?? {};
        expect(firstPayload.threadName).toBe('Origin Thread');

        const secondMessage = makeMessage({ id: 'thread-msg-2', channelId: 'thread-origin' });
        secondMessage.channel = threadChannel;
        await emit('messageCreate', secondMessage);

        const secondPayload = targetWebhook.send.mock.calls[1]?.[0] ?? {};
        expect(secondPayload.threadId).toMatch(/^mock-thread-222-/);
    });

    it('purges recent messages via slash command and reports success', async () => {
        config.rainbowBridge.bridges.test = {
            name: 'Cleanup',
            channels: [
                { guildId: 'guild-1', channelId: 'chan-a', webhookUrl: 'https://discord.com/api/webhooks/111/tokenA' },
                { guildId: 'guild-2', channelId: 'chan-b', webhookUrl: 'https://discord.com/api/webhooks/222/tokenB' }
            ]
        };
        config.rainbowBridge = normalizeRainbowBridgeConfig(config.rainbowBridge);
        refresh();

        const channelMessages = new Collection([
            ['m1', { id: 'm1', deletable: true }],
            ['m2', { id: 'm2', deletable: true }],
            ['m3', { id: 'm3', deletable: true }]
        ]);

        const bulkDelete = vi.fn(async (messages) => {
            const items = Array.isArray(messages) ? messages : [];
            return new Collection(items.map(msg => [msg.id ?? msg, msg]));
        });

        const interaction = {
            commandName: 'bridgepurge',
            isChatInputCommand: () => true,
            inGuild: () => true,
            guildId: 'guild-1',
            memberPermissions: { has: () => true },
            options: { getInteger: () => 3 },
            channel: {
                id: 'chan-a',
                type: ChannelType.GuildText,
                isTextBased: () => true,
                messages: {
                    fetch: vi.fn(async () => channelMessages)
                },
                bulkDelete
            },
            reply: vi.fn(async () => {}),
            deferReply: vi.fn(async () => {}),
            editReply: vi.fn(async () => {})
        };

        await emit('interactionCreate', interaction);

        expect(interaction.deferReply).toHaveBeenCalledTimes(1);
        expect(bulkDelete).toHaveBeenCalledTimes(1);
        const deleteArgs = bulkDelete.mock.calls[0]?.[0] ?? [];
        expect(deleteArgs).toHaveLength(3);
        expect(interaction.editReply).toHaveBeenCalledTimes(1);
    });

    it('persists embed color progression per guild using the database', async () => {
        const { db, cleanup } = await createTempDb();

        try {
            const { client: firstClient, emit: emitFirst } = createTestClient();
            const persistentConfig = {
                rainbowBridge: {
                    bridges: {
                        persistent: {
                            name: 'Persistent',
                            channels: [
                                { guildId: 'guild-1', channelId: 'chan-a', webhookUrl: 'https://discord.com/api/webhooks/111/tokenA' },
                                { guildId: 'guild-2', channelId: 'chan-b', webhookUrl: 'https://discord.com/api/webhooks/222/tokenB' }
                            ]
                        }
                    }
                }
            };
            const persistentLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

            await init({ client: firstClient, config: persistentConfig, logger: persistentLogger, db });
            refresh();

            WebhookClient.instances.length = 0;
            WebhookClient.messageCounter = 0;

            await emitFirst('messageCreate', makeMessage({ content: 'First persistent message' }));

            const firstWebhook = WebhookClient.instances.find(instance => instance.id === '222');
            expect(firstWebhook).toBeTruthy();
            const firstPayload = firstWebhook.send.mock.calls[0]?.[0] ?? {};
            const firstColor = firstPayload.embeds?.[0]?.data?.color ?? firstPayload.embeds?.[0]?.color ?? null;
            expect(firstColor).toBe(0xFF0000);

            const { client: secondClient, emit: emitSecond } = createTestClient();

            WebhookClient.instances.length = 0;
            WebhookClient.messageCounter = 0;

            await init({ client: secondClient, config: persistentConfig, logger: persistentLogger, db });
            refresh();

            await emitSecond('messageCreate', makeMessage({ content: 'Second persistent message' }));

            const secondWebhook = WebhookClient.instances.find(instance => instance.id === '222');
            expect(secondWebhook).toBeTruthy();
            const secondPayload = secondWebhook.send.mock.calls[0]?.[0] ?? {};
            const secondColor = secondPayload.embeds?.[0]?.data?.color ?? secondPayload.embeds?.[0]?.color ?? null;
            expect(secondColor).toBe(0xFFA500);
        } finally {
            await cleanup();
        }
    });
});
