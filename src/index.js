// src/index.js
import { createClient } from './core/client.js';
import { loadConfig } from './core/config.js';
import { createLogger } from './core/logger.js';
import { createDb } from './core/db.js';
import { loadFeatures } from './core/loader.js';

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

// graceful shutdown
process.on('SIGINT', async () => {
    logger.info('SIGINT received — shutting down...');
    await client.destroy();
    process.exit(0);
});
process.on('SIGTERM', async () => {
    logger.info('SIGTERM received — shutting down...');
    await client.destroy();
    process.exit(0);
});
