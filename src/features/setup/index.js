// src/features/setup/index.js
import {
    SlashCommandBuilder,
    PermissionFlagsBits,
    EmbedBuilder,
    ActionRowBuilder,
    StringSelectMenuBuilder
} from 'discord.js';

import { writeConfig } from '../../core/config.js';
import { createLoggingSetup } from '../logging-forwarder/setup.js';
import { createWelcomeSetup } from '../welcome-cards/setup.js';
import { createEmbedBuilderSetup } from '../embed-builder/setup.js';
import { createRainbowBridgeSetup } from '../rainbow-bridge/setup.js';
import { createAutobouncerSetup } from '../auto-bouncer/setup.js';
import { createExperienceSetup } from '../experience/setup.js';
import { createPlaylistsSetup } from '../playlists/setup.js';
import { createSpotlightSetup } from '../spotlight-gallery/setup.js';
import { normalizePlaylistsConfig } from '../playlists/index.js';
import { createModerationSetup } from '../moderation-commands/setup.js';
import { createModerationLoggingSetup } from '../moderation-logging/setup.js';
import { normalizeSpotlightConfig } from '../spotlight-gallery/index.js';
import {
    appendHomeButtonRow,
    formatChannel,
    sanitizeSnowflakeId,
    truncateName
} from './shared.js';

const panelStore = new Map(); // `${userId}:${module}` -> { message, guildId, mode, context }
let activeClient = null;

