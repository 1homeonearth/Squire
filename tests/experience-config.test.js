// tests/experience-config.test.js
import { describe, it, expect } from 'vitest';

import {
    normalizeExperienceConfig,
    normalizeGuildConfig,
    normalizeRule
} from '../src/features/experience/index.js';

describe('experience config normalisation', () => {
    it('creates default rule when none provided', () => {
        const config = normalizeExperienceConfig({ guild: {} });
        expect(config.guild).toBeDefined();
        expect(Array.isArray(config.guild.rules)).toBe(true);
        expect(config.guild.rules.length).toBe(1);
        const rule = config.guild.rules[0];
        expect(typeof rule.id).toBe('string');
        expect(rule.message.enabled).toBe(true);
        expect(rule.voice.enabled).toBe(false);
        expect(rule.multiplier).toBeCloseTo(1);
    });

    it('clamps numeric inputs and removes invalid ids', () => {
        const rawRule = normalizeRule({
            id: '',
            name: '  Custom Rule  ',
            message: { amount: -5, cooldownSeconds: 'not-a-number', enabled: true },
            voice: { amountPerMinute: '3000', enabled: true, ignoreMutedOrDeafened: false },
            reaction: { amount: 20000, cooldownSeconds: -10, enabled: true },
            resets: { onLeave: true, onBan: true },
            multiplier: 5.6789,
            channelBlacklist: ['1234567890', 'invalid', '1234567890'],
            roleBlacklist: ['<@&456789012345>', 'notid'],
            levelUpChannelId: '<#999999999999>',
            leaderboard: {
                customUrl: ' example ',
                autoChannelId: 'abc',
                showAvatar: false,
                stackRoles: true,
                giveRoleOnJoin: false,
                statCooldownSeconds: 99999
            },
            blacklist: {
                channels: ['<#111111111111>', 'bad'],
                categories: ['222222222222', 'zzz']
            }
        });

        expect(rawRule.message.amount).toBe(0);
        expect(rawRule.message.cooldownSeconds).toBe(60);
        expect(rawRule.voice.amountPerMinute).toBe(3000);
        expect(rawRule.voice.ignoreMutedOrDeafened).toBe(false);
        expect(rawRule.reaction.amount).toBe(10000);
        expect(rawRule.reaction.cooldownSeconds).toBe(0);
        expect(rawRule.resets.onLeave).toBe(true);
        expect(rawRule.multiplier).toBeCloseTo(5.68);
        expect(rawRule.channelBlacklist).toEqual(['1234567890']);
        expect(rawRule.roleBlacklist).toEqual([]);
        expect(rawRule.levelUpChannelId).toBeNull();
        expect(rawRule.leaderboard.autoChannelId).toBeNull();
        expect(rawRule.leaderboard.statCooldownSeconds).toBe(86400);
        expect(rawRule.blacklist.channels).toEqual([]);
        expect(rawRule.blacklist.categories).toEqual(['222222222222']);
    });

    it('preserves active rule id when present', () => {
        const first = normalizeRule({ name: 'A' });
        const second = normalizeRule({ name: 'B' });
        const guild = normalizeGuildConfig({ rules: [first, second], activeRuleId: second.id });
        expect(guild.activeRuleId).toBe(second.id);
    });
});
