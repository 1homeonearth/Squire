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
import { normalizeRainbowBridgeConfig, refresh as refreshRainbowBridge } from '../rainbow-bridge/index.js';
import {
    DEFAULT_WELCOME_MESSAGE,
    LEGACY_DEFAULT_WELCOME_MESSAGE,
    sanitizeWelcomeMessage,
    WELCOME_TEMPLATE_PLACEHOLDERS
} from '../welcome-cards/template.js';

const LOGGING_CHANNEL_CATEGORIES = [
    { key: 'messages', label: 'Message logs', description: 'Cross-server message forwards.' },
    { key: 'moderation', label: 'Moderation alerts', description: 'Bans, kicks, warnings and escalations.' },
    { key: 'joins', label: 'Join & leave', description: 'Member join/leave notifications.' },
    { key: 'system', label: 'System notices', description: 'Automation updates and bot diagnostics.' }
];

const panelStore = new Map(); // `${userId}:${module}` -> { message, guildId, mode, context }
let activeClient = null;

export const commands = [
    new SlashCommandBuilder()
    .setName('setup')
    .setDescription('Configure Squire modules')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
];

export function init({ client, config, logger }) {
    activeClient = client;
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

                const homeKey = panelKey(interaction.user?.id, 'home');
                panelStore.delete(homeKey);

                await interaction.deferReply({ ephemeral: true });
                const guildOptions = await collectManageableGuilds({ client, userId: interaction.user.id });
                const view = await buildHomeView({ client, config, guildOptions });
                const message = await interaction.editReply(view);
                panelStore.set(homeKey, { message, guildOptions, view: 'home' });
                return;
            }

            if (!interaction.customId?.startsWith('setup:') && !interaction.isModalSubmit()) {
                return;
            }

            if (!hasManageGuild(interaction)) {
                if (interaction.isRepliable()) {
                    await interaction.reply({ content: 'You need **Manage Server** permission to do that.', ephemeral: true });
                }
                return;
            }

            if (interaction.customId === 'setup:navigate:home') {
                const homeKey = panelKey(interaction.user?.id, 'home');
                const homeEntry = panelStore.get(homeKey);
                const guildOptions = homeEntry?.guildOptions ?? await collectManageableGuilds({ client, userId: interaction.user.id });
                const view = await buildHomeView({ client, config, guildOptions });
                const message = await interaction.update(view);
                panelStore.set(homeKey, { message, guildOptions, view: 'home' });
                return;
            }

            const module = extractModuleFromInteraction(interaction);
            if (module === 'home') {
                const homeKey = panelKey(interaction.user?.id, 'home');
                const homeEntry = panelStore.get(homeKey) ?? {};
                await handleHomeInteraction({ interaction, config, client, logger, homeKey, homeEntry });
                return;
            }

            const key = panelKey(interaction.user?.id, module);
            const entry = panelStore.get(key);

            if (module === 'logging') {
                await handleLoggingInteraction({ interaction, entry, config, client, logger, key });
                return;
            }

            if (module === 'welcome') {
                await handleWelcomeInteraction({ interaction, entry, config, client, key, logger });
                return;
            }

            if (module === 'autobouncer') {
                await handleAutobouncerInteraction({ interaction, entry, config, key, logger, client });
                return;
            }

            if (module === 'rainbow') {
                await handleRainbowBridgeInteraction({ interaction, entry, config, key, client, logger });
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

    const derivedMain = Object.keys(config.mapping || {});
    config.mainServerIds = sanitizeIdArray(Array.isArray(config.mainServerIds) ? config.mainServerIds : derivedMain);
    if (config.loggingServerId) {
        config.mainServerIds = config.mainServerIds.filter(id => id !== config.loggingServerId);
    }

    config.welcome = normalizeWelcomeMap({
        value: config.welcome,
        fallbackGuilds: config.mainServerIds,
        loggingServerId: config.loggingServerId
    });

    if (!config.autoban || typeof config.autoban !== 'object') {
        config.autoban = {};
    }
    if (!Array.isArray(config.autoban.blockedUsernames)) {
        const value = config.autoban.blockedUsernames;
        config.autoban.blockedUsernames = Array.isArray(value) ? value.map(String) : [];
    } else {
        config.autoban.blockedUsernames = config.autoban.blockedUsernames.map(String);
    }
    if (!Array.isArray(config.autoban.notifyWebhookUrls)) {
        const value = config.autoban.notifyWebhookUrls;
        config.autoban.notifyWebhookUrls = Array.isArray(value) ? value.map(String) : [];
    } else {
        config.autoban.notifyWebhookUrls = config.autoban.notifyWebhookUrls.map(String);
    }
    if (!config.autoban.testRoleMap || typeof config.autoban.testRoleMap !== 'object') {
        config.autoban.testRoleMap = {};
    } else {
        const cleaned = {};
        for (const [guildId, roleId] of Object.entries(config.autoban.testRoleMap)) {
            const gid = typeof guildId === 'string' ? guildId.trim() : String(guildId ?? '').trim();
            const rid = typeof roleId === 'string' ? roleId.trim() : String(roleId ?? '').trim();
            if (!gid || !rid) continue;
            cleaned[gid] = rid;
        }
        config.autoban.testRoleMap = cleaned;
    }
    config.autoban.notifyChannelId = config.autoban.notifyChannelId ? String(config.autoban.notifyChannelId) : null;
    config.autoban.scanBio = config.autoban.scanBio === false ? false : true;

    if (typeof config.sampleRate !== 'number' || Number.isNaN(config.sampleRate)) {
        config.sampleRate = 1;
    }

    config.rainbowBridge = normalizeRainbowBridgeConfig(config.rainbowBridge);
}

function sanitizeIdArray(value) {
    if (!Array.isArray(value)) return [];
    const seen = new Set();
    const out = [];
    for (const entry of value) {
        const str = String(entry);
        if (!str || seen.has(str)) continue;
        seen.add(str);
        out.push(str);
    }
    return out;
}

function normalizeWelcomeMap({ value, fallbackGuilds, loggingServerId }) {
    const out = {};
    if (!value || typeof value !== 'object') {
        return out;
    }

    const entries = Object.entries(value);
    const looksLegacy = 'channelId' in value || 'mentions' in value;
    const looksMap = entries.every(([, v]) => typeof v === 'object' && !Array.isArray(v));

    if (looksLegacy) {
        const targetGuildId = fallbackGuilds?.find(id => id) || loggingServerId || null;
        if (targetGuildId) {
            out[targetGuildId] = normalizeWelcomeEntry(value);
        }
        return out;
    }

    if (!looksMap) {
        return out;
    }

    for (const [guildId, entry] of entries) {
        if (!guildId) continue;
        out[String(guildId)] = normalizeWelcomeEntry(entry);
    }
    return out;
}

function normalizeWelcomeEntry(entry) {
    const obj = entry && typeof entry === 'object' ? entry : {};
    const channelId = obj.channelId ? String(obj.channelId) : null;
    const mentions = {};
    const rawMentions = obj.mentions && typeof obj.mentions === 'object' ? obj.mentions : {};
    for (const key of ['rules', 'roles', 'verify']) {
        if (rawMentions[key]) {
            mentions[key] = String(rawMentions[key]);
        }
    }

    const rolesSource = obj.roles && typeof obj.roles === 'object' ? obj.roles : obj;
    const roles = {
        unverifiedRoleId: rolesSource.unverifiedRoleId ? String(rolesSource.unverifiedRoleId) : null,
        verifiedRoleId: rolesSource.verifiedRoleId ? String(rolesSource.verifiedRoleId) : null,
        crossVerifiedRoleId: rolesSource.crossVerifiedRoleId ? String(rolesSource.crossVerifiedRoleId) : null,
        moderatorRoleId: rolesSource.moderatorRoleId ? String(rolesSource.moderatorRoleId) : null
    };

    const rawPreImage = typeof obj.preImageText === 'string'
        ? obj.preImageText
        : (typeof obj.message === 'string' ? obj.message : null);

    let preImageText = sanitizeWelcomeMessage(rawPreImage ?? '');
    let isCustomized;

    if (typeof obj.isCustomized === 'boolean') {
        isCustomized = obj.isCustomized;
    } else if (!rawPreImage || !rawPreImage.trim()) {
        preImageText = DEFAULT_WELCOME_MESSAGE;
        isCustomized = false;
    } else {
        const normalizedRaw = rawPreImage.replace(/\r\n/g, '\n');
        if (normalizedRaw === LEGACY_DEFAULT_WELCOME_MESSAGE) {
            preImageText = DEFAULT_WELCOME_MESSAGE;
            isCustomized = false;
        } else if (preImageText === LEGACY_DEFAULT_WELCOME_MESSAGE) {
            preImageText = DEFAULT_WELCOME_MESSAGE;
            isCustomized = false;
        } else if (preImageText === DEFAULT_WELCOME_MESSAGE) {
            isCustomized = false;
        } else {
            isCustomized = true;
        }
    }

    if (preImageText === LEGACY_DEFAULT_WELCOME_MESSAGE) {
        preImageText = DEFAULT_WELCOME_MESSAGE;
    }

    const enabled = obj.enabled === false ? false : true;

    return {
        channelId,
        mentions,
        preImageText,
        isCustomized: Boolean(isCustomized),
        enabled,
        headerLine1: 'Welcome',
        headerLine2Template: '{username}',
        roles
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
        broadcastConfigUpdate(config, logger);
        return true;
    } catch (err) {
        logger?.error?.(`[setup] Failed to persist config: ${err?.message ?? err}`);
        return false;
    }
}

function broadcastConfigUpdate(config, logger) {
    if (!activeClient?.emit) return;
    try {
        activeClient.emit('squire:configUpdated', config);
    } catch (err) {
        logger?.warn?.(`[setup] Failed to broadcast config update: ${err?.message ?? err}`);
    }
}

async function collectManageableGuilds({ client, userId }) {
    if (!userId) return [];
    const results = [];
    const seen = new Set();
    for (const guild of client.guilds.cache.values()) {
        if (!guild || seen.has(guild.id)) continue;
        seen.add(guild.id);
        let member = guild.members.cache.get(userId);
        if (!member) {
            try {
                member = await guild.members.fetch({ user: userId, force: false });
            } catch {
                member = null;
            }
        }
        if (!member) continue;
        if (!member.permissions?.has?.(PermissionFlagsBits.ManageGuild)) continue;
        results.push({ id: guild.id, name: guild.name });
    }
    results.sort((a, b) => a.name.localeCompare(b.name));
    return results;
}

