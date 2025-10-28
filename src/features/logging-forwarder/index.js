// src/features/logging-forwarder/index.js
// Minimal working forwarder with proper ESM exports:
// - announces online to each mapped webhook
// - forwards text + first image/gif (respects excludes, sampleRate, forwardBots)

import {
    WebhookClient,
    EmbedBuilder
} from 'discord.js';

const RAINBOW = [0xFF0000, 0xFFA500, 0xFFFF00, 0x00FF00, 0x0000FF, 0x800080];

// --- helpers ---
const trunc = (s, n) => (s && String(s).length > n ? String(s).slice(0, n - 1) + '…' : String(s || ''));
function resolveCategoryId(channel) {
    try {
        const isThread = typeof channel.isThread === 'function' && channel.isThread();
        if (isThread) return channel.parent?.parentId ?? null;
        return channel.parentId ?? null;
    } catch { return null; }
}
function extractImageLike(msg) {
    const urls = [];
    for (const a of msg.attachments.values()) {
        const n = (a.name || '').toLowerCase();
        const t = (a.contentType || '').toLowerCase();
        const looks =
        t.startsWith('image/') ||
        t.includes('gif') ||
        /\.(png|jpe?g|gif|webp|avif)$/i.test(n);
        if (looks) urls.push(a.url);
    }
    for (const e of msg.embeds ?? []) {
        const ej = e?.toJSON ? e.toJSON() : (e?.data ?? e);
        if (ej?.image?.url) urls.push(ej.image.url);
        if (ej?.thumbnail?.url) urls.push(ej.thumbnail.url);
        if (ej?.video?.url) urls.push(ej.video.url);
        if (ej?.url) urls.push(ej.url);
    }
    return [...new Set(urls)];
}
function nextColorGen() {
    const perGuild = new Map(); // guildId -> idx
    return (gid) => {
        const i = perGuild.get(gid) ?? -1;
        const ni = (i + 1) % RAINBOW.length;
        perGuild.set(gid, ni);
        return RAINBOW[ni];
    };
}
const nextColor = nextColorGen();

// --- exported feature entrypoint ---
export async function init({ client, config, logger }) {
    const LOGGING_SERVER_ID = config.loggingServerId || null;

    if (!config.mapping || typeof config.mapping !== 'object') {
        config.mapping = {};
    }
    if (!config.excludeChannels || typeof config.excludeChannels !== 'object') {
        config.excludeChannels = {};
    }
    if (!config.excludeCategories || typeof config.excludeCategories !== 'object') {
        config.excludeCategories = {};
    }

    function getSampleRate() {
        return Number.isFinite(config.sampleRate) ? config.sampleRate : 1.0;
    }

    function shouldForwardBots() {
        return !!config.forwardBots;
    }

    // announce online in each mapped destination webhook when client is ready
    client.once('ready', async () => {
        const entries = Object.entries(config.mapping || {});
        logger.info(`Mapped source servers (${entries.length}):`);
        for (const [id] of entries) {
            let name = client.guilds.cache.get(id)?.name ?? `ID ${id}`;
            if (!client.guilds.cache.has(id)) {
                try { const g = await client.guilds.fetch(id); if (g) name = g.name; } catch {}
            }
            logger.info(`  - ${name} (${id})`);
        }
        for (const [id, url] of entries) {
            try {
                const gname = client.guilds.cache.get(id)?.name ?? id;
                const wh = new WebhookClient({ url, allowedMentions: { parse: [], repliedUser: false } });
                await wh.send({ content: `🛡️ **Squire online** for server **${gname}**` });
                logger.info(`[ONLINE] Announced in server ${gname}`);
            } catch (e) {
                logger.error(`[forwarder] online announce failed for ${id}:`, e?.message ?? e);
            }
        }
    });

    // simple message forwarder (text + first image/gif)
    client.on('messageCreate', async (message) => {
        try {
            if (!message.guild) return;

            // Ignore the logging server as a source, if specified
            if (LOGGING_SERVER_ID && message.guild.id === LOGGING_SERVER_ID) {
                logger.verbose?.(`[MSG] server=${message.guild.id} (${message.guild.name}) — skipped: logging server`);
                return;
            }

            if (!shouldForwardBots() && message.author.bot) return;
            if (message.webhookId) return; // don't loop

            const gid = message.guild.id;
            const mapping = config.mapping || {};
            const webhookURL = mapping[gid];
            if (!webhookURL) return;

            // exclusions
            const excludeChannels = config.excludeChannels || {};
            const chanEx = excludeChannels[gid] || [];
            if (chanEx.includes(message.channel.id)) return;

            const catId = resolveCategoryId(message.channel);
            const excludeCategories = config.excludeCategories || {};
            const catEx = excludeCategories[gid] || [];
            if (catId && catEx.includes(catId)) return;

            // sampling
            if (Math.random() >= getSampleRate()) return;

            const isNsfw = Boolean('nsfw' in message.channel && message.channel.nsfw === true);

            const usernameForWebhook =
            message.member?.displayName ??
            message.author.globalName ??
            message.author.username;

            const avatarForWebhook =
            message.member?.displayAvatarURL() ??
            message.author.displayAvatarURL();

            const content = message.content || (message.attachments.size ? '' : '');

            // If NSFW and there are images/gifs, drop the post entirely (avoid empty forwards)
            const media = extractImageLike(message);
            if (isNsfw && media.length > 0) {
                logger.verbose?.(`[MSG] ${message.guild.name} #${message.channel.name} — NSFW with media: dropped`);
                return;
            }

            // If we have any “moving” media (gif/mp4) or images, prefer showing the first as embed image.
            const color = nextColor(gid);
            const embed = new EmbedBuilder().setColor(color);
            if (content) embed.setDescription(trunc(content, 4096));

            // pick the first viable media for the embed
            if (!isNsfw && media.length > 0) {
                // Prefer gif/mp4-like URLs; otherwise first image-like URL
                const first = media.find(u => /\.(gif|mp4)(?:$|\?)/i.test(u)) || media[0];
                embed.setImage(first);
            }

            const wh = new WebhookClient({ url: webhookURL, allowedMentions: { parse: [], repliedUser: false } });

            await wh.send({
                content: `**${message.channel.name}**`,
                username: usernameForWebhook,
                avatarURL: avatarForWebhook,
                embeds: embed.data.description || embed.data.image ? [embed] : []
            });

            // console “signs of life”
            const gname = message.guild?.name ?? gid;
            const cname = message.channel?.name ?? message.channel?.id;
            logger.info(`[FWD] ${gname} #${cname} — by ${usernameForWebhook}`);
        } catch (e) {
            // keep the bot alive
            console.error('[forwarder] messageCreate error:', e?.message ?? e);
        }
    });

}
