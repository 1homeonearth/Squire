// src/features/playlists/index.js
// Shared playlist module handling Spotify + YouTube links.

import {
    SlashCommandBuilder,
    PermissionFlagsBits,
    WebhookClient
} from 'discord.js';
import { setTimeout as wait } from 'node:timers/promises';

const WEBHOOK_NAME = 'Squire Relay';
const WEBHOOK_REASON = 'Squire playlist mirroring';

const SPOTIFY_REGEX = /^(?:(?:https?:\/\/)?open\.spotify\.com\/track\/([A-Za-z0-9]+)(?:\?.*)?|spotify:track:([A-Za-z0-9]+))$/i;
const YOUTUBE_REGEX = /^(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/watch\?v=([A-Za-z0-9_-]{11})|youtu\.be\/([A-Za-z0-9_-]{11})|youtube\.com\/shorts\/([A-Za-z0-9_-]{11}))(?:[&?].*)?$/i;

const MAX_RETRIES = 5;
const BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 10_000;

function jitter(delay) {
    return delay + Math.floor(Math.random() * 250);
}

function computeBackoff(attempt) {
    const delay = BASE_BACKOFF_MS * Math.pow(2, attempt);
    return Math.min(delay, MAX_BACKOFF_MS);
}

export function normalizeUrl(u) {
    let s = String(u ?? '').trim();
    if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
    return s;
}

function pickString(...sources) {
    for (const value of sources) {
        if (typeof value === 'string') {
            const trimmed = value.trim();
            if (trimmed.length) return trimmed;
        }
    }
    return null;
}

function parseBoolean(value, fallback = false) {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase();
        if (!normalized) return fallback;
        if (['1', 'true', 'yes', 'on', 'enable', 'enabled'].includes(normalized)) return true;
        if (['0', 'false', 'no', 'off', 'disable', 'disabled'].includes(normalized)) return false;
    }
    return fallback;
}

function buildSpotifyUrl(trackId) {
    return normalizeUrl(`https://open.spotify.com/track/${trackId}`);
}

function buildYouTubeUrl(videoId) {
    return normalizeUrl(`https://youtu.be/${videoId}`);
}

function extractSpotifyId(link) {
    if (typeof link !== 'string') return null;
    const match = link.match(SPOTIFY_REGEX);
    if (!match) return null;
    return match[1] || match[2] || null;
}

function extractYouTubeId(link) {
    if (typeof link !== 'string') return null;
    const match = link.match(YOUTUBE_REGEX);
    if (!match) return null;
    return match[1] || match[2] || match[3] || null;
}

export function parsePlaylistLink(raw) {
    const input = typeof raw === 'string' ? raw.trim() : '';
    if (!input) {
        throw new PlaylistError('Missing link.', {
            code: 'missing',
            userMessage: 'Please paste a Spotify track or YouTube video link.'
        });
    }

    const spotifyId = extractSpotifyId(input);
    if (spotifyId) {
        return {
            platform: 'spotify',
            id: spotifyId,
            normalizedUrl: buildSpotifyUrl(spotifyId),
            raw: input
        };
    }

    const youtubeId = extractYouTubeId(input);
    if (youtubeId) {
        return {
            platform: 'youtube',
            id: youtubeId,
            normalizedUrl: buildYouTubeUrl(youtubeId),
            raw: input
        };
    }

    throw new PlaylistError('Unsupported link.', {
        code: 'unsupported',
        userMessage: 'I can only add Spotify tracks or YouTube videos. Please paste a direct track/video link.'
    });
}

function playlistUrlForPlatform(platform, playlistId) {
    if (!playlistId) return null;
    if (platform === 'spotify') return normalizeUrl(`https://open.spotify.com/playlist/${playlistId}`);
    if (platform === 'youtube') return normalizeUrl(`https://www.youtube.com/playlist?list=${playlistId}`);
    return null;
}

