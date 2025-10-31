import { expect, it } from 'vitest';
import { ComponentType } from 'discord.js';

import { buildLoggingView, buildWelcomeView } from '../src/features/setup/index.js';

it('buildLoggingView summarises mapping state and controls', async () => {
    const loggingGuildChannels = new Map([
        ['456', { id: '456', name: 'court-log', isTextBased: () => true }]
    ]);
    const sourceGuildChannels = new Map([
        ['321', { id: '321', name: 'general', isTextBased: () => true }]
    ]);

    const client = {
        guilds: {
            cache: new Map([
                ['999', { id: '999', name: 'Queen\'s Court', channels: { cache: loggingGuildChannels, fetch: async () => loggingGuildChannels }, members: { me: null, fetchMe: async () => null } }]
            ]),
            fetch: async (id) => client.guilds.cache.get(id)
        }
    };

    const guild = {
        id: '123',
        name: 'Source Guild',
        channels: { cache: sourceGuildChannels, fetch: async () => sourceGuildChannels }
    };

    const view = await buildLoggingView({
        config: {
            loggingServerId: '999',
            forwardBots: false,
            sampleRate: 0.5,
            mapping: {
                '123': 'https://discord.com/api/webhooks/123/abc'
            },
            loggingWebhookMeta: {
                '123': { channelId: '456', webhookId: '987' }
            },
            loggingChannels: {
                messages: '456'
            },
            excludeChannels: { '123': ['321'] },
            excludeCategories: { '123': ['654'] }
        },
        client,
        guild,
        mode: 'default',
        context: {}
    });

    expect(view.embeds).toHaveLength(1);
    const embed = view.embeds[0];
    const data = embed.data ?? embed.toJSON?.() ?? {};
    const fields = data.fields ?? [];

    const loggingField = fields.find((f) => f.name === 'Logging server');
    expect(loggingField && loggingField.value.includes("Queen's Court")).toBe(true);

    const selectedField = fields.find((f) => f.name === 'Selected main server');
    expect(selectedField && selectedField.value.includes('Source Guild')).toBe(true);

    const mappingField = fields.find((f) => f.name === 'Current mapping');
    expect(mappingField && mappingField.value.includes('<#456>')).toBe(true);

    expect(view.components[0].components[0].data.custom_id).toBe('setup:logging:selectSource');

    const buttonsRow = view.components[1];
    expect(buttonsRow.components).toHaveLength(4);
    expect(buttonsRow.components[0].data.custom_id).toBe('setup:logging:linkCurrent');
});

it('buildWelcomeView surfaces role selections with role picker controls', async () => {
    const rolesCache = new Map([
        ['999', { id: '999', name: 'Unverified', position: 5 }]
    ]);
    const guild = {
        id: '123',
        name: 'Test Guild',
        channels: { cache: new Map(), fetch: async () => new Map() },
        roles: { cache: rolesCache, fetch: async () => rolesCache }
    };

    const guilds = {
        cache: new Map([[guild.id, guild]]),
        fetch: async (id) => guilds.cache.get(id)
    };
    const client = { guilds };

    const config = {
        mainServerIds: ['123'],
        loggingServerId: null,
        welcome: {
            '123': {
                channelId: '555',
                mentions: {},
                enabled: true,
                preImageText: 'Welcome {{user}}!',
                isCustomized: true,
                roles: {
                    unverifiedRoleId: '999',
                    verifiedRoleId: null,
                    crossVerifiedRoleId: null,
                    moderatorRoleId: null
                }
            }
        }
    };

    const view = await buildWelcomeView({
        config,
        client,
        guild,
        mode: 'roles',
        context: { availableGuildIds: ['123'] }
    });

    const embed = view.embeds[0];
    const embedData = embed.data ?? embed.toJSON?.() ?? {};
    const roleField = embedData.fields.find((f) => f.name === 'Autorole (unverified)');
    expect(roleField?.value).toContain('<@&999>');

    const roleRow = view.components.find((row) =>
        row.components.some((component) => component.data?.custom_id === 'setup:welcome:roleChoice:unverifiedRoleId')
    );
    expect(roleRow).toBeTruthy();
    const picker = roleRow.components.find((component) => component.data?.custom_id === 'setup:welcome:roleChoice:unverifiedRoleId');
    const pickerData = picker.toJSON?.() ?? picker.data ?? {};
    expect(pickerData.type).toBe(ComponentType.StringSelect);
    const defaultOption = (pickerData.options ?? []).find((option) => option.value === '999');
    expect(defaultOption?.default).toBe(true);
    const clearOption = (pickerData.options ?? []).find((option) => option.value === '__clear__');
    expect(clearOption?.default).toBe(false);
});

