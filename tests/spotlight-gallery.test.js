// tests/spotlight-gallery.test.js
import { describe, it, expect } from 'vitest';

import {
    DEFAULT_EMOJIS,
    DEFAULT_THRESHOLD,
    normalizeEmojiList,
    normalizeSpotlightConfig,
    normalizeSpotlightGuildConfig
} from '../src/features/spotlight-gallery/index.js';

describe('spotlight gallery config normalisation', () => {
    it('provides safe defaults when config is missing', () => {
        const normalized = normalizeSpotlightGuildConfig({});
        expect(normalized.enabled).toBe(false);
        expect(normalized.channelId).toBeNull();
        expect(normalized.threshold).toBe(DEFAULT_THRESHOLD);
        expect(normalized.allowSelf).toBe(false);
        expect(normalized.emojis).toEqual(DEFAULT_EMOJIS);
    });

    it('sanitizes inputs and clamps numeric values', () => {
        const normalized = normalizeSpotlightGuildConfig({
            enabled: 'true',
            channelId: ' 123456789012345678 ',
            threshold: 99,
            allowSelf: '1',
            emojis: [' ⭐ ', '<:custom:123456789012345678>', '<:custom:123456789012345678>', '']
        });
        expect(normalized.enabled).toBe(true);
        expect(normalized.channelId).toBe('123456789012345678');
        expect(normalized.threshold).toBe(25);
        expect(normalized.allowSelf).toBe(true);
        expect(normalized.emojis).toEqual(['⭐', '<:custom:123456789012345678>']);
    });

    it('normalizes emoji input from string sources', () => {
        const list = normalizeEmojiList('⭐, 🌟\n<:shine:987654321098765432>');
        expect(list).toEqual(['⭐', '🌟', '<:shine:987654321098765432>']);
    });

    it('drops invalid guild keys from spotlight config', () => {
        const normalized = normalizeSpotlightConfig({
            defaults: { enabled: true },
            '123456789012345678': { enabled: true, threshold: 2 },
            'invalid': { enabled: true },
            '222222222222222222': { channelId: '444444444444444444', emojis: ['⭐'] }
        });
        expect(Object.keys(normalized)).toEqual(['123456789012345678', '222222222222222222']);
        expect(normalized['123456789012345678'].threshold).toBe(2);
        expect(normalized['222222222222222222'].channelId).toBe('444444444444444444');
    });
});
