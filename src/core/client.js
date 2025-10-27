// src/core/client.js
import {
    Client,
    GatewayIntentBits,
    Partials
} from 'discord.js';

export async function createClient({ token, logger }) {
    if (!token) throw new Error('token missing in config.json');

    const client = new Client({
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.GuildMessageReactions,
            GatewayIntentBits.MessageContent,
            GatewayIntentBits.GuildMembers // required for join/leave + autoban + welcome cards
        ],
        partials: [
            Partials.Message,
            Partials.Channel,
            Partials.Reaction,
            Partials.User,
            Partials.GuildMember
        ],
        allowedMentions: { parse: [], repliedUser: false }
    });

    let readyOnce = false;
    client.once('clientReady', () => {
        if (readyOnce) return;
        readyOnce = true;
        logger.info(`Logged in as ${client.user?.tag ?? 'unknown'}`);
    });

    await client.login(token);
    return client;
}