export function normalizePlaylistsConfig(source = {}) {
    const cfg = source && typeof source === 'object' ? { ...source } : {};

    const spotifyRaw = cfg.spotify && typeof cfg.spotify === 'object' ? cfg.spotify : {};
    const youtubeRaw = cfg.youtube && typeof cfg.youtube === 'object' ? cfg.youtube : {};

    const spotify = (() => {
        const clientId = pickString(spotifyRaw.clientId, process.env.SPOTIFY_CLIENT_ID);
        const clientSecret = pickString(spotifyRaw.clientSecret, process.env.SPOTIFY_CLIENT_SECRET);
        const refreshToken = pickString(spotifyRaw.refreshToken, process.env.SPOTIFY_REFRESH_TOKEN);
        const playlistId = pickString(spotifyRaw.playlistId, process.env.SPOTIFY_PLAYLIST_ID);
        if (!clientId || !clientSecret || !refreshToken || !playlistId) return null;
        const skipSource = spotifyRaw.skipDupes ?? process.env.PLAYLISTS_SKIP_DUPES;
        const skipDupes = parseBoolean(skipSource, false);
        return {
            clientId,
            clientSecret,
            refreshToken,
            playlistId,
            skipDupes,
            playlistUrl: playlistUrlForPlatform('spotify', playlistId)
        };
    })();

    const youtube = (() => {
        const clientId = pickString(youtubeRaw.clientId, process.env.YT_CLIENT_ID);
        const clientSecret = pickString(youtubeRaw.clientSecret, process.env.YT_CLIENT_SECRET);
        const refreshToken = pickString(youtubeRaw.refreshToken, process.env.YT_REFRESH_TOKEN);
        const playlistId = pickString(youtubeRaw.playlistId, process.env.YT_PLAYLIST_ID);
        if (!clientId || !clientSecret || !refreshToken || !playlistId) return null;
        return {
            clientId,
            clientSecret,
            refreshToken,
            playlistId,
            playlistUrl: playlistUrlForPlatform('youtube', playlistId)
        };
    })();

    return { spotify, youtube };
}

class PlaylistError extends Error {
    constructor(message, options = {}) {
        super(message);
        this.name = 'PlaylistError';
        this.platform = options.platform ?? null;
        this.code = options.code ?? null;
        this.userMessage = options.userMessage ?? message;
    }
}

function buildAuthHeader(clientId, clientSecret) {
    const pair = `${clientId}:${clientSecret}`;
    const encoded = Buffer.from(pair).toString('base64');
    return `Basic ${encoded}`;
}

class SpotifyIntegration {
    constructor(config, logger) {
        this.clientId = config.clientId;
        this.clientSecret = config.clientSecret;
        this.refreshToken = config.refreshToken;
        this.playlistId = config.playlistId;
        this.skipDupes = Boolean(config.skipDupes);
        this.playlistUrl = config.playlistUrl;
        this.logger = logger;
        this.accessToken = null;
        this.expiresAt = 0;
    }

    get trackUriBase() {
        return `spotify:track:`;
    }

