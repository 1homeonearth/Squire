import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { init as initAutoBouncer } from '../src/features/auto-bouncer/index.js';
import { createDb, ensureCollection } from '../src/core/db.js';

async function createTempDb(t) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'squire-test-'));
    const dbPath = path.join(tmp, 'db.json');
    const db = await createDb(dbPath);
    t.after(() => new Promise((resolve) => db.close(() => {
        fs.rmSync(tmp, { recursive: true, force: true });
        resolve();
    })));
    return db;
}

test('auto-bouncer records moderation events for banned members', async (t) => {
    const db = await createTempDb(t);

    const client = new EventEmitter();
    const logs = [];
    const logger = {
        info: (...args) => logs.push(['info', args.join(' ')]),
        warn: (...args) => logs.push(['warn', args.join(' ')]),
        error: (...args) => logs.push(['error', args.join(' ')])
    };

    await initAutoBouncer({
        client,
        logger,
        config: { autoban: { enabled: true, blockedUsernames: ['mega'] } },
        db
    });

    const guild = { id: '1', channels: { cache: new Map(), fetch: async () => null } };

    const member = {
        id: '2',
        user: { username: 'mega_spam', tag: 'mega_spam#0001' },
        displayName: 'mega_spam',
        guild,
        roles: { cache: { some: () => false } },
        bannable: true,
        ban: async () => {}
    };

    client.emit('guildMemberAdd', member);
    await new Promise((resolve) => setTimeout(resolve, 10));

    const events = ensureCollection(db, 'moderation_events');
    assert.equal(events.data.length, 1);
    assert.equal(events.data[0].status, 'banned');
    assert.equal(events.data[0].matchedTerm, 'mega');
    assert.equal(events.data[0].userId, '2');
});

test('auto-bouncer logs permission failures', async (t) => {
    const db = await createTempDb(t);

    const client = new EventEmitter();
    const logger = { info() {}, warn() {}, error() {} };

    await initAutoBouncer({
        client,
        logger,
        config: { autoban: { enabled: true, blockedUsernames: ['link'] } },
        db
    });

    const guild = { id: '7', channels: { cache: new Map(), fetch: async () => null } };

    const member = {
        id: '8',
        user: { username: 'friendly_link', tag: 'friendly_link#1000' },
        displayName: 'friendly_link',
        guild,
        roles: { cache: { some: () => false } },
        bannable: false,
        ban: async () => { throw new Error('should not ban'); }
    };

    client.emit('guildMemberAdd', member);
    await new Promise((resolve) => setTimeout(resolve, 10));

    const events = ensureCollection(db, 'moderation_events');
    assert.equal(events.data.length, 1);
    assert.equal(events.data[0].status, 'failed-permission');
    assert.equal(events.data[0].matchedTerm, 'link');
});
