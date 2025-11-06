#!/usr/bin/env node
// scripts/spotify-refresh-token.mjs
// Helper to exchange an authorization code or refresh token for Spotify access tokens.

const args = new Map();
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const next = argv[i + 1];
    if (key.startsWith('--')) {
        if (next && !next.startsWith('--')) {
            args.set(key, next);
            i += 1;
        } else {
            args.set(key, true);
        }
    }
}

function pickArg(name, envKey) {
    const direct = args.get(name);
    if (typeof direct === 'string' && direct.trim()) return direct.trim();
    const env = envKey ? process.env[envKey] : null;
    if (typeof env === 'string' && env.trim()) return env.trim();
    return null;
}

function usage() {
    console.log('Usage: node scripts/spotify-refresh-token.mjs --code <authorization_code> --redirect <redirect_uri>');
    console.log('   or: node scripts/spotify-refresh-token.mjs --refresh <refresh_token>');
    console.log('Environment variables: SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET (or pass --client-id/--client-secret).');
}

const clientId = pickArg('--client-id', 'SPOTIFY_CLIENT_ID');
const clientSecret = pickArg('--client-secret', 'SPOTIFY_CLIENT_SECRET');
const code = pickArg('--code');
const redirectUri = pickArg('--redirect');
const refreshToken = pickArg('--refresh', 'SPOTIFY_REFRESH_TOKEN');

if (!clientId || !clientSecret) {
    console.error('Missing Spotify client credentials.');
    usage();
    process.exit(1);
}

let grantType = null;
if (code) {
    grantType = 'authorization_code';
    if (!redirectUri) {
        console.error('Missing --redirect for authorization code exchange.');
        usage();
        process.exit(1);
    }
} else if (refreshToken) {
    grantType = 'refresh_token';
} else {
    usage();
    process.exit(1);
}

const params = new URLSearchParams();
params.set('grant_type', grantType);
if (grantType === 'authorization_code') {
    params.set('code', code);
    params.set('redirect_uri', redirectUri);
} else {
    params.set('refresh_token', refreshToken);
}

const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

try {
    const response = await fetch('https://accounts.spotify.com/api/token', {
        method: 'POST',
        headers: {
            Authorization: `Basic ${auth}`,
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: params
    });

    const payload = await response.json();
    if (!response.ok) {
        console.error('Spotify token exchange failed:', payload);
        process.exit(1);
    }

    console.log(JSON.stringify(payload, null, 2));
} catch (err) {
    console.error('Unexpected error while calling Spotify token endpoint:', err?.message ?? err);
    process.exit(1);
}
