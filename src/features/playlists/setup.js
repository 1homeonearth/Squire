// src/features/playlists/setup.js
// Setup panel integration for shared playlist credentials.

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

import { appendHomeButtonRow, sanitizeSnowflakeId } from '../setup/shared.js';

function sanitizeString(value) {
    if (value === undefined || value === null) return '';
    return String(value).trim();
}

function toBoolean(value, fallback = false) {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase();
        if (!normalized) return fallback;
        if (['1', 'true', 'yes', 'on', 'enabled', 'enable'].includes(normalized)) return true;
        if (['0', 'false', 'no', 'off', 'disabled', 'disable'].includes(normalized)) return false;
    }
    return fallback;
}

function normalizeGuildPlaylistMap(source) {
    const output = {};
    if (!source || typeof source !== 'object') {
        return output;
    }
    for (const [guildId, entry] of Object.entries(source)) {
        const sanitizedId = sanitizeSnowflakeId(guildId);
        if (!sanitizedId) continue;
        if (typeof entry === 'string') {
            output[sanitizedId] = {
                playlistId: sanitizeString(entry),
                name: ''
            };
            continue;
        }
        if (entry && typeof entry === 'object') {
            output[sanitizedId] = {
                playlistId: sanitizeString(entry.playlistId),
                name: sanitizeString(entry.name)
            };
        }
    }
    return output;
}

function ensureGuildCoverage(map, guildIds) {
    const normalized = { ...map };
    for (const id of guildIds) {
        if (!normalized[id]) {
            normalized[id] = { playlistId: '', name: '' };
        }
    }
    return normalized;
}

function describeGuildPlaylists({ spotifyEntry, youtubeEntry }) {
    const spotifyLine = spotifyEntry?.playlistId
        ? `Spotify playlist: \`${spotifyEntry.playlistId}\``
        : 'Spotify playlist: ⚠️ Not set';
    const youtubeLine = youtubeEntry?.playlistId
        ? `YouTube playlist: \`${youtubeEntry.playlistId}\``
        : 'YouTube playlist: ⚠️ Not set';
    return `${spotifyLine}\n${youtubeLine}`;
}

