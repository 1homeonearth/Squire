// src/features/experience/setup.js
// Setup panel integration for the experience system.

import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    ModalBuilder,
    StringSelectMenuBuilder,
    TextInputBuilder,
    TextInputStyle
} from 'discord.js';
import { randomUUID } from 'node:crypto';

import {
    formatCategory,
    formatChannel,
    formatRole,
    truncateName
} from '../setup/shared.js';
import {
    normalizeExperienceConfig,
    normalizeGuildConfig,
    normalizeRule
} from './index.js';

const MAX_RULES = 10;

export function createExperienceSetup({ panelStore, saveConfig }) {
    function prepareConfig(config) {
        if (!config.experience || typeof config.experience !== 'object') {
            config.experience = {};
        }
        config.experience = normalizeExperienceConfig(config.experience);
    }

    async function handleInteraction({ interaction, entry, config, client, key, logger }) {
        const availableGuildIds = entry?.availableGuildIds ?? config.mainServerIds ?? [];
        const currentGuildId = entry?.guildId && availableGuildIds.includes(entry.guildId)
            ? entry.guildId
            : availableGuildIds[0] ?? null;
        const ensureGuildConfig = (guildId) => {
            if (!guildId) return null;
            if (!config.experience || typeof config.experience !== 'object') {
                config.experience = {};
            }
            const existing = config.experience[guildId];
            const normalized = normalizeGuildConfig(existing || {});
            config.experience[guildId] = normalized;
            return normalized;
        };

        const currentGuildConfig = ensureGuildConfig(currentGuildId);
        const currentRuleId = entry?.context?.ruleId
            && currentGuildConfig?.rules?.some(rule => rule.id === entry.context.ruleId)
            ? entry.context.ruleId
            : currentGuildConfig?.activeRuleId ?? currentGuildConfig?.rules?.[0]?.id ?? null;

        const storePanelState = (message, context = {}, guildOverride = currentGuildId) => {
            panelStore.set(key, {
                message,
                guildId: guildOverride,
                mode: 'overview',
                context: { ruleId: currentRuleId, ...context },
                availableGuildIds
            });
        };

        const refreshView = async (guildId = currentGuildId, ruleId = currentRuleId) => {
            const view = await buildExperienceView({
                config,
                client,
                guildId,
                availableGuildIds,
                selectedRuleId: ruleId
            });
            const message = interaction.isModalSubmit()
                ? await interaction.editReply(view)
                : await (interaction.deferred || interaction.replied
                    ? interaction.editReply(view)
                    : interaction.update(view));
            storePanelState(message, { ruleId }, guildId);
        };

        const ensureRule = () => {
            if (!currentGuildId) return null;
            const guildCfg = ensureGuildConfig(currentGuildId);
            if (!guildCfg) return null;
            const rule = guildCfg.rules?.find(r => r.id === currentRuleId) ?? guildCfg.rules?.[0] ?? null;
            if (!rule) {
                const newRule = normalizeRule({
                    id: randomUUID(),
                    name: 'Rule 1'
                });
                guildCfg.rules = [newRule];
                guildCfg.activeRuleId = newRule.id;
                saveConfig(config, logger);
                return newRule;
            }
            return rule;
        };

        if (interaction.isStringSelectMenu()) {
            const [, , action] = interaction.customId.split(':');
            if (action === 'guild') {
                const choice = interaction.values?.[0] ?? null;
                const nextGuild = choice && choice !== '__none__' ? choice : null;
                const normalized = nextGuild ? ensureGuildConfig(nextGuild) : null;
                const ruleId = normalized?.activeRuleId ?? normalized?.rules?.[0]?.id ?? null;
                const view = await buildExperienceView({
                    config,
                    client,
                    guildId: nextGuild,
                    availableGuildIds,
                    selectedRuleId: ruleId
                });
                const message = await interaction.update(view);
                panelStore.set(key, {
                    message,
                    guildId: nextGuild,
                    mode: 'overview',
                    context: { ruleId },
                    availableGuildIds
                });
                return;
            }
            if (action === 'rule') {
                if (!currentGuildConfig) {
                    await interaction.reply({ content: 'Select a server first.', ephemeral: true });
                    return;
                }
                const choice = interaction.values?.[0] ?? null;
                const rule = currentGuildConfig.rules?.find(r => r.id === choice) ?? currentGuildConfig.rules?.[0] ?? null;
                if (rule) {
                    currentGuildConfig.activeRuleId = rule.id;
                    saveConfig(config, logger);
                }
                const view = await buildExperienceView({
                    config,
                    client,
                    guildId: currentGuildId,
                    availableGuildIds,
                    selectedRuleId: rule?.id ?? null
                });
                const message = await interaction.update(view);
                storePanelState(message, { ruleId: rule?.id ?? null });
                return;
            }
        }

        if (interaction.isButton()) {
            const [, , action] = interaction.customId.split(':');
            if (action === 'addRule') {
                if (!currentGuildId) {
                    await interaction.reply({ content: 'Select a server first.', ephemeral: true });
                    return;
                }
                const guildCfg = ensureGuildConfig(currentGuildId);
                if (guildCfg.rules.length >= MAX_RULES) {
                    await interaction.reply({ content: `You can only create up to ${MAX_RULES} rule sets.`, ephemeral: true });
                    return;
                }
                const newRule = normalizeRule({
                    id: randomUUID(),
                    name: `Rule ${guildCfg.rules.length + 1}`
                });
                guildCfg.rules.push(newRule);
                guildCfg.activeRuleId = newRule.id;
                saveConfig(config, logger);
                await interaction.deferUpdate();
                await refreshView(currentGuildId, newRule.id);
                return;
            }

            if (action === 'deleteRule') {
                if (!currentGuildConfig || !currentRuleId) {
                    await interaction.reply({ content: 'Nothing to delete.', ephemeral: true });
                    return;
                }
                if (currentGuildConfig.rules.length <= 1) {
                    await interaction.reply({ content: 'Keep at least one rule set for this server.', ephemeral: true });
                    return;
                }
                currentGuildConfig.rules = currentGuildConfig.rules.filter(rule => rule.id !== currentRuleId);
                currentGuildConfig.activeRuleId = currentGuildConfig.rules[0].id;
                saveConfig(config, logger);
                await interaction.deferUpdate();
                await refreshView(currentGuildId, currentGuildConfig.activeRuleId);
                return;
            }

            if (!currentGuildId) {
                await interaction.reply({ content: 'Select a server to configure first.', ephemeral: true });
                return;
            }
            const rule = ensureRule();
            if (!rule) {
                await interaction.reply({ content: 'Unable to find that rule set.', ephemeral: true });
                return;
            }

            const toggleMap = {
                toggleMessage: () => { rule.message.enabled = !rule.message.enabled; },
                toggleVoice: () => { rule.voice.enabled = !rule.voice.enabled; },
                toggleReaction: () => { rule.reaction.enabled = !rule.reaction.enabled; },
                toggleResetLeave: () => { rule.resets.onLeave = !rule.resets.onLeave; },
                toggleResetBan: () => { rule.resets.onBan = !rule.resets.onBan; },
                toggleIgnoreMuted: () => { rule.voice.ignoreMutedOrDeafened = !rule.voice.ignoreMutedOrDeafened; },
                toggleIgnoreAlone: () => { rule.voice.ignoreAlone = !rule.voice.ignoreAlone; }
            };

            if (toggleMap[action]) {
                toggleMap[action]();
                saveConfig(config, logger);
                const view = await buildExperienceView({
                    config,
                    client,
                    guildId: currentGuildId,
                    availableGuildIds,
                    selectedRuleId: rule.id
                });
                const message = await interaction.update(view);
                storePanelState(message, { ruleId: rule.id });
                return;
            }

            if (action === 'editRewards') {
                const modal = new ModalBuilder()
                .setCustomId('setup:experience:modal:rewards')
                .setTitle('XP rewards')
                .addComponents(
                    new ActionRowBuilder().addComponents(
                        new TextInputBuilder()
                        .setCustomId('messageAmount')
                        .setLabel('Message XP amount')
                        .setStyle(TextInputStyle.Short)
                        .setRequired(true)
                        .setValue(String(rule.message.amount))
                    ),
                    new ActionRowBuilder().addComponents(
                        new TextInputBuilder()
                        .setCustomId('messageCooldown')
                        .setLabel('Message cooldown (seconds)')
                        .setStyle(TextInputStyle.Short)
                        .setRequired(true)
                        .setValue(String(rule.message.cooldownSeconds))
                    ),
                    new ActionRowBuilder().addComponents(
                        new TextInputBuilder()
                        .setCustomId('voiceAmount')
                        .setLabel('Voice XP per minute')
                        .setStyle(TextInputStyle.Short)
                        .setRequired(true)
                        .setValue(String(rule.voice.amountPerMinute))
                    ),
                    new ActionRowBuilder().addComponents(
                        new TextInputBuilder()
                        .setCustomId('reactionAmount')
                        .setLabel('Reaction XP amount')
                        .setStyle(TextInputStyle.Short)
                        .setRequired(true)
                        .setValue(String(rule.reaction.amount))
                    ),
                    new ActionRowBuilder().addComponents(
                        new TextInputBuilder()
                        .setCustomId('reactionCooldown')
                        .setLabel('Reaction cooldown (seconds)')
                        .setStyle(TextInputStyle.Short)
                        .setRequired(true)
                        .setValue(String(rule.reaction.cooldownSeconds))
                    )
                );
                storePanelState(entry?.message ?? null, { ruleId: rule.id }, currentGuildId);
                await interaction.showModal(modal);
                return;
            }

            if (action === 'editGeneral') {
                const modal = new ModalBuilder()
                .setCustomId('setup:experience:modal:general')
                .setTitle('General XP settings')
                .addComponents(
                    new ActionRowBuilder().addComponents(
                        new TextInputBuilder()
                        .setCustomId('multiplier')
                        .setLabel('Multiplier (e.g. 1.00)')
                        .setStyle(TextInputStyle.Short)
                        .setRequired(true)
                        .setValue(rule.multiplier.toFixed(2))
                    ),
                    new ActionRowBuilder().addComponents(
                        new TextInputBuilder()
                        .setCustomId('levelUpChannel')
                        .setLabel('Level up channel ID (optional)')
                        .setStyle(TextInputStyle.Short)
                        .setRequired(false)
                        .setValue(rule.levelUpChannelId ?? '')
                    ),
                    new ActionRowBuilder().addComponents(
                        new TextInputBuilder()
                        .setCustomId('customUrl')
                        .setLabel('Leaderboard custom URL')
                        .setStyle(TextInputStyle.Short)
                        .setRequired(false)
                        .setValue(rule.leaderboard.customUrl ?? '')
                    ),
                    new ActionRowBuilder().addComponents(
                        new TextInputBuilder()
                        .setCustomId('autoChannel')
                        .setLabel('Auto leaderboard channel ID')
                        .setStyle(TextInputStyle.Short)
                        .setRequired(false)
                        .setValue(rule.leaderboard.autoChannelId ?? '')
                    ),
                    new ActionRowBuilder().addComponents(
                        new TextInputBuilder()
                        .setCustomId('statCooldown')
                        .setLabel('Stat cooldown (seconds)')
                        .setStyle(TextInputStyle.Short)
                        .setRequired(true)
                        .setValue(String(rule.leaderboard.statCooldownSeconds))
                    )
                );
                storePanelState(entry?.message ?? null, { ruleId: rule.id }, currentGuildId);
                await interaction.showModal(modal);
                return;
            }

            if (action === 'editDisplay') {
                const modal = new ModalBuilder()
                .setCustomId('setup:experience:modal:display')
                .setTitle('Leaderboard display')
                .addComponents(
                    new ActionRowBuilder().addComponents(
                        new TextInputBuilder()
                        .setCustomId('showAvatar')
                        .setLabel('Show avatar? (yes/no)')
                        .setStyle(TextInputStyle.Short)
                        .setRequired(true)
                        .setValue(rule.leaderboard.showAvatar ? 'yes' : 'no')
                    ),
                    new ActionRowBuilder().addComponents(
                        new TextInputBuilder()
                        .setCustomId('stackRoles')
                        .setLabel('Stack roles? (yes/no)')
                        .setStyle(TextInputStyle.Short)
                        .setRequired(true)
                        .setValue(rule.leaderboard.stackRoles ? 'yes' : 'no')
                    ),
                    new ActionRowBuilder().addComponents(
                        new TextInputBuilder()
                        .setCustomId('giveRoleOnJoin')
                        .setLabel('Give role on join? (yes/no)')
                        .setStyle(TextInputStyle.Short)
                        .setRequired(true)
                        .setValue(rule.leaderboard.giveRoleOnJoin ? 'yes' : 'no')
                    )
                );
                storePanelState(entry?.message ?? null, { ruleId: rule.id }, currentGuildId);
                await interaction.showModal(modal);
                return;
            }

            if (action === 'editBlacklists') {
                const modal = new ModalBuilder()
                .setCustomId('setup:experience:modal:blacklists')
                .setTitle('Blacklist settings')
                .addComponents(
                    new ActionRowBuilder().addComponents(
                        new TextInputBuilder()
                        .setCustomId('xpChannels')
                        .setLabel('XP channel blacklist (IDs or mentions)')
                        .setStyle(TextInputStyle.Paragraph)
                        .setRequired(false)
                        .setValue(rule.channelBlacklist.join('\n'))
                    ),
                    new ActionRowBuilder().addComponents(
                        new TextInputBuilder()
                        .setCustomId('xpRoles')
                        .setLabel('XP roles blacklist (IDs or mentions)')
                        .setStyle(TextInputStyle.Paragraph)
                        .setRequired(false)
                        .setValue(rule.roleBlacklist.join('\n'))
                    ),
                    new ActionRowBuilder().addComponents(
                        new TextInputBuilder()
                        .setCustomId('blockedChannels')
                        .setLabel('Blocked channels (IDs or mentions)')
                        .setStyle(TextInputStyle.Paragraph)
                        .setRequired(false)
                        .setValue((rule.blacklist.channels ?? []).join('\n'))
                    ),
                    new ActionRowBuilder().addComponents(
                        new TextInputBuilder()
                        .setCustomId('blockedCategories')
                        .setLabel('Blocked categories (IDs)')
                        .setStyle(TextInputStyle.Paragraph)
                        .setRequired(false)
                        .setValue((rule.blacklist.categories ?? []).join('\n'))
                    )
                );
                storePanelState(entry?.message ?? null, { ruleId: rule.id }, currentGuildId);
                await interaction.showModal(modal);
                return;
            }

            if (action === 'useCurrentChannel') {
                if (!interaction.channelId) {
                    await interaction.reply({ content: 'Cannot detect current channel.', ephemeral: true });
                    return;
                }
                rule.levelUpChannelId = interaction.channelId;
                saveConfig(config, logger);
                const view = await buildExperienceView({
                    config,
                    client,
                    guildId: currentGuildId,
                    availableGuildIds,
                    selectedRuleId: rule.id
                });
                const message = await interaction.update(view);
                storePanelState(message, { ruleId: rule.id });
                return;
            }
        }

        if (interaction.isModalSubmit()) {
            const [, , type] = interaction.customId.split(':');
            const guildId = entry?.guildId ?? currentGuildId;
            const guildCfg = ensureGuildConfig(guildId);
            const ruleId = entry?.context?.ruleId ?? guildCfg?.activeRuleId ?? guildCfg?.rules?.[0]?.id ?? null;
            const rule = guildCfg?.rules?.find(r => r.id === ruleId) ?? null;
            if (!guildId || !rule) {
                await interaction.reply({ content: 'The selected rule set is no longer available.', ephemeral: true });
                return;
            }

            const updateNumbers = (value, fallback, min, max) => {
                const num = Number.parseInt(value, 10);
                if (Number.isNaN(num)) return fallback;
                return Math.max(min, Math.min(max, num));
            };

            const parseIdList = (value) => {
                if (!value) return [];
                return value
                .split(/[,\s\n]+/g)
                .map(v => v.trim())
                .filter(Boolean)
                .map(cleanSnowflake)
                .filter(Boolean);
            };

            const parseBoolean = (value, fallback) => {
                if (typeof value !== 'string') return fallback;
                const normalized = value.trim().toLowerCase();
                if (!normalized) return fallback;
                if (['yes', 'true', 'y', 'enable', 'enabled', '1'].includes(normalized)) return true;
                if (['no', 'false', 'n', 'disable', 'disabled', '0'].includes(normalized)) return false;
                return fallback;
            };

            if (type === 'rewards') {
                const amount = interaction.fields.getTextInputValue('messageAmount');
                const cooldown = interaction.fields.getTextInputValue('messageCooldown');
                rule.message.amount = updateNumbers(amount, rule.message.amount, 0, 10000);
                rule.message.cooldownSeconds = updateNumbers(cooldown, rule.message.cooldownSeconds, 0, 86400);
                const voiceAmount = interaction.fields.getTextInputValue('voiceAmount');
                rule.voice.amountPerMinute = updateNumbers(voiceAmount, rule.voice.amountPerMinute, 0, 10000);
                const reactionAmount = interaction.fields.getTextInputValue('reactionAmount');
                const reactionCooldown = interaction.fields.getTextInputValue('reactionCooldown');
                rule.reaction.amount = updateNumbers(reactionAmount, rule.reaction.amount, 0, 10000);
                rule.reaction.cooldownSeconds = updateNumbers(reactionCooldown, rule.reaction.cooldownSeconds, 0, 86400);
            } else if (type === 'general') {
                const multiplier = interaction.fields.getTextInputValue('multiplier');
                const levelChannel = interaction.fields.getTextInputValue('levelUpChannel');
                const customUrl = interaction.fields.getTextInputValue('customUrl');
                const autoChannel = interaction.fields.getTextInputValue('autoChannel');
                const statCooldown = interaction.fields.getTextInputValue('statCooldown');
                const multiNum = Number(multiplier);
                if (!Number.isNaN(multiNum)) {
                    rule.multiplier = Math.max(0.01, Math.min(100, Math.round(multiNum * 100) / 100));
                }
                rule.levelUpChannelId = cleanSnowflake(levelChannel) ?? null;
                rule.leaderboard.customUrl = (customUrl ?? '').trim().slice(0, 100);
                rule.leaderboard.autoChannelId = cleanSnowflake(autoChannel) ?? null;
                rule.leaderboard.statCooldownSeconds = updateNumbers(statCooldown, rule.leaderboard.statCooldownSeconds, 0, 86400);
            } else if (type === 'display') {
                const showAvatar = interaction.fields.getTextInputValue('showAvatar');
                const stackRoles = interaction.fields.getTextInputValue('stackRoles');
                const giveRoleOnJoin = interaction.fields.getTextInputValue('giveRoleOnJoin');
                rule.leaderboard.showAvatar = parseBoolean(showAvatar, rule.leaderboard.showAvatar);
                rule.leaderboard.stackRoles = parseBoolean(stackRoles, rule.leaderboard.stackRoles);
                rule.leaderboard.giveRoleOnJoin = parseBoolean(giveRoleOnJoin, rule.leaderboard.giveRoleOnJoin);
            } else if (type === 'blacklists') {
                const xpChannels = parseIdList(interaction.fields.getTextInputValue('xpChannels'));
                const xpRoles = parseIdList(interaction.fields.getTextInputValue('xpRoles'));
                const blockedChannels = parseIdList(interaction.fields.getTextInputValue('blockedChannels'));
                const blockedCategories = parseIdList(interaction.fields.getTextInputValue('blockedCategories'));
                rule.channelBlacklist = xpChannels;
                rule.roleBlacklist = xpRoles;
                rule.blacklist.channels = blockedChannels;
                rule.blacklist.categories = blockedCategories;
            }
            saveConfig(config, logger);
            await interaction.deferReply({ ephemeral: true });
            await refreshView(guildId, rule.id);
            return;
        }
    }

    return { prepareConfig, handleInteraction, buildView: buildExperienceView };
}

