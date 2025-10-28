// src/features/setup/index.js
import {
    SlashCommandBuilder,
    PermissionFlagsBits,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    StringSelectMenuBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    ChannelType
} from 'discord.js';

import { writeConfig } from '../../core/config.js';

const LOGGING_CHANNEL_CATEGORIES = [
    { key: 'messages', label: 'Message logs', description: 'Cross-server message forwards.' },
    { key: 'moderation', label: 'Moderation alerts', description: 'Bans, kicks, warnings and escalations.' },
    { key: 'joins', label: 'Join & leave', description: 'Member join/leave notifications.' },
    { key: 'system', label: 'System notices', description: 'Automation updates and bot diagnostics.' }
];

const panelStore = new Map(); // `${userId}:${module}` -> { message, guildId, mode, context }

export const commands = [
    new SlashCommandBuilder()
    .setName('setup')
    .setDescription('Configure Squire modules')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((sub) => sub
        .setName('logging')
        .setDescription('Configure logging forwarder'))
    .addSubcommand((sub) => sub
        .setName('welcome')
        .setDescription('Configure welcome card module'))
    .addSubcommand((sub) => sub
        .setName('autobouncer')
        .setDescription('Configure autobouncer keyword list'))
];

export function init({ client, config, logger }) {
    ensureConfigShape(config);

    client.on('interactionCreate', async (interaction) => {
        try {
            if (interaction.isChatInputCommand() && interaction.commandName === 'setup') {
                if (!interaction.inGuild()) {
                    await interaction.reply({ content: 'Run this command inside a server.', ephemeral: true });
                    return;
                }
                if (!hasManageGuild(interaction)) {
                    await interaction.reply({ content: 'You need **Manage Server** permission to configure Squire.', ephemeral: true });
                    return;
                }

                const sub = interaction.options.getSubcommand();
                const key = panelKey(interaction.user?.id, sub);
                panelStore.delete(key);

                await interaction.deferReply({ ephemeral: true });

                if (sub === 'logging') {
                    const view = await buildLoggingView({
                        config,
                        client,
                        guild: interaction.guild,
                        mode: 'default',
                        context: {}
                    });
                    const message = await interaction.editReply(view);
                    panelStore.set(key, { message, guildId: interaction.guildId, mode: 'default', context: {} });
                    return;
                }

                if (sub === 'welcome') {
                    const view = await buildWelcomeView({
                        config,
                        guild: interaction.guild,
                        mode: 'default',
                        context: {}
                    });
                    const message = await interaction.editReply(view);
                    panelStore.set(key, { message, guildId: interaction.guildId, mode: 'default', context: {} });
                    return;
                }

                if (sub === 'autobouncer') {
                    const view = buildAutobouncerView({ config });
                    const message = await interaction.editReply(view);
                    panelStore.set(key, { message, guildId: interaction.guildId, mode: 'default', context: {} });
                    return;
                }

                await interaction.editReply({ content: 'Unknown setup module.', components: [] });
                return;
            }

            if (!interaction.customId?.startsWith('setup:') && !interaction.isModalSubmit()) {
                return;
            }

            const module = extractModuleFromInteraction(interaction);
            if (!module) return;

            const key = panelKey(interaction.user?.id, module);
            const entry = panelStore.get(key);
            const guild = interaction.guild ?? (entry?.guildId ? await fetchGuild(client, entry.guildId) : null);

            if (!hasManageGuild(interaction)) {
                if (interaction.isRepliable()) {
                    await interaction.reply({ content: 'You need **Manage Server** permission to do that.', ephemeral: true });
                }
                return;
            }

            if (module === 'logging') {
                await handleLoggingInteraction({ interaction, entry, config, client, logger, key, guild });
                return;
            }

            if (module === 'welcome') {
                await handleWelcomeInteraction({ interaction, entry, config, client, key, guild, logger });
                return;
            }

            if (module === 'autobouncer') {
                await handleAutobouncerInteraction({ interaction, entry, config, key, logger });
                return;
            }
        } catch (err) {
            logger?.error?.(`[setup] Interaction error: ${err?.message ?? err}`);
            try {
                if (interaction.isRepliable() && !interaction.replied) {
                    await interaction.reply({ content: 'Something went wrong handling that action.', ephemeral: true });
                }
            } catch {}
        }
    });
}

