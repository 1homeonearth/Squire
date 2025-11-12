import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuditLogEvent, ChannelType, Collection } from 'discord.js';

import { init } from '../src/features/moderation-logging/index.js';
import { createModerationLoggingSetup } from '../src/features/moderation-logging/setup.js';

describe('moderation logging feature', () => {
    let client;
    let emit;
    let config;
    let logger;
    let categoryChannel;
    let actionChannel;
    let loggingGuild;
    let sourceGuild;

    beforeEach(async () => {
        const listeners = new Map();
        client = {
            on(event, handler) {
                const arr = listeners.get(event) ?? [];
                arr.push(handler);
                listeners.set(event, arr);
            },
            guilds: {
                cache: new Map(),
                fetch: vi.fn(async (id) => client.guilds.cache.get(id) ?? null)
            }
        };

        emit = async (event, ...args) => {
            const handlers = listeners.get(event) ?? [];
            for (const handler of handlers) {
                await handler(...args);
            }
        };

        categoryChannel = {
            id: '123456789012345678',
            isTextBased: vi.fn(() => true),
            send: vi.fn(async () => {})
        };
        actionChannel = {
            id: '987654321098765432',
            isTextBased: vi.fn(() => true),
            send: vi.fn(async () => {})
        };

        loggingGuild = {
            id: 'logging-1',
            name: 'Logging Guild',
            channels: {
                cache: new Map([
                    [categoryChannel.id, categoryChannel],
                    [actionChannel.id, actionChannel]
                ]),
                fetch: vi.fn(async (id) => loggingGuild.channels.cache.get(id) ?? null)
            }
        };

        const moderator = { id: 'mod-1', username: 'Moderator' };
        sourceGuild = {
            id: 'guild-1',
            name: 'Source Guild',
            fetchAuditLogs: vi.fn(async ({ type }) => {
                const now = Date.now();
                if (type === AuditLogEvent.ChannelCreate) {
                    return {
                        entries: new Map([[
                            '1',
                            { target: { id: 'category-1' }, executor: moderator, reason: 'Creating', createdTimestamp: now }
                        ]])
                    };
                }
                if (type === AuditLogEvent.MemberBanAdd) {
                    return {
                        entries: new Map([[
                            '2',
                            { target: { id: 'user-1' }, executor: moderator, reason: 'Rule 1', createdTimestamp: now }
                        ]])
                    };
                }
                return { entries: new Map() };
            })
        };

        client.guilds.cache.set(loggingGuild.id, loggingGuild);

        config = {
            loggingServerId: loggingGuild.id,
            moderationLogging: {
                categoryChannelId: categoryChannel.id,
                actionChannelId: actionChannel.id
            }
        };

        logger = {
            warn: vi.fn()
        };

        await init({ client, config, logger });
        categoryChannel.send.mockClear();
        actionChannel.send.mockClear();
    });

    it('logs category creation and moderator bans', async () => {
        const category = {
            id: 'category-1',
            name: 'Staff Logs',
            type: ChannelType.GuildCategory,
            guild: sourceGuild
        };

        await emit('channelCreate', category);
        expect(categoryChannel.send).toHaveBeenCalledTimes(1);
        const catPayload = categoryChannel.send.mock.calls[0]?.[0];
        expect(catPayload?.content).toContain('Category created');
        expect(catPayload?.content).toContain('Staff Logs');

        const user = { id: 'user-1', username: 'Troublemaker' };
        await emit('guildBanAdd', { guild: sourceGuild, user });
        expect(actionChannel.send).toHaveBeenCalledTimes(1);
        const actionPayload = actionChannel.send.mock.calls[0]?.[0];
        expect(actionPayload?.content).toContain('Ban');
        expect(actionPayload?.content).toContain('Troublemaker');
    });
});

describe('moderation logging setup panel', () => {
    it('builds a view with channel selectors', async () => {
        const panelStore = new Map();
        const saveConfig = vi.fn();
        const loggingGuild = {
            id: 'logging-1',
            name: 'Logging Guild',
            channels: {
                cache: new Map(),
                fetch: async () => new Collection([
                    ['123456789012345678', { id: '123456789012345678', name: 'cat-log', isTextBased: () => true, isThread: () => false, rawPosition: 1 }],
                    ['987654321098765432', { id: '987654321098765432', name: 'act-log', isTextBased: () => true, isThread: () => false, rawPosition: 2 }]
                ])
            }
        };
        const fetchGuild = async (_, id) => (id === loggingGuild.id ? loggingGuild : null);
        const setup = createModerationLoggingSetup({ panelStore, saveConfig, fetchGuild });
        const config = {
            loggingServerId: 'logging-1',
            moderationLogging: {
                categoryChannelId: '123456789012345678',
                actionChannelId: null
            }
        };

        const view = await setup.buildView({ config, client: { guilds: { fetch: fetchGuild } } });
        expect(view.embeds).toHaveLength(1);
        const embed = view.embeds[0];
        const data = embed.data ?? embed.toJSON?.() ?? {};
        const fieldNames = data.fields?.map((f) => f.name) ?? [];
        expect(fieldNames).toContain('Category updates');
        expect(fieldNames).toContain('Moderator actions');

        const [categoryRow] = view.components;
        const categoryMenu = categoryRow.components[0];
        const menuData = categoryMenu.toJSON?.() ?? categoryMenu.data ?? {};
        const optionValues = (menuData.options ?? []).map((opt) => opt.value);
        expect(optionValues).toContain('123456789012345678');
        const defaultOption = (menuData.options ?? []).find((opt) => opt.value === '123456789012345678');
        expect(defaultOption?.default).toBe(true);
    });
});
