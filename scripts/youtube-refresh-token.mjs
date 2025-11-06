#!/usr/bin/env node
// scripts/youtube-refresh-token.mjs
// Helper to exchange an authorization code or refresh token for YouTube Data API credentials.

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
    console.log('Usage: node scripts/youtube-refresh-token.mjs --code <authorization_code> --redirect <redirect_uri>');
    console.log('   or: node scripts/youtube-refresh-token.mjs --refresh <refresh_token>');
    console.log('Environment variables: YT_CLIENT_ID, YT_CLIENT_SECRET (or pass --client-id/--client-secret).');
}

const clientId = pickArg('--client-id', 'YT_CLIENT_ID');
const clientSecret = pickArg('--client-secret', 'YT_CLIENT_SECRET');
const code = pickArg('--code');
const redirectUri = pickArg('--redirect');
const refreshToken = pickArg('--refresh', 'YT_REFRESH_TOKEN');

if (!clientId || !clientSecret) {
    console.error('Missing YouTube client credentials.');
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
params.set('client_id', clientId);
params.set('client_secret', clientSecret);

try {
    const response = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: params
    });

    const payload = await response.json();
    if (!response.ok) {
        console.error('YouTube token exchange failed:', payload);
        process.exit(1);
    }

    console.log(JSON.stringify(payload, null, 2));
} catch (err) {
    console.error('Unexpected error while calling YouTube token endpoint:', err?.message ?? err);
    process.exit(1);
}
