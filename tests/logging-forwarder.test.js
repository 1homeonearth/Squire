import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('discord.js', async () => {
    const actual = await vi.importActual('discord.js');

    class MockWebhookClient {
        static instances = [];
        static messageCounter = 0;

        constructor({ url }) {
            this.url = url;
            this.sent = [];
            this.send = vi.fn(async (payload) => {
                this.sent.push(payload);
                MockWebhookClient.messageCounter += 1;
                return { id: `mock-${MockWebhookClient.messageCounter}` };
            });
            MockWebhookClient.instances.push(this);
        }
    }

    return { ...actual, WebhookClient: MockWebhookClient };
});

import { WebhookClient } from 'discord.js';
import { init } from '../src/features/logging-forwarder/index.js';

describe('logging forwarder reactions', () => {
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
            },
            once(event, handler) {
                const key = `once:${event}`;
                listeners.set(key, handler);
            },
            guilds: {
                cache: new Map(),
                fetch: vi.fn()
            }
        };

        emit = async (event, ...args) => {
            if (event === 'ready') {
                const onceHandler = listeners.get(`once:${event}`);
                if (onceHandler) {
                    await onceHandler(...args);
                }
                return;
            }

            const handlers = listeners.get(event) ?? [];
            for (const handler of handlers) {
                await handler(...args);
            }
        };

        config = {
            mapping: { 'guild-1': 'https://discord.com/api/webhooks/1/token' },
            excludeChannels: {},
            excludeCategories: {},
            forwardBots: true,
            sampleRate: 1
        };

        logger = {
            info: vi.fn(),
            verbose: vi.fn(),
            error: vi.fn()
        };

        WebhookClient.instances.length = 0;
        WebhookClient.messageCounter = 0;

        await init({ client, config, logger });
    });

    it('forwards reaction additions to the configured webhook', async () => {
        const reactorMember = {
            displayName: 'Knight Reactor',
            displayAvatarURL: vi.fn(() => 'https://cdn.example.com/reactor.png')
        };
        const memberCache = new Map([[
            'user-1',
            reactorMember
        ]]);

        const guild = {
            id: 'guild-1',
            name: 'Test Guild',
            members: {
                cache: memberCache,
                fetch: vi.fn(async () => reactorMember)
            }
        };

        const channel = { id: 'channel-1', name: 'general', parentId: null };
        const authorMember = {
            displayName: 'Message Author',
            displayAvatarURL: vi.fn(() => 'https://cdn.example.com/author.png')
        };

        const message = {
            id: 'message-123',
            guildId: 'guild-1',
            channelId: 'channel-1',
            guild,
            channel,
            content: 'Look at this <@123> link',
            author: { username: 'AuthorUser', id: 'author-1' },
            member: authorMember
        };

        const reaction = {
            partial: false,
            message,
            emoji: { toString: () => '😀', name: 'grinning' },
            count: 3
        };

        const user = {
            id: 'user-1',
            bot: false,
            username: 'ReactorUser',
            globalName: 'Knight Reactor',
            displayAvatarURL: vi.fn(() => 'https://cdn.example.com/reactor-user.png')
        };

        await emit('messageReactionAdd', reaction, user);

        expect(WebhookClient.instances.length).toBe(1);
        const [webhook] = WebhookClient.instances;
        expect(webhook.send).toHaveBeenCalledTimes(1);

        const payload = webhook.send.mock.calls[0]?.[0] ?? {};
        expect(payload.username).toBe('Knight Reactor');
        const description = payload.embeds?.[0]?.data?.description ?? '';
        expect(description).toContain('😀');
        expect(description).toContain('[View message](https://discord.com/channels/guild-1/channel-1/message-123)');
        expect(description).toContain('×3');
        expect(description).toContain('> Look at this <@\u200B123> link');

        expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('[FWD][reaction]'));
    });

    it('skips bot reactions when bot forwarding is disabled', async () => {
        config.forwardBots = false;

        const guild = {
            id: 'guild-1',
            name: 'Test Guild',
            members: {
                cache: new Map(),
                fetch: vi.fn()
            }
        };

        const channel = { id: 'channel-1', name: 'general', parentId: null };
        const message = {
            id: 'message-123',
            guildId: 'guild-1',
            channelId: 'channel-1',
            guild,
            channel,
            content: 'Bot reaction target',
            author: { username: 'AuthorUser', id: 'author-1' },
            member: { displayName: 'AuthorUser' }
        };

        const reaction = {
            partial: false,
            message,
            emoji: { toString: () => '🤖', name: 'robot' },
            count: 1
        };

        const botUser = {
            id: 'bot-1',
            bot: true,
            username: 'LogBot',
            displayAvatarURL: vi.fn(() => 'https://cdn.example.com/bot.png')
        };

        await emit('messageReactionAdd', reaction, botUser);

        expect(WebhookClient.instances.length).toBe(0);
    });
});