function cleanSnowflake(value) {
    if (!value) return null;
    const trimmed = String(value).trim();
    if (!trimmed) return null;
    const normalized = trimmed.replace(/[^0-9]/g, '');
    if (!normalized) return null;
    return /^\d{5,30}$/.test(normalized) ? normalized : null;
}

async function buildExperienceView({ config, client, guildId, availableGuildIds, selectedRuleId }) {
    const components = [];
    const guild = guildId ? await client.guilds.fetch(guildId).catch(() => null) : null;
    const guildCfg = guildId ? config.experience?.[guildId] : null;
    const rules = guildCfg?.rules ?? [];
    const activeRule = rules.find(rule => rule.id === selectedRuleId) ?? rules[0] ?? null;

    const embed = new EmbedBuilder()
    .setTitle('Experience Points configuration')
    .setDescription('Manage experience points rules, rewards, and leaderboards for this server.')
    .addFields(
        {
            name: 'Server',
            value: guild ? `${guild.name} (${guild.id})` : 'Select a server to configure.',
            inline: false
        },
        {
            name: 'Rule set',
            value: activeRule ? `${activeRule.name} (${activeRule.id})` : 'No rule sets yet. Create one below.',
            inline: false
        }
    );

    if (activeRule) {
        embed.addFields(
            {
                name: 'Messages',
                value: `Status: **${activeRule.message.enabled ? 'Enabled' : 'Disabled'}**\nXP per message: **${activeRule.message.amount}**\nCooldown: **${activeRule.message.cooldownSeconds}s**`,
                inline: true
            },
            {
                name: 'Voice',
                value: `Status: **${activeRule.voice.enabled ? 'Enabled' : 'Disabled'}**\nIgnore muted: **${activeRule.voice.ignoreMutedOrDeafened ? 'Yes' : 'No'}**\nIgnore alone: **${activeRule.voice.ignoreAlone ? 'Yes' : 'No'}**\nXP per minute: **${activeRule.voice.amountPerMinute}**`,
                inline: true
            },
            {
                name: 'Reactions',
                value: `Status: **${activeRule.reaction.enabled ? 'Enabled' : 'Disabled'}**\nXP per reaction: **${activeRule.reaction.amount}**\nCooldown: **${activeRule.reaction.cooldownSeconds}s**`,
                inline: true
            },
            {
                name: 'Resets',
                value: `Reset on leave: **${activeRule.resets.onLeave ? 'Yes' : 'No'}**\nReset on ban: **${activeRule.resets.onBan ? 'Yes' : 'No'}**`,
                inline: true
            },
            {
                name: 'Leaderboard',
                value: `Multiplier: **x${activeRule.multiplier.toFixed(2)}**\nLevel-up channel: ${formatMaybeChannel(guild, activeRule.levelUpChannelId)}\nAuto leaderboard: ${formatMaybeChannel(guild, activeRule.leaderboard.autoChannelId)}\nCustom URL: ${activeRule.leaderboard.customUrl || 'Not set'}\nShow avatar: **${activeRule.leaderboard.showAvatar ? 'Yes' : 'No'}**\nStack roles: **${activeRule.leaderboard.stackRoles ? 'Yes' : 'No'}**\nGive role on rejoin: **${activeRule.leaderboard.giveRoleOnJoin ? 'Yes' : 'No'}**\nStat cooldown: **${activeRule.leaderboard.statCooldownSeconds}s**`,
                inline: false
            },
            {
                name: 'XP channel blacklist',
                value: renderChannelList(guild, activeRule.channelBlacklist) || 'None',
                inline: true
            },
            {
                name: 'XP role blacklist',
                value: renderRoleList(guild, activeRule.roleBlacklist) || 'None',
                inline: true
            },
            {
                name: 'Blocked channels/categories',
                value: formatBlocked(guild, activeRule.blacklist) || 'None',
                inline: false
            }
        );
    }

    const guildOptionsRow = new ActionRowBuilder().addComponents(
        buildGuildSelector({ availableGuildIds, guildId, client })
    );
    components.push(guildOptionsRow);

    components.push(new ActionRowBuilder().addComponents(buildRuleSelector({ rules, selectedRuleId })));

    const ruleActionsRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('setup:experience:addRule').setLabel('Add rule set').setStyle(ButtonStyle.Success).setDisabled(!guildId || rules.length >= MAX_RULES),
        new ButtonBuilder().setCustomId('setup:experience:deleteRule').setLabel('Delete rule set').setStyle(ButtonStyle.Danger).setDisabled(!guildId || !selectedRuleId || rules.length <= 1),
        new ButtonBuilder().setCustomId('setup:experience:useCurrentChannel').setLabel('Use current channel').setStyle(ButtonStyle.Secondary).setDisabled(!guildId || !selectedRuleId),
        new ButtonBuilder().setCustomId('setup:experience:editGeneral').setLabel('Edit general').setStyle(ButtonStyle.Primary).setDisabled(!guildId || !selectedRuleId),
        new ButtonBuilder().setCustomId('setup:navigate:home').setLabel('Back to home').setStyle(ButtonStyle.Secondary)
    );
    components.push(ruleActionsRow);

    const toggleRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('setup:experience:toggleMessage').setLabel('Toggle message XP').setStyle(ButtonStyle.Secondary).setDisabled(!guildId || !selectedRuleId),
        new ButtonBuilder().setCustomId('setup:experience:toggleVoice').setLabel('Toggle voice XP').setStyle(ButtonStyle.Secondary).setDisabled(!guildId || !selectedRuleId),
        new ButtonBuilder().setCustomId('setup:experience:toggleReaction').setLabel('Toggle reaction XP').setStyle(ButtonStyle.Secondary).setDisabled(!guildId || !selectedRuleId),
        new ButtonBuilder().setCustomId('setup:experience:toggleResetLeave').setLabel('Reset on leave').setStyle(ButtonStyle.Secondary).setDisabled(!guildId || !selectedRuleId),
        new ButtonBuilder().setCustomId('setup:experience:toggleResetBan').setLabel('Reset on ban').setStyle(ButtonStyle.Secondary).setDisabled(!guildId || !selectedRuleId)
    );
    components.push(toggleRow);

    const toggleRow2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('setup:experience:toggleIgnoreMuted').setLabel('Ignore muted').setStyle(ButtonStyle.Secondary).setDisabled(!guildId || !selectedRuleId),
        new ButtonBuilder().setCustomId('setup:experience:toggleIgnoreAlone').setLabel('Ignore alone').setStyle(ButtonStyle.Secondary).setDisabled(!guildId || !selectedRuleId),
        new ButtonBuilder().setCustomId('setup:experience:editRewards').setLabel('Edit rewards').setStyle(ButtonStyle.Primary).setDisabled(!guildId || !selectedRuleId),
        new ButtonBuilder().setCustomId('setup:experience:editBlacklists').setLabel('Edit blacklists').setStyle(ButtonStyle.Primary).setDisabled(!guildId || !selectedRuleId),
        new ButtonBuilder().setCustomId('setup:experience:editDisplay').setLabel('Edit display').setStyle(ButtonStyle.Primary).setDisabled(!guildId || !selectedRuleId)
    );
    components.push(toggleRow2);

    return { embeds: [embed], components };
}