    async ensureAccessToken(force = false) {
        if (!force && this.accessToken && Date.now() < this.expiresAt - 5000) {
            return this.accessToken;
        }

        const params = new URLSearchParams();
        params.set('grant_type', 'refresh_token');
        params.set('refresh_token', this.refreshToken);

        const response = await fetch('https://accounts.spotify.com/api/token', {
            method: 'POST',
            headers: {
                Authorization: buildAuthHeader(this.clientId, this.clientSecret),
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: params
        });

        if (!response.ok) {
            const details = await safeJson(response);
            const reason = details?.error_description || response.statusText || 'Unknown error';
            this.logger?.error?.(`[playlists] Spotify token refresh failed: ${reason}`);
            throw new PlaylistError('Failed to refresh Spotify token.', {
                platform: 'spotify',
                code: 'auth',
                userMessage: 'Could not refresh Spotify credentials. Please re-authorize the integration.'
            });
        }

        const data = await response.json();
        this.accessToken = data.access_token;
        const expiresIn = typeof data.expires_in === 'number' ? data.expires_in : 3600;
        this.expiresAt = Date.now() + (expiresIn * 1000);
        return this.accessToken;
    }

    async request(url, options = {}, attempt = 0) {
        if (attempt >= MAX_RETRIES) {
            throw new PlaylistError('Spotify request exceeded retry budget.', {
                platform: 'spotify',
                code: 'retry'
            });
        }

        const token = await this.ensureAccessToken();
        const headers = {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            ...(options.headers || {})
        };

        const response = await fetch(url, { ...options, headers });

        if (response.status === 401 && attempt < MAX_RETRIES - 1) {
            await this.ensureAccessToken(true);
            return this.request(url, options, attempt + 1);
        }

        if (response.status === 429 && attempt < MAX_RETRIES - 1) {
            const retryAfter = Number(response.headers.get('retry-after'));
            const delay = Number.isFinite(retryAfter) && retryAfter > 0
                ? retryAfter * 1000
                : computeBackoff(attempt);
            await wait(jitter(delay));
            return this.request(url, options, attempt + 1);
        }

        if (response.status >= 500 && attempt < MAX_RETRIES - 1) {
            await wait(jitter(computeBackoff(attempt)));
            return this.request(url, options, attempt + 1);
        }

        return response;
    }

    async fetchTrack(trackId) {
        const res = await this.request(`https://api.spotify.com/v1/tracks/${trackId}`, { method: 'GET' });
        if (res.status === 404) {
            throw new PlaylistError('Spotify track not found.', {
                platform: 'spotify',
                code: 'notFound',
                userMessage: 'Spotify could not find that track. Please check the link and try again.'
            });
        }
        if (!res.ok) {
            const details = await safeJson(res);
            const message = details?.error?.message || res.statusText;
            throw new PlaylistError('Failed to load Spotify track details.', {
                platform: 'spotify',
                code: 'request',
                userMessage: message || 'Spotify rejected the request. Try again later.'
            });
        }
        return await res.json();
    }

    async trackExists(trackId) {
        if (!this.skipDupes) return false;
        const targetUri = `${this.trackUriBase}${trackId}`;
        let url = `https://api.spotify.com/v1/playlists/${this.playlistId}/tracks?fields=items(track(uri)),next&limit=100`;
        let pages = 0;
        while (url && pages < 5) {
            const res = await this.request(url, { method: 'GET' });
            if (!res.ok) {
                return false;
            }
            const data = await res.json();
            const items = Array.isArray(data.items) ? data.items : [];
            if (items.some(item => item?.track?.uri === targetUri)) {
                return true;
            }
            url = data.next || null;
            pages += 1;
        }
        return false;
    }

    async addTrack(trackId) {
        const track = await this.fetchTrack(trackId);
        const trackTitle = formatSpotifyTitle(track);
        const trackUri = `${this.trackUriBase}${trackId}`;

        if (await this.trackExists(trackId)) {
            return {
                platform: 'spotify',
                title: trackTitle,
                playlistUrl: this.playlistUrl,
                trackId,
                skipped: true,
                trackUri
            };
        }

        const body = JSON.stringify({ uris: [trackUri] });
        const res = await this.request(`https://api.spotify.com/v1/playlists/${this.playlistId}/tracks`, {
            method: 'POST',
            body
        });

        if (res.status === 429) {
            throw new PlaylistError('Spotify rate limited the request.', {
                platform: 'spotify',
                code: 'rateLimited',
                userMessage: 'The target platform is rate-limiting right now. Try again soon.'
            });
        }

        if (!res.ok) {
            const details = await safeJson(res);
            const message = details?.error?.message || res.statusText;
            throw new PlaylistError('Failed to add track to Spotify playlist.', {
                platform: 'spotify',
                code: 'request',
                userMessage: message || 'Spotify rejected the request. Try again later.'
            });
        }

        const data = await res.json();
        return {
            platform: 'spotify',
            title: trackTitle,
            playlistUrl: this.playlistUrl,
            snapshotId: data.snapshot_id ?? null,
            trackId,
            trackUri,
            skipped: false
        };
    }
}

class YouTubeIntegration {
    constructor(config, logger) {
        this.clientId = config.clientId;
        this.clientSecret = config.clientSecret;
        this.refreshToken = config.refreshToken;
        this.playlistId = config.playlistId;
        this.playlistUrl = config.playlistUrl;
        this.logger = logger;
        this.accessToken = null;
        this.expiresAt = 0;
    }

    async ensureAccessToken(force = false) {
        if (!force && this.accessToken && Date.now() < this.expiresAt - 5000) {
            return this.accessToken;
        }

        const params = new URLSearchParams();
        params.set('grant_type', 'refresh_token');
        params.set('refresh_token', this.refreshToken);
        params.set('client_id', this.clientId);
        params.set('client_secret', this.clientSecret);

        const res = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: params
        });

