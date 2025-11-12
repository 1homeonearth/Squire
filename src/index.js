// src/index.js
import { WebhookClient } from 'discord.js';

import { createClient } from './core/client.js';
import { loadConfig } from './core/config.js';
import { createLogger } from './core/logger.js';
import { createDb } from './core/db.js';
import { loadFeatures } from './core/loader.js';
import { startInternalApi } from '../mcp/internal-api.mjs'; // MCP bridge (localhost) — starts when client is ready

const config = loadConfig();               // reads ./config.json
const logger = createLogger(config.debugLevel || 'info');
const db = await createDb(config.dbPath || './squire.db.json');

const client = await createClient({ token: config.token, logger });

await loadFeatures({
    client,
    config,
    logger,
    db
});

// ————— Start localhost-only MCP control API as soon as the client is usable —————
const bootInternalApi = () => {
    try {
        startInternalApi({ client, logger });
    } catch (e) {
        logger.error(`[internal-api] failed to start: ${e?.message ?? e}`);
    }
};
if (typeof client.isReady === 'function' && client.isReady()) {
    bootInternalApi();
} else {
    client.once('ready', bootInternalApi);
}

const SHUTDOWN_EMOJI = '❎';
let shuttingDown = false;

async function fetchGuildSafe(id) {
    if (!id) return null;
    return client.guilds.cache.get(id) ?? await client.guilds.fetch(id).catch(() => null);
}

async function notifySystemChannel(message) {
    const loggingServerId = config.loggingServerId ?? null;
    const systemChannelId = config.loggingChannels?.system ?? null;
    if (!loggingServerId || !systemChannelId) return;

    try {
        const guild = await fetchGuildSafe(loggingServerId);
        if (!guild) return;

        let channel = guild.channels?.cache?.get(systemChannelId) ?? null;
        if (!channel && typeof guild.channels?.fetch === 'function') {
            channel = await guild.channels.fetch(systemChannelId).catch(() => null);
        }
        if (channel && typeof channel.isTextBased === 'function' && channel.isTextBased()) {
            await channel.send({ content: message });
        }
    } catch (err) {
        logger.warn(`[shutdown] Failed to notify system channel ${systemChannelId}: ${err?.message ?? err}`);
    }
}

async function notifyMappingWebhooks(baseMessage) {
    const entries = Object.entries(config.mapping || {}).filter(([, url]) => typeof url === 'string' && url);
    for (const [guildId, url] of entries) {
        try {
            const guild = await fetchGuildSafe(guildId);
            const guildName = guild?.name ?? guildId;
            const webhook = new WebhookClient({ url, allowedMentions: { parse: [], repliedUser: false } });
            await webhook.send({ content: `${baseMessage} for server **${guildName}**` });
        } catch (err) {
            logger.warn(`[shutdown] Failed to notify webhook for ${guildId}: ${err?.message ?? err}`);
        }
    }
}

async function announceShutdown(signal) {
    const channelMessage = `${SHUTDOWN_EMOJI} **Squire shutting down** (${signal})`;
    const webhookMessage = `${SHUTDOWN_EMOJI} **Squire offline**`;
    await Promise.allSettled([
        notifySystemChannel(channelMessage),
        notifyMappingWebhooks(webhookMessage)
    ]);
}

async function handleShutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;

    logger.info(`${SHUTDOWN_EMOJI} ${signal} received — shutting down...`);

    try {
        await announceShutdown(signal);
    } catch (err) {
        logger.warn(`[shutdown] Notification error: ${err?.message ?? err}`);
    }

    try {
        await client.destroy();
    } catch (err) {
        logger.error(`[shutdown] Failed to destroy client cleanly: ${err?.message ?? err}`);
    }

    if (typeof db?.saveDatabase === 'function') {
        try {
            await new Promise((resolve, reject) => {
                db.saveDatabase((err) => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve();
                    }
                });
            });
        } catch (err) {
            logger.error(`[shutdown] Failed to persist database: ${err?.message ?? err}`);
        }
    }

    process.exit(0);
}

// graceful shutdown
process.on('SIGINT', () => { void handleShutdown('SIGINT'); });
process.on('SIGTERM', () => { void handleShutdown('SIGTERM'); });