async function buildHomeView({ client, config, guildOptions }) {
    const options = Array.isArray(guildOptions) ? guildOptions : [];
    const loggingServerId = config.loggingServerId ?? null;
    const loggingGuild = loggingServerId ? await fetchGuild(client, loggingServerId) : null;

    const optionMap = new Map(options.map(opt => [opt.id, opt.name]));
    if (loggingGuild && !optionMap.has(loggingGuild.id)) {
        optionMap.set(loggingGuild.id, loggingGuild.name);
    }

    const mainServers = Array.isArray(config.mainServerIds) ? config.mainServerIds : [];
    const mainSummary = mainServers.length
        ? mainServers.map(id => `• ${optionMap.get(id) ?? `Server ${id}`} (${id})`).join('\n')
        : 'No main servers selected yet. Use the selector below to choose them.';

    const autobanChannelId = config.autoban?.notifyChannelId ?? null;
    const autobanChannelDisplay = loggingGuild
        ? formatChannel(loggingGuild, autobanChannelId)
        : (autobanChannelId ? `<#${autobanChannelId}>` : 'Not configured');

    const embed = new EmbedBuilder()
    .setTitle('Squire setup overview')
    .setDescription('Manage global targets and jump into module-specific configuration.')
    .addFields(
        {
            name: 'Logging server',
            value: loggingGuild ? `${loggingGuild.name} (${loggingGuild.id})` : 'Not configured',
            inline: false
        },
        {
            name: 'Main servers',
            value: mainSummary,
            inline: false
        },
        {
            name: 'Autobouncer notifications',
            value: autobanChannelDisplay,
            inline: false
        },
        {
            name: 'Rainbow Bridge',
            value: (() => {
                const count = Object.keys(config.rainbowBridge?.bridges ?? {}).length;
                if (!count) return 'No bridges configured yet.';
                return `${count} bridge${count === 1 ? '' : 's'} configured.`;
            })(),
            inline: false
        }
    );

    const components = [];

    const loggingMenu = new StringSelectMenuBuilder()
    .setCustomId('setup:home:loggingServer')
    .setPlaceholder(options.length ? 'Select logging server…' : 'No servers available')
    .setMinValues(1)
    .setMaxValues(1)
    .setDisabled(!options.length);

    const loggingOptions = options.slice(0, 24).map(opt => ({
        label: truncateName(opt.name, 100),
        description: `ID: ${opt.id}`.slice(0, 100),
        value: opt.id,
        default: opt.id === loggingServerId
    }));
    if (loggingGuild && !loggingOptions.find(opt => opt.value === loggingGuild.id)) {
        loggingOptions.unshift({
            label: truncateName(loggingGuild.name, 100),
            description: `ID: ${loggingGuild.id}`.slice(0, 100),
            value: loggingGuild.id,
            default: true
        });
    }
    if (loggingOptions.length) {
        loggingOptions.push({
            label: 'Clear logging server',
            description: 'Remove the logging server configuration.',
            value: '__clear__'
        });
        loggingMenu.addOptions(loggingOptions);
    } else {
        loggingMenu.addOptions({ label: 'No available servers', value: 'noop', default: true });
    }
    components.push(new ActionRowBuilder().addComponents(loggingMenu));

    const filteredMain = options.filter(opt => opt.id !== loggingServerId);
    const mainMenu = new StringSelectMenuBuilder()
    .setCustomId('setup:home:mainServers')
    .setPlaceholder(filteredMain.length ? 'Select main servers…' : 'Add more servers to manage')
    .setMinValues(0)
    .setMaxValues(Math.max(1, Math.min(25, filteredMain.length || 1)))
    .setDisabled(!filteredMain.length);

    const mainOptions = filteredMain.map(opt => ({
        label: truncateName(opt.name, 100),
        description: `ID: ${opt.id}`.slice(0, 100),
        value: opt.id,
        default: mainServers.includes(opt.id)
    }));
    for (const id of mainServers) {
        if (filteredMain.find(opt => opt.id === id)) continue;
        const label = optionMap.get(id) || `Server ${id}`;
        mainOptions.push({
            label: truncateName(label, 100),
            description: `ID: ${id}`.slice(0, 100),
            value: id,
            default: true
        });
    }
    if (mainOptions.length) {
        mainMenu.addOptions(mainOptions.slice(0, 25));
    } else {
        mainMenu.addOptions({ label: 'No selectable servers', value: 'noop', default: true });
    }
    components.push(new ActionRowBuilder().addComponents(mainMenu));

    const moduleMenu = new StringSelectMenuBuilder()
    .setCustomId('setup:home:module')
    .setPlaceholder('Open a setup module…')
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(
        { label: 'Logging', value: 'logging', description: 'Configure webhooks and exclusions.' },
        { label: 'Welcome cards', value: 'welcome', description: 'Choose welcome, rules, roles, and verify channels.' },
        { label: 'Rainbow Bridge', value: 'rainbow', description: 'Link channels together for two-way sync.' },
        { label: 'Autobouncer', value: 'autobouncer', description: 'Manage autoban keywords and notification channel.' }
    );
    components.push(new ActionRowBuilder().addComponents(moduleMenu));

    return { embeds: [embed], components };
}

async function handleHomeInteraction({ interaction, config, client, logger, homeKey, homeEntry }) {
    if (!interaction.isStringSelectMenu()) return;
    const [, , action] = interaction.customId.split(':');
    const guildOptions = homeEntry?.guildOptions ?? await collectManageableGuilds({ client, userId: interaction.user.id });

    if (action === 'loggingServer') {
        const choice = interaction.values?.[0] ?? null;
        if (choice === '__clear__') {
            delete config.loggingServerId;
        } else if (choice && choice !== 'noop') {
            config.loggingServerId = choice;
            config.mainServerIds = sanitizeIdArray((config.mainServerIds || []).filter(id => id !== choice));
        }
        saveConfig(config, logger);

        const view = await buildHomeView({ client, config, guildOptions });
        const message = await interaction.update(view);
        panelStore.set(homeKey, { message, guildOptions, view: 'home' });

        const loggingKey = panelKey(interaction.user?.id, 'logging');
        const loggingEntry = panelStore.get(loggingKey);
        if (loggingEntry) {
            loggingEntry.availableGuildIds = config.mainServerIds;
            panelStore.set(loggingKey, loggingEntry);
        }
        return;
    }

    if (action === 'mainServers') {
        const selections = (interaction.values ?? []).map(String).filter(v => v && v !== 'noop');
        const filtered = selections.filter(id => id !== config.loggingServerId);
        config.mainServerIds = sanitizeIdArray(filtered);
        saveConfig(config, logger);

        const view = await buildHomeView({ client, config, guildOptions });
        const message = await interaction.update(view);
        panelStore.set(homeKey, { message, guildOptions, view: 'home' });

        const loggingKey = panelKey(interaction.user?.id, 'logging');
        const welcomeKey = panelKey(interaction.user?.id, 'welcome');
        const loggingEntry = panelStore.get(loggingKey);
        if (loggingEntry) {
            loggingEntry.availableGuildIds = config.mainServerIds;
            if (loggingEntry.guildId && !config.mainServerIds.includes(loggingEntry.guildId)) {
                loggingEntry.guildId = config.mainServerIds[0] ?? null;
                loggingEntry.mode = 'default';
            }
            panelStore.set(loggingKey, loggingEntry);
        }
        const welcomeEntry = panelStore.get(welcomeKey);
        if (welcomeEntry) {
            welcomeEntry.availableGuildIds = config.mainServerIds.filter(id => id !== config.loggingServerId);
            if (welcomeEntry.guildId && !welcomeEntry.availableGuildIds.includes(welcomeEntry.guildId)) {
                welcomeEntry.guildId = welcomeEntry.availableGuildIds[0] ?? null;
                welcomeEntry.mode = 'default';
            }
            panelStore.set(welcomeKey, welcomeEntry);
        }
        return;
    }

    if (action === 'module') {
        const target = interaction.values?.[0];
        if (!target) {
            await interaction.deferUpdate().catch(() => {});
            return;
        }

        const userId = interaction.user?.id;
        const moduleKey = panelKey(userId, target);
        panelStore.delete(moduleKey);

        if (target === 'logging') {
            const available = config.mainServerIds;
            const initialId = available.find(id => id) ?? null;
            const guild = initialId ? await fetchGuild(client, initialId) : null;
            const view = await buildLoggingView({ config, client, guild, mode: 'default', context: {} });
            const message = await interaction.update(view);
            panelStore.set(moduleKey, {
                message,
                guildId: guild?.id ?? initialId ?? null,
                mode: 'default',
                context: {},
                availableGuildIds: available
            });
            panelStore.set(homeKey, { message, guildOptions, view: 'module', module: 'logging' });
            return;
        }

        if (target === 'welcome') {
            const available = config.mainServerIds.filter(id => id !== config.loggingServerId);
            const view = await buildWelcomeView({ config, client, guild: null, mode: 'chooseGuild', context: { availableGuildIds: available } });
            const message = await interaction.update(view);
            panelStore.set(moduleKey, {
                message,
                guildId: null,
                mode: 'chooseGuild',
                context: {},
                availableGuildIds: available
            });
            panelStore.set(homeKey, { message, guildOptions, view: 'module', module: 'welcome' });
            return;
        }

        if (target === 'rainbow') {
            const view = await buildRainbowBridgeView({
                config,
                client,
                guildOptions,
                mode: 'default',
                context: {}
            });
            const message = await interaction.update(view);
            panelStore.set(moduleKey, {
                message,
                guildOptions,
                mode: 'default',
                context: {}
            });
            panelStore.set(homeKey, { message, guildOptions, view: 'module', module: 'rainbow' });
            return;
        }

        if (target === 'autobouncer') {
            const view = await buildAutobouncerView({ config, client, mode: 'default', context: {} });
            const message = await interaction.update(view);
            panelStore.set(moduleKey, { message, guildId: null, mode: 'default', context: {} });
            panelStore.set(homeKey, { message, guildOptions, view: 'module', module: 'autobouncer' });
            return;
        }
    }
}

