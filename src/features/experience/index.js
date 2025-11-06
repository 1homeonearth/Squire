// src/features/experience/index.js
// Experience (XP) system runtime handlers.

import {
    SlashCommandBuilder,
    PermissionFlagsBits
} from 'discord.js';
import { randomUUID } from 'node:crypto';

import { ensureCollection } from '../../core/db.js';

const DEFAULT_MULTIPLIER = 1;
const DEFAULT_MESSAGE_AMOUNT = 15;
const DEFAULT_MESSAGE_COOLDOWN = 60;
const DEFAULT_VOICE_AMOUNT = 10;
const DEFAULT_REACTION_AMOUNT = 5;
const DEFAULT_REACTION_COOLDOWN = 30;
const DEFAULT_STAT_COOLDOWN = 60;
export const DEFAULT_LEVEL_UP_MESSAGE = '{user} reached level {level}! 🎉';
const MAX_LEVEL_UP_MESSAGE_LENGTH = 1800;

function cloneObject(value) {
    if (typeof structuredClone === 'function') {
        return structuredClone(value);
    }
    return JSON.parse(JSON.stringify(value));
}

export const commands = [
    new SlashCommandBuilder()
    .setName('xp')
    .setDescription('Manage member experience points')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setDMPermission(false)
    .addSubcommand(sub =>
        sub
        .setName('set')
        .setDescription('Set a member\'s experience to an exact value')
        .addUserOption(opt =>
            opt
            .setName('member')
            .setDescription('Member to update')
            .setRequired(true)
        )
        .addIntegerOption(opt =>
            opt
            .setName('amount')
            .setDescription('Exact XP amount to set (0 or greater)')
            .setRequired(true)
            .setMinValue(0)
        )
    )
];

const DEFAULT_RULE_TEMPLATE = Object.freeze({
    name: 'Default',
    message: {
        enabled: true,
        amount: DEFAULT_MESSAGE_AMOUNT,
        cooldownSeconds: DEFAULT_MESSAGE_COOLDOWN
    },
    voice: {
        enabled: false,
        amountPerMinute: DEFAULT_VOICE_AMOUNT,
        ignoreMutedOrDeafened: true,
        ignoreAlone: true
    },
    reaction: {
        enabled: false,
        amount: DEFAULT_REACTION_AMOUNT,
        cooldownSeconds: DEFAULT_REACTION_COOLDOWN
    },
    resets: {
        onLeave: false,
        onBan: false
    },
    multiplier: DEFAULT_MULTIPLIER,
    channelBlacklist: [],
    roleBlacklist: [],
    levelUpChannelId: null,
    levelUpMessage: DEFAULT_LEVEL_UP_MESSAGE,
    leaderboard: {
        customUrl: '',
        autoChannelId: null,
        showAvatar: true,
        stackRoles: false,
        giveRoleOnJoin: true,
        statCooldownSeconds: DEFAULT_STAT_COOLDOWN
    },
    blacklist: {
        channels: [],
        categories: []
    }
});

function cloneDefaultRule() {
    return normalizeRule(cloneObject(DEFAULT_RULE_TEMPLATE));
}

function normalizeRule(rule) {
    if (!rule || typeof rule !== 'object') {
        rule = {};
    }
    const clone = cloneObject(rule);
    clone.id = typeof clone.id === 'string' && clone.id.trim()
        ? clone.id.trim()
        : randomUUID();
    clone.name = typeof clone.name === 'string' && clone.name.trim()
        ? clone.name.trim().slice(0, 100)
        : 'Rule';
    clone.message = normalizeMessageSettings(clone.message);
    clone.voice = normalizeVoiceSettings(clone.voice);
    clone.reaction = normalizeReactionSettings(clone.reaction);
    clone.resets = normalizeResetSettings(clone.resets);
    clone.multiplier = normalizeNumber(clone.multiplier, DEFAULT_MULTIPLIER, 0.01, 1000);
    clone.channelBlacklist = normalizeIdArray(clone.channelBlacklist);
    clone.roleBlacklist = normalizeIdArray(clone.roleBlacklist);
    clone.levelUpChannelId = normalizeId(clone.levelUpChannelId);
    clone.levelUpMessage = normalizeLevelUpMessage(clone.levelUpMessage);
    clone.leaderboard = normalizeLeaderboardSettings(clone.leaderboard);
    clone.blacklist = normalizeGeneralBlacklist(clone.blacklist);
    return clone;
}

