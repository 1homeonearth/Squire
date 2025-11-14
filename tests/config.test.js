import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../src/core/config.js';

const CONFIG_PATH = path.resolve(process.cwd(), 'config.json');

function removeConfigFile() {
    if (fs.existsSync(CONFIG_PATH)) {
        fs.unlinkSync(CONFIG_PATH);
    }
}

describe('loadConfig mainServerIds overrides', () => {
    beforeEach(() => {
        removeConfigFile();
        delete process.env.MAIN_SERVER_IDS_JSON;
    });

    afterEach(() => {
        removeConfigFile();
        delete process.env.MAIN_SERVER_IDS_JSON;
    });

    it('accepts a single snowflake string override', () => {
        process.env.MAIN_SERVER_IDS_JSON = '123456789012345678';

        const cfg = loadConfig();

        expect(cfg.mainServerIds).toEqual(['123456789012345678']);
    });

    it('parses comma or space separated snowflakes', () => {
        process.env.MAIN_SERVER_IDS_JSON = '123456789012345678, 987654321098765432';

        const cfg = loadConfig();

        expect(cfg.mainServerIds).toEqual(['123456789012345678', '987654321098765432']);
    });

    it('falls back to config.json when override is invalid', () => {
        fs.writeFileSync(CONFIG_PATH, JSON.stringify({ mainServerIds: ['555555555555555555'] }, null, 2));
        process.env.MAIN_SERVER_IDS_JSON = 'not-a-snowflake';

        const cfg = loadConfig();

        expect(cfg.mainServerIds).toEqual(['555555555555555555']);
    });
});