function buildGuildSelector({ availableGuildIds, guildId, client }) {
    const menu = new StringSelectMenuBuilder()
    .setCustomId('setup:experience:guild')
    .setPlaceholder('Select a server…')
    .setMinValues(0)
    .setMaxValues(1);
    const options = [];
    for (const id of availableGuildIds.slice(0, 25)) {
        const guild = client.guilds.cache.get(id);
        const label = truncateName(guild?.name ?? id, 100);
        options.push({ label, description: `ID: ${id}`.slice(0, 100), value: id, default: id === guildId });
    }
    if (!options.length) {
        options.push({ label: 'No servers configured', value: '__none__', default: true });
    }
    menu.addOptions(options);
    return menu;
}

function buildRuleSelector({ rules, selectedRuleId }) {
    const menu = new StringSelectMenuBuilder()
    .setCustomId('setup:experience:rule')
    .setPlaceholder(rules.length ? 'Select rule set…' : 'Create a rule set')
    .setMinValues(0)
    .setMaxValues(1)
    .setDisabled(!rules.length);
    if (rules.length) {
        menu.addOptions(rules.slice(0, 25).map(rule => ({
            label: truncateName(rule.name ?? rule.id, 100),
            description: `ID: ${rule.id}`.slice(0, 100),
            value: rule.id,
            default: rule.id === selectedRuleId
        })));
    } else {
        menu.addOptions({ label: 'No rule sets yet', value: '__none__', default: true });
    }
    return menu;
}