const loggingSetup = createLoggingSetup({ panelStore, saveConfig, fetchGuild });
const welcomeSetup = createWelcomeSetup({ panelStore, saveConfig, fetchGuild });
const rainbowSetup = createRainbowBridgeSetup({ panelStore, saveConfig, fetchGuild, collectManageableGuilds });
const autobouncerSetup = createAutobouncerSetup({ panelStore, saveConfig, fetchGuild });
const embedBuilderSetup = createEmbedBuilderSetup({ panelStore, saveConfig, fetchGuild });
const experienceSetup = createExperienceSetup({ panelStore, saveConfig });
const playlistsSetup = createPlaylistsSetup({ panelStore, saveConfig });
const spotlightSetup = createSpotlightSetup({ panelStore, saveConfig, fetchGuild });
const moderationSetup = createModerationSetup({ panelStore, saveConfig, fetchGuild, collectManageableGuilds });
const moderationLoggingSetup = createModerationLoggingSetup({ panelStore, saveConfig, fetchGuild });

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
                await loggingSetup.handleInteraction({ interaction, entry, config, client, logger, key });
                return;
            }

            if (module === 'welcome') {
                await welcomeSetup.handleInteraction({ interaction, entry, config, client, key, logger });
                return;
            }

            if (module === 'autobouncer') {
                await autobouncerSetup.handleInteraction({ interaction, entry, config, key, logger, client });
                return;
            }

            if (module === 'rainbow') {
                await rainbowSetup.handleInteraction({ interaction, entry, config, key, client, logger });
                return;
            }

            if (module === 'embed') {
                await embedBuilderSetup.handleInteraction({ interaction, entry, config, client, key, logger });
                return;
            }

            if (module === 'experience') {
                await experienceSetup.handleInteraction({ interaction, entry, config, client, key, logger });
                return;
            }

            if (module === 'playlists') {
                await playlistsSetup.handleInteraction({ interaction, entry, config, key, logger });
                return;
            }

            if (module === 'spotlight') {
                await spotlightSetup.handleInteraction({ interaction, entry, config, client, key, logger });
                return;
            }

            if (module === 'moderation') {
                await moderationSetup.handleInteraction({ interaction, entry, config, client, key, logger });
                return;
            }

            if (module === 'modlog') {
                await moderationLoggingSetup.handleInteraction({ interaction, entry, config, client, key, logger });
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
    const derivedMain = Object.keys(config.mapping || {});
    config.mainServerIds = sanitizeIdArray(Array.isArray(config.mainServerIds) ? config.mainServerIds : derivedMain);
    if (config.loggingServerId) {
        config.mainServerIds = config.mainServerIds.filter(id => id !== config.loggingServerId);
    }

    loggingSetup.prepareConfig(config);
    welcomeSetup.prepareConfig(config, {
        fallbackGuilds: config.mainServerIds,
        loggingServerId: config.loggingServerId
    });
    autobouncerSetup.prepareConfig(config);
    rainbowSetup.prepareConfig(config);
    embedBuilderSetup.prepareConfig(config);
    experienceSetup.prepareConfig(config);
    playlistsSetup.prepareConfig(config);
    spotlightSetup.prepareConfig(config);
    moderationSetup.prepareConfig(config);
    moderationLoggingSetup.prepareConfig(config);
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

    const playlistSummary = (() => {
        const normalized = normalizePlaylistsConfig(config.playlists);
        const spotify = normalized.spotify ? 'Spotify: ✅ configured' : 'Spotify: ⚠️ configure credentials';
        const youtube = normalized.youtube ? 'YouTube: ✅ configured' : 'YouTube: ⚠️ configure credentials';
        return `${spotify}\n${youtube}`;
    })();

    const spotlightSummary = (() => {
        const normalized = normalizeSpotlightConfig(config.spotlightGallery);
        const entries = Object.values(normalized);
        if (!entries.length) {
            return 'No servers configured yet.';
        }
        const enabled = entries.filter(entry => entry.enabled && entry.channelId).length;
        return `${enabled}/${entries.length} server${entries.length === 1 ? '' : 's'} forwarding highlights.`;
    })();

    const moderationSummary = (() => {
        const roleMap = config.moderationCommands?.roleMap ?? {};
        const entries = Object.values(roleMap).filter(value => Array.isArray(value) && value.length);
        if (!entries.length) {
            return 'No moderator roles selected yet.';
        }
        const roleCount = entries.reduce((total, list) => total + list.length, 0);
        return `${roleCount} role${roleCount === 1 ? '' : 's'} across ${entries.length} server${entries.length === 1 ? '' : 's'}.`;
    })();

    const moderationLoggingSummary = (() => {
        const cfg = config.moderationLogging || {};
        const selections = [cfg.categoryChannelId, cfg.actionChannelId].filter(Boolean).length;
        if (!selections) {
            return 'No moderation logging channels selected yet.';
        }
        return `${selections}/2 destinations configured.`;
    })();

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
        },
        {
            name: 'Experience Points',
            value: (() => {
                const guildEntries = Object.values(config.experience ?? {});
                if (!guildEntries.length) return 'No experience points rules configured yet.';
                const ruleCount = guildEntries.reduce((total, entry) => total + (entry?.rules?.length ?? 0), 0);
                return `${ruleCount} rule set${ruleCount === 1 ? '' : 's'} across ${guildEntries.length} server${guildEntries.length === 1 ? '' : 's'}.`;
            })(),
            inline: false
        },
        {
            name: 'Moderation commands',
            value: moderationSummary,
            inline: false
        },
        {
            name: 'Moderation logging',
            value: moderationLoggingSummary,
            inline: false
        },
        {
            name: 'Playlist relay',
            value: playlistSummary,
            inline: false
        },
        {
            name: 'Spotlight gallery',
            value: spotlightSummary,
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

    if (loggingServerId && !loggingOptions.find(opt => opt.value === loggingServerId)) {
        loggingOptions.unshift({
            label: truncateName(loggingGuild?.name ?? loggingServerId, 100),
            description: `ID: ${loggingServerId}`.slice(0, 100),
            value: loggingServerId,
            default: true
        });
    }

    if (loggingOptions.length) {
        loggingMenu.addOptions(loggingOptions);
    } else {
        loggingMenu.addOptions({ label: 'No logging server configured', value: 'noop', default: true });
    }
    components.push(new ActionRowBuilder().addComponents(loggingMenu));

    const mainMenu = new StringSelectMenuBuilder()
    .setCustomId('setup:home:mainServers')
    .setPlaceholder(options.length ? 'Select main servers…' : 'No servers available')
    .setMinValues(0)
    .setMaxValues(Math.min(25, options.length || 1))
    .setDisabled(!options.length);

    const mainOpts = options.slice(0, 25).map(opt => ({
        label: truncateName(opt.name, 100),
        description: `ID: ${opt.id}`.slice(0, 100),
        value: opt.id,
        default: config.mainServerIds?.includes(opt.id) ?? false
    }));
    if (mainOpts.length) {
        mainMenu.addOptions(mainOpts);
    } else {
        mainMenu.addOptions({ label: 'No main servers configured', value: 'noop', default: true });
    }
    components.push(new ActionRowBuilder().addComponents(mainMenu));

    const moduleMenu = new StringSelectMenuBuilder()
    .setCustomId('setup:home:module')
    .setPlaceholder('Open module setup…')
    .addOptions(
        { label: 'Logging', value: 'logging', description: 'Map main servers to logging channels.' },
        { label: 'Welcome cards', value: 'welcome', description: 'Configure welcome automation and autoroles.' },
        { label: 'Rainbow Bridge', value: 'rainbow', description: 'Link channels across servers.' },
        { label: 'Autobouncer', value: 'autobouncer', description: 'Manage autoban keywords and notification channel.' },
        { label: 'Embed builder', value: 'embed', description: 'Design reusable embeds with buttons.' },
        { label: 'Experience Points', value: 'experience', description: 'Configure experience points rules and leaderboards.' },
        { label: 'Moderation commands', value: 'moderation', description: 'Select moderator roles for each server.' },
        { label: 'Moderation logging', value: 'modlog', description: 'Route moderator actions and category updates.' },
        { label: 'Spotlight gallery', value: 'spotlight', description: 'Celebrate standout posts with reaction thresholds.' },
        { label: 'Playlist relay', value: 'playlists', description: 'Manage Spotify and YouTube credentials.' }
    );
    components.push(new ActionRowBuilder().addComponents(moduleMenu));

    appendHomeButtonRow(components);

    return { embeds: [embed], components };
}