function normalizeGuildConfig(entry) {
    if (!entry || typeof entry !== 'object') {
        entry = {};
    }
    const result = { ...entry };
    const rules = Array.isArray(result.rules)
        ? result.rules.map(normalizeRule).filter(Boolean)
        : [];
    if (!rules.length) {
        rules.push(cloneDefaultRule());
    }
    const activeRuleId = typeof result.activeRuleId === 'string' && rules.some(rule => rule.id === result.activeRuleId)
        ? result.activeRuleId
        : rules[0].id;
    result.rules = rules;
    result.activeRuleId = activeRuleId;
    return result;
}

function normalizeExperienceConfig(source) {
    const result = {};
    if (!source || typeof source !== 'object') {
        return result;
    }
    for (const [guildId, entry] of Object.entries(source)) {
        const normalizedGuild = normalizeGuildConfig(entry);
        result[guildId] = normalizedGuild;
    }
    return result;
}

function normalizeMessageSettings(value) {
    const obj = value && typeof value === 'object' ? value : {};
    return {
        enabled: obj.enabled === false ? false : true,
        amount: normalizeInteger(obj.amount, DEFAULT_MESSAGE_AMOUNT, 0, 10000),
        cooldownSeconds: normalizeInteger(obj.cooldownSeconds, DEFAULT_MESSAGE_COOLDOWN, 0, 86400)
    };
}

function normalizeVoiceSettings(value) {
    const obj = value && typeof value === 'object' ? value : {};
    return {
        enabled: obj.enabled === true,
        amountPerMinute: normalizeInteger(obj.amountPerMinute, DEFAULT_VOICE_AMOUNT, 0, 10000),
        ignoreMutedOrDeafened: obj.ignoreMutedOrDeafened === false ? false : true,
        ignoreAlone: obj.ignoreAlone === false ? false : true
    };
}

function normalizeReactionSettings(value) {
    const obj = value && typeof value === 'object' ? value : {};
    return {
        enabled: obj.enabled === true,
        amount: normalizeInteger(obj.amount, DEFAULT_REACTION_AMOUNT, 0, 10000),
        cooldownSeconds: normalizeInteger(obj.cooldownSeconds, DEFAULT_REACTION_COOLDOWN, 0, 86400)
    };
}

function normalizeResetSettings(value) {
    const obj = value && typeof value === 'object' ? value : {};
    return {
        onLeave: obj.onLeave === true,
        onBan: obj.onBan === true
    };
}

function normalizeLeaderboardSettings(value) {
    const obj = value && typeof value === 'object' ? value : {};
    return {
        customUrl: typeof obj.customUrl === 'string' ? obj.customUrl.trim().slice(0, 100) : '',
        autoChannelId: normalizeId(obj.autoChannelId),
        showAvatar: obj.showAvatar === false ? false : true,
        stackRoles: obj.stackRoles === true,
        giveRoleOnJoin: obj.giveRoleOnJoin === false ? false : true,
        statCooldownSeconds: normalizeInteger(obj.statCooldownSeconds, DEFAULT_STAT_COOLDOWN, 0, 86400)
    };
}

function normalizeGeneralBlacklist(value) {
    const obj = value && typeof value === 'object' ? value : {};
    return {
        channels: normalizeIdArray(obj.channels),
        categories: normalizeIdArray(obj.categories)
    };
}

function normalizeId(value) {
    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (/^\d{6,30}$/.test(trimmed)) {
            return trimmed;
        }
    }
    return null;
}

function normalizeIdArray(value) {
    const list = Array.isArray(value) ? value : [];
    const seen = new Set();
    const out = [];
    for (const item of list) {
        const id = normalizeId(String(item));
        if (!id || seen.has(id)) continue;
        seen.add(id);
        out.push(id);
    }
    return out;
}

