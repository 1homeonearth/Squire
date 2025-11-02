import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';

vi.mock('@napi-rs/canvas', () => ({
    createCanvas: vi.fn(() => ({
        getContext: vi.fn(() => ({
            fillRect: vi.fn(),
            beginPath: vi.fn(),
            arcTo: vi.fn(),
            closePath: vi.fn(),
            fill: vi.fn(),
            createRadialGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
            arc: vi.fn(),
            save: vi.fn(),
            restore: vi.fn(),
            drawImage: vi.fn(),
            clip: vi.fn(),
            stroke: vi.fn(),
            measureText: vi.fn(() => ({ width: 0 })),
            fillText: vi.fn(),
            font: '',
            textAlign: '',
            textBaseline: ''
        })),
        encode: vi.fn(async () => Buffer.alloc(0))
    })),
    loadImage: vi.fn()
}));

vi.mock('canvacord', () => ({
    loadImage: vi.fn(async () => { throw new Error('skip-image'); }),
    Font: { loadDefault: vi.fn() }
}));

vi.mock('discord.js', () => ({
    AttachmentBuilder: class AttachmentBuilder {},
    PermissionFlagsBits: { MentionEveryone: 0n }
}));

import { init as initWelcomeCards } from '../src/features/welcome-cards/index.js';

function createTestChannel(id, guild) {
    const messageCache = createCollection();
    const channel = {
        id,
        name: id,
        guild,
        isTextBased: () => true,
        send: vi.fn(),
        permissionsFor: vi.fn(() => ({ has: vi.fn(() => true) })),
        messages: {
            cache: messageCache,
            fetch: vi.fn(async (messageId) => messageCache.get(messageId)),
            delete: vi.fn(async (messageId) => {
                messageCache.delete(messageId);
            })
        }
    };
    return channel;
}

function createCollection(initialEntries = []) {
    const map = new Map(initialEntries);
    const collection = {
        get: (key) => map.get(key),
        set: (key, value) => {
            map.set(key, value);
            return collection;
        },
        delete: (key) => map.delete(key),
        find: (predicate) => {
            for (const value of map.values()) {
                if (predicate(value)) return value;
            }
            return undefined;
        },
        values: () => map.values(),
        [Symbol.iterator]: map[Symbol.iterator].bind(map)
    };
    return collection;
}

function createBaseContext() {
    const client = new EventEmitter();
    client.channels = {
        cache: createCollection(),
        fetch: vi.fn(async () => null)
    };
    client.guilds = {
        cache: createCollection(),
        fetch: vi.fn(async () => null)
    };

    const logger = {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn()
    };

    const guild = {
        id: 'guild-1',
        name: 'Guild One',
        channels: {
            cache: createCollection(),
            fetch: vi.fn(async () => null)
        },
        systemChannel: null,
        members: { me: { id: 'bot-user' } },
        roles: { cache: new Map() },
        memberCount: 5
    };

    return { client, logger, guild };
}

function createMember(guild) {
    return {
        id: 'member-1',
        user: {
            id: 'user-1',
            username: 'newcomer',
            tag: 'newcomer#0001',
            async fetch() { return this; }
        },
        displayName: 'newcomer',
        guild,
        roles: {
            add: vi.fn(async () => {}),
            cache: new Map()
        },
        displayAvatarURL: vi.fn(() => 'https://cdn.example/avatar.png')
    };
}

async function flushAsyncTasks(iterations = 5) {
    for (let i = 0; i < iterations; i += 1) {
        await new Promise(resolve => queueMicrotask(resolve));
    }
}

describe('welcome cards autoban cleanup', () => {
    afterEach(() => {
        vi.clearAllTimers();
        vi.clearAllMocks();
        vi.useRealTimers();
    });

    it('removes the tracked welcome message after an autoban', async () => {
        const { client, logger, guild } = createBaseContext();
        const channel = createTestChannel('welcome-1', guild);
        const sentMessages = [];
        channel.send.mockImplementation(async () => {
            const message = {
                id: `msg-${sentMessages.length + 1}`,
                channelId: channel.id,
                channel,
                delete: vi.fn(async () => {
                    message.deleted = true;
                })
            };
            channel.messages.cache.set(message.id, message);
            sentMessages.push(message);
            return message;
        });
        guild.channels.cache.set(channel.id, channel);
        channel.guild = guild;
        client.channels.cache.set(channel.id, channel);

        const config = {
            welcome: {
                [guild.id]: {
                    enabled: true,
                    channelId: channel.id
                }
            }
        };

        initWelcomeCards({ client, logger, config });

        const member = createMember(guild);
        client.emit('guildMemberAdd', member);
        await flushAsyncTasks();

        expect(channel.send).toHaveBeenCalledTimes(1);
        const trackedMessage = sentMessages[0];
        expect(trackedMessage.delete).not.toHaveBeenCalled();

        client.emit('squire:autoban:banned', {
            guildId: guild.id,
            userId: member.id,
            welcomeChannelId: channel.id
        });

        await flushAsyncTasks();

        expect(trackedMessage.delete).toHaveBeenCalledTimes(1);
    });

    it('cleans up after delayed welcome sends when the autoban fires first', async () => {
        vi.useFakeTimers();
        const { client, logger, guild } = createBaseContext();
        const channel = createTestChannel('welcome-2', guild);
        let resolveSend;
        const message = {
            id: 'msg-delayed',
            channelId: channel.id,
            channel,
            delete: vi.fn(async () => {
                message.deleted = true;
            })
        };
        channel.send.mockImplementation(() => new Promise((resolve) => {
            resolveSend = () => {
                channel.messages.cache.set(message.id, message);
                resolve(message);
            };
        }));
        guild.channels.cache.set(channel.id, channel);
        channel.guild = guild;
        client.channels.cache.set(channel.id, channel);

        const config = {
            welcome: {
                [guild.id]: {
                    enabled: true,
                    channelId: channel.id
                }
            }
        };

        initWelcomeCards({ client, logger, config });

        const member = createMember(guild);
        client.emit('guildMemberAdd', member);
        await flushAsyncTasks();

        client.emit('squire:autoban:banned', {
            guildId: guild.id,
            userId: member.id,
            welcomeChannelId: channel.id
        });
        await flushAsyncTasks();

        expect(message.delete).not.toHaveBeenCalled();

        expect(typeof resolveSend).toBe('function');
        resolveSend();
        await flushAsyncTasks();

        vi.advanceTimersByTime(300);
        await flushAsyncTasks();

        expect(message.delete).toHaveBeenCalledTimes(1);
    });
});