async function handleHomeInteraction({ interaction, config, client, logger, homeKey, homeEntry }) {
    const guildOptions = homeEntry?.guildOptions ?? await collectManageableGuilds({ client, userId: interaction.user.id });
    const [, , action] = interaction.customId.split(':');

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
        const embedKey = panelKey(interaction.user?.id, 'embed');
        const embedEntry = panelStore.get(embedKey);
        if (embedEntry) {
            const available = embedBuilderSetup.collectEligibleGuildIds(config);
            embedEntry.availableGuildIds = available;
            if (embedEntry.guildId && !available.includes(embedEntry.guildId)) {
                embedEntry.guildId = available[0] ?? null;
                embedEntry.mode = 'default';
            }
            panelStore.set(embedKey, embedEntry);
        }
        const experienceKey = panelKey(interaction.user?.id, 'experience');
        const experienceEntry = panelStore.get(experienceKey);
        if (experienceEntry) {
            experienceEntry.availableGuildIds = config.mainServerIds;
            if (experienceEntry.guildId && !config.mainServerIds.includes(experienceEntry.guildId)) {
                experienceEntry.guildId = config.mainServerIds[0] ?? null;
                experienceEntry.context = {};
            }
            panelStore.set(experienceKey, experienceEntry);
        }
        const spotlightKey = panelKey(interaction.user?.id, 'spotlight');
        const spotlightEntry = panelStore.get(spotlightKey);
        if (spotlightEntry) {
            spotlightEntry.availableGuildIds = config.mainServerIds;
            if (spotlightEntry.guildId && !config.mainServerIds.includes(spotlightEntry.guildId)) {
                spotlightEntry.guildId = config.mainServerIds[0] ?? null;
                spotlightEntry.mode = 'default';
            }
            panelStore.set(spotlightKey, spotlightEntry);
        }
        const moderationKey = panelKey(interaction.user?.id, 'moderation');
        const moderationEntry = panelStore.get(moderationKey);
        if (moderationEntry) {
            const available = await collectManageableGuilds({ client, userId: interaction.user.id });
            moderationEntry.guildOptions = available;
            if (moderationEntry.guildId && !available.some(opt => opt.id === moderationEntry.guildId)) {
                moderationEntry.guildId = available[0]?.id ?? null;
                moderationEntry.context = { guildId: moderationEntry.guildId ?? null };
            }
            panelStore.set(moderationKey, moderationEntry);
        }
        const modlogKey = panelKey(interaction.user?.id, 'modlog');
        if (panelStore.has(modlogKey)) {
            panelStore.delete(modlogKey);
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
        const embedKey = panelKey(interaction.user?.id, 'embed');
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
        const embedEntry = panelStore.get(embedKey);
        if (embedEntry) {
            const available = embedBuilderSetup.collectEligibleGuildIds(config);
            embedEntry.availableGuildIds = available;
            if (embedEntry.guildId && !available.includes(embedEntry.guildId)) {
                embedEntry.guildId = available[0] ?? null;
                embedEntry.mode = 'default';
            }
            panelStore.set(embedKey, embedEntry);
        }
        const experienceKey = panelKey(interaction.user?.id, 'experience');
        const experienceEntry = panelStore.get(experienceKey);
        if (experienceEntry) {
            experienceEntry.availableGuildIds = config.mainServerIds;
            if (experienceEntry.guildId && !config.mainServerIds.includes(experienceEntry.guildId)) {
                experienceEntry.guildId = config.mainServerIds[0] ?? null;
                experienceEntry.context = {};
            }
            panelStore.set(experienceKey, experienceEntry);
        }
        const spotlightKey = panelKey(interaction.user?.id, 'spotlight');
        const spotlightEntry = panelStore.get(spotlightKey);
        if (spotlightEntry) {
            spotlightEntry.availableGuildIds = config.mainServerIds;
            if (spotlightEntry.guildId && !config.mainServerIds.includes(spotlightEntry.guildId)) {
                spotlightEntry.guildId = config.mainServerIds[0] ?? null;
                spotlightEntry.mode = 'default';
            }
            panelStore.set(spotlightKey, spotlightEntry);
        }
        const moderationKey = panelKey(interaction.user?.id, 'moderation');
        const moderationEntry = panelStore.get(moderationKey);
        if (moderationEntry) {
            const available = await collectManageableGuilds({ client, userId: interaction.user.id });
            moderationEntry.guildOptions = available;
            if (moderationEntry.guildId && !available.some(opt => opt.id === moderationEntry.guildId)) {
                moderationEntry.guildId = available[0]?.id ?? null;
                moderationEntry.context = { guildId: moderationEntry.guildId ?? null };
            }
            panelStore.set(moderationKey, moderationEntry);
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
            const view = await loggingSetup.buildView({ config, client, guild, mode: 'default', context: {} });
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
            const view = await welcomeSetup.buildView({ config, client, guild: null, mode: 'chooseGuild', context: { availableGuildIds: available } });
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
            const view = await rainbowSetup.buildView({
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
            const view = await autobouncerSetup.buildView({ config, client, mode: 'default', context: {} });
            const message = await interaction.update(view);
            panelStore.set(moduleKey, { message, guildId: null, mode: 'default', context: {} });
            panelStore.set(homeKey, { message, guildOptions, view: 'module', module: 'autobouncer' });
            return;
        }

        if (target === 'embed') {
            const available = embedBuilderSetup.collectEligibleGuildIds(config);
            const embedState = config.embedBuilder && typeof config.embedBuilder === 'object'
                ? config.embedBuilder
                : { activeKey: null, embeds: {} };
            const presetKeys = Object.keys(embedState.embeds ?? {});
            const activeKey = embedState.activeKey && embedState.embeds?.[embedState.activeKey]
                ? embedState.activeKey
                : (presetKeys[0] ?? null);
            const preset = activeKey ? embedState.embeds?.[activeKey] : null;
            const configuredGuildId = preset?.guildId ? sanitizeSnowflakeId(preset.guildId) : null;
            const initialId = configuredGuildId && available.includes(configuredGuildId)
                ? configuredGuildId
                : (available[0] ?? configuredGuildId ?? null);
            const guild = initialId ? await fetchGuild(client, initialId) : null;
            const view = await embedBuilderSetup.buildView({
                config,
                client,
                guild,
                mode: 'default',
                context: {},
                presetKey: activeKey ?? undefined,
                availableGuildIds: available
            });
            const message = await interaction.update(view);
            panelStore.set(moduleKey, {
                message,
                guildId: guild?.id ?? initialId ?? null,
                mode: 'default',
                context: {},
                presetKey: activeKey ?? undefined,
                availableGuildIds: available
            });
            panelStore.set(homeKey, { message, guildOptions, view: 'module', module: 'embed' });
            return;
        }

        if (target === 'experience') {
            const available = Array.isArray(config.mainServerIds) ? config.mainServerIds : [];
            const initialGuildId = available[0] ?? null;
            const selectedRuleId = initialGuildId
                ? (config.experience?.[initialGuildId]?.activeRuleId
                    ?? config.experience?.[initialGuildId]?.rules?.[0]?.id
                    ?? null)
                : null;
            const view = await experienceSetup.buildView({
                config,
                client,
                guildId: initialGuildId,
                availableGuildIds: available,
                selectedRuleId
            });
            const message = await interaction.update(view);
            panelStore.set(moduleKey, {
                message,
                guildId: initialGuildId,
                mode: 'overview',
                context: selectedRuleId ? { ruleId: selectedRuleId } : {},
                availableGuildIds: available
            });
            panelStore.set(homeKey, { message, guildOptions, view: 'module', module: 'experience' });
            return;
        }

        if (target === 'moderation') {
            const available = await collectManageableGuilds({ client, userId: interaction.user.id });
            const built = await moderationSetup.buildView({ config, client, guildOptions: available, context: {} });
            const message = await interaction.update(built.view ?? built);
            panelStore.set(moduleKey, {
                message,
                guildId: built.desiredGuildId ?? null,
                mode: 'overview',
                context: { guildId: built.desiredGuildId ?? null },
                guildOptions: available
            });
            panelStore.set(homeKey, { message, guildOptions, view: 'module', module: 'moderation' });
            return;
        }

        if (target === 'modlog') {
            const built = await moderationLoggingSetup.buildView({ config, client, context: {} });
            const message = await interaction.update(built);
            panelStore.set(moduleKey, {
                message,
                context: {},
                mode: 'default'
            });
            panelStore.set(homeKey, { message, guildOptions, view: 'module', module: 'modlog' });
            return;
        }

        if (target === 'spotlight') {
            const available = spotlightSetup.collectEligibleGuildIds(config);
            const initialId = available[0] ?? null;
            const guild = initialId ? await fetchGuild(client, initialId) : null;
            const view = await spotlightSetup.buildView({ config, client, guildId: initialId, guild, mode: 'default', availableGuildIds: available });
            const message = await interaction.update({ embeds: view.embeds, components: view.components });
            panelStore.set(moduleKey, {
                message,
                guildId: view.activeGuildId ?? initialId ?? null,
                mode: view.mode ?? 'default',
                context: {},
                availableGuildIds: available
            });
            panelStore.set(homeKey, { message, guildOptions, view: 'module', module: 'spotlight' });
            return;
        }

        if (target === 'playlists') {
            const view = await playlistsSetup.buildView({ config });
            const message = await interaction.update(view);
            panelStore.set(moduleKey, {
                message,
                guildId: null,
                mode: 'default',
                context: {}
            });
            panelStore.set(homeKey, { message, guildOptions, view: 'module', module: 'playlists' });
            return;
        }
    }
}