function renderChannelList(guild, channelIds) {
    const list = Array.isArray(channelIds) ? channelIds : [];
    if (!list.length) return '';
    return list.map(id => formatMaybeChannel(guild, id)).join('\n');
}

function renderRoleList(guild, roleIds) {
    const list = Array.isArray(roleIds) ? roleIds : [];
    if (!list.length) return '';
    return list.map(id => {
        if (guild) {
            const role = guild.roles.cache.get(id);
            if (role) return formatRole(guild, role.id);
        }
        return `<@&${id}>`;
    }).join('\n');
}

function formatBlocked(guild, blacklist) {
    if (!blacklist || typeof blacklist !== 'object') return '';
    const channels = renderChannelList(guild, blacklist.channels);
    const categories = (Array.isArray(blacklist.categories) ? blacklist.categories : []).map(id => {
        if (guild) {
            const category = guild.channels.cache.get(id);
            if (category) return formatCategory(guild, category.id);
        }
        return `Category ${id}`;
    }).join('\n');
    const parts = [];
    if (channels) parts.push(`Channels:\n${channels}`);
    if (categories) parts.push(`Categories:\n${categories}`);
    return parts.join('\n\n');
}

function formatMaybeChannel(guild, channelId) {
    if (!channelId) return 'Not set';
    if (!guild) return `<#${channelId}>`;
    const channel = guild.channels.cache.get(channelId);
    if (channel) {
        return formatChannel(guild, channel.id);
    }
    return `<#${channelId}>`;
}