function ensureConfigShape(config) {
    config.mapping = coerceRecord(config.mapping);
    config.excludeChannels = mapValuesToArray(config.excludeChannels);
    config.excludeCategories = mapValuesToArray(config.excludeCategories);
    config.loggingWebhookMeta = coerceRecord(config.loggingWebhookMeta);
    config.loggingChannels = coerceRecord(config.loggingChannels);

    if (!config.welcome || typeof config.welcome !== 'object') {
        config.welcome = {};
    }
    if (!config.welcome.mentions || typeof config.welcome.mentions !== 'object') {
        config.welcome.mentions = {};
    }

    if (!config.autoban || typeof config.autoban !== 'object') {
        config.autoban = {};
    }
    if (!Array.isArray(config.autoban.blockedUsernames)) {
        const value = config.autoban.blockedUsernames;
        config.autoban.blockedUsernames = Array.isArray(value) ? value.map(String) : [];
    } else {
        config.autoban.blockedUsernames = config.autoban.blockedUsernames.map(String);
    }

    if (typeof config.sampleRate !== 'number' || Number.isNaN(config.sampleRate)) {
        config.sampleRate = 1;
    }
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

function hasManageGuild(interaction) {
    return interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
}

function panelKey(userId, module) {
    if (!userId || !module) return null;
    return `${userId}:${module}`;
}

async function fetchGuild(client, guildId) {
    if (!guildId) return null;
    const cached = client.guilds.cache.get(guildId);
    if (cached) return cached;
    try {
        return await client.guilds.fetch(guildId);
    } catch {
        return null;
    }
}

function extractModuleFromInteraction(interaction) {
    if (interaction.isModalSubmit()) {
        const parts = interaction.customId.split(':');
        return parts[1] || null;
    }
    const parts = interaction.customId?.split(':');
    if (!parts || parts.length < 2) return null;
    return parts[1];
}

function saveConfig(config, logger) {
    try {
        writeConfig(config);
        return true;
    } catch (err) {
        logger?.error?.(`[setup] Failed to persist config: ${err?.message ?? err}`);
        return false;
    }
}

async function handleLoggingInteraction({ interaction, entry, config, client, logger, key, guild }) {
    const sourceGuild = guild ?? (entry?.guildId ? await fetchGuild(client, entry.guildId) : null);
    const baseContext = entry?.context ?? {};

    if (interaction.isButton()) {
        switch (interaction.customId) {
            case 'setup:logging:chooseServer': {
                const view = await buildLoggingView({ config, client, guild: sourceGuild, mode: 'select-server', context: {} });
                const message = await interaction.update(view);
                panelStore.set(key, { message, guildId: sourceGuild?.id ?? null, mode: 'select-server', context: {} });
                return;
            }
            case 'setup:logging:linkCurrent': {
                const view = await buildLoggingView({
                    config,
                    client,
                    guild: sourceGuild,
                    mode: 'select-mapping-channel',
                    context: { sourceGuildId: sourceGuild?.id ?? entry?.guildId ?? null }
                });
                const message = await interaction.update(view);
                panelStore.set(key, {
                    message,
                    guildId: sourceGuild?.id ?? null,
                    mode: 'select-mapping-channel',
                    context: { sourceGuildId: sourceGuild?.id ?? entry?.guildId ?? null }
                });
                return;
            }
            case 'setup:logging:removeCurrent': {
                if (sourceGuild?.id) {
                    delete config.mapping[sourceGuild.id];
                    if (config.loggingWebhookMeta[sourceGuild.id]) {
                        delete config.loggingWebhookMeta[sourceGuild.id];
                    }
                    saveConfig(config, logger);
                }
                const view = await buildLoggingView({ config, client, guild: sourceGuild, mode: 'default', context: {} });
                const message = await interaction.update(view);
                panelStore.set(key, { message, guildId: sourceGuild?.id ?? null, mode: 'default', context: {} });
                await interaction.followUp({ content: 'Mapping removed for this server.', ephemeral: true }).catch(() => {});
                return;
            }
            case 'setup:logging:manageChannels': {
                const view = await buildLoggingView({ config, client, guild: sourceGuild, mode: 'choose-category', context: {} });
                const message = await interaction.update(view);
                panelStore.set(key, { message, guildId: sourceGuild?.id ?? null, mode: 'choose-category', context: {} });
                return;
            }
            case 'setup:logging:manageExclusions': {
                const view = await buildLoggingView({ config, client, guild: sourceGuild, mode: 'manage-exclusions', context: {} });
                const message = await interaction.update(view);
                panelStore.set(key, { message, guildId: sourceGuild?.id ?? null, mode: 'manage-exclusions', context: {} });
                return;
            }
            case 'setup:logging:toggleBots': {
                config.forwardBots = !config.forwardBots;
                saveConfig(config, logger);
                const view = await buildLoggingView({ config, client, guild: sourceGuild, mode: entry?.mode ?? 'default', context: baseContext });
                const message = await interaction.update(view);
                panelStore.set(key, { message, guildId: sourceGuild?.id ?? null, mode: entry?.mode ?? 'default', context: baseContext });
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
                const view = await buildLoggingView({ config, client, guild: sourceGuild, mode: 'default', context: {} });
                const message = await interaction.update(view);
                panelStore.set(key, { message, guildId: sourceGuild?.id ?? null, mode: 'default', context: {} });
                return;
            }
            default:
                return;
        }
    }

    if (interaction.isStringSelectMenu()) {
        const parts = interaction.customId.split(':');
        switch (parts[2]) {
            case 'setServer': {
                const choice = interaction.values?.[0] ?? null;
                if (choice === '__clear__') {
                    delete config.loggingServerId;
                } else if (choice) {
                    config.loggingServerId = choice;
                }
                saveConfig(config, logger);
                const view = await buildLoggingView({ config, client, guild: sourceGuild, mode: 'default', context: {} });
                const message = await interaction.update(view);
                panelStore.set(key, { message, guildId: sourceGuild?.id ?? null, mode: 'default', context: {} });
                await interaction.followUp({ content: choice === '__clear__' ? 'Logging server cleared.' : `Logging server set to ${choice}.`, ephemeral: true }).catch(() => {});
                return;
            }
            case 'createWebhook': {
                const targetChannelId = interaction.values?.[0];
                const sourceGuildId = parts[3] || sourceGuild?.id;
                if (!targetChannelId || !sourceGuildId) {
                    const view = await buildLoggingView({ config, client, guild: sourceGuild, mode: 'default', context: {} });
                    const message = await interaction.update(view);
                    panelStore.set(key, { message, guildId: sourceGuild?.id ?? null, mode: 'default', context: {} });
                    return;
                }
                const result = await linkGuildToChannel({ config, client, logger, sourceGuildId, channelId: targetChannelId });
                const view = await buildLoggingView({ config, client, guild: sourceGuild, mode: 'default', context: {} });
                const message = await interaction.update(view);
                panelStore.set(key, { message, guildId: sourceGuild?.id ?? null, mode: 'default', context: {} });
                const reply = result.ok ? `Linked **${result.sourceName}** to <#${targetChannelId}>.` : result.error;
                await interaction.followUp({ content: reply, ephemeral: true }).catch(() => {});
                return;
            }
            case 'pickCategory': {
                const category = interaction.values?.[0];
                if (!category) {
                    const view = await buildLoggingView({ config, client, guild: sourceGuild, mode: 'default', context: {} });
                    const message = await interaction.update(view);
                    panelStore.set(key, { message, guildId: sourceGuild?.id ?? null, mode: 'default', context: {} });
                    return;
                }
                const view = await buildLoggingView({ config, client, guild: sourceGuild, mode: 'select-category-channel', context: { category } });
                const message = await interaction.update(view);
                panelStore.set(key, { message, guildId: sourceGuild?.id ?? null, mode: 'select-category-channel', context: { category } });
                return;
            }
            case 'setCategory': {
                const category = parts[3];
                const channelId = interaction.values?.[0] ?? null;
                if (!category) {
                    const view = await buildLoggingView({ config, client, guild: sourceGuild, mode: 'default', context: {} });
                    const message = await interaction.update(view);
                    panelStore.set(key, { message, guildId: sourceGuild?.id ?? null, mode: 'default', context: {} });
                    return;
                }
                if (channelId === '__clear__') {
                    delete config.loggingChannels[category];
                } else if (channelId) {
                    config.loggingChannels[category] = channelId;
                }
                saveConfig(config, logger);
                const view = await buildLoggingView({ config, client, guild: sourceGuild, mode: 'default', context: {} });
                const message = await interaction.update(view);
                panelStore.set(key, { message, guildId: sourceGuild?.id ?? null, mode: 'default', context: {} });
                await interaction.followUp({ content: channelId === '__clear__' ? `Cleared channel for **${category}**.` : `Channel for **${category}** set.`, ephemeral: true }).catch(() => {});
                return;
            }
            case 'excludeChannels': {
                const channels = interaction.values?.map(String) ?? [];
                if (sourceGuild?.id) {
                    config.excludeChannels[sourceGuild.id] = channels;
                    saveConfig(config, logger);
                }
                const view = await buildLoggingView({ config, client, guild: sourceGuild, mode: 'manage-exclusions', context: {} });
                const message = await interaction.update(view);
                panelStore.set(key, { message, guildId: sourceGuild?.id ?? null, mode: 'manage-exclusions', context: {} });
                await interaction.followUp({ content: `Excluded ${channels.length} channel(s).`, ephemeral: true }).catch(() => {});
                return;
            }
            case 'excludeCategories': {
                const categories = interaction.values?.map(String) ?? [];
                if (sourceGuild?.id) {
                    config.excludeCategories[sourceGuild.id] = categories;
                    saveConfig(config, logger);
                }
                const view = await buildLoggingView({ config, client, guild: sourceGuild, mode: 'manage-exclusions', context: {} });
                const message = await interaction.update(view);
                panelStore.set(key, { message, guildId: sourceGuild?.id ?? null, mode: 'manage-exclusions', context: {} });
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
                    const view = await buildLoggingView({ config, client, guild: sourceGuild, mode: entry?.mode ?? 'default', context: entry?.context ?? {} });
                    const message = await entry.message.edit(view);
                    panelStore.set(key, { message, guildId: sourceGuild?.id ?? null, mode: entry?.mode ?? 'default', context: entry?.context ?? {} });
                } catch {}
            }
        }
    }
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

async function buildLoggingView({ config, client, guild, mode, context }) {
    const sourceGuild = guild ?? null;
    const loggingServerId = config.loggingServerId ?? null;
    const loggingGuild = await fetchGuild(client, loggingServerId);

    const mapping = config.mapping || {};
    const meta = config.loggingWebhookMeta || {};
    const excludeChannels = config.excludeChannels || {};
    const excludeCategories = config.excludeCategories || {};

    const sourceId = sourceGuild?.id ?? null;
    const webhookUrl = sourceId ? mapping[sourceId] : null;
    const webhookMeta = sourceId ? meta[sourceId] : null;
    const excludedChan = sourceId ? (excludeChannels[sourceId] || []) : [];
    const excludedCats = sourceId ? (excludeCategories[sourceId] || []) : [];

    const embed = new EmbedBuilder()
    .setTitle('Logging module setup')
    .setDescription('Configure the centralized logging server and forwarding rules.')
    .addFields(
        {
            name: 'Logging server',
            value: loggingGuild ? `${loggingGuild.name} (${loggingGuild.id})` : 'Not configured',
            inline: false
        },
        {
            name: 'This server mapping',
            value: webhookUrl
                ? `Linked to ${formatChannel(loggingGuild, webhookMeta?.channelId)}\n${truncateWebhook(webhookUrl)}`
                : 'Not linked yet.',
            inline: false
        },
        {
            name: 'Excluded channels',
            value: excludedChan.length ? excludedChan.map(id => formatChannel(sourceGuild, id)).slice(0, 5).join('\n') + (excludedChan.length > 5 ? `\n… ${excludedChan.length - 5} more` : '') : 'None',
            inline: true
        },
        {
            name: 'Excluded categories',
            value: excludedCats.length ? excludedCats.map(id => formatCategory(sourceGuild, id)).slice(0, 5).join('\n') + (excludedCats.length > 5 ? `\n… ${excludedCats.length - 5} more` : '') : 'None',
            inline: true
        },
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
            name: 'Logging channels',
            value: formatLoggingChannels(loggingGuild, config.loggingChannels || {}),
            inline: false
        }
    );

    const buttonsPrimary = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
        .setCustomId('setup:logging:chooseServer')
        .setLabel('Select logging server')
        .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
        .setCustomId('setup:logging:linkCurrent')
        .setLabel('Link this server')
        .setStyle(ButtonStyle.Primary)
        .setDisabled(!sourceId || !loggingGuild),
        new ButtonBuilder()
        .setCustomId('setup:logging:removeCurrent')
        .setLabel('Remove mapping')
        .setStyle(ButtonStyle.Danger)
        .setDisabled(!sourceId || !webhookUrl),
        new ButtonBuilder()
        .setCustomId('setup:logging:manageChannels')
        .setLabel('Set logging channels')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(!loggingGuild),
        new ButtonBuilder()
        .setCustomId('setup:logging:manageExclusions')
        .setLabel('Manage exclusions')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(!sourceGuild)
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
        .setLabel('Refresh')
        .setStyle(ButtonStyle.Secondary)
    );

    const components = [buttonsPrimary, buttonsSecondary];

    if (mode === 'select-server') {
        const guildOptions = Array.from(client.guilds.cache.values())
        .sort((a, b) => a.name.localeCompare(b.name))
        .slice(0, 24)
        .map(g => ({
            label: truncateName(g.name, 100),
            description: `ID: ${g.id}`,
            value: g.id,
            default: g.id === loggingServerId
        }));
        guildOptions.push({ label: 'Clear logging server', value: '__clear__', description: 'Stop forwarding to a logging server.' });
        const menu = new StringSelectMenuBuilder()
        .setCustomId('setup:logging:setServer')
        .setPlaceholder('Select logging server…')
        .setMinValues(1)
        .setMaxValues(1)
        .addOptions(guildOptions);
        components.push(new ActionRowBuilder().addComponents(menu));
    }

    if (mode === 'select-mapping-channel') {
        const channels = await collectTextChannels(loggingGuild);
        const menu = new StringSelectMenuBuilder()
        .setCustomId(`setup:logging:createWebhook:${context?.sourceGuildId ?? sourceId ?? 'unknown'}`)
        .setPlaceholder(loggingGuild ? 'Select a logging channel…' : 'Set logging server first')
        .setMinValues(1)
        .setMaxValues(1)
        .setDisabled(!loggingGuild || channels.length === 0);

        if (channels.length) {
            menu.addOptions(channels.slice(0, 25).map((ch) => ({
                label: truncateName(ch.name, 100),
                description: `#${ch.name} — ID ${ch.id}`.slice(0, 100),
                value: ch.id,
                default: webhookMeta?.channelId === ch.id
            })));
        } else {
            menu.addOptions({ label: 'No available text channels', value: 'none', default: true });
        }

        components.push(new ActionRowBuilder().addComponents(menu));
    }

    if (mode === 'choose-category') {
        const menu = new StringSelectMenuBuilder()
        .setCustomId('setup:logging:pickCategory')
        .setPlaceholder('Select which log category to configure…')
        .setMinValues(1)
        .setMaxValues(1)
        .addOptions(LOGGING_CHANNEL_CATEGORIES.map((cat) => ({
            label: cat.label,
            description: cat.description.slice(0, 100),
            value: cat.key,
            default: Boolean(config.loggingChannels?.[cat.key])
        })));
        components.push(new ActionRowBuilder().addComponents(menu));
    }

    if (mode === 'select-category-channel') {
        const category = context?.category;
        const channels = await collectTextChannels(loggingGuild);
        const menu = new StringSelectMenuBuilder()
        .setCustomId(`setup:logging:setCategory:${category}`)
        .setPlaceholder(loggingGuild ? `Select channel for ${category}` : 'Set logging server first')
        .setMinValues(1)
        .setMaxValues(1)
        .setDisabled(!loggingGuild || channels.length === 0);

        menu.addOptions({ label: 'Clear channel', value: '__clear__', description: 'Remove configured channel for this category.' });

        if (channels.length) {
            menu.addOptions(channels.slice(0, 24).map((ch) => ({
                label: truncateName(ch.name, 100),
                description: `#${ch.name} — ${ch.id}`.slice(0, 100),
                value: ch.id,
                default: config.loggingChannels?.[category] === ch.id
            })));
        }

        components.push(new ActionRowBuilder().addComponents(menu));
    }

    if (mode === 'manage-exclusions') {
        const sourceChannels = await collectTextChannels(sourceGuild);
        const channelMenu = new StringSelectMenuBuilder()
        .setCustomId('setup:logging:excludeChannels')
        .setPlaceholder('Select channels to exclude…')
        .setMinValues(0)
        .setMaxValues(Math.min(25, sourceChannels.length || 1))
        .addOptions(sourceChannels.slice(0, 25).map((ch) => ({
            label: truncateName(ch.name, 100),
            description: `#${ch.name}`.slice(0, 100),
            value: ch.id,
            default: excludedChan.includes(ch.id)
        })));

        const categories = await collectCategories(sourceGuild);
        const categoryMenu = new StringSelectMenuBuilder()
        .setCustomId('setup:logging:excludeCategories')
        .setPlaceholder('Select categories to exclude…')
        .setMinValues(0)
        .setMaxValues(Math.min(25, categories.length || 1))
        .addOptions(categories.slice(0, 25).map((cat) => ({
            label: truncateName(cat.name, 100),
            description: cat.id,
            value: cat.id,
            default: excludedCats.includes(cat.id)
        })));

        components.push(new ActionRowBuilder().addComponents(channelMenu));
        components.push(new ActionRowBuilder().addComponents(categoryMenu));
    }

    return { embeds: [embed], components };
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

