import { expect, it } from 'vitest';

import { buildLoggingView } from '../src/features/setup/index.js';

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