function normalizeInteger(value, fallback, min, max) {
    const num = Number.parseInt(value, 10);
    if (Number.isNaN(num)) return fallback;
    return Math.min(max, Math.max(min, num));
}

function normalizeNumber(value, fallback, min, max) {
    const num = Number(value);
    if (Number.isNaN(num)) return fallback;
    const clamped = Math.min(max, Math.max(min, num));
    return Math.round(clamped * 100) / 100;
}

function normalizeLevelUpMessage(value) {
    if (typeof value !== 'string') {
        return DEFAULT_LEVEL_UP_MESSAGE;
    }
    const trimmed = value.trim();
    if (!trimmed) {
        return DEFAULT_LEVEL_UP_MESSAGE;
    }
    return trimmed.slice(0, MAX_LEVEL_UP_MESSAGE_LENGTH);
}

function xpForLevel(level) {
    const safeLevel = Math.max(0, Math.floor(level));
    return 5 * safeLevel * safeLevel + 50 * safeLevel + 100;
}

export function getLevelFromXp(xp) {
    let remaining = Math.max(0, Math.floor(Number(xp) || 0));
    let level = 0;
    while (remaining >= xpForLevel(level)) {
        remaining -= xpForLevel(level);
        level += 1;
        if (level > 1000) break; // guard against runaway loops
    }
    return level;
}

function renderLevelUpMessage(template, context) {
    const base = normalizeLevelUpMessage(template);
    const replacements = new Map([
        ['{user}', context.userMention ?? ''],
        ['{userTag}', context.userTag ?? ''],
        ['{displayName}', context.displayName ?? ''],
        ['{level}', String(context.level ?? '')],
        ['{previousLevel}', String(context.previousLevel ?? '')],
        ['{levelDelta}', String(context.levelDelta ?? '')],
        ['{xp}', String(context.totalXp ?? '')],
        ['{guild}', context.guildName ?? ''],
        ['{channel}', context.channelMention ?? '']
    ]);

    let result = base;
    for (const [token, value] of replacements.entries()) {
        if (value === undefined || value === null) continue;
        result = result.replaceAll(token, value);
    }

    const trimmed = result.trim();
    if (!trimmed) {
        return DEFAULT_LEVEL_UP_MESSAGE;
    }

    return trimmed.slice(0, MAX_LEVEL_UP_MESSAGE_LENGTH);
}

function getActiveRule(config, guildId) {
    if (!guildId) return null;
    const guildConfig = config.experience?.[guildId];
    if (!guildConfig) return null;
    const { activeRuleId, rules } = guildConfig;
    const found = rules?.find(rule => rule.id === activeRuleId) ?? rules?.[0];
    return found ?? null;
}

function memberHasBlacklistedRole(member, rule) {
    const list = Array.isArray(rule.roleBlacklist) ? rule.roleBlacklist : [];
    if (!list.length) return false;
    if (!member?.roles?.cache) return false;
    return list.some(id => member.roles.cache.has(id));
}

function channelIsBlacklisted(rule, channel) {
    if (!channel) return false;
    const blacklist = new Set([...(rule.channelBlacklist ?? []), ...(rule.blacklist?.channels ?? [])]);
    if (blacklist.has(channel.id)) {
        return true;
    }
    const categoryId = channel.parentId ?? null;
    if (categoryId && Array.isArray(rule.blacklist?.categories) && rule.blacklist.categories.includes(categoryId)) {
        return true;
    }
    return false;
}

function calculateAward(baseAmount, rule) {
    const multiplier = Number(rule?.multiplier) || DEFAULT_MULTIPLIER;
    const total = Math.max(0, baseAmount) * multiplier;
    return Math.max(0, Math.round(total));
}

function getCooldownMap(map, guildId, userId) {
    const key = `${guildId}:${userId}`;
    return {
        key,
        last: map.get(key)
    };
}

function updateCooldown(map, key, timestamp) {
    map.set(key, timestamp);
}

