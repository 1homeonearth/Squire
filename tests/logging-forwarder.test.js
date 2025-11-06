import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('discord.js', async () => {
    const actual = await vi.importActual('discord.js');

    class MockWebhookClient {
        static instances = [];
        static messageCounter = 0;
        static failNextWith = null;

        constructor({ url }) {
            this.url = url;
            this.sent = [];
            this.send = vi.fn(async (payload) => {
                if (MockWebhookClient.failNextWith) {
                    const error = MockWebhookClient.failNextWith;
                    MockWebhookClient.failNextWith = null;
                    throw error;
                }
                this.sent.push(payload);
                MockWebhookClient.messageCounter += 1;
                return { id: `mock-${MockWebhookClient.messageCounter}` };
            });
            MockWebhookClient.instances.push(this);
        }
    }

    return { ...actual, WebhookClient: MockWebhookClient };
});

import { AuditLogEvent, WebhookClient } from 'discord.js';
import { init } from '../src/features/logging-forwarder/index.js';

describe('logging forwarder reactions', () => {
    let client;
    let emit;
    let config;
    let logger;
    let modChannel;

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
                fetch: vi.fn(async (id) => client.guilds.cache.get(id) ?? null)
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

        modChannel = {
            id: 'mod-channel',
            isTextBased: vi.fn(() => true),
            send: vi.fn(async () => {})
        };

        const loggingGuild = {
            id: 'logging-1',
            name: 'Logging Guild',
            channels: {
                cache: new Map([[modChannel.id, modChannel]]),
                fetch: vi.fn(async (id) => (id === modChannel.id ? modChannel : null))
            }
        };

        client.guilds.cache.set(loggingGuild.id, loggingGuild);

        config = {
            mapping: { 'guild-1': 'https://discord.com/api/webhooks/1/token' },
            excludeChannels: {},
            excludeCategories: {},
            forwardBots: true,
            sampleRate: 1,
            loggingServerId: loggingGuild.id,
            loggingChannels: { moderation: modChannel.id }
        };

        logger = {
            info: vi.fn(),
            verbose: vi.fn(),
            error: vi.fn(),
            warn: vi.fn()
        };

        WebhookClient.instances.length = 0;
        WebhookClient.messageCounter = 0;
        WebhookClient.failNextWith = null;

        await init({ client, config, logger });
        modChannel.send.mockClear();
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

    it('logs bans to the moderation channel with moderator details', async () => {
        const auditEntry = {
            target: { id: 'user-1' },
            executor: { id: 'mod-1', tag: 'Mod#0001' },
            createdTimestamp: Date.now(),
            reason: 'Rule 1 violation'
        };

        const guild = {
            id: 'guild-1',
            name: 'Main Guild',
            fetchAuditLogs: vi.fn(async (options) => {
                expect(options.type).toBe(AuditLogEvent.MemberBanAdd);
                return { entries: new Map([[auditEntry.executor.id, auditEntry]]) };
            })
        };

        const user = { id: 'user-1', tag: 'Target#0001' };

        await emit('guildBanAdd', { guild, user });

        expect(modChannel.send).toHaveBeenCalledTimes(1);
        const payload = modChannel.send.mock.calls[0]?.[0] ?? {};
        expect(payload.content).toContain('Ban');
        expect(payload.content).toContain('Main Guild');
        expect(payload.content).toContain('Mod#0001');
        expect(payload.content).toContain('Target#0001');
        expect(payload.content).toContain('<#mod-channel>');
    });

    it('logs kicks when audit logs show a moderator action', async () => {
        const auditEntry = {
            target: { id: 'user-2' },
            executor: { id: 'mod-2', username: 'KickMod' },
            createdTimestamp: Date.now(),
            reason: 'Cleanup'
        };

        const guild = {
            id: 'guild-2',
            name: 'Second Guild',
            fetchAuditLogs: vi.fn(async (options) => {
                expect(options.type).toBe(AuditLogEvent.MemberKick);
                return { entries: new Map([[auditEntry.executor.id, auditEntry]]) };
            })
        };

        const member = {
            guild,
            user: { id: 'user-2', tag: 'Kicked#1234' }
        };

        await emit('guildMemberRemove', member);

        expect(modChannel.send).toHaveBeenCalledTimes(1);
        const payload = modChannel.send.mock.calls[0]?.[0] ?? {};
        expect(payload.content).toContain('Kick');
        expect(payload.content).toContain('Second Guild');
        expect(payload.content).toContain('KickMod');
        expect(payload.content).toContain('Kicked#1234');
    });

    it('records timeout applications with expiry', async () => {
        const future = Date.now() + 60_000;
        const auditEntry = {
            target: { id: 'user-3' },
            executor: { id: 'mod-3', tag: 'TimeoutMod#9999' },
            createdTimestamp: Date.now(),
            reason: 'Cooling off',
            changes: [{ key: 'communication_disabled_until' }]
        };

        const guild = {
            id: 'guild-3',
            name: 'Timeout Guild',
            fetchAuditLogs: vi.fn(async (options) => {
                expect(options.type).toBe(AuditLogEvent.MemberUpdate);
                return { entries: new Map([[auditEntry.executor.id, auditEntry]]) };
            })
        };

        const oldMember = {
            guild,
            communicationDisabledUntilTimestamp: null
        };

        const newMember = {
            guild,
            user: { id: 'user-3', tag: 'Muted#3333' },
            communicationDisabledUntilTimestamp: future
        };

        await emit('guildMemberUpdate', oldMember, newMember);

        expect(modChannel.send).toHaveBeenCalledTimes(1);
        const payload = modChannel.send.mock.calls[0]?.[0] ?? {};
        expect(payload.content).toContain('Timeout applied');
        expect(payload.content).toContain('Timeout Guild');
        expect(payload.content).toContain('TimeoutMod#9999');
        expect(payload.content).toContain('Muted#3333');
        expect(payload.content).toMatch(/Expires:/);
    });
});

describe('logging forwarder messages', () => {
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
        WebhookClient.failNextWith = null;

        await init({ client, config, logger });
    });

    const baseMessage = () => {
        const guild = { id: 'guild-1', name: 'Test Guild' };
        const channel = { id: 'channel-1', name: 'general', parentId: null, nsfw: false };
        return {
            id: `message-${Math.random()}`,
            guildId: guild.id,
            channelId: channel.id,
            guild,
            channel,
            member: { displayName: 'Knight Writer', displayAvatarURL: vi.fn(() => 'https://cdn.example.com/member.png') },
            author: {
                username: 'KnightWriter',
                id: 'author-1',
                displayAvatarURL: vi.fn(() => 'https://cdn.example.com/author.png')
            },
            attachments: new Map(),
            embeds: [],
            poll: null,
            content: 'Hello world'
        };
    };

    it('reuses webhook clients for repeated forwards to the same URL', async () => {
        const messageA = baseMessage();
        const messageB = baseMessage();

        await emit('messageCreate', messageA);
        await emit('messageCreate', messageB);

        expect(WebhookClient.instances.length).toBe(1);
        const [webhook] = WebhookClient.instances;
        expect(webhook.send).toHaveBeenCalledTimes(2);
    });

    it('routes message forward errors through the logger', async () => {
        WebhookClient.failNextWith = new Error('network down');

        const message = baseMessage();
        await emit('messageCreate', message);

        expect(logger.error).toHaveBeenCalledWith('[forwarder] messageCreate error:', expect.any(Error));
        const [errorCall] = logger.error.mock.calls;
        expect(errorCall?.[1]?.message).toBe('network down');
    });
});