        if (!res.ok) {
            const details = await safeJson(res);
            const reason = details?.error_description || details?.error?.message || res.statusText || 'Unknown error';
            this.logger?.error?.(`[playlists] YouTube token refresh failed: ${reason}`);
            throw new PlaylistError('Failed to refresh YouTube token.', {
                platform: 'youtube',
                code: 'auth',
                userMessage: 'Could not refresh YouTube credentials. Please re-authorize the integration.'
            });
        }

        const data = await res.json();
        this.accessToken = data.access_token;
        const expiresIn = typeof data.expires_in === 'number' ? data.expires_in : 3600;
        this.expiresAt = Date.now() + (expiresIn * 1000);
        return this.accessToken;
    }

    async request(url, options = {}, attempt = 0) {
        if (attempt >= MAX_RETRIES) {
            throw new PlaylistError('YouTube request exceeded retry budget.', {
                platform: 'youtube',
                code: 'retry'
            });
        }

        const token = await this.ensureAccessToken();
        const headers = {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            ...(options.headers || {})
        };

        const res = await fetch(url, { ...options, headers });

        if (res.status === 401 && attempt < MAX_RETRIES - 1) {
            await this.ensureAccessToken(true);
            return this.request(url, options, attempt + 1);
        }

        if (res.status === 429 && attempt < MAX_RETRIES - 1) {
            const retryAfter = Number(res.headers.get('retry-after'));
            const delay = Number.isFinite(retryAfter) && retryAfter > 0
                ? retryAfter * 1000
                : computeBackoff(attempt);
            await wait(jitter(delay));
            return this.request(url, options, attempt + 1);
        }

        if (res.status >= 500 && attempt < MAX_RETRIES - 1) {
            await wait(jitter(computeBackoff(attempt)));
            return this.request(url, options, attempt + 1);
        }

        return res;
    }

    async fetchVideo(videoId) {
        const res = await this.request(`https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${videoId}`, { method: 'GET' });
        if (!res.ok) {
            const error = await safeJson(res);
            const reason = extractYouTubeReason(error);
            if (res.status === 404 || reason === 'videoNotFound') {
                throw new PlaylistError('YouTube video not found.', {
                    platform: 'youtube',
                    code: 'notFound',
                    userMessage: 'YouTube reported that this video is unavailable.'
                });
            }
            throw new PlaylistError('Failed to load YouTube video details.', {
                platform: 'youtube',
                code: 'request',
                userMessage: error?.error?.message || 'YouTube rejected the request. Try again later.'
            });
        }
        const data = await res.json();
        const item = Array.isArray(data.items) ? data.items[0] : null;
        if (!item) {
            throw new PlaylistError('YouTube video not found.', {
                platform: 'youtube',
                code: 'notFound',
                userMessage: 'YouTube reported that this video is unavailable.'
            });
        }
        return item;
    }

    async addVideo(videoId) {
        const video = await this.fetchVideo(videoId);
        const title = video?.snippet?.title ?? `Video ${videoId}`;
        const body = JSON.stringify({
            snippet: {
                playlistId: this.playlistId,
                resourceId: {
                    kind: 'youtube#video',
                    videoId
                }
            }
        });

        const res = await this.request('https://www.googleapis.com/youtube/v3/playlistItems?part=snippet', {
            method: 'POST',
            body
        });

        if (!res.ok) {
            const details = await safeJson(res);
            const reason = extractYouTubeReason(details);
            if (reason === 'quotaExceeded' || reason === 'rateLimitExceeded') {
                throw new PlaylistError('YouTube quota exceeded.', {
                    platform: 'youtube',
                    code: 'rateLimited',
                    userMessage: 'The target platform is rate-limiting right now. Try again soon.'
                });
            }
            if (reason === 'playlistNotFound') {
                throw new PlaylistError('YouTube playlist not found.', {
                    platform: 'youtube',
                    code: 'playlistNotFound',
                    userMessage: 'YouTube could not find the configured playlist. Verify the playlist ID.'
                });
            }
            if (reason === 'videoNotFound') {
                throw new PlaylistError('YouTube video not found.', {
                    platform: 'youtube',
                    code: 'notFound',
                    userMessage: 'YouTube reported that this video is unavailable.'
                });
            }
            if (reason === 'invalidValue') {
                throw new PlaylistError('Invalid YouTube request.', {
                    platform: 'youtube',
                    code: 'invalid',
                    userMessage: 'YouTube rejected the request. Please double-check the playlist configuration.'
                });
            }
            throw new PlaylistError('Failed to add YouTube video to playlist.', {
                platform: 'youtube',
                code: 'request',
                userMessage: details?.error?.message || 'YouTube rejected the request. Try again later.'
            });
        }

        const data = await res.json();
        return {
            platform: 'youtube',
            title,
            playlistUrl: this.playlistUrl,
            playlistItemId: data?.id ?? null,
            videoId,
            skipped: false
        };
    }
}