function shouldAwardMessageXp({ message, rule }) {
    if (!message?.guildId || !rule?.message?.enabled) return false;
    if (message.author?.bot) return false;
    if (channelIsBlacklisted(rule, message.channel)) return false;
    return true;
}

function shouldAwardReactionXp({ reaction, user, rule, member }) {
    if (!reaction?.message?.guildId || !rule?.reaction?.enabled) return false;
    if (user?.bot) return false;
    const channel = reaction.message?.channel ?? null;
    if (channel && channelIsBlacklisted(rule, channel)) return false;
    if (memberHasBlacklistedRole(member, rule)) return false;
    return true;
}

function shouldTrackVoiceState(state, rule) {
    if (!state?.guild?.id) return false;
    if (!rule?.voice?.enabled) return false;
    const channel = state.channel ?? null;
    if (!channel) return false;
    if (channelIsBlacklisted(rule, channel)) return false;
    if (state.member?.user?.bot) return false;
    if (memberHasBlacklistedRole(state.member, rule)) return false;
    if (rule.voice.ignoreMutedOrDeafened) {
        if (state.selfMute || state.selfDeaf || state.serverMute || state.serverDeaf) {
            return false;
        }
    }
    if (rule.voice.ignoreAlone) {
        const members = channel.members?.filter(m => !m.user?.bot) ?? [];
        if (typeof members.size === 'number') {
            if (members.size <= 1) return false;
        } else if (Array.isArray(members) && members.length <= 1) {
            return false;
        }
    }
    return true;
}