function truncateName(name, max) {
    const value = String(name ?? 'Unknown');
    return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function formatChannel(guild, channelId) {
    if (!channelId) return 'Not configured';
    const channel = guild?.channels?.cache?.get?.(channelId);
    if (channel?.isTextBased?.()) {
        return `<#${channel.id}>`;
    }
    return `<#${channelId}>`;
}

function formatCategory(guild, categoryId) {
    if (!categoryId) return 'Not configured';
    const channel = guild?.channels?.cache?.get?.(categoryId);
    if (channel?.type === ChannelType.GuildCategory) {
        return `📂 ${channel.name}`;
    }
    return categoryId;
}

async function collectTextChannels(guild) {
    if (!guild) return [];
    try {
        const collection = await guild.channels.fetch();
        return collection
        .filter(ch => ch && typeof ch.isTextBased === 'function' && ch.isTextBased() && !ch.isThread?.())
        .map(ch => ch)
        .sort((a, b) => (a.rawPosition ?? 0) - (b.rawPosition ?? 0));
    } catch {
        return [];
    }
}

async function collectCategories(guild) {
    if (!guild) return [];
    try {
        const collection = await guild.channels.fetch();
        return collection
        .filter(ch => ch?.type === ChannelType.GuildCategory)
        .map(ch => ch)
        .sort((a, b) => (a.rawPosition ?? 0) - (b.rawPosition ?? 0));
    } catch {
        return [];
    }
}

async function handleWelcomeInteraction({ interaction, entry, config, client, key, guild, logger }) {
    const sourceGuild = guild ?? (entry?.guildId ? await fetchGuild(client, entry.guildId) : null);

    if (interaction.isButton()) {
        const target = interaction.customId.split(':')[2];
        switch (target) {
            case 'setWelcome': {
                const view = await buildWelcomeView({ config, guild: sourceGuild, mode: 'select', context: { target: 'welcome' } });
                const message = await interaction.update(view);
                panelStore.set(key, { message, guildId: sourceGuild?.id ?? null, mode: 'select', context: { target: 'welcome' } });
                return;
            }
            case 'setRules': {
                const view = await buildWelcomeView({ config, guild: sourceGuild, mode: 'select', context: { target: 'rules' } });
                const message = await interaction.update(view);
                panelStore.set(key, { message, guildId: sourceGuild?.id ?? null, mode: 'select', context: { target: 'rules' } });
                return;
            }
            case 'setRoles': {
                const view = await buildWelcomeView({ config, guild: sourceGuild, mode: 'select', context: { target: 'roles' } });
                const message = await interaction.update(view);
                panelStore.set(key, { message, guildId: sourceGuild?.id ?? null, mode: 'select', context: { target: 'roles' } });
                return;
            }
            case 'setVerify': {
                const view = await buildWelcomeView({ config, guild: sourceGuild, mode: 'select', context: { target: 'verify' } });
                const message = await interaction.update(view);
                panelStore.set(key, { message, guildId: sourceGuild?.id ?? null, mode: 'select', context: { target: 'verify' } });
                return;
            }
            case 'refresh': {
                const view = await buildWelcomeView({ config, guild: sourceGuild, mode: 'default', context: {} });
                const message = await interaction.update(view);
                panelStore.set(key, { message, guildId: sourceGuild?.id ?? null, mode: 'default', context: {} });
                return;
            }
            default:
                return;
        }
    }

    if (interaction.isStringSelectMenu()) {
        const target = interaction.customId.split(':')[3];
        const selection = interaction.values?.[0];
        if (!target) {
            const view = await buildWelcomeView({ config, guild: sourceGuild, mode: 'default', context: {} });
            const message = await interaction.update(view);
            panelStore.set(key, { message, guildId: sourceGuild?.id ?? null, mode: 'default', context: {} });
            return;
        }
        if (target === 'welcome') {
            config.welcome.channelId = selection === '__clear__' ? null : selection;
        } else {
            if (!config.welcome.mentions) config.welcome.mentions = {};
            if (selection === '__clear__') {
                delete config.welcome.mentions[target];
            } else {
                config.welcome.mentions[target] = selection;
            }
        }
        saveConfig(config, logger);
        const view = await buildWelcomeView({ config, guild: sourceGuild, mode: 'default', context: {} });
        const message = await interaction.update(view);
        panelStore.set(key, { message, guildId: sourceGuild?.id ?? null, mode: 'default', context: {} });
        await interaction.followUp({ content: 'Welcome configuration updated.', ephemeral: true }).catch(() => {});
    }
}

async function buildWelcomeView({ config, guild, mode, context }) {
    const welcomeCfg = config.welcome || {};
    const mentionMap = welcomeCfg.mentions || {};

    const embed = new EmbedBuilder()
    .setTitle('Welcome card setup')
    .setDescription('Select where welcome and goodbye messages should post.')
    .addFields(
        { name: 'Welcome channel', value: formatChannel(guild, welcomeCfg.channelId) },
        { name: 'Rules mention', value: mentionToDisplay(guild, mentionMap.rules) },
        { name: 'Roles mention', value: mentionToDisplay(guild, mentionMap.roles) },
        { name: 'Verify mention', value: mentionToDisplay(guild, mentionMap.verify) }
    );

    const buttons = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('setup:welcome:setWelcome').setLabel('Set welcome channel').setStyle(ButtonStyle.Primary).setDisabled(!guild),
        new ButtonBuilder().setCustomId('setup:welcome:setRules').setLabel('Set rules channel').setStyle(ButtonStyle.Secondary).setDisabled(!guild),
        new ButtonBuilder().setCustomId('setup:welcome:setRoles').setLabel('Set roles channel').setStyle(ButtonStyle.Secondary).setDisabled(!guild),
        new ButtonBuilder().setCustomId('setup:welcome:setVerify').setLabel('Set verify channel').setStyle(ButtonStyle.Secondary).setDisabled(!guild),
        new ButtonBuilder().setCustomId('setup:welcome:refresh').setLabel('Refresh').setStyle(ButtonStyle.Secondary)
    );

    const components = [buttons];

    if (mode === 'select') {
        const target = context?.target;
        const channels = await collectTextChannels(guild);
        const menu = new StringSelectMenuBuilder()
        .setCustomId(`setup:welcome:apply:${target}`)
        .setPlaceholder('Select a channel…')
        .setMinValues(1)
        .setMaxValues(1)
        .setDisabled(!guild || channels.length === 0);

        menu.addOptions({ label: 'Clear selection', value: '__clear__', description: 'Remove configured channel.' });

        if (channels.length) {
            menu.addOptions(channels.slice(0, 24).map(ch => ({
                label: truncateName(ch.name, 100),
                description: `#${ch.name}`.slice(0, 100),
                value: ch.id,
                default: target === 'welcome'
                    ? welcomeCfg.channelId === ch.id
                    : mentionMap[target] === ch.id
            })));
        }

        components.push(new ActionRowBuilder().addComponents(menu));
    }

    return { embeds: [embed], components };
}