function extractYouTubeReason(payload) {
    const errors = payload?.error?.errors;
    if (Array.isArray(errors) && errors.length) {
        return errors[0]?.reason ?? null;
    }
    return payload?.error?.status ?? null;
}

async function safeJson(response) {
    try {
        return await response.clone().json();
    } catch {
        return null;
    }
}

function formatSpotifyTitle(track) {
    const name = track?.name ?? 'Spotify track';
    const artists = Array.isArray(track?.artists)
        ? track.artists.map(artist => artist?.name).filter(Boolean)
        : [];
    if (!artists.length) return name;
    return `${name} — ${artists.join(', ')}`;
}

export class WebhookRelayManager {
    constructor({ client, logger, createWebhookClient } = {}) {
        this.client = client;
        this.logger = logger;
        this.createWebhookClient = typeof createWebhookClient === 'function'
            ? createWebhookClient
            : ({ id, token }) => new WebhookClient({ id, token });
        this.cache = new Map();
    }

    getCache(channelId) {
        return this.cache.get(channelId) ?? null;
    }

    setCache(channelId, value) {
        if (value) {
            this.cache.set(channelId, value);
        } else {
            this.cache.delete(channelId);
        }
    }

    hasManageWebhook(channel) {
        try {
            if (!channel) return false;
            const perms = channel.permissionsFor(channel.guild?.members?.me ?? this.client?.user?.id ?? null);
            return perms?.has?.(PermissionFlagsBits.ManageWebhooks) ?? false;
        } catch {
            return false;
        }
    }

    async resolveWebhook(channel) {
        if (!channel?.isTextBased?.()) return null;
        const channelId = channel.id;
        if (!channelId) return null;

        const existing = this.getCache(channelId);
        if (existing) {
            return existing;
        }

        if (!this.hasManageWebhook(channel)) {
            this.setCache(channelId, null);
            return null;
        }

        try {
            const hooks = await channel.fetchWebhooks();
            const hook = hooks?.find?.(entry => entry?.name === WEBHOOK_NAME && entry?.token);
            if (hook) {
                const cached = {
                    id: hook.id,
                    token: hook.token,
                    client: this.createWebhookClient({ id: hook.id, token: hook.token })
                };
                this.setCache(channelId, cached);
                return cached;
            }
        } catch (err) {
            this.logger?.warn?.(`[playlists] Failed to fetch webhooks for ${channelId}: ${err?.message ?? err}`);
            this.setCache(channelId, null);
            return null;
        }

        try {
            const created = await channel.createWebhook({ name: WEBHOOK_NAME, reason: WEBHOOK_REASON });
            if (!created?.token) {
                this.setCache(channelId, null);
                return null;
            }
            const cached = {
                id: created.id,
                token: created.token,
                client: this.createWebhookClient({ id: created.id, token: created.token })
            };
            this.setCache(channelId, cached);
            return cached;
        } catch (err) {
            this.logger?.warn?.(`[playlists] Failed to create webhook for ${channelId}: ${err?.message ?? err}`);
            this.setCache(channelId, null);
            return null;
        }
    }

