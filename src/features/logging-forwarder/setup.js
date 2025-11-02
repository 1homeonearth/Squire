// src/features/logging-forwarder/setup.js
// Setup panel integration for the logging forwarder module.
import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    ModalBuilder,
    PermissionFlagsBits,
    StringSelectMenuBuilder,
    TextInputBuilder,
    TextInputStyle
} from 'discord.js';
import {
    appendHomeButtonRow,
    collectCategories,
    collectTextChannels,
    formatCategory,
    formatChannel,
    truncateName
} from '../setup/shared.js';

export const LOGGING_CHANNEL_CATEGORIES = [
    { key: 'messages', label: 'Message logs', description: 'Cross-server message forwards.' },
    { key: 'moderation', label: 'Moderation alerts', description: 'Bans, kicks, warnings and escalations.' },
    { key: 'joins', label: 'Join & leave', description: 'Member join/leave notifications.' },
    { key: 'system', label: 'System notices', description: 'Automation updates and bot diagnostics.' }
];

export function createLoggingSetup({ panelStore, saveConfig, fetchGuild }) {
    function prepareConfig(config) {
        config.mapping = coerceRecord(config.mapping);
        config.excludeChannels = mapValuesToArray(config.excludeChannels);
        config.excludeCategories = mapValuesToArray(config.excludeCategories);
        config.loggingWebhookMeta = coerceRecord(config.loggingWebhookMeta);
        config.loggingChannels = coerceRecord(config.loggingChannels);
        if (typeof config.sampleRate !== 'number' || Number.isNaN(config.sampleRate)) {
            config.sampleRate = 1;
        }
    }

    async function handleInteraction({ interaction, entry, config, client, logger, key }) {
        const availableGuildIds = entry?.availableGuildIds ?? config.mainServerIds ?? [];
        const currentGuildId = entry?.guildId && availableGuildIds.includes(entry.guildId)
            ? entry.guildId
            : (availableGuildIds[0] ?? null);
        const sourceGuild = currentGuildId ? await fetchGuild(client, currentGuildId) : null;
        const baseContext = entry?.context ?? {};
        const currentMode = entry?.mode ?? 'default';

        const persistState = (message, overrides = {}) => {
            panelStore.set(key, {
                message,
                guildId: overrides.guildId ?? currentGuildId ?? null,
                mode: overrides.mode ?? currentMode,
                context: overrides.context ?? baseContext,
                availableGuildIds
            });
        };

        if (interaction.isButton()) {
            switch (interaction.customId) {
                case 'setup:logging:linkCurrent': {
                    if (!currentGuildId) {
                        await interaction.reply({ content: 'Select a main server first.', ephemeral: true });
                        return;
                    }
                    const view = await buildView({
                        config,
                        client,
                        guild: sourceGuild,
                        mode: 'select-mapping-channel',
                        context: { sourceGuildId: currentGuildId }
                    });
                    const message = await interaction.update(view);
                    persistState(message, {
                        mode: 'select-mapping-channel',
                        context: { sourceGuildId: currentGuildId }
                    });
                    return;
                }
                case 'setup:logging:removeCurrent': {
                    if (currentGuildId) {
                        delete config.mapping[currentGuildId];
                        if (config.loggingWebhookMeta[currentGuildId]) {
                            delete config.loggingWebhookMeta[currentGuildId];
                        }
                        saveConfig(config, logger);
                    }
                    const view = await buildView({ config, client, guild: sourceGuild, mode: 'default', context: {} });
                    const message = await interaction.update(view);
                    persistState(message, { mode: 'default', context: {} });
                    await interaction.followUp({ content: 'Mapping removed for this server.', ephemeral: true }).catch(() => {});
                    return;
                }
                case 'setup:logging:manageChannels': {
                    const view = await buildView({ config, client, guild: sourceGuild, mode: 'choose-category', context: {} });
                    const message = await interaction.update(view);
                    persistState(message, { mode: 'choose-category', context: {} });
                    return;
                }
                case 'setup:logging:manageExclusions': {
                    const view = await buildView({ config, client, guild: sourceGuild, mode: 'manage-exclusions', context: {} });
                    const message = await interaction.update(view);
                    persistState(message, { mode: 'manage-exclusions', context: {} });
                    return;
                }
                case 'setup:logging:toggleBots': {
                    config.forwardBots = !config.forwardBots;
                    saveConfig(config, logger);
                    const view = await buildView({ config, client, guild: sourceGuild, mode: currentMode, context: baseContext });
                    const message = await interaction.update(view);
                    persistState(message, { mode: currentMode, context: baseContext });
                    await interaction.followUp({ content: `Forwarding bot messages is now ${config.forwardBots ? 'enabled' : 'disabled'}.`, ephemeral: true }).catch(() => {});
                    return;
                }
                case 'setup:logging:setSample': {
                    const modal = new ModalBuilder()
                    .setCustomId('setup:logging:sampleModal')
                    .setTitle('Set sample rate')
                    .addComponents(
                        new ActionRowBuilder().addComponents(
                            new TextInputBuilder()
                            .setCustomId('setup:logging:sampleInput')
                            .setLabel('Sample rate (0-1)')
                            .setStyle(TextInputStyle.Short)
                            .setRequired(true)
                            .setValue(String(config.sampleRate ?? 1))
                        )
                    );
                    await interaction.showModal(modal);
                    return;
                }
                case 'setup:logging:refresh': {
                    const view = await buildView({ config, client, guild: sourceGuild, mode: 'default', context: {} });
                    const message = await interaction.update(view);
                    persistState(message, { mode: 'default', context: {} });
                    return;
                }
                default:
                    return;
            }
        }

        if (interaction.isStringSelectMenu()) {
            const parts = interaction.customId.split(':');
            switch (parts[2]) {
                case 'selectSource': {
                    const choice = interaction.values?.[0] ?? null;
                    const nextGuildId = choice && choice !== 'noop' ? choice : null;
                    const nextGuild = nextGuildId ? await fetchGuild(client, nextGuildId) : null;
                    const view = await buildView({ config, client, guild: nextGuild, mode: 'default', context: {} });
                    const message = await interaction.update(view);
                    panelStore.set(key, {
                        message,
                        guildId: nextGuildId,
                        mode: 'default',
                        context: {},
                        availableGuildIds
                    });
                    return;
                }
                case 'selectMappingChannel': {
                    const channelId = interaction.values?.[0] ?? null;
                    const sourceGuildId = baseContext.sourceGuildId ?? currentGuildId;
                    const loggingGuild = config.loggingServerId ? await fetchGuild(client, config.loggingServerId) : null;
                    if (!sourceGuildId || !loggingGuild) {
                        await interaction.reply({ content: 'Set a logging server and choose a main server first.', ephemeral: true });
                        return;
                    }
                    if (!channelId || channelId === 'noop') {
                        await interaction.reply({ content: 'Select a channel to link.', ephemeral: true });
                        return;
                    }
                    const result = await linkGuildToChannel({
                        config,
                        client,
                        logger,
                        sourceGuildId,
                        channelId
                    });
                    if (!result.ok) {
                        await interaction.reply({ content: result.error ?? 'Could not create webhook.', ephemeral: true });
                        return;
                    }
                    const view = await buildView({ config, client, guild: sourceGuild, mode: 'default', context: {} });
                    const message = await interaction.update(view);
                    persistState(message, { mode: 'default', context: {} });
                    await interaction.followUp({ content: `Linked **${result.sourceName}** to <#${channelId}>.`, ephemeral: true }).catch(() => {});
                    return;
                }
                case 'selectCategory': {
                    const category = interaction.values?.[0] ?? null;
                    const sourceGuildId = currentGuildId;
                    if (!category || !sourceGuildId) {
                        await interaction.deferUpdate().catch(() => {});
                        return;
                    }
                    const view = await buildView({ config, client, guild: sourceGuild, mode: 'select-category-channel', context: { category } });
                    const message = await interaction.update(view);
                    persistState(message, { mode: 'select-category-channel', context: { category } });
                    return;
                }
                case 'selectCategoryChannel': {
                    const category = baseContext.category ?? null;
                    const channelId = interaction.values?.[0] ?? null;
                    if (!category) {
                        await interaction.deferUpdate().catch(() => {});
                        return;
                    }
                    if (!config.loggingChannels || typeof config.loggingChannels !== 'object') {
                        config.loggingChannels = {};
                    }
                    if (channelId === '__clear__') {
                        delete config.loggingChannels[category];
                    } else if (channelId) {
                        config.loggingChannels[category] = channelId;
                    }
                    saveConfig(config, logger);
                    const view = await buildView({ config, client, guild: sourceGuild, mode: 'default', context: {} });
                    const message = await interaction.update(view);
                    persistState(message, { mode: 'default', context: {} });
                    await interaction.followUp({ content: channelId === '__clear__' ? `Cleared channel for **${category}**.` : `Channel for **${category}** set.`, ephemeral: true }).catch(() => {});
                    return;
                }
                case 'excludeChannels': {
                    const channels = interaction.values?.map(String) ?? [];
                    if (currentGuildId) {
                        config.excludeChannels[currentGuildId] = channels;
                        saveConfig(config, logger);
                    }
                    const view = await buildView({ config, client, guild: sourceGuild, mode: 'manage-exclusions', context: {} });
                    const message = await interaction.update(view);
                    persistState(message, { mode: 'manage-exclusions', context: {} });
                    await interaction.followUp({ content: `Excluded ${channels.length} channel(s).`, ephemeral: true }).catch(() => {});
                    return;
                }
                case 'excludeCategories': {
                    const categories = interaction.values?.map(String) ?? [];
                    if (currentGuildId) {
                        config.excludeCategories[currentGuildId] = categories;
                        saveConfig(config, logger);
                    }
                    const view = await buildView({ config, client, guild: sourceGuild, mode: 'manage-exclusions', context: {} });
                    const message = await interaction.update(view);
                    persistState(message, { mode: 'manage-exclusions', context: {} });
                    await interaction.followUp({ content: `Excluded ${categories.length} categor${categories.length === 1 ? 'y' : 'ies'}.`, ephemeral: true }).catch(() => {});
                    return;
                }
                default:
                    return;
            }
        }

        if (interaction.isModalSubmit()) {
            if (interaction.customId === 'setup:logging:sampleModal') {
                const raw = interaction.fields.getTextInputValue('setup:logging:sampleInput');
                const value = Number(raw);
                if (!Number.isFinite(value) || value < 0 || value > 1) {
                    await interaction.reply({ content: 'Sample rate must be a number between 0 and 1.', ephemeral: true });
                    return;
                }
                config.sampleRate = value;
                saveConfig(config, logger);
                await interaction.reply({ content: `Sample rate updated to ${value}.`, ephemeral: true });
                if (entry?.message) {
                    try {
                        const view = await buildView({ config, client, guild: sourceGuild, mode: currentMode, context: baseContext });
                        const message = await entry.message.edit(view);
                        persistState(message, { mode: currentMode, context: baseContext });
                    } catch {}
                }
            }
        }
    }

    async function buildView({ config, client, guild, mode, context }) {
        const loggingServerId = config.loggingServerId ?? null;
        const loggingGuild = loggingServerId ? await fetchGuild(client, loggingServerId) : null;
        const selectedGuild = guild ?? null;
        const selectedGuildId = selectedGuild?.id ?? context?.sourceGuildId ?? null;

        const mapping = config.mapping || {};
        const meta = config.loggingWebhookMeta || {};
        const excludeChannels = config.excludeChannels || {};
        const excludeCategories = config.excludeCategories || {};
        const embed = new EmbedBuilder()
        .setTitle('Logging module setup')
        .setDescription('Link each main server to a logging channel and manage exclusions from anywhere.')
        .addFields(
            {
                name: 'Logging server',
                value: loggingGuild ? `${loggingGuild.name} (${loggingGuild.id})` : 'Not configured',
                inline: false
            },
            {
                name: 'Selected main server',
                value: selectedGuild ? `${selectedGuild.name} (${selectedGuild.id})` : 'Choose a server using the selector below.',
                inline: false
            }
        );

        if (selectedGuildId) {
            const webhookUrl = mapping[selectedGuildId];
            const webhookMeta = meta[selectedGuildId];
            const excludedChan = excludeChannels[selectedGuildId] || [];
            const excludedCats = excludeCategories[selectedGuildId] || [];

            embed.addFields(
                {
                    name: 'Current mapping',
                    value: webhookUrl
                        ? `Linked to ${formatChannel(loggingGuild, webhookMeta?.channelId)}\n${truncateWebhook(webhookUrl)}`
                        : 'Not linked yet.',
                    inline: false
                },
                {
                    name: 'Excluded channels',
                    value: excludedChan.length
                        ? excludedChan.map(id => formatChannel(selectedGuild, id)).slice(0, 5).join('\n') + (excludedChan.length > 5 ? `\n… ${excludedChan.length - 5} more` : '')
                        : 'None',
                    inline: true
                },
                {
                    name: 'Excluded categories',
                    value: excludedCats.length
                        ? excludedCats.map(id => formatCategory(selectedGuild, id)).slice(0, 5).join('\n') + (excludedCats.length > 5 ? `\n… ${excludedCats.length - 5} more` : '')
                        : 'None',
                    inline: true
                }
            );
        }

        embed.addFields(
            {
                name: 'Forward bot messages',
                value: config.forwardBots ? '✅ Enabled' : '🚫 Disabled',
                inline: true
            },
            {
                name: 'Sample rate',
                value: `${Number.isFinite(config.sampleRate) ? config.sampleRate : 1}`,
                inline: true
            },
            {
                name: 'Logging channel categories',
                value: formatLoggingChannels(loggingGuild, config.loggingChannels || {}),
                inline: false
            }
        );

        const components = [];

        const availableSources = (config.mainServerIds || []).filter(id => id);
        const sourceOptions = [];
        for (const id of availableSources.slice(0, 24)) {
            const g = client.guilds.cache.get(id) ?? await fetchGuild(client, id);
            sourceOptions.push({
                label: truncateName(g?.name ?? id, 100),
                description: `ID: ${id}`.slice(0, 100),
                value: id,
                default: id === selectedGuildId
            });
        }
        if (selectedGuildId && !sourceOptions.find(opt => opt.value === selectedGuildId)) {
            const g = client.guilds.cache.get(selectedGuildId) ?? await fetchGuild(client, selectedGuildId);
            sourceOptions.unshift({
                label: truncateName(g?.name ?? selectedGuildId, 100),
                description: `ID: ${selectedGuildId}`.slice(0, 100),
                value: selectedGuildId,
                default: true
            });
        }

        const sourceMenu = new StringSelectMenuBuilder()
        .setCustomId('setup:logging:selectSource')
        .setPlaceholder(availableSources.length ? 'Select a main server…' : 'Add main servers on the overview page')
        .setMinValues(1)
        .setMaxValues(1)
        .setDisabled(!availableSources.length);

        if (sourceOptions.length) {
            sourceMenu.addOptions(sourceOptions);
        } else {
            sourceMenu.addOptions({ label: 'No main servers configured', value: 'noop', default: true });
        }
        components.push(new ActionRowBuilder().addComponents(sourceMenu));

        const buttonsPrimary = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
            .setCustomId('setup:logging:linkCurrent')
            .setLabel('Link this server')
            .setStyle(ButtonStyle.Primary)
            .setDisabled(!selectedGuildId || !loggingGuild),
            new ButtonBuilder()
            .setCustomId('setup:logging:removeCurrent')
            .setLabel('Remove mapping')
            .setStyle(ButtonStyle.Danger)
            .setDisabled(!selectedGuildId || !mapping[selectedGuildId]),
            new ButtonBuilder()
            .setCustomId('setup:logging:manageChannels')
            .setLabel('Configure categories')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(!loggingGuild),
            new ButtonBuilder()
            .setCustomId('setup:logging:manageExclusions')
            .setLabel('Manage exclusions')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(!selectedGuildId)
        );

        const buttonsSecondary = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
            .setCustomId('setup:logging:toggleBots')
            .setLabel(config.forwardBots ? 'Disable bot forwards' : 'Enable bot forwards')
            .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
            .setCustomId('setup:logging:setSample')
            .setLabel('Set sample rate')
            .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
            .setCustomId('setup:logging:refresh')
            .setLabel('Refresh view')
            .setStyle(ButtonStyle.Secondary)
        );

        components.push(buttonsPrimary);
        components.push(buttonsSecondary);

        if (mode === 'select-mapping-channel') {
            const channels = loggingGuild ? await collectTextChannels(loggingGuild) : [];
            const menu = new StringSelectMenuBuilder()
            .setCustomId('setup:logging:selectMappingChannel')
            .setPlaceholder(channels.length ? 'Select a logging channel…' : 'No channels available')
            .setMinValues(1)
            .setMaxValues(1)
            .setDisabled(!loggingGuild || channels.length === 0);

            if (channels.length) {
                menu.addOptions(channels.slice(0, 24).map((ch) => ({
                    label: `ID: ${ch.id}`.slice(0, 100),
                    description: `#${truncateName(ch.name, 90)}`.slice(0, 100),
                    value: ch.id,
                    default: config.loggingWebhookMeta?.[context?.sourceGuildId ?? selectedGuildId]?.channelId === ch.id
                })));
            } else {
                menu.addOptions({ label: 'No channels available', value: 'noop', default: true });
            }

            components.push(new ActionRowBuilder().addComponents(menu));
        }

        if (mode === 'choose-category') {
            const menu = new StringSelectMenuBuilder()
            .setCustomId('setup:logging:selectCategory')
            .setPlaceholder('Pick a logging category…')
            .setMinValues(1)
            .setMaxValues(1)
            .setDisabled(!loggingGuild);

            menu.addOptions(LOGGING_CHANNEL_CATEGORIES.map((cat) => ({
                label: cat.label,
                description: cat.description.slice(0, 100),
                value: cat.key,
                default: context?.category === cat.key
            })));

            components.push(new ActionRowBuilder().addComponents(menu));
        }

        if (mode === 'select-category-channel') {
            const { category } = context ?? {};
            const channels = loggingGuild ? await collectTextChannels(loggingGuild) : [];
            const menu = new StringSelectMenuBuilder()
            .setCustomId('setup:logging:selectCategoryChannel')
            .setPlaceholder(channels.length ? 'Select a channel for this category…' : 'No channels available')
            .setMinValues(1)
            .setMaxValues(1)
            .setDisabled(!loggingGuild || channels.length === 0);

            menu.addOptions({ label: 'Clear channel', value: '__clear__', description: 'Remove configured channel for this category.' });

            if (channels.length) {
                menu.addOptions(channels.slice(0, 24).map((ch) => ({
                    label: `ID: ${ch.id}`.slice(0, 100),
                    description: `#${truncateName(ch.name, 90)}`.slice(0, 100),
                    value: ch.id,
                    default: config.loggingChannels?.[category] === ch.id
                })));
            }

            components.push(new ActionRowBuilder().addComponents(menu));
        }

        if (mode === 'manage-exclusions') {
            const sourceChannels = await collectTextChannels(selectedGuild);
            const channelMenu = new StringSelectMenuBuilder()
            .setCustomId('setup:logging:excludeChannels')
            .setPlaceholder('Select channels to exclude…')
            .setMinValues(0)
            .setMaxValues(Math.min(25, sourceChannels.length || 1));

            if (sourceChannels.length) {
                channelMenu.addOptions(sourceChannels.slice(0, 25).map((ch) => ({
                    label: `ID: ${ch.id}`.slice(0, 100),
                    description: `#${truncateName(ch.name, 90)}`.slice(0, 100),
                    value: ch.id,
                    default: (excludeChannels[selectedGuildId] || []).includes(ch.id)
                })));
            } else {
                channelMenu.addOptions({ label: 'No text channels found', value: 'noop', default: true });
            }

            const categories = await collectCategories(selectedGuild);
            const categoryMenu = new StringSelectMenuBuilder()
            .setCustomId('setup:logging:excludeCategories')
            .setPlaceholder('Select categories to exclude…')
            .setMinValues(0)
            .setMaxValues(Math.min(25, categories.length || 1));

            if (categories.length) {
                categoryMenu.addOptions(categories.slice(0, 25).map((cat) => ({
                    label: truncateName(cat.name, 100),
                    description: cat.id,
                    value: cat.id,
                    default: (excludeCategories[selectedGuildId] || []).includes(cat.id)
                })));
            } else {
                categoryMenu.addOptions({ label: 'No categories found', value: 'noop', default: true });
            }

            components.push(new ActionRowBuilder().addComponents(channelMenu));
            components.push(new ActionRowBuilder().addComponents(categoryMenu));
        }

        appendHomeButtonRow(components);

        return { embeds: [embed], components };
    }

    async function linkGuildToChannel({ config, client, logger, sourceGuildId, channelId }) {
        try {
            const loggingServerId = config.loggingServerId;
            if (!loggingServerId) {
                return { ok: false, error: 'Set a logging server first.' };
            }
            const loggingGuild = await fetchGuild(client, loggingServerId);
            if (!loggingGuild) {
                return { ok: false, error: 'Could not access logging server.' };
            }
            const channel = await loggingGuild.channels.fetch(channelId).catch(() => null);
            if (!channel || typeof channel.isTextBased !== 'function' || !channel.isTextBased() || channel.isThread?.()) {
                return { ok: false, error: 'Selected channel is not text-based.' };
            }
            const me = loggingGuild.members.me ?? await loggingGuild.members.fetchMe().catch(() => null);
            if (!me || !channel.permissionsFor(me)?.has(PermissionFlagsBits.ManageWebhooks)) {
                return { ok: false, error: 'Squire lacks permission to manage webhooks in that channel.' };
            }

            const sourceGuild = await fetchGuild(client, sourceGuildId);
            const sourceName = sourceGuild?.name ?? sourceGuildId;
            const desiredName = `Squire • ${truncateName(sourceName, 40)}`;

            const meta = config.loggingWebhookMeta[sourceGuildId] || {};
            let webhook = null;
            if (meta.webhookId) {
                webhook = await channel.fetchWebhooks().then((hooks) => hooks.get(meta.webhookId) ?? null).catch(() => null);
            }

            if (webhook) {
                await webhook.edit({ name: desiredName, channel: channelId }).catch(() => {});
            } else {
                webhook = await channel.createWebhook({ name: desiredName, reason: 'Configured via /setup logging' });
            }

            const url = `https://discord.com/api/webhooks/${webhook.id}/${webhook.token}`;
            config.mapping[sourceGuildId] = url;
            config.loggingWebhookMeta[sourceGuildId] = {
                channelId,
                webhookId: webhook.id
            };
            saveConfig(config, logger);
            return { ok: true, sourceName };
        } catch (err) {
            logger?.error?.(`[setup] Failed to create webhook: ${err?.message ?? err}`);
            return { ok: false, error: 'Failed to create webhook. Check permissions and try again.' };
        }
    }

    function formatLoggingChannels(loggingGuild, mapping) {
        if (!mapping || typeof mapping !== 'object' || !Object.keys(mapping).length) {
            return 'No dedicated logging channels configured.';
        }
        const parts = [];
        for (const cat of LOGGING_CHANNEL_CATEGORIES) {
            const channelId = mapping[cat.key];
            parts.push(`• **${cat.label}:** ${formatChannel(loggingGuild, channelId)}`);
        }
        return parts.join('\n');
    }

    return {
        prepareConfig,
        handleInteraction,
        buildView,
        formatLoggingChannels
    };
}

function coerceRecord(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return { ...value };
}

function mapValuesToArray(value) {
    const out = {};
    if (!value || typeof value !== 'object') return out;
    for (const [key, arr] of Object.entries(value)) {
        if (!Array.isArray(arr)) continue;
        out[String(key)] = arr.map(String);
    }
    return out;
}

function truncateWebhook(url) {
    if (!url) return 'Not configured';
    try {
        const u = new URL(url);
        const tail = u.pathname.split('/').slice(-2).join('/');
        return `${u.host}/${tail}`;
    } catch {
        return url.length > 60 ? `${url.slice(0, 57)}…` : url;
    }
}
