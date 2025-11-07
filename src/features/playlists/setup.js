// src/features/playlists/setup.js
// Setup panel integration for shared playlist credentials.

import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle
} from 'discord.js';

import { appendHomeButtonRow } from '../setup/shared.js';
import { normalizePlaylistsConfig } from './index.js';

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

        config.playlists.spotify = {
            clientId: sanitizeString(rawSpotify.clientId),
            clientSecret: sanitizeString(rawSpotify.clientSecret),
            refreshToken: sanitizeString(rawSpotify.refreshToken),
            playlistId: sanitizeString(rawSpotify.playlistId),
            skipDupes: toBoolean(rawSpotify.skipDupes, false)
        };

        config.playlists.youtube = {
            clientId: sanitizeString(rawYouTube.clientId),
            clientSecret: sanitizeString(rawYouTube.clientSecret),
            refreshToken: sanitizeString(rawYouTube.refreshToken),
            playlistId: sanitizeString(rawYouTube.playlistId)
        };
    }

    function platformStatus({ configured, playlistUrl, extra }) {
        if (!configured) {
            return '⚠️ Missing credentials — provide the client ID, client secret, refresh token, and playlist ID.';
        }
        const lines = ['✅ Credentials configured'];
        if (playlistUrl) {
            lines.push(`Playlist: ${playlistUrl}`);
        }
        if (extra) {
            lines.push(extra);
        }
        return lines.join('\n');
    }

    async function buildView({ config }) {
        const spotify = config.playlists?.spotify ?? {};
        const youtube = config.playlists?.youtube ?? {};
        const normalized = normalizePlaylistsConfig(config.playlists);

        const spotifyConfigured = ['clientId', 'clientSecret', 'refreshToken', 'playlistId']
            .every(key => Boolean(spotify[key]));
        const youtubeConfigured = ['clientId', 'clientSecret', 'refreshToken', 'playlistId']
            .every(key => Boolean(youtube[key]));

        const embed = new EmbedBuilder()
        .setTitle('Shared playlist credentials')
        .setDescription('Manage OAuth credentials for the `/add` playlist relay command. Values update instantly in `config.json`.')
        .addFields(
            {
                name: 'Spotify',
                value: platformStatus({
                    configured: spotifyConfigured,
                    playlistUrl: normalized.spotify?.playlistUrl ?? null,
                    extra: `Skip duplicates: **${spotify.skipDupes ? 'On' : 'Off'}**`
                }),
                inline: false
            },
            {
                name: 'YouTube',
                value: platformStatus({
                    configured: youtubeConfigured,
                    playlistUrl: normalized.youtube?.playlistUrl ?? null
                }),
                inline: false
            }
        );

        const components = [];

        const spotifyRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
            .setCustomId('setup:playlists:configure:spotify')
            .setLabel('Configure Spotify')
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
            .setLabel('Configure YouTube')
            .setStyle(ButtonStyle.Primary)
        );
        components.push(youtubeRow);

        appendHomeButtonRow(components);

        return { embeds: [embed], components };
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

    async function refreshPanel({ interaction, config, key, responder }) {
        const view = await buildView({ config });
        const handler = responder ?? (interaction.deferred || interaction.replied
            ? interaction.editReply.bind(interaction)
            : interaction.update.bind(interaction));
        const message = await handler(view);
        panelStore.set(key, {
            message,
            mode: 'default',
            context: {}
        });
    }

    async function handleModalSubmit({ interaction, config, key, logger }) {
        await interaction.reply({ content: 'Saved playlist credentials.', ephemeral: true });
        const entry = panelStore.get(key);
        if (!entry?.message) {
            return;
        }
        try {
            const view = await buildView({ config });
            const message = await entry.message.edit(view);
            panelStore.set(key, { message, mode: 'default', context: {} });
        } catch (err) {
            logger?.warn?.(`[playlists:setup] Failed to refresh panel after modal: ${err?.message ?? err}`);
        }
    }

    async function handleInteraction({ interaction, config, key, logger }) {
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
            if (interaction.customId === 'setup:playlists:toggleSkipDupes') {
                if (!config.playlists || typeof config.playlists !== 'object') {
                    config.playlists = {};
                }
                if (!config.playlists.spotify || typeof config.playlists.spotify !== 'object') {
                    config.playlists.spotify = { clientId: '', clientSecret: '', refreshToken: '', playlistId: '', skipDupes: false };
                }
                config.playlists.spotify.skipDupes = !config.playlists.spotify.skipDupes;
                saveConfig(config, logger);
                await refreshPanel({ interaction, config, key });
                await interaction.followUp({
                    content: config.playlists.spotify.skipDupes
                        ? 'Spotify duplicate skipping enabled.'
                        : 'Spotify duplicate skipping disabled.',
                    ephemeral: true
                }).catch(() => {});
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
                await handleModalSubmit({ interaction, config, key, logger });
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
                await handleModalSubmit({ interaction, config, key, logger });
                return;
            }
        }

        if (!interaction.deferred && !interaction.replied) {
            await refreshPanel({ interaction, config, key, responder: interaction.reply.bind(interaction) });
        }
    }

    return {
        prepareConfig,
        buildView,
        handleInteraction
    };
}