    async sendAsMember({ channel, url, username, avatarURL }) {
        if (!channel?.isTextBased?.()) {
            throw new PlaylistError('Channel is not text-based.', {
                code: 'channel'
            });
        }
        const channelId = channel.id;
        const webhook = await this.resolveWebhook(channel);
        if (webhook?.client) {
            try {
                await webhook.client.send({
                    content: url,
                    username,
                    avatarURL,
                    allowedMentions: { parse: [] }
                });
                return { mirrored: true };
            } catch (err) {
                this.logger?.warn?.(`[playlists] Failed to send via webhook ${webhook.id} in ${channelId}: ${err?.message ?? err}`);
                this.setCache(channelId, null);
            }
        }

        try {
            await channel.send({ content: url, allowedMentions: { parse: [] } });
        } catch {
            throw new PlaylistError('Failed to post message in channel.', {
                code: 'sendFailed',
                userMessage: 'I added the item, but I do not have permission to post in this channel.'
            });
        }
        return { mirrored: false };
    }
}

export async function routeToPlatform(parsed, integrations) {
    if (parsed.platform === 'spotify') {
        const spotify = integrations.spotify;
        if (!spotify) {
            throw new PlaylistError('Spotify integration is not configured.', {
                platform: 'spotify',
                code: 'disabled',
                userMessage: 'Spotify integration is not configured. Ask an admin to finish setup.'
            });
        }
        return await spotify.addTrack(parsed.id);
    }
    if (parsed.platform === 'youtube') {
        const youtube = integrations.youtube;
        if (!youtube) {
            throw new PlaylistError('YouTube integration is not configured.', {
                platform: 'youtube',
                code: 'disabled',
                userMessage: 'YouTube integration is not configured. Ask an admin to finish setup.'
            });
        }
        return await youtube.addVideo(parsed.id);
    }
    throw new PlaylistError('Unsupported platform.', {
        code: 'unsupported',
        userMessage: 'I can only add Spotify tracks or YouTube videos. Please paste a direct track/video link.'
    });
}

function resolveDisplayName(interaction) {
    return interaction.member?.displayName
        ?? interaction.member?.nickname
        ?? interaction.user?.globalName
        ?? interaction.user?.username
        ?? 'Member';
}

function resolveAvatarUrl(interaction) {
    const member = interaction.member;
    if (member && typeof member.displayAvatarURL === 'function') {
        return member.displayAvatarURL({ extension: 'png', size: 256 });
    }
    if (interaction.user && typeof interaction.user.displayAvatarURL === 'function') {
        return interaction.user.displayAvatarURL({ extension: 'png', size: 256 });
    }
    return null;
}

function createSuccessMessage({ platform, title, playlistUrl, mirrored, skipped }) {
    const lines = [];
    const label = platform === 'spotify' ? 'Spotify' : 'YouTube';
    if (skipped) {
        lines.push(`Already on the ${label} playlist: ${title}`);
    } else {
        lines.push(`Added to the ${label} playlist: ${title}`);
    }
    if (playlistUrl) {
        lines.push(`Playlist: ${playlistUrl}`);
    }
    if (!skipped && !mirrored) {
        lines.push('Note: I need Manage Webhooks in this channel to mirror your name/avatar, so I posted as the bot instead.');
    }
    if (skipped) {
        lines.push('The link was not re-posted because the track already exists in the playlist.');
    }
    return lines.join('\n');
}

function createErrorMessage(err) {
    if (err instanceof PlaylistError) {
        return err.userMessage;
    }
    return 'Something went wrong while processing that link. Please try again in a moment.';
}

function logAudit(logger, interaction, result) {
    if (!logger) return;
    const platformId = result.platform === 'spotify' ? result.trackId : result.videoId ?? null;
    const playlistId = result.platform === 'spotify'
        ? runtime.spotify?.playlistId
        : runtime.youtube?.playlistId;
    const payload = {
        guild: interaction.guildId ?? null,
        channel: interaction.channelId ?? null,
        userId: interaction.user?.id ?? null,
        platform: result.platform,
        id: platformId,
        playlistId,
        snapshotId: result.snapshotId ?? null,
        playlistItemId: result.playlistItemId ?? null,
        trackUri: result.trackUri ?? null,
        videoId: result.videoId ?? null,
        timestamp: new Date().toISOString()
    };
    logger.info(`[playlists] audit ${JSON.stringify(payload)}`);
}