async function handleLoggingInteraction({ interaction, entry, config, client, logger, key }) {
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
                const view = await buildLoggingView({
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
                const view = await buildLoggingView({ config, client, guild: sourceGuild, mode: 'default', context: {} });
                const message = await interaction.update(view);
                persistState(message, { mode: 'default', context: {} });
                await interaction.followUp({ content: 'Mapping removed for this server.', ephemeral: true }).catch(() => {});
                return;
            }
            case 'setup:logging:manageChannels': {
                const view = await buildLoggingView({ config, client, guild: sourceGuild, mode: 'choose-category', context: {} });
                const message = await interaction.update(view);
                persistState(message, { mode: 'choose-category', context: {} });
                return;
            }
            case 'setup:logging:manageExclusions': {
                const view = await buildLoggingView({ config, client, guild: sourceGuild, mode: 'manage-exclusions', context: {} });
                const message = await interaction.update(view);
                persistState(message, { mode: 'manage-exclusions', context: {} });
                return;
            }
            case 'setup:logging:toggleBots': {
                config.forwardBots = !config.forwardBots;
                saveConfig(config, logger);
                const view = await buildLoggingView({ config, client, guild: sourceGuild, mode: currentMode, context: baseContext });
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
                const view = await buildLoggingView({ config, client, guild: sourceGuild, mode: 'default', context: {} });
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
                const view = await buildLoggingView({ config, client, guild: nextGuild, mode: 'default', context: {} });
                const message = await interaction.update(view);
                panelStore.set(key, {
                    message,
                    guildId: nextGuild?.id ?? nextGuildId ?? null,
                    mode: 'default',
                    context: {},
                    availableGuildIds
                });
                return;
            }
            case 'createWebhook': {
                const targetChannelId = interaction.values?.[0];
                const sourceGuildId = parts[3] || currentGuildId;
                if (!targetChannelId || !sourceGuildId) {
                    const view = await buildLoggingView({ config, client, guild: sourceGuild, mode: 'default', context: {} });
                    const message = await interaction.update(view);
                    persistState(message, { mode: 'default', context: {} });
                    return;
                }
                const result = await linkGuildToChannel({ config, client, logger, sourceGuildId, channelId: targetChannelId });
                const view = await buildLoggingView({ config, client, guild: await fetchGuild(client, sourceGuildId), mode: 'default', context: {} });
                const message = await interaction.update(view);
                persistState(message, { guildId: sourceGuildId, mode: 'default', context: {} });
                const reply = result.ok ? `Linked **${result.sourceName}** to <#${targetChannelId}>.` : result.error;
                await interaction.followUp({ content: reply, ephemeral: true }).catch(() => {});
                return;
            }
            case 'pickCategory': {
                const category = interaction.values?.[0];
                if (!category) {
                    const view = await buildLoggingView({ config, client, guild: sourceGuild, mode: 'default', context: {} });
                    const message = await interaction.update(view);
                    persistState(message, { mode: 'default', context: {} });
                    return;
                }
                const view = await buildLoggingView({ config, client, guild: sourceGuild, mode: 'select-category-channel', context: { category } });
                const message = await interaction.update(view);
                persistState(message, { mode: 'select-category-channel', context: { category } });
                return;
            }
            case 'setCategory': {
                const category = parts[3];
                const channelId = interaction.values?.[0] ?? null;
                if (!category) {
                    const view = await buildLoggingView({ config, client, guild: sourceGuild, mode: 'default', context: {} });
                    const message = await interaction.update(view);
                    persistState(message, { mode: 'default', context: {} });
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
                const view = await buildLoggingView({ config, client, guild: sourceGuild, mode: 'manage-exclusions', context: {} });
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
                const view = await buildLoggingView({ config, client, guild: sourceGuild, mode: 'manage-exclusions', context: {} });
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
                    const view = await buildLoggingView({ config, client, guild: sourceGuild, mode: currentMode, context: baseContext });
                    const message = await entry.message.edit(view);
                    persistState(message, { mode: currentMode, context: baseContext });
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
    const loggingServerId = config.loggingServerId ?? null;
    const loggingGuild = loggingServerId ? await fetchGuild(client, loggingServerId) : null;
    const selectedGuild = guild ?? null;
    const selectedGuildId = selectedGuild?.id ?? context?.sourceGuildId ?? null;

    const mapping = config.mapping || {};
    const meta = config.loggingWebhookMeta || {};
    const excludeChannels = config.excludeChannels || {};
    const excludeCategories = config.excludeCategories || {};
    const autobanChannelId = config.autoban?.notifyChannelId ?? null;

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
        .setLabel('Set logging channels')
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
        .setLabel('Refresh')
        .setStyle(ButtonStyle.Secondary)
    );

    components.push(buttonsPrimary);
    components.push(buttonsSecondary);

    if (mode === 'select-mapping-channel') {
        const channels = (await collectTextChannels(loggingGuild)).filter(ch => ch.id !== autobanChannelId);
        const menu = new StringSelectMenuBuilder()
        .setCustomId(`setup:logging:createWebhook:${context?.sourceGuildId ?? selectedGuildId ?? 'unknown'}`)
        .setPlaceholder(loggingGuild ? 'Select a logging channel…' : 'Set logging server first')
        .setMinValues(1)
        .setMaxValues(1)
        .setDisabled(!loggingGuild || channels.length === 0);

        if (channels.length) {
            menu.addOptions(channels.slice(0, 25).map((ch) => ({
                label: `ID: ${ch.id}`.slice(0, 100),
                description: `#${truncateName(ch.name, 90)}`.slice(0, 100),
                value: ch.id,
                default: meta[context?.sourceGuildId ?? selectedGuildId]?.channelId === ch.id
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
        const channels = (await collectTextChannels(loggingGuild)).filter(ch => ch.id !== autobanChannelId);
        const menu = new StringSelectMenuBuilder()
        .setCustomId(`setup:logging:setCategory:${category}`)
        .setPlaceholder(loggingGuild ? `Select channel for ${category}` : 'Set logging server first')
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

function sanitizeBridgeId(value) {
    if (!value) return null;
    const cleaned = String(value).trim().toLowerCase().replace(/\s+/g, '-');
    const safe = cleaned.replace(/[^a-z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^[-_]+|[-_]+$/g, '');
    if (!safe) return null;
    return safe.slice(0, 48);
}

function sanitizeSnowflakeId(value) {
    if (value === undefined || value === null) return null;
    const trimmed = String(value).trim();
    return /^\d{15,25}$/.test(trimmed) ? trimmed : null;
}

function isValidWebhookUrl(url) {
    if (typeof url !== 'string') return false;
    const trimmed = url.trim();
    return /^https?:\/\/(?:\w+\.)?discord\.com\/api\/webhooks\/\d+\/[A-Za-z0-9._-]+$/i.test(trimmed);
}

function formatChannel(guild, channelId) {
    if (!channelId) return 'Not configured';
    const channel = guild?.channels?.cache?.get?.(channelId);
    if (channel?.isTextBased?.()) {
        return `<#${channel.id}>`;
    }
    return `<#${channelId}>`;
}

function formatRole(guild, roleId) {
    if (!roleId) return 'Not configured';
    const role = guild?.roles?.cache?.get?.(roleId);
    if (role) {
        return `<@&${role.id}>`;
    }
    return `<@&${roleId}>`;
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

function appendHomeButtonRow(components) {
    components.push(new ActionRowBuilder().addComponents(
        new ButtonBuilder()
        .setCustomId('setup:navigate:home')
        .setLabel('⬅ Back to overview')
        .setStyle(ButtonStyle.Secondary)
    ));
}

async function handleWelcomeInteraction({ interaction, entry, config, client, key, logger }) {
    const availableGuildIds = entry?.availableGuildIds ?? config.mainServerIds.filter(id => id !== config.loggingServerId);
    const currentGuildId = entry?.guildId && availableGuildIds.includes(entry.guildId)
        ? entry.guildId
        : null;
    const targetGuild = currentGuildId ? await fetchGuild(client, currentGuildId).catch(() => null) : null;

    const ensureWelcomeEntry = () => {
        if (!currentGuildId) return null;
        if (!config.welcome || typeof config.welcome !== 'object') {
            config.welcome = {};
        }
        if (!config.welcome[currentGuildId]) {
            config.welcome[currentGuildId] = {
                channelId: null,
                mentions: {},
                preImageText: DEFAULT_WELCOME_MESSAGE,
                isCustomized: false,
                enabled: true,
                headerLine1: 'Welcome',
                headerLine2Template: '{username}',
                roles: {
                    unverifiedRoleId: null,
                    verifiedRoleId: null,
                    crossVerifiedRoleId: null,
                    moderatorRoleId: null
                }
            };
        }
        const entryCfg = config.welcome[currentGuildId];
        if (!entryCfg.mentions || typeof entryCfg.mentions !== 'object') {
            entryCfg.mentions = {};
        }
        if (!entryCfg.roles || typeof entryCfg.roles !== 'object') {
            entryCfg.roles = {
                unverifiedRoleId: null,
                verifiedRoleId: null,
                crossVerifiedRoleId: null,
                moderatorRoleId: null
            };
        }
        entryCfg.preImageText = sanitizeWelcomeMessage(entryCfg.preImageText ?? '');
        if (entryCfg.preImageText === LEGACY_DEFAULT_WELCOME_MESSAGE) {
            entryCfg.preImageText = DEFAULT_WELCOME_MESSAGE;
        }
        if (typeof entryCfg.isCustomized !== 'boolean') {
            entryCfg.isCustomized = entryCfg.preImageText !== DEFAULT_WELCOME_MESSAGE;
        }
        if (!entryCfg.headerLine1) entryCfg.headerLine1 = 'Welcome';
        if (!entryCfg.headerLine2Template) entryCfg.headerLine2Template = '{username}';
        return entryCfg;
    };

    const storePanelState = (message, mode, context, guildOverride = currentGuildId) => {
        panelStore.set(key, {
            message,
            guildId: guildOverride,
            mode,
            context: context ?? {},
            availableGuildIds
        });
    };

    if (interaction.isButton()) {
        const [, , action] = interaction.customId.split(':');

        if (action === 'backToGuilds') {
            const view = await buildWelcomeView({
                config,
                client,
                guild: null,
                mode: 'chooseGuild',
                context: { availableGuildIds }
            });
            const message = await interaction.update(view);
            storePanelState(message, 'chooseGuild', {}, null);
            return;
        }

        if (action === 'backToRoles') {
            if (!currentGuildId || !targetGuild) {
                await interaction.reply({ content: 'Select a server to configure first.', ephemeral: true });
                return;
            }
            const view = await buildWelcomeView({
                config,
                client,
                guild: targetGuild,
                mode: 'roles',
                context: { availableGuildIds }
            });
            const message = await interaction.update(view);
            storePanelState(message, 'roles', {});
            return;
        }

        if (action === 'openChannels') {
            if (!currentGuildId || !targetGuild) {
                await interaction.reply({ content: 'Select a server to configure first.', ephemeral: true });
                return;
            }
            const view = await buildWelcomeView({
                config,
                client,
                guild: targetGuild,
                mode: 'channels',
                context: { availableGuildIds }
            });
            const message = await interaction.update(view);
            storePanelState(message, 'channels', {});
            return;
        }

        if (action === 'update') {
            const previousMode = entry?.mode ?? (currentGuildId ? 'roles' : 'chooseGuild');
            const guildForView = previousMode === 'chooseGuild' ? null : targetGuild;
            const view = await buildWelcomeView({
                config,
                client,
                guild: guildForView,
                mode: previousMode,
                context: { availableGuildIds }
            });
            const message = await interaction.update(view);
            storePanelState(message, previousMode, {}, previousMode === 'chooseGuild' ? null : currentGuildId);
            await interaction.followUp({ content: 'View updated.', ephemeral: true }).catch(() => {});
            return;
        }

        if (action === 'editMessage') {
            if (!currentGuildId || !targetGuild) {
                await interaction.reply({ content: 'Select a server to configure first.', ephemeral: true });
                return;
            }
            const entryCfg = ensureWelcomeEntry();
            if (!entryCfg) {
                await interaction.reply({ content: 'Select a server to configure first.', ephemeral: true });
                return;
            }
            const modal = new ModalBuilder()
            .setCustomId('setup:welcome:messageModal')
            .setTitle('Edit welcome message')
            .addComponents(
                new ActionRowBuilder().addComponents(
                    new TextInputBuilder()
                    .setCustomId('setup:welcome:messageInput')
                    .setLabel('Message template')
                    .setStyle(TextInputStyle.Paragraph)
                    .setRequired(false)
                    .setPlaceholder('Use {{user}}, {{guild}}, {{rules}}, etc.')
                    .setMaxLength(2000)
                    .setValue(entryCfg.preImageText ?? DEFAULT_WELCOME_MESSAGE)
                )
            );
            storePanelState(entry?.message ?? null, entry?.mode ?? 'roles', entry?.context ?? {}, entry?.guildId ?? currentGuildId);
            await interaction.showModal(modal);
            return;
        }

        if (action === 'toggleEnabled') {
            if (!currentGuildId || !targetGuild) {
                await interaction.reply({ content: 'Select a server to configure first.', ephemeral: true });
                return;
            }
            const entryCfg = ensureWelcomeEntry();
            if (!entryCfg) {
                await interaction.reply({ content: 'Select a server to configure first.', ephemeral: true });
                return;
            }
            entryCfg.enabled = entryCfg.enabled === false;
            saveConfig(config, logger);
            const view = await buildWelcomeView({
                config,
                client,
                guild: targetGuild,
                mode: 'roles',
                context: { availableGuildIds }
            });
            const message = await interaction.update(view);
            storePanelState(message, 'roles', {});
            await interaction.followUp({ content: `Welcome cards are now ${entryCfg.enabled ? 'enabled' : 'disabled'}.`, ephemeral: true }).catch(() => {});
            return;
        }

        return;
    }

    if (interaction.isModalSubmit()) {
        if (interaction.customId === 'setup:welcome:messageModal') {
            const entryCfg = ensureWelcomeEntry();
            if (!entryCfg) {
                await interaction.reply({ content: 'Select a server to configure first.', ephemeral: true });
                return;
            }
            const raw = interaction.fields.getTextInputValue('setup:welcome:messageInput') ?? '';
            if (!raw.trim()) {
                entryCfg.preImageText = DEFAULT_WELCOME_MESSAGE;
                entryCfg.isCustomized = false;
            } else {
                const sanitized = sanitizeWelcomeMessage(raw);
                entryCfg.preImageText = sanitized;
                entryCfg.isCustomized = sanitized !== DEFAULT_WELCOME_MESSAGE;
            }
            saveConfig(config, logger);
            await interaction.reply({ content: 'Welcome message updated.', ephemeral: true });
            const entryState = panelStore.get(key);
            if (entryState?.message) {
                try {
                    const guildId = entryState.guildId ?? null;
                    const guildForView = guildId ? await fetchGuild(client, guildId) : null;
                    const view = await buildWelcomeView({
                        config,
                        client,
                        guild: guildForView,
                        mode: entryState.mode ?? (guildForView ? 'roles' : 'chooseGuild'),
                        context: { availableGuildIds: entryState.availableGuildIds ?? availableGuildIds }
                    });
                    const message = await entryState.message.edit(view);
                    storePanelState(message, entryState.mode ?? (guildForView ? 'roles' : 'chooseGuild'), entryState.context ?? {}, guildId);
                } catch {}
            }
        }
        return;
    }

    if (interaction.isAnySelectMenu()) {
        const parts = interaction.customId.split(':');
        const action = parts[2];

        if (action === 'selectGuild') {
            const choice = interaction.values?.[0] ?? null;
            const nextGuildId = choice && choice !== 'noop' ? choice : null;
            const guild = nextGuildId ? await fetchGuild(client, nextGuildId).catch(() => null) : null;
            const mode = nextGuildId ? 'roles' : 'chooseGuild';
            const view = await buildWelcomeView({
                config,
                client,
                guild,
                mode,
                context: { availableGuildIds }
            });
            const message = await interaction.update(view);
            panelStore.set(key, {
                message,
                guildId: nextGuildId,
                mode,
                context: {},
                availableGuildIds
            });
            return;
        }

        if (action === 'roleChoice') {
            if (!currentGuildId || !targetGuild) {
                await interaction.reply({ content: 'Select a server to configure first.', ephemeral: true });
                return;
            }
            const target = parts[3];
            if (!['unverifiedRoleId', 'verifiedRoleId', 'crossVerifiedRoleId', 'moderatorRoleId'].includes(target)) {
                await interaction.reply({ content: 'Unsupported role selector.', ephemeral: true });
                return;
            }
            const entryCfg = ensureWelcomeEntry();
            if (!entryCfg) {
                await interaction.reply({ content: 'Select a server to configure first.', ephemeral: true });
                return;
            }
            const choice = Array.isArray(interaction.values) && interaction.values.length
                ? interaction.values[0]
                : null;
            const nextRoleId = choice && choice !== '__clear__' && choice !== 'noop' ? choice : null;
            entryCfg.roles[target] = nextRoleId;
            saveConfig(config, logger);
            const view = await buildWelcomeView({
                config,
                client,
                guild: targetGuild,
                mode: 'roles',
                context: { availableGuildIds }
            });
            const message = await interaction.update(view);
            storePanelState(message, 'roles', {});
            const text = nextRoleId ? 'Role updated.' : 'Role cleared.';
            await interaction.followUp({ content: text, ephemeral: true }).catch(() => {});
            return;
        }

        if (action === 'channelChoice') {
            if (!currentGuildId || !targetGuild) {
                await interaction.reply({ content: 'Select a server to configure first.', ephemeral: true });
                return;
            }
            const target = parts[3];
            if (!['welcome', 'rules', 'roles', 'verify'].includes(target)) {
                await interaction.reply({ content: 'Unsupported channel selector.', ephemeral: true });
                return;
            }
            const entryCfg = ensureWelcomeEntry();
            if (!entryCfg) {
                await interaction.reply({ content: 'Select a server to configure first.', ephemeral: true });
                return;
            }
            const choice = interaction.values?.[0] ?? null;
            const nextChannelId = choice && choice !== '__clear__' && choice !== 'noop' ? choice : null;
            if (target === 'welcome') {
                entryCfg.channelId = nextChannelId;
            } else {
                entryCfg.mentions[target] = nextChannelId;
            }
            saveConfig(config, logger);
            const view = await buildWelcomeView({
                config,
                client,
                guild: targetGuild,
                mode: 'channels',
                context: { availableGuildIds }
            });
            const message = await interaction.update(view);
            storePanelState(message, 'channels', {});
            await interaction.followUp({ content: 'Channel selection updated.', ephemeral: true }).catch(() => {});
            return;
        }
    }
}

async function buildWelcomeView({ config, client, guild, mode, context }) {
    const availableGuildIds = context?.availableGuildIds ?? config.mainServerIds.filter(id => id !== config.loggingServerId);
    const selectedGuild = guild ?? null;
    const selectedGuildId = selectedGuild?.id ?? null;
    const sourceEntry = selectedGuildId ? config.welcome?.[selectedGuildId] : null;

    const welcomeEntry = {
        channelId: sourceEntry?.channelId ?? null,
        mentions: sourceEntry?.mentions && typeof sourceEntry.mentions === 'object' ? { ...sourceEntry.mentions } : {},
        preImageText: sanitizeWelcomeMessage(sourceEntry?.preImageText ?? sourceEntry?.message ?? DEFAULT_WELCOME_MESSAGE),
        isCustomized: typeof sourceEntry?.isCustomized === 'boolean'
            ? sourceEntry.isCustomized
            : sanitizeWelcomeMessage(sourceEntry?.preImageText ?? sourceEntry?.message ?? DEFAULT_WELCOME_MESSAGE) !== DEFAULT_WELCOME_MESSAGE,
        enabled: sourceEntry?.enabled === false ? false : true,
        roles: {
            unverifiedRoleId: sourceEntry?.roles?.unverifiedRoleId ?? null,
            verifiedRoleId: sourceEntry?.roles?.verifiedRoleId ?? null,
            crossVerifiedRoleId: sourceEntry?.roles?.crossVerifiedRoleId ?? null,
            moderatorRoleId: sourceEntry?.roles?.moderatorRoleId ?? null
        }
    };

    if (welcomeEntry.preImageText === LEGACY_DEFAULT_WELCOME_MESSAGE) {
        welcomeEntry.preImageText = DEFAULT_WELCOME_MESSAGE;
        welcomeEntry.isCustomized = false;
    }

    const mentionMap = welcomeEntry.mentions || {};
    const messageFieldValue = selectedGuild
        ? formatWelcomeMessageField(welcomeEntry.preImageText, welcomeEntry.isCustomized)
        : 'Select a server to begin.';
    const placeholderFieldValue = formatPlaceholderField();

    const helpLines = [];
    if (!selectedGuild || mode === 'chooseGuild') {
        helpLines.push('• Pick a main server below to configure welcome cards for that community.');
    } else if (mode === 'channels') {
        helpLines.push('• Use each dropdown to choose which channel ID should receive the welcome content.');
        helpLines.push('• Select **Clear channel** to remove an assignment.');
        helpLines.push('• Use **Back to role settings** to adjust role assignments.');
    } else {
        helpLines.push('• Update the role ID dropdowns to map each automation hook to a Discord role.');
        helpLines.push('• Choose **Clear selection** to remove an assignment.');
        helpLines.push('• Use **Configure channels** to adjust welcome, rules, roles, and verify targets.');
    }
    helpLines.push('• The welcome card image always renders **Welcome** and the member\'s username on the image itself.');
    helpLines.push('• Moderator pings (if configured) and the sentence `User is cross-verified.` appear in the plaintext before the image.');
    const helpFieldValue = helpLines.join('\n');

    const embed = new EmbedBuilder()
    .setTitle('Welcome card setup')
    .setDescription(selectedGuild
        ? `Updating settings for **${selectedGuild.name}**. Use the controls below to adjust welcome automation.`
        : 'Select a server to configure welcome messaging, autoroles, and verification handling.')
    .addFields(
        { name: 'Module status', value: welcomeEntry.enabled ? '✅ Enabled' : '🚫 Disabled', inline: true },
        { name: 'Welcome channel', value: formatChannel(selectedGuild, welcomeEntry.channelId), inline: true },
        { name: 'Rules mention', value: mentionToDisplay(selectedGuild, mentionMap.rules), inline: true },
        { name: 'Roles mention', value: mentionToDisplay(selectedGuild, mentionMap.roles), inline: true },
        { name: 'Verify mention', value: mentionToDisplay(selectedGuild, mentionMap.verify), inline: true },
        { name: 'Autorole (unverified)', value: formatRole(selectedGuild, welcomeEntry.roles.unverifiedRoleId), inline: true },
        { name: 'Verified role (reference)', value: formatRole(selectedGuild, welcomeEntry.roles.verifiedRoleId), inline: true },
        { name: 'Cross-verified role', value: formatRole(selectedGuild, welcomeEntry.roles.crossVerifiedRoleId), inline: true },
        { name: 'Moderator ping role', value: formatRole(selectedGuild, welcomeEntry.roles.moderatorRoleId), inline: true },
        { name: 'Pre-image text', value: messageFieldValue, inline: false },
        { name: 'Available placeholders', value: placeholderFieldValue, inline: false },
        { name: 'Help', value: helpFieldValue, inline: false }
    );

    const components = [];

    const guildOptions = [];
    for (const id of availableGuildIds.slice(0, 24)) {
        const g = client.guilds.cache.get(id) ?? await fetchGuild(client, id);
        guildOptions.push({
            label: truncateName(g?.name ?? id, 100),
            description: `ID: ${id}`.slice(0, 100),
            value: id,
            default: id === selectedGuildId
        });
    }
    if (selectedGuildId && !guildOptions.find(opt => opt.value === selectedGuildId)) {
        const g = client.guilds.cache.get(selectedGuildId) ?? await fetchGuild(client, selectedGuildId);
        guildOptions.unshift({
            label: truncateName(g?.name ?? selectedGuildId, 100),
            description: `ID: ${selectedGuildId}`.slice(0, 100),
            value: selectedGuildId,
            default: true
        });
    }

    const guildMenu = new StringSelectMenuBuilder()
    .setCustomId('setup:welcome:selectGuild')
    .setPlaceholder(availableGuildIds.length ? 'Select a server to configure…' : 'Add main servers on the overview page')
    .setMinValues(1)
    .setMaxValues(1)
    .setDisabled(!availableGuildIds.length);

    if (guildOptions.length) {
        guildMenu.addOptions(guildOptions);
    } else {
        guildMenu.addOptions({ label: 'No eligible servers', value: 'noop', default: true });
    }

    if (!selectedGuild || mode === 'chooseGuild') {
        components.push(new ActionRowBuilder().addComponents(guildMenu));
        components.push(new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('setup:navigate:home').setLabel('⬅ Back to overview').setStyle(ButtonStyle.Secondary)
        ));
        return { embeds: [embed], components };
    }

    const viewMode = mode === 'channels' ? 'channels' : 'roles';

    const buttonRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('setup:welcome:backToGuilds').setLabel('⬅ Back to server select').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('setup:welcome:update').setLabel('Update view').setStyle(ButtonStyle.Secondary)
    );

    if (viewMode === 'channels') {
        buttonRow.addComponents(
            new ButtonBuilder().setCustomId('setup:welcome:backToRoles').setLabel('Back to role settings').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('setup:welcome:toggleEnabled').setLabel(welcomeEntry.enabled ? 'Disable module' : 'Enable module').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('setup:welcome:editMessage').setLabel('Edit pre-image text').setStyle(ButtonStyle.Primary)
        );
    } else {
        buttonRow.addComponents(
            new ButtonBuilder().setCustomId('setup:welcome:openChannels').setLabel('Configure channels').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('setup:welcome:toggleEnabled').setLabel(welcomeEntry.enabled ? 'Disable module' : 'Enable module').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('setup:welcome:editMessage').setLabel('Edit pre-image text').setStyle(ButtonStyle.Primary)
        );
    }

    components.push(buttonRow);

    if (viewMode === 'channels') {
        const channels = await collectTextChannels(selectedGuild);
        components.push(new ActionRowBuilder().addComponents(buildChannelSelect({
            customId: 'setup:welcome:channelChoice:welcome',
            placeholder: 'Welcome channel',
            channels,
            currentId: welcomeEntry.channelId
        })));
        components.push(new ActionRowBuilder().addComponents(buildChannelSelect({
            customId: 'setup:welcome:channelChoice:rules',
            placeholder: 'Rules mention channel',
            channels,
            currentId: mentionMap.rules ?? null
        })));
        components.push(new ActionRowBuilder().addComponents(buildChannelSelect({
            customId: 'setup:welcome:channelChoice:roles',
            placeholder: 'Roles mention channel',
            channels,
            currentId: mentionMap.roles ?? null
        })));
        components.push(new ActionRowBuilder().addComponents(buildChannelSelect({
            customId: 'setup:welcome:channelChoice:verify',
            placeholder: 'Verify mention channel',
            channels,
            currentId: mentionMap.verify ?? null
        })));
        return { embeds: [embed], components };
    }

    const roles = await collectRoleOptions(selectedGuild);
    components.push(new ActionRowBuilder().addComponents(buildRoleSelect({
        customId: 'setup:welcome:roleChoice:unverifiedRoleId',
        placeholder: 'Autorole (unverified)',
        roles,
        currentId: welcomeEntry.roles.unverifiedRoleId
    })));
    components.push(new ActionRowBuilder().addComponents(buildRoleSelect({
        customId: 'setup:welcome:roleChoice:verifiedRoleId',
        placeholder: 'Verified role (reference)',
        roles,
        currentId: welcomeEntry.roles.verifiedRoleId
    })));
    components.push(new ActionRowBuilder().addComponents(buildRoleSelect({
        customId: 'setup:welcome:roleChoice:crossVerifiedRoleId',
        placeholder: 'Cross-verified role',
        roles,
        currentId: welcomeEntry.roles.crossVerifiedRoleId
    })));
    components.push(new ActionRowBuilder().addComponents(buildRoleSelect({
        customId: 'setup:welcome:roleChoice:moderatorRoleId',
        placeholder: 'Moderator ping role',
        roles,
        currentId: welcomeEntry.roles.moderatorRoleId
    })));

    return { embeds: [embed], components };
}

function buildChannelSelect({ customId, placeholder, channels, currentId }) {
    const menu = new StringSelectMenuBuilder()
    .setCustomId(customId)
    .setPlaceholder(placeholder)
    .setMinValues(1)
    .setMaxValues(1);

    const options = [];
    options.push({
        label: 'Clear channel',
        value: '__clear__',
        description: 'Remove the configured channel.',
        default: !currentId
    });

    for (const ch of channels.slice(0, 24)) {
        options.push({
            label: `ID: ${ch.id}`.slice(0, 100),
            description: `#${truncateName(ch.name, 95)}`.slice(0, 100),
            value: ch.id,
            default: ch.id === currentId
        });
    }

    if (!channels.length) {
        options.push({ label: 'No available channels', value: 'noop', default: true });
    }

    menu.addOptions(options.slice(0, 25));
    return menu;
}

async function collectRoleOptions(guild) {
    if (!guild) return [];
    try {
        await guild.roles.fetch();
    } catch {}
    const roles = Array.from(guild.roles?.cache?.values?.() ?? [])
    .filter(role => role && !role.managed && role.id !== guild.id)
    .sort((a, b) => b.position - a.position);
    return roles;
}

function buildRoleSelect({ customId, placeholder, roles, currentId }) {
    const menu = new StringSelectMenuBuilder()
    .setCustomId(customId)
    .setPlaceholder(placeholder)
    .setMinValues(1)
    .setMaxValues(1);

    const options = [];
    options.push({
        label: 'Clear selection',
        value: '__clear__',
        description: 'Remove the configured role.',
        default: !currentId
    });

    for (const role of roles) {
        if (options.length >= 25) break;
        options.push({
            label: `ID: ${role.id}`.slice(0, 100),
            description: truncateName(role.name, 100),
            value: role.id,
            default: role.id === currentId
        });
    }

    if (!roles.length) {
        options.push({ label: 'No roles available', value: 'noop', default: true });
    }

    menu.addOptions(options.slice(0, 25));
    return menu;
}
function mentionToDisplay(guild, channelId) {
    if (!channelId) return 'Not configured';
    return formatChannel(guild, channelId);
}

function formatWelcomeMessageField(template, isCustomized) {
    const sanitized = sanitizeWelcomeMessage(template ?? '');
    const previewSource = sanitized.replace(/\s+$/u, '');
    if (!previewSource) {
        return 'Using default message.';
    }
    const lines = previewSource.split('\n');
    let preview = lines.slice(0, 4).join('\n');
    if (preview.length > 180) {
        preview = `${preview.slice(0, 177)}…`;
    }
    const block = `\`\`\`\n${preview || ' '}\n\`\`\``;
    const customized = typeof isCustomized === 'boolean'
        ? isCustomized
        : sanitized !== DEFAULT_WELCOME_MESSAGE;
    return customized
        ? `${block}\nCustom message active.`
        : `${block}\nUsing default message.`;
}

function formatPlaceholderField() {
    return WELCOME_TEMPLATE_PLACEHOLDERS
    .map(entry => `${entry.token} — ${entry.description}`)
    .join('\n');
}

async function handleRainbowBridgeInteraction({ interaction, entry, config, key, client, logger }) {
    const guildOptions = entry?.guildOptions ?? await collectManageableGuilds({ client, userId: interaction.user.id });
    const bridges = config.rainbowBridge?.bridges ?? {};

    const updateView = async (mode, context) => {
        const view = await buildRainbowBridgeView({ config, client, guildOptions, mode, context });
        const message = await interaction.update(view);
        panelStore.set(key, { message, guildOptions, mode, context });
    };

    const setStateOnly = (mode, context) => {
        panelStore.set(key, {
            message: entry?.message ?? null,
            guildOptions,
            mode,
            context
        });
    };

    if (interaction.isButton()) {
        const parts = interaction.customId.split(':');
        const action = parts[2];
        const bridgeId = parts[3] || null;

        switch (action) {
            case 'createBridge': {
                const modal = new ModalBuilder()
                .setCustomId('setup:rainbow:createBridgeModal')
                .setTitle('Create a new bridge')
                .addComponents(
                    new ActionRowBuilder().addComponents(
                        new TextInputBuilder()
                        .setCustomId('setup:rainbow:bridgeId')
                        .setLabel('Bridge ID (letters, numbers, - or _)')
                        .setStyle(TextInputStyle.Short)
                        .setRequired(true)
                    ),
                    new ActionRowBuilder().addComponents(
                        new TextInputBuilder()
                        .setCustomId('setup:rainbow:bridgeName')
                        .setLabel('Display name (optional)')
                        .setStyle(TextInputStyle.Short)
                        .setRequired(false)
                    )
                );
                setStateOnly(entry?.mode ?? 'default', entry?.context ?? {});
                await interaction.showModal(modal);
                return;
            }
            case 'manageBridge': {
                if (!Object.keys(bridges).length) {
                    await interaction.reply({ content: 'Create a bridge first, then manage it.', ephemeral: true });
                    return;
                }
                const modal = new ModalBuilder()
                .setCustomId('setup:rainbow:manageBridgeModal')
                .setTitle('Manage a bridge')
                .addComponents(
                    new ActionRowBuilder().addComponents(
                        new TextInputBuilder()
                        .setCustomId('setup:rainbow:manageBridgeId')
                        .setLabel('Bridge ID')
                        .setStyle(TextInputStyle.Short)
                        .setRequired(true)
                        .setPlaceholder('example-bridge')
                    )
                );
                setStateOnly(entry?.mode ?? 'default', entry?.context ?? {});
                await interaction.showModal(modal);
                return;
            }
            case 'refresh': {
                await updateView('default', {});
                return;
            }
            case 'addChannel': {
                if (!bridgeId || !bridges[bridgeId]) {
                    await interaction.reply({ content: 'That bridge no longer exists.', ephemeral: true });
                    return;
                }
                if (!guildOptions.length) {
                    const modal = buildRainbowBridgeAddChannelModal({ bridgeId });
                    setStateOnly('manage', { bridgeId, action: 'add', stage: 'manual-entry' });
                    await interaction.showModal(modal);
                    return;
                }
                await updateView('manage', { bridgeId, action: 'add', stage: 'pick-guild' });
                return;
            }
            case 'removeChannel': {
                if (!bridgeId || !bridges[bridgeId]) {
                    await interaction.reply({ content: 'That bridge no longer exists.', ephemeral: true });
                    return;
                }
                if (!bridges[bridgeId].channels?.length) {
                    await interaction.reply({ content: 'This bridge has no channels yet.', ephemeral: true });
                    return;
                }
                const modalContext = { bridgeId, action: 'remove' };
                if (entry?.message) {
                    try {
                        const view = await buildRainbowBridgeView({ config, client, guildOptions, mode: 'manage', context: modalContext });
                        const message = await entry.message.edit(view);
                        panelStore.set(key, { message, guildOptions, mode: 'manage', context: modalContext });
                    } catch {}
                } else {
                    panelStore.set(key, { message: entry?.message ?? null, guildOptions, mode: 'manage', context: modalContext });
                }
                const modal = new ModalBuilder()
                .setCustomId(`setup:rainbow:removeChannelModal:${bridgeId}`)
                .setTitle('Remove channel from bridge')
                .addComponents(
                    new ActionRowBuilder().addComponents(
                        new TextInputBuilder()
                        .setCustomId('setup:rainbow:removeChannelIds')
                        .setLabel('Channel IDs to remove')
                        .setPlaceholder('One per line or separated by spaces, optional guildId:channelId')
                        .setStyle(TextInputStyle.Paragraph)
                        .setRequired(true)
                    )
                );
                await interaction.showModal(modal);
                return;
            }
            case 'toggleBots': {
                if (!bridgeId || !bridges[bridgeId]) {
                    await interaction.reply({ content: 'That bridge no longer exists.', ephemeral: true });
                    return;
                }
                const inherited = config.rainbowBridge.forwardBots !== false;
                const current = bridges[bridgeId].forwardBots === undefined
                    ? inherited
                    : bridges[bridgeId].forwardBots;
                const next = !current;
                bridges[bridgeId].forwardBots = next;
                config.rainbowBridge = normalizeRainbowBridgeConfig(config.rainbowBridge);
                refreshRainbowBridge();
                saveConfig(config, logger);
                await updateView('manage', { bridgeId });
                await interaction.followUp({
                    content: next
                        ? 'Bot messages will now be mirrored for this bridge.'
                        : 'Bot messages will no longer be mirrored for this bridge.',
                    ephemeral: true
                }).catch(() => {});
                return;
            }
            case 'deleteBridge': {
                if (!bridgeId || !bridges[bridgeId]) {
                    await interaction.reply({ content: 'That bridge no longer exists.', ephemeral: true });
                    return;
                }
                await updateView('manage', { bridgeId, action: 'confirm-delete' });
                return;
            }
            case 'confirmDelete': {
                if (!bridgeId || !bridges[bridgeId]) {
                    await interaction.reply({ content: 'That bridge no longer exists.', ephemeral: true });
                    return;
                }
                const name = bridges[bridgeId].name ?? bridgeId;
                delete bridges[bridgeId];
                config.rainbowBridge = normalizeRainbowBridgeConfig(config.rainbowBridge);
                refreshRainbowBridge();
                saveConfig(config, logger);
                await updateView('default', {});
                await interaction.followUp({ content: `Bridge **${name}** deleted.`, ephemeral: true }).catch(() => {});
                return;
            }
            case 'cancelDelete': {
                if (!bridgeId) {
                    await updateView('default', {});
                    return;
                }
                await updateView('manage', { bridgeId });
                return;
            }
            case 'backToList': {
                await updateView('default', {});
                return;
            }
            default:
                return;
        }
    }

    if (interaction.isStringSelectMenu()) {
        const parts = interaction.customId.split(':');
        const action = parts[2];

        if (action === 'pickGuild') {
            const bridgeId = parts[3] || null;
            if (!bridgeId || !bridges[bridgeId]) {
                await interaction.reply({ content: 'That bridge no longer exists.', ephemeral: true });
                return;
            }
            const choice = interaction.values?.[0] ?? null;
            if (!choice || choice === 'noop') {
                await interaction.reply({ content: 'Select a server to continue adding a channel.', ephemeral: true });
                return;
            }
            const sanitizedGuildId = sanitizeSnowflakeId(choice);
            if (!sanitizedGuildId) {
                await interaction.reply({ content: 'That server selection is invalid.', ephemeral: true });
                return;
            }

            panelStore.set(key, {
                message: entry?.message ?? null,
                guildOptions,
                mode: 'manage',
                context: { bridgeId, action: 'add', stage: 'pick-guild', selectedGuildId: sanitizedGuildId }
            });

            const modal = buildRainbowBridgeAddChannelModal({ bridgeId, guildId: sanitizedGuildId });
            await interaction.showModal(modal);
            return;
        }

        await interaction.reply({
            content: 'Rainbow Bridge management now uses text entry forms. Use the buttons below to open the appropriate form.',
            ephemeral: true
        }).catch(() => {});
        return;
    }

    if (interaction.isModalSubmit()) {
        if (interaction.customId === 'setup:rainbow:createBridgeModal') {
            const rawId = interaction.fields.getTextInputValue('setup:rainbow:bridgeId')?.trim();
            const rawName = interaction.fields.getTextInputValue('setup:rainbow:bridgeName')?.trim();
            const bridgeId = sanitizeBridgeId(rawId);
            if (!bridgeId) {
                await interaction.reply({ content: 'Bridge ID must contain only letters, numbers, hyphens, or underscores.', ephemeral: true });
                return;
            }
            if (bridges[bridgeId]) {
                await interaction.reply({ content: 'A bridge with that ID already exists.', ephemeral: true });
                return;
            }
            const displayName = rawName?.length ? rawName : (rawId?.length ? rawId : bridgeId);
            config.rainbowBridge.bridges = config.rainbowBridge.bridges || {};
            config.rainbowBridge.bridges[bridgeId] = { name: displayName, channels: [] };
            config.rainbowBridge = normalizeRainbowBridgeConfig(config.rainbowBridge);
            refreshRainbowBridge();
            saveConfig(config, logger);
            await interaction.reply({ content: `Bridge **${displayName}** created. Add at least two channels to activate it.`, ephemeral: true });
            if (entry?.message) {
                try {
                    const view = await buildRainbowBridgeView({ config, client, guildOptions, mode: 'manage', context: { bridgeId } });
                    const message = await entry.message.edit(view);
                    panelStore.set(key, { message, guildOptions, mode: 'manage', context: { bridgeId } });
                } catch {}
            }
            return;
        }

        if (interaction.customId === 'setup:rainbow:manageBridgeModal') {
            const rawId = interaction.fields.getTextInputValue('setup:rainbow:manageBridgeId')?.trim();
            const bridgeId = sanitizeBridgeId(rawId);
            if (!bridgeId || !bridges[bridgeId]) {
                await interaction.reply({ content: 'That bridge could not be found. Check the ID and try again.', ephemeral: true });
                return;
            }
            const bridge = bridges[bridgeId];
            if (entry?.message) {
                try {
                    const view = await buildRainbowBridgeView({ config, client, guildOptions, mode: 'manage', context: { bridgeId } });
                    const message = await entry.message.edit(view);
                    panelStore.set(key, { message, guildOptions, mode: 'manage', context: { bridgeId } });
                } catch {}
            } else {
                panelStore.set(key, { message: entry?.message ?? null, guildOptions, mode: 'manage', context: { bridgeId } });
            }
            await interaction.reply({ content: `Managing bridge **${truncateName(bridge.name ?? bridgeId, 80)}**.`, ephemeral: true });
            return;
        }

        if (interaction.customId.startsWith('setup:rainbow:addChannelModal:')) {
            const parts = interaction.customId.split(':');
            const bridgeId = parts[3] || null;
            if (!bridgeId || !bridges[bridgeId]) {
                await interaction.reply({ content: 'That bridge no longer exists.', ephemeral: true });
                return;
            }
            const rawGuildId = interaction.fields.getTextInputValue('setup:rainbow:addChannelGuildId')?.trim();
            const rawChannelId = interaction.fields.getTextInputValue('setup:rainbow:addChannelId')?.trim();
            const rawWebhook = interaction.fields.getTextInputValue('setup:rainbow:addChannelWebhook')?.trim();

            const guildId = sanitizeSnowflakeId(rawGuildId);
            const channelId = sanitizeSnowflakeId(rawChannelId);
            if (!guildId) {
                await interaction.reply({ content: 'Enter a valid guild ID.', ephemeral: true });
                return;
            }
            if (!channelId) {
                await interaction.reply({ content: 'Enter a valid channel ID.', ephemeral: true });
                return;
            }

            const bridge = bridges[bridgeId];
            if (bridge.channels?.some(ch => ch.channelId === channelId)) {
                await interaction.reply({ content: 'That channel is already part of this bridge.', ephemeral: true });
                return;
            }

            const guild = await fetchGuild(client, guildId);
            if (!guild) {
                await interaction.reply({ content: 'I could not access that server. Make sure the bot is still in it.', ephemeral: true });
                return;
            }

            let channel = guild.channels?.cache?.get(channelId) ?? null;
            if (!channel && typeof guild.channels?.fetch === 'function') {
                channel = await guild.channels.fetch(channelId).catch(() => null);
            }
            if (!channel || typeof channel.isTextBased !== 'function' || !channel.isTextBased() || channel.isThread?.()) {
                await interaction.reply({ content: 'That channel is not a standard text channel.', ephemeral: true });
                return;
            }

            let webhookUrl = null;
            if (rawWebhook) {
                if (!isValidWebhookUrl(rawWebhook)) {
                    await interaction.reply({ content: 'That does not look like a valid Discord webhook URL.', ephemeral: true });
                    return;
                }
                webhookUrl = rawWebhook;
            } else {
                try {
                    const desiredName = `Rainbow Bridge • ${truncateName(guild.name ?? guildId, 32)}`;
                    const webhook = await channel.createWebhook({
                        name: desiredName,
                        reason: 'Configured via /setup rainbow bridge'
                    });
                    webhookUrl = `https://discord.com/api/webhooks/${webhook.id}/${webhook.token}`;
                } catch (err) {
                    logger?.warn?.(`[setup] Failed to create webhook for bridge ${bridgeId} in channel ${channelId}: ${err?.message ?? err}`);
                    await interaction.reply({ content: 'I could not create a webhook automatically. Please provide an existing webhook URL when adding the channel.', ephemeral: true });
                    return;
                }
            }

            bridge.channels = Array.isArray(bridge.channels) ? bridge.channels : [];
            bridge.channels.push({ guildId, channelId, webhookUrl });
            config.rainbowBridge = normalizeRainbowBridgeConfig(config.rainbowBridge);
            refreshRainbowBridge();
            saveConfig(config, logger);

            const guildName = guild?.name ?? guildId;
            const channelDisplay = channel?.isTextBased?.() ? `<#${channel.id}>` : `#${channelId}`;
            await interaction.reply({ content: `Linked ${channelDisplay} from **${guildName}** to **${bridge.name ?? bridgeId}**.`, ephemeral: true });

            if (entry?.message) {
                try {
                    const view = await buildRainbowBridgeView({ config, client, guildOptions, mode: 'manage', context: { bridgeId } });
                    const message = await entry.message.edit(view);
                    panelStore.set(key, { message, guildOptions, mode: 'manage', context: { bridgeId } });
                } catch {}
            } else {
                panelStore.set(key, { message: entry?.message ?? null, guildOptions, mode: 'manage', context: { bridgeId } });
            }
            return;
        }

        if (interaction.customId.startsWith('setup:rainbow:removeChannelModal:')) {
            const parts = interaction.customId.split(':');
            const bridgeId = parts[3] || null;
            if (!bridgeId || !bridges[bridgeId]) {
                await interaction.reply({ content: 'That bridge no longer exists.', ephemeral: true });
                return;
            }
            const raw = interaction.fields.getTextInputValue('setup:rainbow:removeChannelIds')?.trim() ?? '';
            const tokens = raw.split(/[\s,]+/).map(token => token.trim()).filter(Boolean);
            const channelIds = new Set();
            const pairIds = new Set();
            for (const token of tokens) {
                if (!token) continue;
                if (token.includes(':')) {
                    const [rawGuild, rawChannel] = token.split(':', 2);
                    const channelId = sanitizeSnowflakeId(rawChannel);
                    if (!channelId) continue;
                    const guildId = sanitizeSnowflakeId(rawGuild);
                    if (guildId) {
                        pairIds.add(`${guildId}:${channelId}`);
                    }
                    channelIds.add(channelId);
                } else {
                    const channelId = sanitizeSnowflakeId(token);
                    if (channelId) {
                        channelIds.add(channelId);
                    }
                }
            }

            if (!channelIds.size && !pairIds.size) {
                await interaction.reply({ content: 'Provide at least one valid channel ID to remove.', ephemeral: true });
                return;
            }

            const before = bridges[bridgeId].channels?.length ?? 0;
            bridges[bridgeId].channels = (bridges[bridgeId].channels || []).filter((channel) => {
                const pairKey = `${channel.guildId}:${channel.channelId}`;
                if (pairIds.has(pairKey)) return false;
                if (channelIds.has(channel.channelId)) return false;
                return true;
            });
            const removed = before - (bridges[bridgeId].channels?.length ?? 0);
            if (!removed) {
                await interaction.reply({ content: 'No matching channels were removed. Check the IDs and try again.', ephemeral: true });
                return;
            }

            config.rainbowBridge = normalizeRainbowBridgeConfig(config.rainbowBridge);
            refreshRainbowBridge();
            saveConfig(config, logger);

            await interaction.reply({ content: `Removed ${removed} channel${removed === 1 ? '' : 's'} from this bridge.`, ephemeral: true });

            if (entry?.message) {
                try {
                    const view = await buildRainbowBridgeView({ config, client, guildOptions, mode: 'manage', context: { bridgeId } });
                    const message = await entry.message.edit(view);
                    panelStore.set(key, { message, guildOptions, mode: 'manage', context: { bridgeId } });
                } catch {}
            } else {
                panelStore.set(key, { message: entry?.message ?? null, guildOptions, mode: 'manage', context: { bridgeId } });
            }
            return;
        }
    }
}

async function buildRainbowBridgeView({ config, client, guildOptions: _guildOptions, mode, context }) {
    const guildOptionList = Array.isArray(_guildOptions) ? _guildOptions : [];
    const embed = new EmbedBuilder()
    .setTitle('🌈 Rainbow Bridge setup')
    .setDescription('Synchronize messages, edits, and deletions across channels in different servers.');

    const components = [];
    const bridges = config.rainbowBridge?.bridges ?? {};
    const bridgeEntries = Object.entries(bridges);
    if (mode === 'default') {
        const summary = bridgeEntries.length
            ? bridgeEntries.map(([id, entry]) => {
                const count = entry.channels?.length ?? 0;
                return `• **${truncateName(entry.name ?? id, 60)}** (\`${id}\`) — ${count} channel${count === 1 ? '' : 's'}`;
            }).join('\n')
            : 'No bridges configured yet. Create one to begin linking channels.';

        embed.addFields({ name: 'Configured bridges', value: summary.slice(0, 1024), inline: false });

        const actionsRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('setup:rainbow:createBridge').setLabel('Create bridge').setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
            .setCustomId('setup:rainbow:manageBridge')
            .setLabel('Manage bridge')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(!bridgeEntries.length),
            new ButtonBuilder().setCustomId('setup:rainbow:refresh').setLabel('Refresh').setStyle(ButtonStyle.Secondary)
        );

        components.push(actionsRow);

        appendHomeButtonRow(components);
        return { embeds: [embed], components };
    }

    if (mode === 'manage') {
        const bridgeId = context?.bridgeId ?? null;
        const bridge = bridgeId ? bridges[bridgeId] : null;
        if (!bridge) {
            embed.addFields({ name: 'Status', value: 'The selected bridge could not be found. Return to the list and choose another.', inline: false });
            components.push(new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('setup:rainbow:backToList').setLabel('Back to bridges').setStyle(ButtonStyle.Secondary)
            ));
            appendHomeButtonRow(components);
            return { embeds: [embed], components };
        }

        const inherited = config.rainbowBridge.forwardBots !== false;
        const bots = bridge.forwardBots === undefined ? inherited : bridge.forwardBots;

        embed
        .setTitle(`🌈 Bridge: ${bridge.name ?? bridgeId}`)
        .addFields(
            { name: 'Bridge ID', value: `\`${bridgeId}\``, inline: true },
            { name: 'Bot messages', value: bots ? '✅ Mirrored' : '🚫 Ignored', inline: true }
        );

        const channelLines = [];
        const guildCache = new Map();
        for (const link of bridge.channels ?? []) {
            if (!guildCache.has(link.guildId)) {
                const fetched = await fetchGuild(client, link.guildId);
                guildCache.set(link.guildId, fetched);
            }
            const guild = guildCache.get(link.guildId);
            const guildName = guild?.name ?? link.guildId;
            let channelDisplay = `<#${link.channelId}>`;
            const channel = guild?.channels?.cache?.get(link.channelId) ?? null;
            if (channel?.isTextBased?.()) {
                channelDisplay = `<#${channel.id}>`;
            }
            channelLines.push(`• ${guildName} — ${channelDisplay}`);
        }

        embed.addFields({
            name: 'Linked channels',
            value: channelLines.length
                ? channelLines.join('\n').slice(0, 1024)
                : 'No channels linked yet. Add at least two channels to activate syncing.',
            inline: false
        });

        if ((bridge.channels?.length ?? 0) < 2) {
            embed.addFields({ name: 'Status', value: 'Add at least two channels so messages can be mirrored between them.', inline: false });
        }

        if (context?.action === 'add') {
            if (context?.stage === 'pick-guild') {
                embed.setFooter({ text: 'Select the server that hosts the channel you want to add.' });
            } else {
                embed.setFooter({ text: 'Use “Add channel” to paste the guild ID, channel ID, and optional webhook URL.' });
            }
        } else if (context?.action === 'remove') {
            embed.setFooter({ text: 'Use “Remove channel” to paste the channel IDs you want to unlink from this bridge.' });
        } else if (context?.action === 'confirm-delete') {
            embed.setFooter({ text: 'This action cannot be undone. Confirm to delete the bridge.' });
        }

        const actionsRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`setup:rainbow:addChannel:${bridgeId}`).setLabel('Add channel').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId(`setup:rainbow:removeChannel:${bridgeId}`).setLabel('Remove channel').setStyle(ButtonStyle.Secondary).setDisabled(!bridge.channels?.length),
            new ButtonBuilder().setCustomId(`setup:rainbow:toggleBots:${bridgeId}`).setLabel(bots ? 'Disable bot mirroring' : 'Enable bot mirroring').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId(`setup:rainbow:deleteBridge:${bridgeId}`).setLabel('Delete bridge').setStyle(ButtonStyle.Danger)
        );

        components.push(actionsRow);
        components.push(new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('setup:rainbow:backToList').setLabel('Back to bridges').setStyle(ButtonStyle.Secondary)
        ));

        if (context?.action === 'confirm-delete') {
            components.push(new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`setup:rainbow:confirmDelete:${bridgeId}`).setLabel('Yes, delete bridge').setStyle(ButtonStyle.Danger),
                new ButtonBuilder().setCustomId(`setup:rainbow:cancelDelete:${bridgeId}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary)
            ));
        }

        if (context?.action === 'add' && context?.stage === 'pick-guild') {
            const menu = new StringSelectMenuBuilder()
            .setCustomId(`setup:rainbow:pickGuild:${bridgeId}`)
            .setPlaceholder(guildOptionList.length ? 'Select a server…' : 'No accessible servers')
            .setMinValues(1)
            .setMaxValues(1)
            .setDisabled(!guildOptionList.length);

            if (guildOptionList.length) {
                menu.addOptions(guildOptionList.slice(0, 25).map((opt) => ({
                    label: truncateName((opt.name ?? opt.id) || opt.id, 100),
                    description: `ID: ${opt.id}`.slice(0, 100),
                    value: opt.id,
                    default: context?.selectedGuildId === opt.id
                })));
            } else {
                menu.addOptions({ label: 'No available servers', value: 'noop', default: true });
            }

            components.push(new ActionRowBuilder().addComponents(menu));
        }

        appendHomeButtonRow(components);
        return { embeds: [embed], components };
    }

    appendHomeButtonRow(components);
    return { embeds: [embed], components };
}

function buildRainbowBridgeAddChannelModal({ bridgeId, guildId }) {
    const sanitizedGuildId = sanitizeSnowflakeId(guildId);
    const guildInput = new TextInputBuilder()
    .setCustomId('setup:rainbow:addChannelGuildId')
    .setLabel('Guild ID')
    .setPlaceholder('123456789012345678')
    .setStyle(TextInputStyle.Short)
    .setRequired(true);

    if (sanitizedGuildId) {
        guildInput.setValue(sanitizedGuildId);
    }

    const channelInput = new TextInputBuilder()
    .setCustomId('setup:rainbow:addChannelId')
    .setLabel('Channel ID')
    .setPlaceholder('123456789012345678')
    .setStyle(TextInputStyle.Short)
    .setRequired(true);

    const webhookInput = new TextInputBuilder()
    .setCustomId('setup:rainbow:addChannelWebhook')
    .setLabel('Existing webhook URL (optional)')
    .setPlaceholder('https://discord.com/api/webhooks/...')
    .setStyle(TextInputStyle.Short)
    .setRequired(false);

    return new ModalBuilder()
    .setCustomId(`setup:rainbow:addChannelModal:${bridgeId}`)
    .setTitle('Add channel to bridge')
    .addComponents(
        new ActionRowBuilder().addComponents(guildInput),
        new ActionRowBuilder().addComponents(channelInput),
        new ActionRowBuilder().addComponents(webhookInput)
    );
}

async function handleAutobouncerInteraction({ interaction, entry, config, key, logger, client }) {
    if (interaction.isButton()) {
        const action = interaction.customId.split(':')[2];
        switch (action) {
            case 'toggle': {
                config.autoban.enabled = config.autoban.enabled === false;
                saveConfig(config, logger);
                const view = await buildAutobouncerView({ config, client, mode: 'default', context: {} });
                const message = await interaction.update(view);
                panelStore.set(key, { message, guildId: entry?.guildId ?? null, mode: 'default', context: {} });
                await interaction.followUp({ content: `Autobouncer is now ${config.autoban.enabled === false ? 'disabled' : 'enabled'}.`, ephemeral: true }).catch(() => {});
                return;
            }
            case 'toggleBio': {
                config.autoban.scanBio = config.autoban.scanBio === false;
                saveConfig(config, logger);
                const view = await buildAutobouncerView({ config, client, mode: 'default', context: {} });
                const message = await interaction.update(view);
                panelStore.set(key, { message, guildId: entry?.guildId ?? null, mode: 'default', context: {} });
                await interaction.followUp({ content: `Autobouncer bio scanning is now ${config.autoban.scanBio === false ? 'disabled' : 'enabled'}.`, ephemeral: true }).catch(() => {});
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
                const currentMode = entry?.mode ?? 'default';
                const currentContext = entry?.context ?? {};
                const view = await buildAutobouncerView({ config, client, mode: currentMode, context: currentContext });
                const message = await interaction.update(view);
                panelStore.set(key, { message, guildId: entry?.guildId ?? null, mode: currentMode, context: currentContext });
                return;
            }
            case 'backToOverview': {
                const view = await buildAutobouncerView({ config, client, mode: 'default', context: {} });
                const message = await interaction.update(view);
                panelStore.set(key, { message, guildId: entry?.guildId ?? null, mode: 'default', context: {} });
                return;
            }
            case 'refreshGuild': {
                const guildId = interaction.customId.split(':')[3] ?? null;
                if (!guildId || guildId === 'unknown') {
                    await interaction.reply({ content: 'The selected server could not be reloaded. Return to the overview and pick it again.', ephemeral: true }).catch(() => {});
                    return;
                }
                const view = await buildAutobouncerView({ config, client, mode: 'test-role', context: { guildId } });
                const message = await interaction.update(view);
                panelStore.set(key, { message, guildId: entry?.guildId ?? null, mode: 'test-role', context: { guildId } });
                await interaction.followUp({ content: 'Reloaded the server roles.', ephemeral: true }).catch(() => {});
                return;
            }
            case 'clearTestRole': {
                const guildId = interaction.customId.split(':')[3] ?? null;
                if (!guildId || guildId === 'unknown') {
                    await interaction.reply({ content: 'That server selection expired. Return to the overview and choose it again.', ephemeral: true }).catch(() => {});
                    return;
                }
                if (!config.autoban.testRoleMap || typeof config.autoban.testRoleMap !== 'object') {
                    config.autoban.testRoleMap = {};
                }
                delete config.autoban.testRoleMap[guildId];
                saveConfig(config, logger);
                const view = await buildAutobouncerView({ config, client, mode: 'test-role', context: { guildId } });
                const message = await interaction.update(view);
                panelStore.set(key, { message, guildId: entry?.guildId ?? null, mode: 'test-role', context: { guildId } });
                const guild = await fetchGuild(client, guildId).catch(() => null);
                const guildName = guild?.name ?? guildId;
                await interaction.followUp({ content: `Cleared the test role override for **${guildName}**.`, ephemeral: true }).catch(() => {});
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
                    const view = await buildAutobouncerView({
                        config,
                        client,
                        mode: entryState.mode ?? 'default',
                        context: entryState.context ?? {}
                    });
                    const message = await entryState.message.edit(view);
                    panelStore.set(key, {
                        message,
                        guildId: entryState.guildId ?? null,
                        mode: entryState.mode ?? 'default',
                        context: entryState.context ?? {}
                    });
                } catch {}
            }
        }
    }
    if (interaction.isStringSelectMenu()) {
        const parts = interaction.customId.split(':');
        if (parts[2] === 'setChannel') {
            const choice = interaction.values?.[0] ?? null;
            if (choice === '__clear__') {
                config.autoban.notifyChannelId = null;
            } else if (choice && choice !== 'noop') {
                config.autoban.notifyChannelId = choice;
            }
            saveConfig(config, logger);
            const view = await buildAutobouncerView({ config, client, mode: 'default', context: {} });
            const message = await interaction.update(view);
            panelStore.set(key, { message, guildId: entry?.guildId ?? null, mode: 'default', context: {} });
            await interaction.followUp({ content: choice === '__clear__' ? 'Autobouncer notifications disabled.' : 'Autobouncer notifications channel updated.', ephemeral: true }).catch(() => {});
        } else if (parts[2] === 'pickTestRoleGuild') {
            const guildId = interaction.values?.[0] ?? null;
            if (!guildId || guildId === 'noop') {
                await interaction.reply({ content: 'Select a server to update the test role override.', ephemeral: true }).catch(() => {});
                return;
            }
            const view = await buildAutobouncerView({ config, client, mode: 'test-role', context: { guildId } });
            const message = await interaction.update(view);
            panelStore.set(key, { message, guildId: entry?.guildId ?? null, mode: 'test-role', context: { guildId } });
            return;
        } else if (parts[2] === 'chooseTestRole') {
            const guildId = parts[3] ?? null;
            const choice = interaction.values?.[0] ?? null;
            if (!guildId || guildId === 'unknown') {
                await interaction.reply({ content: 'That selection expired. Return to the overview and choose the server again.', ephemeral: true }).catch(() => {});
                return;
            }
            if (!config.autoban.testRoleMap || typeof config.autoban.testRoleMap !== 'object') {
                config.autoban.testRoleMap = {};
            }
            const guild = await fetchGuild(client, guildId).catch(() => null);
            const guildName = guild?.name ?? guildId;
            let content;
            if (!choice || choice === 'noop') {
                await interaction.reply({ content: 'Pick a role or choose **Clear test role override**.', ephemeral: true }).catch(() => {});
                return;
            }
            if (choice === '__clear__') {
                delete config.autoban.testRoleMap[guildId];
                content = `Cleared the test role override for **${guildName}**.`;
            } else {
                config.autoban.testRoleMap[guildId] = choice;
                content = `Set the test role override for **${guildName}** to <@&${choice}>.`;
            }
            saveConfig(config, logger);
            const view = await buildAutobouncerView({ config, client, mode: 'test-role', context: { guildId } });
            const message = await interaction.update(view);
            panelStore.set(key, { message, guildId: entry?.guildId ?? null, mode: 'test-role', context: { guildId } });
            await interaction.followUp({ content, ephemeral: true }).catch(() => {});
                return;
        }
    }
}

async function buildAutobouncerView({ config, client, mode = 'default', context = {} }) {
    const autobanCfg = config.autoban || {};
    const keywords = Array.isArray(autobanCfg.blockedUsernames) ? autobanCfg.blockedUsernames : [];
    const testRoleMap = autobanCfg.testRoleMap && typeof autobanCfg.testRoleMap === 'object' ? autobanCfg.testRoleMap : {};

    if (mode === 'test-role') {
        const guildId = context?.guildId ?? null;
        const guild = guildId ? await fetchGuild(client, guildId).catch(() => null) : null;
        const roles = guild ? await collectRoleOptions(guild) : [];
        const currentRoleId = guildId && typeof testRoleMap[guildId] === 'string' ? testRoleMap[guildId] : null;

        const embed = new EmbedBuilder()
        .setTitle('Autobouncer test role override')
        .setDescription('Pick which role the autobouncer should treat as “already passed” when running its simulated sweeps for this server.')
        .addFields(
            {
                name: 'Server',
                value: guild
                    ? `**${truncateName(guild.name, 70)}**\n\`${guild.id}\``
                    : guildId
                        ? `Server unavailable\n\`${guildId}\``
                        : 'Server selection expired.',
                inline: false
            },
            {
                name: 'Current override',
                value: currentRoleId ? formatRole(guild, currentRoleId) : 'No test role override configured.',
                inline: false
            }
        );

        const components = [];
        const navRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
            .setCustomId('setup:autobouncer:backToOverview')
            .setLabel('⬅ Back to autobouncer')
            .setStyle(ButtonStyle.Secondary)
        );

        if (guildId) {
            navRow.addComponents(
                new ButtonBuilder()
                .setCustomId(`setup:autobouncer:refreshGuild:${guildId}`)
                .setLabel('Refresh roles')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(!guild)
            );
            if (currentRoleId) {
                navRow.addComponents(
                    new ButtonBuilder()
                    .setCustomId(`setup:autobouncer:clearTestRole:${guildId}`)
                    .setLabel('Clear test role')
                    .setStyle(ButtonStyle.Secondary)
                );
            }
        }

        components.push(navRow);

        const roleMenu = new StringSelectMenuBuilder()
        .setCustomId(`setup:autobouncer:chooseTestRole:${guildId ?? 'unknown'}`)
        .setPlaceholder(guild ? 'Select a role or clear the override…' : 'Server unavailable')
        .setMinValues(1)
        .setMaxValues(1)
        .setDisabled(!guildId);

        const roleOptions = [
            {
                label: currentRoleId ? 'Clear test role override' : 'Leave override empty',
                value: '__clear__',
                description: 'Fall back to the autorole and welcome defaults.',
                default: !currentRoleId
            }
        ];

        if (roles.length) {
            for (const role of roles) {
                if (roleOptions.length >= 25) break;
                roleOptions.push({
                    label: `ID: ${role.id}`.slice(0, 100),
                    description: truncateName(role.name, 100),
                    value: role.id,
                    default: role.id === currentRoleId
                });
            }
        } else if (guild) {
            roleOptions.push({
                label: 'No additional roles available',
                value: 'noop',
                description: 'Roles may be managed or hidden from me.',
                default: false
            });
        } else {
            roleOptions.push({
                label: 'Unable to load roles',
                value: 'noop',
                description: 'Re-open this server after re-inviting Squire.',
                default: false
            });
        }

        roleMenu.addOptions(roleOptions.slice(0, 25));
        components.push(new ActionRowBuilder().addComponents(roleMenu));
        appendHomeButtonRow(components);
        return { embeds: [embed], components };
    }

    const loggingGuildId = config.loggingServerId ?? null;
    const loggingGuild = loggingGuildId ? await fetchGuild(client, loggingGuildId) : null;
    const channels = loggingGuild ? await collectTextChannels(loggingGuild) : [];
    const notifyChannelId = autobanCfg.notifyChannelId ?? null;

    const embed = new EmbedBuilder()
    .setTitle('Autobouncer setup')
    .setDescription('Manage the keyword list used to automatically remove suspicious accounts and stale-role sweeps.')
    .addFields(
        { name: 'Status', value: autobanCfg.enabled === false ? '🚫 Disabled' : '✅ Enabled', inline: true },
        { name: 'Logging channel', value: loggingGuild ? formatChannel(loggingGuild, notifyChannelId) : (notifyChannelId ? `<#${notifyChannelId}>` : 'Not configured'), inline: true },
        { name: 'Bio scanning', value: autobanCfg.scanBio === false ? '🚫 Disabled' : '✅ Enabled', inline: true },
        { name: 'Keywords', value: keywords.length ? keywords.map(k => `• ${k}`).slice(0, 10).join('\n') + (keywords.length > 10 ? `\n… ${keywords.length - 10} more` : '') : 'No keywords configured.', inline: false }
    );

    const candidateGuildIds = new Set();
    if (Array.isArray(config.mainServerIds)) {
        for (const id of config.mainServerIds) {
            if (id) candidateGuildIds.add(String(id));
        }
    }
    if (config.welcome && typeof config.welcome === 'object') {
        for (const id of Object.keys(config.welcome)) {
            if (id) candidateGuildIds.add(String(id));
        }
    }
    for (const id of Object.keys(testRoleMap)) {
        if (id) candidateGuildIds.add(String(id));
    }

    const guildInfo = [];
    const sortedIds = [...candidateGuildIds].filter(Boolean).sort((a, b) => a.localeCompare(b));
    for (const guildId of sortedIds) {
        const guild = await fetchGuild(client, guildId).catch(() => null);
        const name = guild?.name ?? `Server ${guildId}`;
        const welcomeEntry = config.welcome?.[guildId] ?? {};
        const roles = welcomeEntry?.roles ?? {};
        const unverifiedRoleId = roles?.unverifiedRoleId ? String(roles.unverifiedRoleId) : null;
        const testRoleId = typeof testRoleMap[guildId] === 'string' ? testRoleMap[guildId] : null;
        guildInfo.push({ guildId, guild, name, unverifiedRoleId, testRoleId });
    }
    guildInfo.sort((a, b) => a.name.localeCompare(b.name));

    const summaryTargets = guildInfo.filter(info => info.unverifiedRoleId || info.testRoleId);
    let summaryValue;
    if (summaryTargets.length) {
        const lines = summaryTargets.map(info => {
            const unverifiedDisplay = info.unverifiedRoleId
                ? formatRole(info.guild, info.unverifiedRoleId)
                : 'Not configured';
            const testDisplay = info.testRoleId
                ? formatRole(info.guild, info.testRoleId)
                : 'Not configured';
            return `• **${truncateName(info.name, 60)}** — unverified: ${unverifiedDisplay} • test: ${testDisplay}`;
        });
        const limited = lines.slice(0, 10);
        summaryValue = limited.join('\n');
        if (lines.length > limited.length) {
            summaryValue += `\n… ${lines.length - limited.length} more`;
        }
        summaryValue = summaryValue.slice(0, 1024);
    } else {
        summaryValue = 'No tracked roles configured yet. Configure the welcome autorole or set a test role override below.';
    }

    embed.addFields({ name: 'Role sweeps', value: summaryValue, inline: false });

    const buttons = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('setup:autobouncer:toggle').setLabel(autobanCfg.enabled === false ? 'Enable' : 'Disable').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('setup:autobouncer:toggleBio').setLabel(autobanCfg.scanBio === false ? 'Enable bio scan' : 'Disable bio scan').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('setup:autobouncer:editKeywords').setLabel('Edit keywords').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('setup:autobouncer:refresh').setLabel('Refresh').setStyle(ButtonStyle.Secondary)
    );
    const channelMenu = new StringSelectMenuBuilder()
    .setCustomId('setup:autobouncer:setChannel')
    .setPlaceholder(loggingGuild ? 'Select a logging channel…' : 'Set logging server first')
    .setMinValues(1)
    .setMaxValues(1)
    .setDisabled(!loggingGuild || channels.length === 0);

    channelMenu.addOptions({ label: 'Leave blank', value: '__clear__', description: 'Disable autobouncer notifications.' });

    if (channels.length) {
        channelMenu.addOptions(channels.slice(0, 24).map(ch => ({
            label: `ID: ${ch.id}`.slice(0, 100),
            description: `#${truncateName(ch.name, 90)}`.slice(0, 100),
            value: ch.id,
            default: notifyChannelId === ch.id
        })));
    } else {
        channelMenu.addOptions({ label: 'No available channels', value: 'noop', default: true });
    }

    const testRoleMenu = new StringSelectMenuBuilder()
    .setCustomId('setup:autobouncer:pickTestRoleGuild')
    .setPlaceholder(guildInfo.length ? 'Select a server to configure test role…' : 'No servers available')
    .setMinValues(1)
    .setMaxValues(1)
    .setDisabled(guildInfo.length === 0);

    if (guildInfo.length) {
        testRoleMenu.addOptions(guildInfo.slice(0, 25).map(info => {
            const description = info.testRoleId
                ? `Override → ${formatRole(info.guild, info.testRoleId)}`.slice(0, 100)
                : 'No test role override set';
            return {
                label: truncateName(info.name, 100),
                description,
                value: info.guildId
            };
        }));
    } else {
        testRoleMenu.addOptions({ label: 'No servers available', value: 'noop', default: true });
    }

    const components = [
        buttons,
        new ActionRowBuilder().addComponents(channelMenu),
        new ActionRowBuilder().addComponents(testRoleMenu)
    ];
    appendHomeButtonRow(components);

    return { embeds: [embed], components };
}

export {
    buildLoggingView,
    buildWelcomeView,
    buildAutobouncerView
};
