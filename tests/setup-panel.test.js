import test from 'node:test';
import assert from 'node:assert/strict';

import { buildSetupPanel } from '../src/features/logging-forwarder/index.js';

test('buildSetupPanel summarises mapping entries and toggles', () => {
    const view = buildSetupPanel({
        forwardBots: false,
        sampleRate: 0.75,
        mapping: {
            '123': 'https://discord.com/api/webhooks/123/abc',
            '456': 'https://discord.com/api/webhooks/456/def'
        }
    });

    assert.equal(view.embeds.length, 1);
    const embed = view.embeds[0];
    const data = embed.data ?? embed.toJSON?.() ?? {};
    const fields = data.fields ?? [];

    const mappingField = fields.find((f) => f.name === 'Mappings');
    assert.ok(mappingField, 'includes mapping field');
    assert.ok(mappingField.value.includes('123'));
    assert.ok(mappingField.value.includes('456'));

    const buttonsRow = view.components[0];
    assert.equal(buttonsRow.components.length, 4);
    assert.equal(buttonsRow.components[0].data.custom_id, 'setup:add-mapping');
    assert.equal(buttonsRow.components[1].data.label, 'Enable bot forwards');
});

