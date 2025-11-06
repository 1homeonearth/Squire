import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    parsePlaylistLink,
    normalizePlaylistsConfig,
    WebhookRelayManager,
    routeToPlatform
} from '../src/features/playlists/index.js';

const originalEnv = {
    SPOTIFY_CLIENT_ID: process.env.SPOTIFY_CLIENT_ID,
    SPOTIFY_CLIENT_SECRET: process.env.SPOTIFY_CLIENT_SECRET,
    SPOTIFY_REFRESH_TOKEN: process.env.SPOTIFY_REFRESH_TOKEN,
    SPOTIFY_PLAYLIST_ID: process.env.SPOTIFY_PLAYLIST_ID,
    PLAYLISTS_SKIP_DUPES: process.env.PLAYLISTS_SKIP_DUPES,
    YT_CLIENT_ID: process.env.YT_CLIENT_ID,
    YT_CLIENT_SECRET: process.env.YT_CLIENT_SECRET,
    YT_REFRESH_TOKEN: process.env.YT_REFRESH_TOKEN,
    YT_PLAYLIST_ID: process.env.YT_PLAYLIST_ID
};

afterEach(() => {
    Object.entries(originalEnv).forEach(([key, value]) => {
        if (typeof value === 'undefined') {
            delete process.env[key];
        } else {
            process.env[key] = value;
        }
    });
});

describe('parsePlaylistLink', () => {
    it('parses Spotify URLs and normalizes output', () => {
        const parsed = parsePlaylistLink('open.spotify.com/track/12345');
        expect(parsed.platform).toBe('spotify');
        expect(parsed.id).toBe('12345');
        expect(parsed.normalizedUrl).toBe('https://open.spotify.com/track/12345');
    });

    it('parses Spotify URIs', () => {
        const parsed = parsePlaylistLink('spotify:track:67890');
        expect(parsed.platform).toBe('spotify');
        expect(parsed.id).toBe('67890');
        expect(parsed.normalizedUrl).toBe('https://open.spotify.com/track/67890');
    });

    it('parses YouTube URLs including shorts and youtu.be', () => {
        const parsedWatch = parsePlaylistLink('youtube.com/watch?v=aaaaaaaaaaa');
        expect(parsedWatch.platform).toBe('youtube');
        expect(parsedWatch.id).toBe('aaaaaaaaaaa');
        expect(parsedWatch.normalizedUrl).toBe('https://youtu.be/aaaaaaaaaaa');

        const parsedShorts = parsePlaylistLink('https://www.youtube.com/shorts/BBBBBBBBBBB');
        expect(parsedShorts.platform).toBe('youtube');
        expect(parsedShorts.id).toBe('BBBBBBBBBBB');
        expect(parsedShorts.normalizedUrl).toBe('https://youtu.be/BBBBBBBBBBB');

        const parsedShortLink = parsePlaylistLink('https://youtu.be/CCCCCCCCCCC');
        expect(parsedShortLink.platform).toBe('youtube');
        expect(parsedShortLink.id).toBe('CCCCCCCCCCC');
    });

    it('throws for unsupported links', () => {
        try {
            parsePlaylistLink('https://example.com');
            throw new Error('Expected failure');
        } catch (err) {
            expect(err.message).toBe('Unsupported link.');
            expect(err.userMessage).toContain('Spotify tracks or YouTube videos');
        }
    });
});

describe('normalizePlaylistsConfig', () => {
    it('draws Spotify config from env with skip dupes flag', () => {
        process.env.SPOTIFY_CLIENT_ID = 'cid';
        process.env.SPOTIFY_CLIENT_SECRET = 'secret';
        process.env.SPOTIFY_REFRESH_TOKEN = 'refresh';
        process.env.SPOTIFY_PLAYLIST_ID = 'playlist';
        process.env.PLAYLISTS_SKIP_DUPES = 'true';
        const normalized = normalizePlaylistsConfig({});
        expect(normalized.spotify?.clientId).toBe('cid');
        expect(normalized.spotify?.skipDupes).toBe(true);
    });

    it('returns null entries when required fields missing', () => {
        const normalized = normalizePlaylistsConfig({});
        expect(normalized.spotify).toBeNull();
        expect(normalized.youtube).toBeNull();
    });
});

describe('WebhookRelayManager', () => {
    it('caches resolved webhooks per channel', async () => {
        const sendSpy = vi.fn(async () => {});
        const createWebhookClient = vi.fn(() => ({ send: sendSpy }));
        const channel = {
            id: '123',
            isTextBased: () => true,
            guild: { members: { me: {} } },
            permissionsFor: vi.fn(() => ({ has: vi.fn(() => true) })),
            fetchWebhooks: vi.fn(async () => [
                { id: '999', name: 'Squire Relay', token: 'tok' }
            ]),
            createWebhook: vi.fn(),
            send: vi.fn()
        };

        const manager = new WebhookRelayManager({ client: { user: { id: 'bot' } }, createWebhookClient });
        await manager.sendAsMember({ channel, url: 'https://example.com', username: 'User', avatarURL: null });
        expect(createWebhookClient).toHaveBeenCalledTimes(1);
        expect(channel.fetchWebhooks).toHaveBeenCalledTimes(1);
        expect(sendSpy).toHaveBeenCalledWith({
            content: 'https://example.com',
            username: 'User',
            avatarURL: null,
            allowedMentions: { parse: [] }
        });

        await manager.sendAsMember({ channel, url: 'https://example.com/2', username: 'User', avatarURL: null });
        expect(createWebhookClient).toHaveBeenCalledTimes(1);
        expect(channel.fetchWebhooks).toHaveBeenCalledTimes(1);
        expect(sendSpy).toHaveBeenCalledTimes(2);
        expect(channel.send).not.toHaveBeenCalled();
    });
});

describe('routeToPlatform', () => {
    it('routes Spotify requests to the Spotify client', async () => {
        const spotify = { addTrack: vi.fn(async (id) => ({
            platform: 'spotify',
            title: 'Song',
            playlistUrl: 'https://spotify',
            snapshotId: 'snap',
            trackId: id,
            trackUri: `spotify:track:${id}`,
            skipped: false
        })) };
        const result = await routeToPlatform({ platform: 'spotify', id: 'track123' }, { spotify, youtube: null });
        expect(spotify.addTrack).toHaveBeenCalledWith('track123');
        expect(result.platform).toBe('spotify');
        expect(result.trackId).toBe('track123');
    });

    it('routes YouTube requests to the YouTube client', async () => {
        const youtube = { addVideo: vi.fn(async (id) => ({
            platform: 'youtube',
            title: 'Video',
            playlistUrl: 'https://youtube',
            playlistItemId: 'item',
            videoId: id,
            skipped: false
        })) };
        const result = await routeToPlatform({ platform: 'youtube', id: 'video123' }, { spotify: null, youtube });
        expect(youtube.addVideo).toHaveBeenCalledWith('video123');
        expect(result.platform).toBe('youtube');
        expect(result.videoId).toBe('video123');
    });

    it('throws when integration is missing', async () => {
        await expect(routeToPlatform({ platform: 'spotify', id: 'x' }, { spotify: null, youtube: null }))
            .rejects.toThrowError(/Spotify integration is not configured/);
    });
});