function mentionToDisplay(guild, channelId) {
    if (!channelId) return 'Not configured';
    return formatChannel(guild, channelId);
}

async function handleAutobouncerInteraction({ interaction, entry, config, key, logger }) {
    if (interaction.isButton()) {
        const action = interaction.customId.split(':')[2];
        switch (action) {
            case 'toggle': {
                config.autoban.enabled = config.autoban.enabled === false;
                saveConfig(config, logger);
                const view = buildAutobouncerView({ config });
                const message = await interaction.update(view);
                panelStore.set(key, { message, guildId: entry?.guildId ?? null, mode: 'default', context: {} });
                await interaction.followUp({ content: `Autobouncer is now ${config.autoban.enabled === false ? 'disabled' : 'enabled'}.`, ephemeral: true }).catch(() => {});
                return;
            }
            case 'editKeywords': {
                const keywords = Array.isArray(config.autoban.blockedUsernames) ? config.autoban.blockedUsernames.join('\n') : '';
                const modal = new ModalBuilder()
                .setCustomId('setup:autobouncer:keywordsModal')
                .setTitle('Edit blocked keywords')
                .addComponents(
                    new ActionRowBuilder().addComponents(
                        new TextInputBuilder()
                        .setCustomId('setup:autobouncer:keywordsInput')
                        .setLabel('Keywords (one per line)')
                        .setStyle(TextInputStyle.Paragraph)
                        .setRequired(false)
                        .setValue(keywords)
                    )
                );
                await interaction.showModal(modal);
                return;
            }
            case 'refresh': {
                const view = buildAutobouncerView({ config });
                const message = await interaction.update(view);
                panelStore.set(key, { message, guildId: entry?.guildId ?? null, mode: 'default', context: {} });
                return;
            }
            default:
                return;
        }
    }

    if (interaction.isModalSubmit()) {
        if (interaction.customId === 'setup:autobouncer:keywordsModal') {
            const raw = interaction.fields.getTextInputValue('setup:autobouncer:keywordsInput') ?? '';
            const keywords = raw.split(/\r?\n|,/).map(s => s.trim()).filter(Boolean);
            config.autoban.blockedUsernames = Array.from(new Set(keywords.map(s => s.toLowerCase())));
            saveConfig(config, logger);
            await interaction.reply({ content: `Saved ${config.autoban.blockedUsernames.length} keyword(s).`, ephemeral: true });
            const entryState = panelStore.get(key);
            if (entryState?.message) {
                try {
                    const view = buildAutobouncerView({ config });
                    const message = await entryState.message.edit(view);
                    panelStore.set(key, { message, guildId: entryState.guildId ?? null, mode: 'default', context: {} });
                } catch {}
            }
        }
    }
}

function buildAutobouncerView({ config }) {
    const autobanCfg = config.autoban || {};
    const keywords = Array.isArray(autobanCfg.blockedUsernames) ? autobanCfg.blockedUsernames : [];

    const embed = new EmbedBuilder()
    .setTitle('Autobouncer setup')
    .setDescription('Manage the keyword list used to automatically remove suspicious accounts.')
    .addFields(
        { name: 'Status', value: autobanCfg.enabled === false ? '🚫 Disabled' : '✅ Enabled', inline: true },
        { name: 'Keywords', value: keywords.length ? keywords.map(k => `• ${k}`).slice(0, 10).join('\n') + (keywords.length > 10 ? `\n… ${keywords.length - 10} more` : '') : 'No keywords configured.', inline: false }
    );

    const buttons = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('setup:autobouncer:toggle').setLabel(autobanCfg.enabled === false ? 'Enable' : 'Disable').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('setup:autobouncer:editKeywords').setLabel('Edit keywords').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('setup:autobouncer:refresh').setLabel('Refresh').setStyle(ButtonStyle.Secondary)
    );

    return { embeds: [embed], components: [buttons] };
}

export {
    buildLoggingView,
    buildWelcomeView,
    buildAutobouncerView
};