export function init({ client, logger: _logger, config, db }) {
    let activeConfig = { ...config, experience: normalizeExperienceConfig(config.experience) };
    const logger = _logger;

    const profiles = db ? ensureCollection(db, 'experience_profiles', { indices: ['guildId', 'userId'] }) : null;
    const messageCooldowns = new Map();
    const reactionCooldowns = new Map();
    const voiceSessions = new Map(); // key -> { lastAwardAt, startedAt }

    function getRule(guildId) {
        return getActiveRule(activeConfig, guildId);
    }

    function fetchOrCreateProfile(guildId, userId) {
        if (!profiles) return null;
        let entry = profiles.findOne({ guildId, userId });
        if (!entry) {
            entry = { guildId, userId, xp: 0, updatedAt: Date.now() };
            profiles.insert(entry);
        }
        return entry;
    }

    function setProfileXp(guildId, userId, xp) {
        if (!profiles) return 0;
        const value = Math.max(0, Number.parseInt(xp, 10) || 0);
        let entry = profiles.findOne({ guildId, userId });
        if (!entry) {
            entry = { guildId, userId, xp: value, updatedAt: Date.now() };
            profiles.insert(entry);
        } else {
            entry.xp = value;
            entry.updatedAt = Date.now();
            profiles.update(entry);
        }
        return entry.xp;
    }

    async function resolveGuild(guildId) {
        if (!guildId) return null;
        let guild = client.guilds.cache.get(guildId) ?? null;
        if (!guild && typeof client.guilds.fetch === 'function') {
            guild = await client.guilds.fetch(guildId).catch(() => null);
        }
        return guild;
    }

    async function resolveTextChannel({ channel, channelId, guildId }) {
        const candidate = channel && typeof channel.isTextBased === 'function' && channel.isTextBased()
            ? channel
            : null;
        if (candidate) return candidate;

        const targetId = channelId ?? null;
        if (!targetId) return null;

        let guild = channel?.guild ?? null;
        if (!guild && guildId) {
            guild = await resolveGuild(guildId);
        }
        if (guild) {
            let fromGuild = guild.channels?.cache?.get(targetId) ?? null;
            if (!fromGuild && typeof guild.channels?.fetch === 'function') {
                fromGuild = await guild.channels.fetch(targetId).catch(() => null);
            }
            if (fromGuild?.isTextBased?.()) {
                return fromGuild;
            }
        }

        let fetched = null;
        if (client.channels && typeof client.channels.fetch === 'function') {
            fetched = await client.channels.fetch(targetId).catch(() => null);
        }
        if (fetched?.isTextBased?.()) {
            return fetched;
        }

        return null;
    }

    async function handleLevelUp({ guildId, userId, rule, context, totalXp, previousXp, level, levelDelta, xpAwarded }) {
        try {
            const guild = context?.guild ?? await resolveGuild(guildId);
            const member = context?.member ?? await guild?.members?.fetch?.(userId).catch(() => null);
            const user = member?.user ?? await client.users?.fetch?.(userId).catch(() => null);
            const mention = `<@${userId}>`;
            const displayName = member?.displayName
                ?? user?.globalName
                ?? user?.username
                ?? userId;
            const userTag = user?.tag ?? user?.username ?? userId;

            let announceChannel = null;
            if (rule?.levelUpChannelId) {
                announceChannel = await resolveTextChannel({ channelId: rule.levelUpChannelId, guildId });
            }
            if (!announceChannel) {
                announceChannel = await resolveTextChannel({
                    channel: context?.channel ?? null,
                    channelId: context?.channelId ?? null,
                    guildId
                });
            }
            if (!announceChannel) {
                announceChannel = await resolveTextChannel({
                    channelId: context?.originChannelId ?? null,
                    guildId
                });
            }

            const channelMention = announceChannel
                ? `<#${announceChannel.id}>`
                : (context?.channelId ? `<#${context.channelId}>` : '');

            const rendered = renderLevelUpMessage(rule?.levelUpMessage, {
                userMention: mention,
                userTag,
                displayName,
                level,
                previousLevel: Math.max(0, level - levelDelta),
                levelDelta,
                totalXp,
                guildName: guild?.name ?? '',
                channelMention
            });

            let success = null;
            if (announceChannel) {
                try {
                    await announceChannel.send({
                        content: rendered,
                        allowedMentions: { users: [userId] }
                    });
                    success = true;
                } catch (err) {
                    logger?.warn?.(`[xp] Failed to announce level ${level} for ${userId} in ${guildId}: ${err?.message ?? err}`);
                    success = false;
                }
            }

            let statusNote = '';
            if (success === false) {
                statusNote = ' (announcement failed)';
            } else if (success === null) {
                statusNote = ' (announcement skipped)';
            }
            logger?.info?.(`[xp] ${userTag} reached level ${level} in ${guildId}${statusNote}`);

            client.emit('squire:experience:log', {
                type: 'level-up',
                guildId,
                userId,
                level,
                levelDelta,
                totalXp,
                xpAwarded,
                previousXp,
                ruleId: rule?.id ?? null,
                ruleName: rule?.name ?? null,
                channelId: announceChannel?.id ?? null,
                sourceChannelId: context?.originChannelId ?? context?.channelId ?? null,
                sourceType: context?.type ?? null,
                message: rendered,
                success
            });
        } catch (err) {
            logger?.warn?.(`[xp] Level-up handling failed for ${guildId}/${userId}: ${err?.message ?? err}`);
        }
    }

    async function awardExperience({ guildId, userId, baseAmount, rule, context }) {
        if (!profiles) return;
        const awarded = calculateAward(baseAmount, rule);
        if (awarded <= 0) return;
        try {
            const entry = fetchOrCreateProfile(guildId, userId);
            if (!entry) return;
            const previousXp = entry.xp || 0;
            const previousLevel = getLevelFromXp(previousXp);
            entry.xp = Math.max(0, previousXp + awarded);
            entry.updatedAt = Date.now();
            profiles.update(entry);
            const newLevel = getLevelFromXp(entry.xp);
            const levelDelta = newLevel - previousLevel;
            if (levelDelta > 0) {
                await handleLevelUp({
                    guildId,
                    userId,
                    rule,
                    context,
                    totalXp: entry.xp,
                    previousXp,
                    level: newLevel,
                    levelDelta,
                    xpAwarded: awarded
                });
            }
        } catch (err) {
            logger?.warn?.(`[xp] Failed to award XP for ${guildId}/${userId}: ${err?.message ?? err}`);
        }
    }

    function resetProfile(guildId, userId) {
        if (!profiles) return;
        const entry = profiles.findOne({ guildId, userId });
        if (!entry) return;
        entry.xp = 0;
        entry.updatedAt = Date.now();
        profiles.update(entry);
    }

    function cleanupVoiceSession(key) {
        voiceSessions.delete(key);
    }

    function updateVoiceSession(state) {
        const guildId = state.guild?.id;
        if (!guildId) return;
        const rule = getRule(guildId);
        const key = `${guildId}:${state.id}`;
        if (!shouldTrackVoiceState(state, rule)) {
            cleanupVoiceSession(key);
            return;
        }
        const now = Date.now();
        const entry = voiceSessions.get(key);
        if (entry) {
            entry.channelId = state.channelId;
            entry.lastUpdate = now;
        } else {
            voiceSessions.set(key, {
                channelId: state.channelId,
                startedAt: now,
                lastAwardAt: now
            });
        }
    }

    function finalizeVoiceSession(state) {
        const guildId = state.guild?.id;
        if (!guildId) return;
        const key = `${guildId}:${state.id}`;
        const entry = voiceSessions.get(key);
        if (!entry) return;
        const rule = getRule(guildId);
        if (!rule?.voice?.enabled) {
            cleanupVoiceSession(key);
            return;
        }
        const now = Date.now();
        const elapsedMs = now - (entry.lastAwardAt ?? entry.startedAt ?? now);
        const minutes = Math.floor(elapsedMs / 60000);
        if (minutes > 0) {
            const baseAmount = minutes * (rule.voice?.amountPerMinute ?? DEFAULT_VOICE_AMOUNT);
            void awardExperience({
                guildId,
                userId: state.id,
                baseAmount,
                rule,
                context: {
                    type: 'voice',
                    guild: state.guild ?? null,
                    member: state.member ?? null,
                    originChannelId: state.channelId ?? entry.channelId ?? null,
                    channelId: rule.levelUpChannelId ?? null
                }
            });
        }
        cleanupVoiceSession(key);
    }

    client.on('messageCreate', async (message) => {
        try {
            if (!message.inGuild?.() || !message.guildId) return;
        } catch {
            if (!message.guildId) return;
        }
        const rule = getRule(message.guildId);
        if (!rule || !shouldAwardMessageXp({ message, rule })) return;

        const member = message.member ?? await message.guild?.members?.fetch?.(message.author.id).catch(() => null);
        if (memberHasBlacklistedRole(member, rule)) return;

        const cooldown = rule.message.cooldownSeconds * 1000;
        const { key, last } = getCooldownMap(messageCooldowns, message.guildId, message.author.id);
        const now = Date.now();
        if (typeof last === 'number' && now - last < cooldown) {
            return;
        }
        updateCooldown(messageCooldowns, key, now);
        await awardExperience({
            guildId: message.guildId,
            userId: message.author.id,
            baseAmount: rule.message.amount,
            rule,
            context: {
                type: 'message',
                channel: message.channel ?? null,
                channelId: message.channel?.id ?? null,
                originChannelId: message.channel?.id ?? null,
                guild: message.guild ?? null,
                member,
                messageId: message.id
            }
        });
    });

    client.on('messageReactionAdd', async (reaction, user) => {
        try {
            if (reaction.partial) {
                await reaction.fetch();
            }
        } catch {
            return;
        }
        const message = reaction.message;
        if (!message?.guildId) return;
        const rule = getRule(message.guildId);
        if (!rule) return;

        const guild = message.guild ?? await client.guilds.fetch(message.guildId).catch(() => null);
        const member = guild ? await guild.members.fetch(user.id).catch(() => null) : null;
        if (!shouldAwardReactionXp({ reaction, user, rule, member })) return;

        const cooldown = (rule.reaction.cooldownSeconds ?? DEFAULT_REACTION_COOLDOWN) * 1000;
        const { key, last } = getCooldownMap(reactionCooldowns, message.guildId, user.id);
        const now = Date.now();
        if (typeof last === 'number' && now - last < cooldown) {
            return;
        }
        updateCooldown(reactionCooldowns, key, now);
        await awardExperience({
            guildId: message.guildId,
            userId: user.id,
            baseAmount: rule.reaction.amount,
            rule,
            context: {
                type: 'reaction',
                channel: message.channel ?? null,
                channelId: message.channel?.id ?? null,
                originChannelId: message.channel?.id ?? null,
                guild: message.guild ?? guild ?? null,
                member,
                messageId: message.id,
                emoji: reaction.emoji?.toString?.() ?? null
            }
        });
    });

    client.on('voiceStateUpdate', (oldState, newState) => {
        if (oldState?.channelId && oldState.channelId !== newState?.channelId) {
            finalizeVoiceSession(oldState);
        }
        if (!newState?.channelId) {
            finalizeVoiceSession(oldState);
            return;
        }
        updateVoiceSession(newState);
    });

    setInterval(() => {
        for (const [key, entry] of voiceSessions.entries()) {
            const [guildId, userId] = key.split(':');
            const rule = getRule(guildId);
            if (!rule?.voice?.enabled) {
                voiceSessions.delete(key);
                continue;
            }
            const now = Date.now();
            const elapsedMs = now - (entry.lastAwardAt ?? entry.startedAt ?? now);
            if (elapsedMs < 60000) {
                continue;
            }
            const minutes = Math.floor(elapsedMs / 60000);
            if (minutes <= 0) continue;
            const baseAmount = minutes * (rule.voice?.amountPerMinute ?? DEFAULT_VOICE_AMOUNT);
            void awardExperience({
                guildId,
                userId,
                baseAmount,
                rule,
                context: {
                    type: 'voice',
                    guild: null,
                    member: null,
                    originChannelId: entry.channelId ?? null,
                    channelId: rule.levelUpChannelId ?? null
                }
            });
            entry.lastAwardAt = now;
        }
    }, 30000).unref?.();

    client.on('guildMemberRemove', (member) => {
        const guildId = member.guild?.id;
        if (!guildId) return;
        const rule = getRule(guildId);
        if (!rule?.resets?.onLeave) return;
        resetProfile(guildId, member.id);
    });

    client.on('guildBanAdd', (ban) => {
        const guildId = ban.guild?.id;
        if (!guildId) return;
        const rule = getRule(guildId);
        if (!rule?.resets?.onBan) return;
        resetProfile(guildId, ban.user?.id ?? null);
    });

    client.on('interactionCreate', async (interaction) => {
        if (!interaction.isChatInputCommand() || interaction.commandName !== 'xp') return;
        if (!interaction.inGuild?.() || !interaction.guildId) {
            await interaction.reply({ content: 'This command can only be used inside a server.', ephemeral: true });
            return;
        }
        if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
            await interaction.reply({ content: 'You need **Manage Server** permission to manage XP.', ephemeral: true });
            return;
        }
        const sub = interaction.options.getSubcommand();
        if (sub === 'set') {
            const target = interaction.options.getMember('member')
                ?? await interaction.guild.members.fetch(interaction.options.getUser('member')?.id ?? '').catch(() => null);
            if (!target) {
                await interaction.reply({ content: 'Unable to resolve that member in this server.', ephemeral: true });
                return;
            }
            const amount = interaction.options.getInteger('amount');
            const newValue = setProfileXp(interaction.guildId, target.id, amount);
            await interaction.reply({
                content: `Set **${target.user?.tag ?? target.id}** to **${newValue}** XP.`,
                ephemeral: true
            });
        }
    });

    client.on('squire:configUpdated', (nextConfig) => {
        activeConfig = { ...nextConfig, experience: normalizeExperienceConfig(nextConfig.experience) };
        for (const [key] of voiceSessions.entries()) {
            const [guildId] = key.split(':');
            const rule = getRule(guildId);
            if (!rule?.voice?.enabled) {
                voiceSessions.delete(key);
            }
        }
    });

    return {
        normalizeExperienceConfig,
        normalizeGuildConfig,
        normalizeRule
    };
}

export {
    normalizeExperienceConfig,
    normalizeGuildConfig,
    normalizeRule
};