export function createPlaylistsSetup({ panelStore, saveConfig }) {
    function prepareConfig(config) {
        if (!config.playlists || typeof config.playlists !== 'object') {
            config.playlists = {};
        }
        const rawSpotify = config.playlists.spotify && typeof config.playlists.spotify === 'object'
            ? config.playlists.spotify
            : {};
        const rawYouTube = config.playlists.youtube && typeof config.playlists.youtube === 'object'
            ? config.playlists.youtube
            : {};

        const mainGuilds = Array.isArray(config.mainServerIds)
            ? config.mainServerIds.map(id => sanitizeSnowflakeId(id)).filter(Boolean)
            : [];

        const spotifyGuilds = ensureGuildCoverage(
            normalizeGuildPlaylistMap(rawSpotify.guilds ?? rawSpotify.perGuild ?? {}),
            mainGuilds
        );

        const youtubeGuilds = ensureGuildCoverage(
            normalizeGuildPlaylistMap(rawYouTube.guilds ?? {}),
            mainGuilds
        );

        config.playlists.spotify = {
            clientId: sanitizeString(rawSpotify.clientId),
            clientSecret: sanitizeString(rawSpotify.clientSecret),
            refreshToken: sanitizeString(rawSpotify.refreshToken),
            playlistId: sanitizeString(rawSpotify.playlistId),
            skipDupes: toBoolean(rawSpotify.skipDupes, false),
            guilds: spotifyGuilds
        };

        config.playlists.youtube = {
            clientId: sanitizeString(rawYouTube.clientId),
            clientSecret: sanitizeString(rawYouTube.clientSecret),
            refreshToken: sanitizeString(rawYouTube.refreshToken),
            playlistId: sanitizeString(rawYouTube.playlistId),
            guilds: youtubeGuilds
        };
    }

    function platformStatus({ configured, playlistId, extra }) {
        if (!configured) {
            return '⚠️ Missing credentials — provide the client ID, client secret, refresh token, and playlist ID.';
        }
        const lines = ['✅ Credentials configured'];
        if (playlistId) {
            lines.push(`Fallback playlist ID: \`${playlistId}\``);
        }
        if (extra) {
            lines.push(extra);
        }
        return lines.join('\n');
    }

    async function buildView({ config, selectedGuildId }) {
        const spotify = config.playlists?.spotify ?? {};
        const youtube = config.playlists?.youtube ?? {};
        const spotifyConfigured = ['clientId', 'clientSecret', 'refreshToken']
            .every(key => Boolean(spotify[key]));
        const youtubeConfigured = ['clientId', 'clientSecret', 'refreshToken']
            .every(key => Boolean(youtube[key]));

        const mainGuilds = Array.isArray(config.mainServerIds)
            ? config.mainServerIds.map(id => sanitizeSnowflakeId(id)).filter(Boolean)
            : [];
        const configuredGuilds = new Set([
            ...mainGuilds,
            ...Object.keys(spotify.guilds ?? {}),
            ...Object.keys(youtube.guilds ?? {})
        ].map(sanitizeSnowflakeId).filter(Boolean));
        const guildChoices = Array.from(configuredGuilds);
        const resolvedGuildId = selectedGuildId && guildChoices.includes(selectedGuildId)
            ? selectedGuildId
            : (guildChoices[0] ?? null);

        const spotifyEntry = resolvedGuildId ? spotify.guilds?.[resolvedGuildId] : null;
        const youtubeEntry = resolvedGuildId ? youtube.guilds?.[resolvedGuildId] : null;

        const embed = new EmbedBuilder()
        .setTitle('Playlist integrations')
        .setDescription('Manage OAuth credentials and per-server playlists for the `/add` command. Values update instantly in `config.json`.')
        .addFields(
            {
                name: 'Spotify credentials',
                value: platformStatus({
                    configured: spotifyConfigured,
                    playlistId: spotify.playlistId,
                    extra: `Skip duplicates: **${spotify.skipDupes ? 'On' : 'Off'}**`
                }),
                inline: false
            },
            {
                name: 'YouTube credentials',
                value: platformStatus({
                    configured: youtubeConfigured,
                    playlistId: youtube.playlistId
                }),
                inline: false
            }
        );

        const coverageLines = guildChoices.length
            ? guildChoices.map((id) => {
                const spotifyStatus = spotify.guilds?.[id]?.playlistId ? '✅' : '⚠️';
                const youtubeStatus = youtube.guilds?.[id]?.playlistId ? '✅' : '⚠️';
                return `• ${id}: Spotify ${spotifyStatus} | YouTube ${youtubeStatus}`;
            }).join('\n')
            : 'Add guild IDs to `mainServerIds` to start tracking per-server playlists.';

        embed.addFields({
            name: 'Main server coverage',
            value: coverageLines,
            inline: false
        });

        if (resolvedGuildId) {
            embed.addFields({
                name: `Selected server ${resolvedGuildId}`,
                value: describeGuildPlaylists({ spotifyEntry, youtubeEntry }),
                inline: false
            });
        } else {
            embed.addFields({
                name: 'Selected server',
                value: 'Select a server from the dropdown to edit its playlists.',
                inline: false
            });
        }

        const components = [];

        const guildMenu = new StringSelectMenuBuilder()
        .setCustomId('setup:playlists:selectGuild')
        .setPlaceholder(guildChoices.length ? 'Select main server…' : 'Add guild IDs to `mainServerIds`')
        .setMinValues(1)
        .setMaxValues(1)
        .setDisabled(!guildChoices.length);

        if (guildChoices.length) {
            guildMenu.addOptions(guildChoices.slice(0, 25).map(id => ({
                label: id,
                value: id,
                default: id === resolvedGuildId
            })));
        } else {
            guildMenu.addOptions({ label: 'No servers configured', value: 'noop', default: true });
        }
        components.push(new ActionRowBuilder().addComponents(guildMenu));

        const perGuildRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
            .setCustomId('setup:playlists:setSpotifyPlaylist')
            .setLabel('Set Spotify playlist')
            .setStyle(ButtonStyle.Primary)
            .setDisabled(!resolvedGuildId),
            new ButtonBuilder()
            .setCustomId('setup:playlists:setYouTubePlaylist')
            .setLabel('Set YouTube playlist')
            .setStyle(ButtonStyle.Primary)
            .setDisabled(!resolvedGuildId)
        );
        components.push(perGuildRow);

        const spotifyRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
            .setCustomId('setup:playlists:configure:spotify')
            .setLabel('Configure Spotify credentials')
            .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
            .setCustomId('setup:playlists:toggleSkipDupes')
            .setLabel(spotify.skipDupes ? 'Skip duplicates: On' : 'Skip duplicates: Off')
            .setStyle(ButtonStyle.Secondary)
        );
        components.push(spotifyRow);

        const youtubeRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
            .setCustomId('setup:playlists:configure:youtube')
            .setLabel('Configure YouTube credentials')
            .setStyle(ButtonStyle.Primary)
        );
        components.push(youtubeRow);

        appendHomeButtonRow(components);

        return { embeds: [embed], components, resolvedGuildId };
    }

    function buildSpotifyModal(config) {
        const spotify = config.playlists?.spotify ?? {};
        return new ModalBuilder()
        .setCustomId('setup:playlists:spotifyModal')
        .setTitle('Spotify credentials')
        .addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                .setCustomId('setup:playlists:spotify:clientId')
                .setLabel('Client ID')
                .setStyle(TextInputStyle.Short)
                .setRequired(false)
                .setValue(spotify.clientId ?? '')
            ),
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                .setCustomId('setup:playlists:spotify:clientSecret')
                .setLabel('Client secret')
                .setStyle(TextInputStyle.Paragraph)
                .setRequired(false)
                .setValue(spotify.clientSecret ?? '')
            ),
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                .setCustomId('setup:playlists:spotify:refreshToken')
                .setLabel('Refresh token')
                .setStyle(TextInputStyle.Paragraph)
                .setRequired(false)
                .setValue(spotify.refreshToken ?? '')
            ),
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                .setCustomId('setup:playlists:spotify:playlistId')
                .setLabel('Playlist ID')
                .setStyle(TextInputStyle.Short)
                .setRequired(false)
                .setValue(spotify.playlistId ?? '')
            )
        );
    }

    function buildYouTubeModal(config) {
        const youtube = config.playlists?.youtube ?? {};
        return new ModalBuilder()
        .setCustomId('setup:playlists:youtubeModal')
        .setTitle('YouTube credentials')
        .addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                .setCustomId('setup:playlists:youtube:clientId')
                .setLabel('Client ID')
                .setStyle(TextInputStyle.Short)
                .setRequired(false)
                .setValue(youtube.clientId ?? '')
            ),
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                .setCustomId('setup:playlists:youtube:clientSecret')
                .setLabel('Client secret')
                .setStyle(TextInputStyle.Paragraph)
                .setRequired(false)
                .setValue(youtube.clientSecret ?? '')
            ),
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                .setCustomId('setup:playlists:youtube:refreshToken')
                .setLabel('Refresh token')
                .setStyle(TextInputStyle.Paragraph)
                .setRequired(false)
                .setValue(youtube.refreshToken ?? '')
            ),
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                .setCustomId('setup:playlists:youtube:playlistId')
                .setLabel('Playlist ID')
                .setStyle(TextInputStyle.Short)
                .setRequired(false)
                .setValue(youtube.playlistId ?? '')
            )
        );
    }

    function buildSpotifyGuildModal(config, guildId) {
        const entry = config.playlists?.spotify?.guilds?.[guildId] ?? {};
        return new ModalBuilder()
        .setCustomId('setup:playlists:spotifyGuildModal')
        .setTitle(`Spotify playlist — ${guildId}`)
        .addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                .setCustomId('setup:playlists:spotifyGuild:playlistId')
                .setLabel('Playlist ID')
                .setStyle(TextInputStyle.Short)
                .setRequired(false)
                .setValue(entry.playlistId ?? '')
            )
        );
    }

    function buildYouTubeGuildModal(config, guildId) {
        const entry = config.playlists?.youtube?.guilds?.[guildId] ?? {};
        return new ModalBuilder()
        .setCustomId('setup:playlists:youtubeGuildModal')
        .setTitle(`YouTube playlist — ${guildId}`)
        .addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                .setCustomId('setup:playlists:youtubeGuild:playlistId')
                .setLabel('Playlist ID')
                .setStyle(TextInputStyle.Short)
                .setRequired(false)
                .setValue(entry.playlistId ?? '')
            )
        );
    }

    async function refreshPanel({ interaction, config, key, responder, selectedGuildId }) {
        const view = await buildView({ config, selectedGuildId });
        const payload = { embeds: view.embeds, components: view.components };
        const handler = responder ?? (interaction.deferred || interaction.replied
            ? interaction.editReply.bind(interaction)
            : interaction.update.bind(interaction));
        const message = await handler(payload);
        panelStore.set(key, {
            message,
            mode: 'default',
            context: {},
            guildId: view.resolvedGuildId ?? selectedGuildId ?? null
        });
    }

    async function handleModalSubmit({ interaction, config, key, logger, message = 'Saved playlist credentials.', selectedGuildId }) {
        await interaction.reply({ content: message, ephemeral: true });
        const entry = panelStore.get(key);
        if (!entry?.message) {
            return;
        }
        try {
            const guildId = selectedGuildId ?? entry.guildId ?? null;
            const view = await buildView({ config, selectedGuildId: guildId });
            const panelMessage = await entry.message.edit({ embeds: view.embeds, components: view.components });
            panelStore.set(key, { message: panelMessage, mode: 'default', context: {}, guildId: view.resolvedGuildId ?? guildId });
        } catch (err) {
            logger?.warn?.(`[playlists:setup] Failed to refresh panel after modal: ${err?.message ?? err}`);
        }
    }

    async function handleInteraction({ interaction, config, key, logger }) {
        const spotify = config.playlists?.spotify ?? {};
        const youtube = config.playlists?.youtube ?? {};
        const mainGuilds = Array.isArray(config.mainServerIds)
            ? config.mainServerIds.map(id => sanitizeSnowflakeId(id)).filter(Boolean)
            : [];
        const configuredGuilds = new Set([
            ...mainGuilds,
            ...Object.keys(spotify.guilds ?? {}),
            ...Object.keys(youtube.guilds ?? {})
        ].map(sanitizeSnowflakeId).filter(Boolean));
        const guildChoices = Array.from(configuredGuilds);
        const state = panelStore.get(key) ?? {};
        const storedGuildId = state.guildId ?? null;
        const resolvedGuildId = storedGuildId && guildChoices.includes(storedGuildId)
            ? storedGuildId
            : (guildChoices[0] ?? null);

        if (interaction.isButton()) {
            if (interaction.customId === 'setup:playlists:configure:spotify') {
                const modal = buildSpotifyModal(config);
                await interaction.showModal(modal);
                return;
            }
            if (interaction.customId === 'setup:playlists:configure:youtube') {
                const modal = buildYouTubeModal(config);
                await interaction.showModal(modal);
                return;
            }
            if (interaction.customId === 'setup:playlists:setSpotifyPlaylist') {
                if (!resolvedGuildId) {
                    await interaction.reply({ content: 'Select a server before configuring playlists.', ephemeral: true });
                    return;
                }
                const modal = buildSpotifyGuildModal(config, resolvedGuildId);
                await interaction.showModal(modal);
                return;
            }
            if (interaction.customId === 'setup:playlists:setYouTubePlaylist') {
                if (!resolvedGuildId) {
                    await interaction.reply({ content: 'Select a server before configuring playlists.', ephemeral: true });
                    return;
                }
                const modal = buildYouTubeGuildModal(config, resolvedGuildId);
                await interaction.showModal(modal);
                return;
            }
            if (interaction.customId === 'setup:playlists:toggleSkipDupes') {
                if (!config.playlists || typeof config.playlists !== 'object') {
                    config.playlists = {};
                }
                if (!config.playlists.spotify || typeof config.playlists.spotify !== 'object') {
                    config.playlists.spotify = { clientId: '', clientSecret: '', refreshToken: '', playlistId: '', skipDupes: false };
                }
                config.playlists.spotify.skipDupes = !config.playlists.spotify.skipDupes;
                saveConfig(config, logger);
                await refreshPanel({ interaction, config, key, selectedGuildId: resolvedGuildId });
                await interaction.followUp({
                    content: config.playlists.spotify.skipDupes
                        ? 'Spotify duplicate skipping enabled.'
                        : 'Spotify duplicate skipping disabled.',
                    ephemeral: true
                }).catch(() => {});
                return;
            }
        }

        if (interaction.isAnySelectMenu && interaction.isAnySelectMenu()) {
            if (interaction.customId === 'setup:playlists:selectGuild') {
                const choice = interaction.values?.[0] ?? null;
                const nextGuildId = choice && choice !== 'noop' ? choice : null;
                await refreshPanel({ interaction, config, key, selectedGuildId: nextGuildId });
                return;
            }
        }

        if (interaction.isModalSubmit()) {
            if (interaction.customId === 'setup:playlists:spotifyModal') {
                const spotify = config.playlists?.spotify ?? {};
                spotify.clientId = sanitizeString(interaction.fields.getTextInputValue('setup:playlists:spotify:clientId'));
                spotify.clientSecret = sanitizeString(interaction.fields.getTextInputValue('setup:playlists:spotify:clientSecret'));
                spotify.refreshToken = sanitizeString(interaction.fields.getTextInputValue('setup:playlists:spotify:refreshToken'));
                spotify.playlistId = sanitizeString(interaction.fields.getTextInputValue('setup:playlists:spotify:playlistId'));
                spotify.skipDupes = toBoolean(spotify.skipDupes, false);
                config.playlists.spotify = spotify;
                saveConfig(config, logger);
                await handleModalSubmit({ interaction, config, key, logger, selectedGuildId: resolvedGuildId });
                return;
            }
            if (interaction.customId === 'setup:playlists:youtubeModal') {
                const youtube = config.playlists?.youtube ?? {};
                youtube.clientId = sanitizeString(interaction.fields.getTextInputValue('setup:playlists:youtube:clientId'));
                youtube.clientSecret = sanitizeString(interaction.fields.getTextInputValue('setup:playlists:youtube:clientSecret'));
                youtube.refreshToken = sanitizeString(interaction.fields.getTextInputValue('setup:playlists:youtube:refreshToken'));
                youtube.playlistId = sanitizeString(interaction.fields.getTextInputValue('setup:playlists:youtube:playlistId'));
                config.playlists.youtube = youtube;
                saveConfig(config, logger);
                await handleModalSubmit({ interaction, config, key, logger, selectedGuildId: resolvedGuildId });
                return;
            }
            if (interaction.customId === 'setup:playlists:spotifyGuildModal') {
                const guildId = resolvedGuildId;
                if (!guildId) {
                    await interaction.reply({ content: 'Select a server before updating playlists.', ephemeral: true });
                    return;
                }
                if (!config.playlists.spotify || typeof config.playlists.spotify !== 'object') {
                    config.playlists.spotify = { clientId: '', clientSecret: '', refreshToken: '', playlistId: '', skipDupes: false, guilds: {} };
                }
                if (!config.playlists.spotify.guilds || typeof config.playlists.spotify.guilds !== 'object') {
                    config.playlists.spotify.guilds = {};
                }
                const playlistId = sanitizeString(interaction.fields.getTextInputValue('setup:playlists:spotifyGuild:playlistId'));
                const entry = config.playlists.spotify.guilds[guildId] ?? { playlistId: '', name: '' };
                entry.playlistId = playlistId;
                config.playlists.spotify.guilds[guildId] = entry;
                saveConfig(config, logger);
                await handleModalSubmit({
                    interaction,
                    config,
                    key,
                    logger,
                    message: `Spotify playlist updated for ${guildId}.`,
                    selectedGuildId: guildId
                });
                return;
            }
            if (interaction.customId === 'setup:playlists:youtubeGuildModal') {
                const guildId = resolvedGuildId;
                if (!guildId) {
                    await interaction.reply({ content: 'Select a server before updating playlists.', ephemeral: true });
                    return;
                }
                if (!config.playlists.youtube || typeof config.playlists.youtube !== 'object') {
                    config.playlists.youtube = { clientId: '', clientSecret: '', refreshToken: '', playlistId: '', guilds: {} };
                }
                if (!config.playlists.youtube.guilds || typeof config.playlists.youtube.guilds !== 'object') {
                    config.playlists.youtube.guilds = {};
                }
                const playlistId = sanitizeString(interaction.fields.getTextInputValue('setup:playlists:youtubeGuild:playlistId'));
                const entry = config.playlists.youtube.guilds[guildId] ?? { playlistId: '', name: '' };
                entry.playlistId = playlistId;
                config.playlists.youtube.guilds[guildId] = entry;
                saveConfig(config, logger);
                await handleModalSubmit({
                    interaction,
                    config,
                    key,
                    logger,
                    message: `YouTube playlist updated for ${guildId}.`,
                    selectedGuildId: guildId
                });
                return;
            }
        }

        if (!interaction.deferred && !interaction.replied) {
            await refreshPanel({ interaction, config, key, responder: interaction.reply.bind(interaction), selectedGuildId: resolvedGuildId });
        }
    }

    return {
        prepareConfig,
        buildView,
        handleInteraction
    };
}

