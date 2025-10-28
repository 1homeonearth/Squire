import test from 'node:test';
import assert from 'node:assert/strict';

import { buildLoggingView } from '../src/features/setup/index.js';

test('buildLoggingView summarises mapping state and controls', async () => {
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

    assert.equal(view.embeds.length, 1);
    const embed = view.embeds[0];
    const data = embed.data ?? embed.toJSON?.() ?? {};
    const fields = data.fields ?? [];

    const loggingField = fields.find((f) => f.name === 'Logging server');
    assert.ok(loggingField && loggingField.value.includes('Queen\'s Court'));

    const mappingField = fields.find((f) => f.name === 'This server mapping');
    assert.ok(mappingField && mappingField.value.includes('<#456>'));

    const buttonsRow = view.components[0];
    assert.equal(buttonsRow.components.length, 5);
    assert.equal(buttonsRow.components[0].data.custom_id, 'setup:logging:chooseServer');
    assert.equal(buttonsRow.components[1].data.custom_id, 'setup:logging:linkCurrent');
});

