import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
    collectTargetGuildIds,
    formatBanResults
} from '../src/features/moderation-commands/index.js';
import { loadConfig } from '../src/core/config.js';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.resolve(__dir, '../config.json');
let hadOriginalConfig = false;
let originalConfigContents = '';

beforeEach(() => {
    hadOriginalConfig = fs.existsSync(CONFIG_PATH);
    originalConfigContents = hadOriginalConfig ? fs.readFileSync(CONFIG_PATH, 'utf8') : '';
});

afterEach(() => {
    delete process.env.MODERATION_ROLE_MAP_JSON;
    if (fs.existsSync(CONFIG_PATH)) {
        fs.unlinkSync(CONFIG_PATH);
    }
    if (hadOriginalConfig) {
        fs.writeFileSync(CONFIG_PATH, originalConfigContents);
    }
});

describe('moderation command helpers', () => {
    it('collectTargetGuildIds deduplicates and aggregates from config and cache', () => {
        const config = {
            mainServerIds: ['123', '456', ''],
            mapping: {
                '789': 'https://example.com/webhook',
                '': 'ignored'
            },
            loggingServerId: '999'
        };
        const client = {
            guilds: {
                cache: new Map([
                    ['456', {}],
                    ['321', {}]
                ])
            }
        };

        const ids = collectTargetGuildIds(config, client, '654');
        expect(ids.sort()).toEqual(['123', '321', '456', '654', '789', '999']);
    });

    it('collectTargetGuildIds filters empty or falsy values', () => {
        const config = {
            mainServerIds: [null, undefined, '  ', '135']
        };
        const client = {
            guilds: {
                cache: new Map([
                    ['', {}],
                    ['246', {}]
                ])
            }
        };

        const ids = collectTargetGuildIds(config, client, '');
        expect(ids).toEqual(['135', '246']);
    });

    it('formatBanResults summarises successes, repeats, and failures', () => {
        const message = formatBanResults('Bad Actor#0001', [
            { guildId: '123', guildName: 'Alpha', status: 'banned' },
            { guildId: '456', guildName: 'Beta', status: 'failed', error: 'Missing permissions' },
            { guildId: '789', guildName: 'Gamma', status: 'already' }
        ], { reason: 'Raid spam' });

        expect(message).toContain('Ban results for **Bad Actor#0001**');
        expect(message).toContain('Reason: Raid spam');
        expect(message).toContain('✅ Banned in 1 server');
        expect(message).toContain('Alpha');
        expect(message).toContain('⚠️ Failed in 1 server');
        expect(message).toContain('Missing permissions');
        expect(message).toContain('ℹ️ Already banned in 1 server');
        expect(message).toContain('Gamma');
    });

    it('formatBanResults handles empty results gracefully', () => {
        const message = formatBanResults('Target', [], {});
        expect(message).toContain('No target servers were found');
    });

    it('loadConfig uses MODERATION_ROLE_MAP_JSON override for the role map', () => {
        fs.writeFileSync(CONFIG_PATH, JSON.stringify({
            moderationCommands: {
                roleMap: {
                    '111': ['staff-old']
                }
            }
        }));
        process.env.MODERATION_ROLE_MAP_JSON = JSON.stringify({
            '222': ['staff-new']
        });

        const config = loadConfig();

        expect(config.moderationCommands).toBeDefined();
        expect(config.moderationCommands.roleMap).toEqual({
            '222': ['staff-new']
        });
    });

    it('loadConfig coerces string role maps from disk into objects', () => {
        fs.writeFileSync(CONFIG_PATH, JSON.stringify({
            moderationCommands: {
                roleMap: JSON.stringify({
                    '333': ['role-one']
                })
            }
        }));

        const config = loadConfig();

        expect(config.moderationCommands.roleMap).toEqual({
            '333': ['role-one']
        });
    });
});

