import { beforeEach, describe, expect, it, vi } from 'vitest';

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
                return { id: `mock-${this.id}-${MockWebhookClient.messageCounter}` };
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

import { WebhookClient } from 'discord.js';
import { init, normalizeRainbowBridgeConfig, refresh } from '../src/features/rainbow-bridge/index.js';

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

function makeMessage({
    channelId = 'chan-a',
    guildId = 'guild-1',
    content = 'Hello world',
    id = `msg-${Math.random().toString(36).slice(2)}`,
    webhookId = null
} = {}) {
    return {
        id,
        guild: { id: guildId, name: `Guild ${guildId}` },
        channel: { id: channelId, name: `channel-${channelId}` },
        content,
        attachments: new Map(),
        embeds: [],
        stickers: { size: 0, map: () => [] },
        author: { bot: false, username: 'User', id: 'user-1' },
        member: { displayName: 'User', displayAvatarURL: () => null },
        webhookId,
        createdTimestamp: Date.now()
    };
}

describe('rainbow bridge refresh hook', () => {
    let client;
    let emit;
    let config;
    let logger;

    beforeEach(async () => {
        const listeners = new Map();
        client = {
            on(event, handler) {
                const existing = listeners.get(event) ?? [];
                existing.push(handler);
                listeners.set(event, existing);
            }
        };
        emit = async (event, ...args) => {
            const handlers = listeners.get(event) ?? [];
            for (const handler of handlers) {
                await handler(...args);
            }
        };

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

        expect(WebhookClient.instances.length).toBe(1);
        const [targetWebhook] = WebhookClient.instances;
        expect(targetWebhook.send).toHaveBeenCalledTimes(1);
        const payload = targetWebhook.send.mock.calls[0]?.[0] ?? {};
        expect((payload.content ?? '') || (payload.embeds?.[0]?.data?.description ?? '')).toContain('Second wave');

        await emit('messageCreate', makeMessage({
            id: 'msg-mirror',
            channelId: 'chan-b',
            guildId: 'guild-2',
            webhookId: '222',
            content: 'Mirrored message'
        }));
        expect(targetWebhook.send).toHaveBeenCalledTimes(1);
    });
});