export const commands = [
    new SlashCommandBuilder()
    .setName('add')
    .setDescription('Add a Spotify track or YouTube video to the shared playlist')
    .setDMPermission(false)
    .addStringOption(opt =>
        opt
        .setName('link')
        .setDescription('Paste a Spotify track or YouTube video link.')
        .setRequired(true)
    )
];

const runtime = {
    client: null,
    logger: null,
    spotify: null,
    youtube: null,
    webhookRelay: null
};

function rebuildIntegrations(config, logger) {
    const normalized = normalizePlaylistsConfig(config?.playlists);
    runtime.spotify = normalized.spotify ? new SpotifyIntegration(normalized.spotify, logger) : null;
    runtime.youtube = normalized.youtube ? new YouTubeIntegration(normalized.youtube, logger) : null;
}

async function replySafely(interaction, payload) {
    if (interaction.deferred || interaction.replied) {
        await interaction.editReply(payload);
    } else {
        await interaction.reply({ ...payload, ephemeral: true });
    }
}

export async function init(ctx) {
    runtime.client = ctx.client;
    runtime.logger = ctx.logger;
    runtime.webhookRelay = new WebhookRelayManager({ client: ctx.client, logger: ctx.logger });

    rebuildIntegrations(ctx.config, ctx.logger);

    if (!runtime.spotify && !runtime.youtube) {
        ctx.logger.warn('[playlists] No playlist integrations configured; /add will return errors.');
    }

    ctx.client.on('squire:configUpdated', (nextConfig) => {
        rebuildIntegrations(nextConfig, ctx.logger);
    });

    ctx.client.on('interactionCreate', async (interaction) => {
        if (!interaction.isChatInputCommand()) return;
        if (interaction.commandName !== 'add') return;

        const channel = interaction.channel;
        if (!channel?.isTextBased?.()) {
            await replySafely(interaction, {
                content: 'This command can only be used in text channels inside a server.',
                ephemeral: true
            });
            return;
        }

        const rawLink = interaction.options.getString('link', true);

        let parsed;
        try {
            parsed = parsePlaylistLink(rawLink);
        } catch (err) {
            await replySafely(interaction, {
                content: createErrorMessage(err),
                ephemeral: true
            });
            return;
        }

        const integrations = { spotify: runtime.spotify, youtube: runtime.youtube };

        if ((parsed.platform === 'spotify' && !integrations.spotify)
            || (parsed.platform === 'youtube' && !integrations.youtube)) {
            const message = parsed.platform === 'spotify'
                ? 'Spotify integration is not configured. Ask an admin to finish setup.'
                : 'YouTube integration is not configured. Ask an admin to finish setup.';
            await replySafely(interaction, { content: message, ephemeral: true });
            return;
        }

        if (!interaction.deferred && !interaction.replied) {
            await interaction.deferReply({ ephemeral: true });
        }

        let result;
        try {
            result = await routeToPlatform(parsed, integrations);
        } catch (err) {
            await replySafely(interaction, {
                content: createErrorMessage(err),
                ephemeral: true
            });
            return;
        }

        let mirrored = false;
        let postNotice = null;
        if (!result.skipped) {
            try {
                const identity = {
                    username: resolveDisplayName(interaction),
                    avatarURL: resolveAvatarUrl(interaction)
                };
                const sendResult = await runtime.webhookRelay.sendAsMember({
                    channel,
                    url: parsed.normalizedUrl,
                    username: identity.username,
                    avatarURL: identity.avatarURL
                });
                mirrored = sendResult?.mirrored ?? false;
            } catch (err) {
                runtime.logger?.warn?.(`[playlists] Failed to deliver mirrored message: ${err?.message ?? err}`);
                mirrored = false;
                postNotice = err instanceof PlaylistError
                    ? err.userMessage
                    : 'I added the item, but I could not post the link in this channel.';
            }
        }

        let content = createSuccessMessage({
            platform: result.platform,
            title: result.title,
            playlistUrl: result.playlistUrl,
            mirrored,
            skipped: result.skipped
        });

        if (postNotice) {
            content += `\n${postNotice}`;
        }

        await replySafely(interaction, { content, ephemeral: true });

        if (!result.skipped) {
            logAudit(runtime.logger, interaction, result);
        }
    });
}

