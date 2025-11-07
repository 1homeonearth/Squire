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

function sanitizeSongComponent(value) {
    if (typeof value !== 'string') return '';
    return value
        .replace(/["“”‘’]/g, '')
        .replace(/\s*[\(\[\{][^\)\]\}]*[\)\]\}]\s*/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function removeFeaturingClauses(value) {
    if (!value) return '';
    return value.replace(/\b(feat\.?|ft\.?)\b.*$/i, '').trim();
}

function normalizeSongKey(value) {
    const sanitized = sanitizeSongComponent(value);
    if (!sanitized) return '';
    return removeFeaturingClauses(sanitized)
        .replace(/&/g, 'and')
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim();
}

function normalizeArtistKey(value) {
    const base = typeof value === 'string' ? value.replace(/-\s*topic$/i, '') : '';
    const sanitized = sanitizeSongComponent(base);
    if (!sanitized) return '';
    return sanitized
        .replace(/&/g, 'and')
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim();
}

function parseYouTubeSongMetadata(snippet = {}) {
    const rawTitle = sanitizeSongComponent(snippet.title ?? '');
    if (!rawTitle) {
        return null;
    }
    const parts = rawTitle.split(/\s*[-–—]\s*/);
    if (parts.length >= 2) {
        const artist = removeFeaturingClauses(sanitizeSongComponent(parts[0]));
        const title = removeFeaturingClauses(sanitizeSongComponent(parts.slice(1).join(' - ')));
        if (artist && title) {
            return { artist, title };
        }
    }
    const channelTitle = sanitizeSongComponent(snippet.channelTitle ?? '');
    if (channelTitle) {
        const artist = removeFeaturingClauses(channelTitle);
        if (artist && rawTitle) {
            return { artist, title: removeFeaturingClauses(rawTitle) };
        }
    }
    return null;
}

function buildSpotifySongMetadata(track) {
    const title = sanitizeSongComponent(track?.name ?? '');
    const artists = Array.isArray(track?.artists)
        ? track.artists.map(entry => sanitizeSongComponent(entry?.name ?? '')).filter(Boolean)
        : [];
    return {
        title,
        artist: artists[0] ?? '',
        artists
    };
}

function normalizeGuildPlaylists(source, platform) {
    const map = {};
    if (!source || typeof source !== 'object') {
        return map;
    }
    for (const [guildId, raw] of Object.entries(source)) {
        const id = pickString(guildId);
        if (!id) continue;
        let playlistId = null;
        let name = null;
        if (typeof raw === 'string') {
            playlistId = pickString(raw);
        } else if (raw && typeof raw === 'object') {
            playlistId = pickString(raw.playlistId);
            name = pickString(raw.name);
        }
        map[id] = {
            playlistId,
            playlistUrl: playlistId ? playlistUrlForPlatform(platform, playlistId) : null,
            name
        };
    }
    return map;
}

export function normalizePlaylistsConfig(source = {}) {
    const cfg = source && typeof source === 'object' ? { ...source } : {};

    const spotifyRaw = cfg.spotify && typeof cfg.spotify === 'object' ? cfg.spotify : {};
    const youtubeRaw = cfg.youtube && typeof cfg.youtube === 'object' ? cfg.youtube : {};

    const spotifyGuilds = normalizeGuildPlaylists(spotifyRaw.guilds ?? {}, 'spotify');
    const youtubeGuilds = normalizeGuildPlaylists(youtubeRaw.guilds ?? {}, 'youtube');

    const spotifyFallbackId = pickString(spotifyRaw.playlistId, process.env.SPOTIFY_PLAYLIST_ID);
    const youtubeFallbackId = pickString(youtubeRaw.playlistId, process.env.YT_PLAYLIST_ID);

    const spotify = (() => {
        const clientId = pickString(spotifyRaw.clientId, process.env.SPOTIFY_CLIENT_ID);
        const clientSecret = pickString(spotifyRaw.clientSecret, process.env.SPOTIFY_CLIENT_SECRET);
        const refreshToken = pickString(spotifyRaw.refreshToken, process.env.SPOTIFY_REFRESH_TOKEN);
        if (!clientId || !clientSecret || !refreshToken) return null;
        const skipSource = spotifyRaw.skipDupes ?? process.env.PLAYLISTS_SKIP_DUPES;
        const skipDupes = parseBoolean(skipSource, false);
        return {
            clientId,
            clientSecret,
            refreshToken,
            skipDupes,
            fallback: spotifyFallbackId ? {
                playlistId: spotifyFallbackId,
                playlistUrl: playlistUrlForPlatform('spotify', spotifyFallbackId)
            } : null,
            guilds: spotifyGuilds
        };
    })();

    const youtube = (() => {
        const clientId = pickString(youtubeRaw.clientId, process.env.YT_CLIENT_ID);
        const clientSecret = pickString(youtubeRaw.clientSecret, process.env.YT_CLIENT_SECRET);
        const refreshToken = pickString(youtubeRaw.refreshToken, process.env.YT_REFRESH_TOKEN);
        if (!clientId || !clientSecret || !refreshToken) return null;
        return {
            clientId,
            clientSecret,
            refreshToken,
            fallback: youtubeFallbackId ? {
                playlistId: youtubeFallbackId,
                playlistUrl: playlistUrlForPlatform('youtube', youtubeFallbackId)
            } : null,
            guilds: youtubeGuilds
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
        this.skipDupes = Boolean(config.skipDupes);
        this.guilds = config.guilds ?? {};
        this.fallback = config.fallback ?? null;
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

    async trackExists(trackId, playlistId) {
        if (!this.skipDupes || !playlistId) return false;
        const targetUri = `${this.trackUriBase}${trackId}`;
        let url = `https://api.spotify.com/v1/playlists/${playlistId}/tracks?fields=items(track(uri)),next&limit=100`;
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

    resolvePlaylist(guildId) {
        if (guildId && this.guilds[guildId]?.playlistId) {
            const entry = this.guilds[guildId];
            return {
                playlistId: entry.playlistId,
                playlistUrl: entry.playlistUrl ?? playlistUrlForPlatform('spotify', entry.playlistId)
            };
        }
        return this.fallback ?? null;
    }

    async addTrack(trackId, guildId) {
        const playlist = this.resolvePlaylist(guildId);
        if (!playlist?.playlistId) {
            throw new PlaylistError('Spotify playlist not configured for this server.', {
                platform: 'spotify',
                code: 'playlistMissing',
                userMessage: 'Configure the Spotify playlist for this server in `/setup` before adding tracks.'
            });
        }
        const track = await this.fetchTrack(trackId);
        const trackTitle = formatSpotifyTitle(track);
        const trackUri = `${this.trackUriBase}${trackId}`;
        const songMetadata = buildSpotifySongMetadata(track);

        if (await this.trackExists(trackId, playlist.playlistId)) {
            return {
                platform: 'spotify',
                title: trackTitle,
                playlistUrl: playlist.playlistUrl,
                trackId,
                skipped: true,
                trackUri,
                playlistId: playlist.playlistId,
                songMetadata
            };
        }

        const body = JSON.stringify({ uris: [trackUri] });
        const res = await this.request(`https://api.spotify.com/v1/playlists/${playlist.playlistId}/tracks`, {
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
            playlistUrl: playlist.playlistUrl,
            snapshotId: data.snapshot_id ?? null,
            trackId,
            trackUri,
            skipped: false,
            playlistId: playlist.playlistId,
            songMetadata
        };
    }

    async findMatchingTrack({ title, artist }) {
        const normalizedTitle = normalizeSongKey(title);
        const normalizedArtist = normalizeArtistKey(artist);
        if (!normalizedTitle || !normalizedArtist) {
            return null;
        }

        const params = new URLSearchParams();
        params.set('type', 'track');
        params.set('limit', '5');
        const queryTitle = sanitizeSongComponent(title).replace(/"/g, '');
        const queryArtist = sanitizeSongComponent(artist).replace(/"/g, '');
        params.set('q', `track:"${queryTitle}" artist:"${queryArtist}"`);

        const res = await this.request(`https://api.spotify.com/v1/search?${params.toString()}`, { method: 'GET' });
        if (!res.ok) {
            const details = await safeJson(res);
            const message = details?.error?.message || res.statusText || 'Unknown error';
            this.logger?.warn?.(`[playlists] Spotify search failed for ${artist} — ${title}: ${message}`);
            return null;
        }

        const data = await res.json();
        const tracks = Array.isArray(data?.tracks?.items) ? data.tracks.items : [];
        for (const track of tracks) {
            const trackTitle = normalizeSongKey(track?.name ?? '');
            if (!trackTitle) continue;
            const artists = Array.isArray(track?.artists)
                ? track.artists.map(entry => normalizeArtistKey(entry?.name ?? '')).filter(Boolean)
                : [];
            if (trackTitle === normalizedTitle && artists.includes(normalizedArtist)) {
                return track;
            }
        }
        return null;
    }
}

class YouTubeIntegration {
    constructor(config, logger) {
        this.clientId = config.clientId;
        this.clientSecret = config.clientSecret;
        this.refreshToken = config.refreshToken;
        this.guilds = config.guilds ?? {};
        this.fallback = config.fallback ?? null;
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

    resolvePlaylist(guildId) {
        if (guildId && this.guilds[guildId]?.playlistId) {
            const entry = this.guilds[guildId];
            return {
                playlistId: entry.playlistId,
                playlistUrl: entry.playlistUrl ?? playlistUrlForPlatform('youtube', entry.playlistId)
            };
        }
        return this.fallback ?? null;
    }

    async addVideo(videoId, guildId) {
        const playlist = this.resolvePlaylist(guildId);
        if (!playlist?.playlistId) {
            throw new PlaylistError('YouTube playlist not configured for this server.', {
                platform: 'youtube',
                code: 'playlistMissing',
                userMessage: 'Configure the YouTube playlist for this server in `/setup` before adding videos.'
            });
        }
        const video = await this.fetchVideo(videoId);
        const title = video?.snippet?.title ?? `Video ${videoId}`;
        const metadata = parseYouTubeSongMetadata(video?.snippet ?? {});
        const body = JSON.stringify({
            snippet: {
                playlistId: playlist.playlistId,
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
            playlistUrl: playlist.playlistUrl,
            playlistItemId: data?.id ?? null,
            videoId,
            skipped: false,
            playlistId: playlist.playlistId,
            songMetadata: metadata ? { title: metadata.title, artist: metadata.artist } : null,
            originalTitle: video?.snippet?.title ?? title
        };
    }

    async findMatchingVideo({ title, artist }) {
        const normalizedTitle = normalizeSongKey(title);
        const normalizedArtist = normalizeArtistKey(artist);
        if (!normalizedTitle || !normalizedArtist) {
            return null;
        }

        const params = new URLSearchParams();
        params.set('part', 'snippet');
        params.set('type', 'video');
        params.set('maxResults', '5');
        const queryTitle = sanitizeSongComponent(title);
        const queryArtist = sanitizeSongComponent(artist);
        params.set('q', `${queryArtist} ${queryTitle}`);

        const res = await this.request(`https://www.googleapis.com/youtube/v3/search?${params.toString()}`, { method: 'GET' });
        if (!res.ok) {
            const details = await safeJson(res);
            const reason = extractYouTubeReason(details) ?? res.statusText ?? 'Unknown error';
            this.logger?.warn?.(`[playlists] YouTube search failed for ${artist} — ${title}: ${reason}`);
            return null;
        }

        const data = await res.json();
        const items = Array.isArray(data?.items) ? data.items : [];
        for (const item of items) {
            const videoId = item?.id?.videoId ?? null;
            if (!videoId) continue;
            const snippet = item?.snippet ?? {};
            const parsed = parseYouTubeSongMetadata(snippet);
            if (parsed) {
                const parsedTitle = normalizeSongKey(parsed.title);
                const parsedArtist = normalizeArtistKey(parsed.artist);
                if (parsedTitle === normalizedTitle && parsedArtist === normalizedArtist) {
                    return { videoId, snippet };
                }
            }
            const channelMatch = normalizeArtistKey(snippet.channelTitle ?? '');
            const titleMatch = normalizeSongKey(snippet.title ?? '');
            if (titleMatch === normalizedTitle && channelMatch === normalizedArtist) {
                return { videoId, snippet };
            }
        }
        return null;
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

function mirrorErrorMessage(err) {
    if (err instanceof PlaylistError) {
        return err.userMessage ?? err.message;
    }
    if (err?.message) {
        return err.message;
    }
    return String(err ?? 'Unknown error');
}

async function mirrorSpotifyTrackToYouTube({ primary, youtube, guildId }) {
    if (!primary?.songMetadata) {
        return { platform: 'youtube', status: 'metadataMissing' };
    }
    const { title, artist } = primary.songMetadata;
    if (!title || !artist) {
        return { platform: 'youtube', status: 'metadataMissing' };
    }

    let match;
    try {
        match = await youtube.findMatchingVideo({ title, artist });
    } catch (err) {
        return { platform: 'youtube', status: 'error', message: mirrorErrorMessage(err) };
    }

    if (!match?.videoId) {
        return { platform: 'youtube', status: 'notFound' };
    }

    try {
        const addition = await youtube.addVideo(match.videoId, guildId);
        return {
            platform: 'youtube',
            status: addition.skipped ? 'skipped' : 'added',
            title: addition.title,
            playlistUrl: addition.playlistUrl,
            videoId: addition.videoId
        };
    } catch (err) {
        return { platform: 'youtube', status: 'error', message: mirrorErrorMessage(err) };
    }
}

async function mirrorYouTubeVideoToSpotify({ primary, spotify, guildId }) {
    const metadata = primary?.songMetadata;
    if (!metadata?.title || !metadata?.artist) {
        return { platform: 'spotify', status: 'metadataMissing' };
    }

    let track;
    try {
        track = await spotify.findMatchingTrack({ title: metadata.title, artist: metadata.artist });
    } catch (err) {
        return { platform: 'spotify', status: 'error', message: mirrorErrorMessage(err) };
    }

    if (!track?.id) {
        return { platform: 'spotify', status: 'notFound' };
    }

    try {
        const addition = await spotify.addTrack(track.id, guildId);
        return {
            platform: 'spotify',
            status: addition.skipped ? 'skipped' : 'added',
            title: addition.title,
            playlistUrl: addition.playlistUrl,
            trackId: addition.trackId
        };
    } catch (err) {
        return { platform: 'spotify', status: 'error', message: mirrorErrorMessage(err) };
    }
}

export async function routeToPlatform(parsed, integrations, { guildId } = {}) {
    if (parsed.platform === 'spotify') {
        const spotify = integrations.spotify;
        if (!spotify) {
            throw new PlaylistError('Spotify integration is not configured.', {
                platform: 'spotify',
                code: 'disabled',
                userMessage: 'Spotify integration is not configured. Ask an admin to finish setup.'
            });
        }
        const primary = await spotify.addTrack(parsed.id, guildId);
        const mirrors = [];
        if (integrations.youtube) {
            const mirror = await mirrorSpotifyTrackToYouTube({
                primary,
                youtube: integrations.youtube,
                guildId
            });
            if (mirror) mirrors.push(mirror);
        }
        return { primary, mirrors };
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
        const primary = await youtube.addVideo(parsed.id, guildId);
        const mirrors = [];
        if (integrations.spotify) {
            const mirror = await mirrorYouTubeVideoToSpotify({
                primary,
                spotify: integrations.spotify,
                guildId
            });
            if (mirror) mirrors.push(mirror);
        }
        return { primary, mirrors };
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

function describeMirrorOutcome(entry) {
    const label = entry.platform === 'spotify' ? 'Spotify' : 'YouTube';
    switch (entry.status) {
        case 'added':
            return `Mirrored on the ${label} playlist: ${entry.title ?? 'Matched entry'}`;
        case 'skipped':
            return `Already on the ${label} playlist: ${entry.title ?? 'Matched entry'}`;
        case 'notFound':
            return label === 'Spotify'
                ? 'Could not find a matching Spotify track to mirror.'
                : 'Could not find a matching YouTube video to mirror.';
        case 'metadataMissing':
            return `Could not determine song metadata to mirror onto ${label}.`;
        case 'error':
            return `Mirror to ${label} failed: ${entry.message ?? 'Unknown error.'}`;
        default:
            return null;
    }
}

function createSuccessMessage({ primary, mirrors = [], mirrored }) {
    const lines = [];
    const label = primary.platform === 'spotify' ? 'Spotify' : 'YouTube';
    if (primary.skipped) {
        lines.push(`Already on the ${label} playlist: ${primary.title}`);
    } else {
        lines.push(`Added to the ${label} playlist: ${primary.title}`);
    }
    if (primary.playlistUrl) {
        lines.push(`Playlist: ${primary.playlistUrl}`);
    }
    if (!primary.skipped && !mirrored) {
        lines.push('Note: I need Manage Webhooks in this channel to mirror your name/avatar, so I posted as the bot instead.');
    }
    if (primary.skipped) {
        lines.push('The link was not re-posted because the track already exists in the playlist.');
    }
    for (const mirror of mirrors) {
        const summary = describeMirrorOutcome(mirror);
        if (summary) {
            lines.push(summary);
            if (mirror.playlistUrl && ['added', 'skipped'].includes(mirror.status)) {
                lines.push(`Playlist: ${mirror.playlistUrl}`);
            }
        }
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
    const playlistId = result.playlistId ?? null;
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

        let outcome;
        try {
            outcome = await routeToPlatform(parsed, integrations, { guildId: interaction.guildId ?? null });
        } catch (err) {
            await replySafely(interaction, {
                content: createErrorMessage(err),
                ephemeral: true
            });
            return;
        }

        const primary = outcome?.primary ?? null;
        const mirrors = Array.isArray(outcome?.mirrors) ? outcome.mirrors : [];
        if (!primary) {
            await replySafely(interaction, {
                content: 'Something went wrong while processing that link. Please try again in a moment.',
                ephemeral: true
            });
            return;
        }

        let mirroredLink = false;
        let postNotice = null;
        if (!primary.skipped) {
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
                mirroredLink = sendResult?.mirrored ?? false;
            } catch (err) {
                runtime.logger?.warn?.(`[playlists] Failed to deliver mirrored message: ${err?.message ?? err}`);
                mirroredLink = false;
                postNotice = err instanceof PlaylistError
                    ? err.userMessage
                    : 'I added the item, but I could not post the link in this channel.';
            }
        }

        let content = createSuccessMessage({
            primary,
            mirrors,
            mirrored: mirroredLink
        });

        if (postNotice) {
            content += `\n${postNotice}`;
        }

        await replySafely(interaction, { content, ephemeral: true });

        if (!primary.skipped) {
            logAudit(runtime.logger, interaction, primary);
        }
    });
}

