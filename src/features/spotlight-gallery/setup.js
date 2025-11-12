// src/features/spotlight-gallery/setup.js
// Setup panel integration for the spotlight gallery module.
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

import {
    appendHomeButtonRow,
    collectTextChannels,
    formatChannel,
    sanitizeSnowflakeId,
    truncateName
} from '../setup/shared.js';

import {
    DEFAULT_EMOJIS,
    DEFAULT_THRESHOLD,
    normalizeEmojiList,
    normalizeSpotlightConfig,
    normalizeSpotlightGuildConfig
} from './index.js';

function ensureSpotlightRoot(config) {
    if (!config.spotlightGallery || typeof config.spotlightGallery !== 'object') {
        config.spotlightGallery = {};
    }
    return config.spotlightGallery;
}

function ensureGuildConfig(config, guildId) {
    const root = ensureSpotlightRoot(config);
    const existing = root[guildId];
    const normalized = normalizeSpotlightGuildConfig(existing ?? {});
    root[guildId] = normalized;
    return normalized;
}

function collectEligibleGuildIds(config) {
    return Array.isArray(config.mainServerIds) ? config.mainServerIds.slice() : [];
}

export function createSpotlightSetup({ panelStore, saveConfig, fetchGuild }) {
    function prepareConfig(config) {
        config.spotlightGallery = normalizeSpotlightConfig(config.spotlightGallery);
    }

    async function buildView({ config, client, guildId, guild, mode = 'default', availableGuildIds = [] }) {
        const embed = new EmbedBuilder()
        .setTitle('Spotlight gallery')
        .setColor(0xF1C40F);

        const components = [];

        const eligibleGuildIds = availableGuildIds.length ? availableGuildIds : collectEligibleGuildIds(config);
        const activeGuildId = guildId && eligibleGuildIds.includes(guildId)
            ? guildId
            : (eligibleGuildIds[0] ?? null);

        if (!eligibleGuildIds.length) {
            embed.setDescription('Add at least one main server in the overview before configuring the spotlight gallery.');
            appendHomeButtonRow(components);
            return { embeds: [embed], components };
        }

        const targetGuild = guild && guild.id === activeGuildId
            ? guild
            : (activeGuildId ? await fetchGuild(client, activeGuildId).catch(() => null) : null);

        const guildConfigs = normalizeSpotlightConfig(config.spotlightGallery);
        const current = guildConfigs[activeGuildId] ?? normalizeSpotlightGuildConfig({});

        embed.setDescription('Celebrate standout messages by reposting them once they reach the reaction threshold.');
        embed.addFields(
            {
                name: 'Status',
                value: current.enabled ? '✅ Enabled' : '⚪ Disabled',
                inline: true
            },
            {
                name: 'Highlight channel',
                value: current.channelId
                    ? formatChannel(targetGuild, current.channelId)
                    : 'Not configured',
                inline: true
            },
            {
                name: 'Reaction threshold',
                value: `${current.threshold} reaction${current.threshold === 1 ? '' : 's'}`,
                inline: true
            },
            {
                name: 'Allowed self-reactions',
                value: current.allowSelf ? '✅ Allowed' : '🚫 Ignored',
                inline: true
            },
            {
                name: 'Trigger emojis',
                value: current.emojis.length ? current.emojis.join(' ') : DEFAULT_EMOJIS.join(' '),
                inline: false
            }
        );

        const guildSelect = new StringSelectMenuBuilder()
        .setCustomId('setup:spotlight:guild')
        .setPlaceholder('Select server…')
        .setMinValues(1)
        .setMaxValues(1);

        const guildOptions = await Promise.all(eligibleGuildIds.slice(0, 25).map(async (id) => {
            const cached = client.guilds.cache.get(id);
            const resolved = cached ?? await fetchGuild(client, id).catch(() => null);
            const label = truncateName(resolved?.name ?? `Server ${id}`, 100);
            return { label, value: id, description: `ID: ${id}`.slice(0, 100), default: id === activeGuildId };
        }));

        if (guildOptions.length) {
            guildSelect.addOptions(guildOptions);
        } else {
            guildSelect.addOptions({ label: 'No servers available', value: 'noop', default: true });
            guildSelect.setDisabled(true);
        }

        components.push(new ActionRowBuilder().addComponents(guildSelect));

        if (mode === 'select-channel') {
            const channels = targetGuild ? await collectTextChannels(targetGuild) : [];
            const channelSelect = new StringSelectMenuBuilder()
            .setCustomId('setup:spotlight:channel')
            .setPlaceholder(channels.length ? 'Select highlight channel…' : 'No channels available')
            .setMinValues(1)
            .setMaxValues(1)
            .setDisabled(!channels.length);

            if (channels.length) {
                channelSelect.addOptions(channels.slice(0, 25).map((channel) => ({
                    label: truncateName(channel.name, 100),
                    value: channel.id,
                    description: `#${channel.name}`.slice(0, 100),
                    default: channel.id === current.channelId
                })));
            } else {
                channelSelect.addOptions({ label: 'No text channels available', value: 'noop', default: true });
            }

            components.push(new ActionRowBuilder().addComponents(channelSelect));
            components.push(new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                .setCustomId('setup:spotlight:clearChannel')
                .setLabel('Clear highlight channel')
                .setStyle(ButtonStyle.Danger)
                .setDisabled(!current.channelId),
                new ButtonBuilder()
                .setCustomId('setup:spotlight:returnDefault')
                .setLabel('Done')
                .setStyle(ButtonStyle.Secondary)
            ));
        } else {
            components.push(new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                .setCustomId('setup:spotlight:toggle')
                .setLabel(current.enabled ? 'Disable module' : 'Enable module')
                .setStyle(current.enabled ? ButtonStyle.Danger : ButtonStyle.Success),
                new ButtonBuilder()
                .setCustomId('setup:spotlight:openChannel')
                .setLabel(current.channelId ? 'Change channel' : 'Set channel')
                .setStyle(ButtonStyle.Primary)
                .setDisabled(!activeGuildId),
                new ButtonBuilder()
                .setCustomId('setup:spotlight:emojis')
                .setLabel('Edit emojis')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(!activeGuildId),
                new ButtonBuilder()
                .setCustomId('setup:spotlight:threshold')
                .setLabel('Set threshold')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(!activeGuildId)
            ));

            components.push(new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                .setCustomId('setup:spotlight:self')
                .setLabel(current.allowSelf ? 'Disallow self-reactions' : 'Allow self-reactions')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(!activeGuildId),
                new ButtonBuilder()
                .setCustomId('setup:spotlight:refresh')
                .setLabel('Refresh view')
                .setStyle(ButtonStyle.Secondary)
            ));
        }

        appendHomeButtonRow(components);

        return {
            embeds: [embed],
            components,
            activeGuildId,
            mode
        };
    }

    async function handleInteraction({ interaction, entry, config, client, key, logger }) {
        const availableGuildIds = Array.isArray(entry?.availableGuildIds) && entry.availableGuildIds.length
            ? entry.availableGuildIds
            : collectEligibleGuildIds(config);

        const storedGuildId = entry?.guildId ?? null;
        const currentMode = entry?.mode ?? 'default';
        const activeGuildId = storedGuildId && availableGuildIds.includes(storedGuildId)
            ? storedGuildId
            : (availableGuildIds[0] ?? null);

        const getGuild = async (guildId) => guildId ? await fetchGuild(client, guildId).catch(() => null) : null;

        const persistState = (message, overrides = {}) => {
            panelStore.set(key, {
                message,
                guildId: overrides.guildId ?? activeGuildId ?? null,
                mode: overrides.mode ?? currentMode,
                context: overrides.context ?? {},
                availableGuildIds
            });
        };

        const refreshState = async (overrides = {}) => {
            const state = panelStore.get(key) ?? {};
            const guildId = overrides.guildId ?? state.guildId ?? activeGuildId ?? null;
            const mode = overrides.mode ?? state.mode ?? 'default';
            const messageRef = state.message;
            if (!messageRef) return;
            const guild = guildId ? await fetchGuild(client, guildId).catch(() => null) : null;
            const available = overrides.availableGuildIds ?? state.availableGuildIds ?? availableGuildIds;
            const view = await buildView({ config, client, guildId, guild, mode, availableGuildIds: available });
            try {
                const message = await messageRef.edit({ embeds: view.embeds, components: view.components });
                panelStore.set(key, {
                    message,
                    guildId: view.activeGuildId ?? guildId,
                    mode: view.mode ?? mode,
                    context: overrides.context ?? {},
                    availableGuildIds: available
                });
            } catch {}
        };

        if (interaction.isStringSelectMenu()) {
            if (interaction.customId === 'setup:spotlight:guild') {
                const choice = interaction.values?.[0] ?? null;
                if (!choice || choice === 'noop') {
                    await interaction.deferUpdate().catch(() => {});
                    return;
                }
                const sanitized = sanitizeSnowflakeId(choice);
                const guildId = sanitized && availableGuildIds.includes(sanitized)
                    ? sanitized
                    : (availableGuildIds[0] ?? null);
                const guild = guildId ? await getGuild(guildId) : null;
                const view = await buildView({ config, client, guildId, guild, mode: 'default', availableGuildIds });
                const message = await interaction.update({ embeds: view.embeds, components: view.components });
                panelStore.set(key, {
                    message,
                    guildId: view.activeGuildId ?? guildId,
                    mode: 'default',
                    context: {},
                    availableGuildIds
                });
                return;
            }

            if (interaction.customId === 'setup:spotlight:channel') {
                const state = panelStore.get(key) ?? {};
                const guildId = state.guildId && availableGuildIds.includes(state.guildId)
                    ? state.guildId
                    : (availableGuildIds[0] ?? null);
                if (!guildId) {
                    await interaction.reply({ content: 'Select a server before choosing a channel.', ephemeral: true });
                    return;
                }
                const choice = interaction.values?.[0] ?? null;
                if (!choice || choice === 'noop') {
                    await interaction.deferUpdate().catch(() => {});
                    return;
                }
                const sanitized = sanitizeSnowflakeId(choice);
                if (!sanitized) {
                    await interaction.reply({ content: 'That selection is not a text channel.', ephemeral: true });
                    return;
                }
                const current = ensureGuildConfig(config, guildId);
                current.channelId = sanitized;
                config.spotlightGallery[guildId] = normalizeSpotlightGuildConfig(current);
                saveConfig(config, logger);
                const guild = await getGuild(guildId);
                const view = await buildView({ config, client, guildId, guild, mode: 'default', availableGuildIds });
                const message = await interaction.update({ embeds: view.embeds, components: view.components });
                persistState(message, { guildId: view.activeGuildId ?? guildId, mode: 'default' });
                await interaction.followUp({ content: 'Highlight channel updated.', ephemeral: true }).catch(() => {});
                return;
            }
        }

        if (interaction.isButton()) {
            switch (interaction.customId) {
                case 'setup:spotlight:toggle': {
                    if (!activeGuildId) {
                        await interaction.reply({ content: 'Add a main server before enabling the spotlight gallery.', ephemeral: true });
                        return;
                    }
                    const current = ensureGuildConfig(config, activeGuildId);
                    current.enabled = !current.enabled;
                    config.spotlightGallery[activeGuildId] = normalizeSpotlightGuildConfig(current);
                    saveConfig(config, logger);
                    const guild = await getGuild(activeGuildId);
                    const view = await buildView({ config, client, guildId: activeGuildId, guild, mode: 'default', availableGuildIds });
                    const message = await interaction.update({ embeds: view.embeds, components: view.components });
                    persistState(message, { guildId: view.activeGuildId ?? activeGuildId, mode: 'default' });
                    await interaction.followUp({ content: current.enabled ? 'Spotlight gallery enabled.' : 'Spotlight gallery disabled.', ephemeral: true }).catch(() => {});
                    return;
                }
                case 'setup:spotlight:openChannel': {
                    if (!activeGuildId) {
                        await interaction.reply({ content: 'Select a server before choosing a channel.', ephemeral: true });
                        return;
                    }
                    const guild = await getGuild(activeGuildId);
                    if (!guild) {
                        await interaction.reply({ content: 'Could not load that server. Try again.', ephemeral: true });
                        return;
                    }
                    const view = await buildView({ config, client, guildId: activeGuildId, guild, mode: 'select-channel', availableGuildIds });
                    const message = await interaction.update({ embeds: view.embeds, components: view.components });
                    persistState(message, { guildId: view.activeGuildId ?? activeGuildId, mode: 'select-channel' });
                    return;
                }
                case 'setup:spotlight:returnDefault': {
                    const state = panelStore.get(key) ?? {};
                    const guildId = state.guildId && availableGuildIds.includes(state.guildId)
                        ? state.guildId
                        : (availableGuildIds[0] ?? null);
                    const guild = guildId ? await getGuild(guildId) : null;
                    const view = await buildView({ config, client, guildId, guild, mode: 'default', availableGuildIds });
                    const message = await interaction.update({ embeds: view.embeds, components: view.components });
                    persistState(message, { guildId: view.activeGuildId ?? guildId, mode: 'default' });
                    return;
                }
                case 'setup:spotlight:clearChannel': {
                    const state = panelStore.get(key) ?? {};
                    const guildId = state.guildId && availableGuildIds.includes(state.guildId)
                        ? state.guildId
                        : (availableGuildIds[0] ?? null);
                    if (!guildId) {
                        await interaction.reply({ content: 'Select a server before clearing the channel.', ephemeral: true });
                        return;
                    }
                    const current = ensureGuildConfig(config, guildId);
                    current.channelId = null;
                    config.spotlightGallery[guildId] = normalizeSpotlightGuildConfig(current);
                    saveConfig(config, logger);
                    const guild = await getGuild(guildId);
                    const view = await buildView({ config, client, guildId, guild, mode: 'select-channel', availableGuildIds });
                    const message = await interaction.update({ embeds: view.embeds, components: view.components });
                    persistState(message, { guildId: view.activeGuildId ?? guildId, mode: 'select-channel' });
                    await interaction.followUp({ content: 'Highlight channel cleared.', ephemeral: true }).catch(() => {});
                    return;
                }
                case 'setup:spotlight:emojis': {
                    if (!activeGuildId) {
                        await interaction.reply({ content: 'Select a server first.', ephemeral: true });
                        return;
                    }
                    const current = ensureGuildConfig(config, activeGuildId);
                    const modal = new ModalBuilder()
                    .setCustomId('setup:spotlight:emojisModal')
                    .setTitle('Set trigger emojis')
                    .addComponents(new ActionRowBuilder().addComponents(
                        new TextInputBuilder()
                        .setCustomId('setup:spotlight:emojiInput')
                        .setLabel('Emojis (comma or newline separated)')
                        .setRequired(false)
                        .setStyle(TextInputStyle.Paragraph)
                        .setMaxLength(200)
                        .setValue(current.emojis.join('\n'))
                    ));
                    await interaction.showModal(modal);
                    return;
                }
                case 'setup:spotlight:threshold': {
                    if (!activeGuildId) {
                        await interaction.reply({ content: 'Select a server first.', ephemeral: true });
                        return;
                    }
                    const current = ensureGuildConfig(config, activeGuildId);
                    const modal = new ModalBuilder()
                    .setCustomId('setup:spotlight:thresholdModal')
                    .setTitle('Set reaction threshold')
                    .addComponents(new ActionRowBuilder().addComponents(
                        new TextInputBuilder()
                        .setCustomId('setup:spotlight:thresholdInput')
                        .setLabel('Minimum matching reactions')
                        .setRequired(true)
                        .setStyle(TextInputStyle.Short)
                        .setMaxLength(3)
                        .setValue(String(current.threshold ?? DEFAULT_THRESHOLD))
                    ));
                    await interaction.showModal(modal);
                    return;
                }
                case 'setup:spotlight:self': {
                    if (!activeGuildId) {
                        await interaction.reply({ content: 'Select a server first.', ephemeral: true });
                        return;
                    }
                    const current = ensureGuildConfig(config, activeGuildId);
                    current.allowSelf = !current.allowSelf;
                    config.spotlightGallery[activeGuildId] = normalizeSpotlightGuildConfig(current);
                    saveConfig(config, logger);
                    const guild = await getGuild(activeGuildId);
                    const view = await buildView({ config, client, guildId: activeGuildId, guild, mode: 'default', availableGuildIds });
                    const message = await interaction.update({ embeds: view.embeds, components: view.components });
                    persistState(message, { guildId: view.activeGuildId ?? activeGuildId, mode: 'default' });
                    await interaction.followUp({ content: current.allowSelf ? 'Self-reactions will count.' : 'Self-reactions will be ignored.', ephemeral: true }).catch(() => {});
                    return;
                }
                case 'setup:spotlight:refresh': {
                    await interaction.deferUpdate().catch(() => {});
                    await refreshState();
                    return;
                }
                default:
                    return;
            }
        }

        if (interaction.isModalSubmit()) {
            if (interaction.customId === 'setup:spotlight:emojisModal') {
                const state = panelStore.get(key) ?? {};
                const guildId = state.guildId && availableGuildIds.includes(state.guildId)
                    ? state.guildId
                    : (availableGuildIds[0] ?? null);
                if (!guildId) {
                    await interaction.reply({ content: 'Select a server first.', ephemeral: true });
                    return;
                }
                const raw = interaction.fields.getTextInputValue('setup:spotlight:emojiInput') ?? '';
                const parsed = normalizeEmojiList(raw);
                const current = ensureGuildConfig(config, guildId);
                current.emojis = parsed.length ? parsed : DEFAULT_EMOJIS.slice();
                config.spotlightGallery[guildId] = normalizeSpotlightGuildConfig(current);
                saveConfig(config, logger);
                await interaction.reply({ content: `Trigger emojis updated to ${parsed.join(' ') || DEFAULT_EMOJIS.join(' ')}.`, ephemeral: true });
                await refreshState({ guildId, mode: 'default' });
                return;
            }

            if (interaction.customId === 'setup:spotlight:thresholdModal') {
                const state = panelStore.get(key) ?? {};
                const guildId = state.guildId && availableGuildIds.includes(state.guildId)
                    ? state.guildId
                    : (availableGuildIds[0] ?? null);
                if (!guildId) {
                    await interaction.reply({ content: 'Select a server first.', ephemeral: true });
                    return;
                }
                const raw = interaction.fields.getTextInputValue('setup:spotlight:thresholdInput') ?? '';
                const parsed = Number.parseInt(raw.trim(), 10);
                if (!Number.isFinite(parsed) || parsed <= 0) {
                    await interaction.reply({ content: 'Enter a positive integer for the threshold.', ephemeral: true });
                    return;
                }
                const clamped = Math.max(1, Math.min(parsed, 25));
                const current = ensureGuildConfig(config, guildId);
                current.threshold = clamped;
                config.spotlightGallery[guildId] = normalizeSpotlightGuildConfig(current);
                saveConfig(config, logger);
                await interaction.reply({ content: `Threshold set to ${clamped}.`, ephemeral: true });
                await refreshState({ guildId, mode: 'default' });
                return;
            }
        }
    }

    return {
        prepareConfig,
        buildView,
        handleInteraction,
        collectEligibleGuildIds
    };
}
