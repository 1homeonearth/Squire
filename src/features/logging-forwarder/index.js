// src/features/logging-forwarder/index.js
// Minimal working forwarder with proper ESM exports:
// - exports `init(...)` so the loader can start it
// - exports `/setup` (stub) so deploy script has at least one command
// - announces online to each mapped webhook
// - forwards text + first image/gif (respects excludes, sampleRate, forwardBots)

import {
    WebhookClient,
    EmbedBuilder,
    SlashCommandBuilder,
    PermissionFlagsBits,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    StringSelectMenuBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
} from 'discord.js';

import { writeConfig } from '../../core/config.js';

const RAINBOW = [0xFF0000, 0xFFA500, 0xFFFF00, 0x00FF00, 0x0000FF, 0x800080];

// --- helpers ---
const trunc = (s, n) => (s && String(s).length > n ? String(s).slice(0, n - 1) + '…' : String(s || ''));
const truncWebhook = (url) => {
    if (!url) return 'No webhook URL';
    try {
        const u = new URL(url);
        const tail = u.pathname.split('/').slice(-2).join('/');
        return `${u.host}/${tail}`;
    } catch {
        return url.length > 60 ? `${url.slice(0, 57)}…` : url;
    }
};
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

// --- setup panel helpers ---
const panelState = new Map(); // userId -> { message }

function coerceMapping(config) {
    if (!config.mapping || typeof config.mapping !== 'object') {
        config.mapping = {};
    }
    return config.mapping;
}

function persistConfig(config, logger) {
    try {
        writeConfig(config);
    } catch (err) {
        logger?.error?.(`[setup] Failed to persist config: ${err?.message ?? err}`);
    }
}

export function buildSetupPanel(config) {
    const mapping = Object.entries(coerceMapping(config));
    const embed = new EmbedBuilder()
    .setTitle('Squire Forwarder Setup')
    .setDescription('Configure cross-server logging without editing config.json manually.')
    .addFields(
        { name: 'Forward bot messages', value: config.forwardBots ? '✅ Enabled' : '🚫 Disabled', inline: true },
        { name: 'Sample rate', value: `${Number.isFinite(config.sampleRate) ? config.sampleRate : 1}`, inline: true },
        { name: 'Mappings', value: mapping.length ? mapping.map(([gid, hook]) => `• **${gid}** → ${truncWebhook(hook)}`).slice(0, 10).join('\n') + (mapping.length > 10 ? `\n… ${mapping.length - 10} more` : '') : 'No servers mapped yet.', inline: false }
    );

    const buttonsRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
        .setCustomId('setup:add-mapping')
        .setLabel('Add mapping')
        .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
        .setCustomId('setup:toggle-bots')
        .setLabel(config.forwardBots ? 'Disable bot forwards' : 'Enable bot forwards')
        .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
        .setCustomId('setup:set-sample')
        .setLabel('Set sample rate')
        .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
        .setCustomId('setup:refresh')
        .setLabel('Refresh')
        .setStyle(ButtonStyle.Secondary)
    );

    const components = [buttonsRow];
    if (mapping.length) {
        const menu = new StringSelectMenuBuilder()
        .setCustomId('setup:remove-mapping')
        .setPlaceholder('Remove a mapping…')
        .setMinValues(1)
        .setMaxValues(1)
        .addOptions(mapping.slice(0, 25).map(([gid, hook]) => ({
            label: gid,
            description: truncWebhook(hook).slice(0, 100),
            value: gid
        })));
        components.push(new ActionRowBuilder().addComponents(menu));
    }

    return {
        embeds: [embed],
        components
    };
}

function storePanel(userId, message, logger) {
    panelState.set(userId, { message, logger });
}

async function refreshPanelForUser(userId, data) {
    const state = panelState.get(userId);
    if (!state?.message) return;
    try {
        const updated = await state.message.edit(data);
        panelState.set(userId, { ...state, message: updated });
    } catch (err) {
        // ignore (ephemeral messages may have expired)
        if (state?.logger) {
            state.logger.warn?.(`[setup] Failed to refresh panel for ${userId}: ${err?.message ?? err}`);
        }
    }
}

function requireManageGuild(interaction) {
    return interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
}

// --- exported slash commands ---
export const commands = [
    new SlashCommandBuilder()
    .setName('setup')
    .setDescription('Open Squire setup panel')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
];

// --- exported feature entrypoint ---
export async function init({ client, config, logger }) {
    const LOGGING_SERVER_ID = config.loggingServerId || null;

    config.mapping = { ...(config.mapping || {}) };
    let mapping = config.mapping;
    let excludeChannels = { ...(config.excludeChannels || {}) };
    let excludeCategories = { ...(config.excludeCategories || {}) };

    function getSampleRate() {
        return Number.isFinite(config.sampleRate) ? config.sampleRate : 1.0;
    }

    function shouldForwardBots() {
        return !!config.forwardBots;
    }

    function setMapping(next) {
        config.mapping = { ...next };
        mapping = config.mapping;
    }

    // announce online in each mapped destination webhook when client is ready
    client.once('ready', async () => {
        const entries = Object.entries(mapping);
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
            const webhookURL = mapping[gid];
            if (!webhookURL) return;

            // exclusions
            const chanEx = excludeChannels[gid] || [];
            if (chanEx.includes(message.channel.id)) return;

            const catId = resolveCategoryId(message.channel);
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

    client.on('interactionCreate', async (interaction) => {
        try {
            const userId = interaction.user?.id;

            if (interaction.isChatInputCommand() && interaction.commandName === 'setup') {
                if (!requireManageGuild(interaction)) {
                    await interaction.reply({ content: 'You need **Manage Server** permission.', ephemeral: true });
                    return;
                }

                await interaction.deferReply({ ephemeral: true });
                const message = await interaction.editReply(buildSetupPanel(config));
                storePanel(userId, message, logger);
                return;
            }

            if (!userId) return;

            if (interaction.isButton() && interaction.customId.startsWith('setup:')) {
                if (!requireManageGuild(interaction)) {
                    await interaction.reply({ content: 'You need **Manage Server** permission.', ephemeral: true });
                    return;
                }

                if (interaction.customId === 'setup:add-mapping') {
                    const modal = new ModalBuilder()
                    .setCustomId('setup:add-mapping-modal')
                    .setTitle('Add server mapping')
                    .addComponents(
                        new ActionRowBuilder().addComponents(
                            new TextInputBuilder()
                            .setCustomId('setup:guild')
                            .setLabel('Source guild ID')
                            .setStyle(TextInputStyle.Short)
                            .setRequired(true)
                            .setPlaceholder('123456789012345678')
                        ),
                        new ActionRowBuilder().addComponents(
                            new TextInputBuilder()
                            .setCustomId('setup:webhook')
                            .setLabel('Destination webhook URL')
                            .setStyle(TextInputStyle.Paragraph)
                            .setRequired(true)
                            .setPlaceholder('https://discord.com/api/webhooks/...')
                        )
                    );
                    await interaction.showModal(modal);
                    return;
                }

                if (interaction.customId === 'setup:toggle-bots') {
                    config.forwardBots = !shouldForwardBots();
                    persistConfig(config, logger);
                    const message = await interaction.update(buildSetupPanel(config));
                    storePanel(userId, message, logger);
                    return;
                }

                if (interaction.customId === 'setup:set-sample') {
                    const modal = new ModalBuilder()
                    .setCustomId('setup:set-sample-modal')
                    .setTitle('Update sample rate')
                    .addComponents(
                        new ActionRowBuilder().addComponents(
                            new TextInputBuilder()
                            .setCustomId('setup:sample')
                            .setLabel('Sample rate (0-1)')
                            .setStyle(TextInputStyle.Short)
                            .setRequired(true)
                            .setValue(String(getSampleRate()))
                            .setPlaceholder('1')
                        )
                    );
                    await interaction.showModal(modal);
                    return;
                }

                if (interaction.customId === 'setup:refresh') {
                    const message = await interaction.update(buildSetupPanel(config));
                    storePanel(userId, message, logger);
                    return;
                }

                return;
            }

            if (interaction.isStringSelectMenu() && interaction.customId === 'setup:remove-mapping') {
                if (!requireManageGuild(interaction)) {
                    await interaction.reply({ content: 'You need **Manage Server** permission.', ephemeral: true });
                    return;
                }

                const toRemove = interaction.values?.[0];
                if (!toRemove) {
                    await interaction.update(buildSetupPanel(config));
                    return;
                }

                const next = { ...mapping };
                delete next[toRemove];
                setMapping(next);
                persistConfig(config, logger);
                const message = await interaction.update(buildSetupPanel(config));
                storePanel(userId, message, logger);
                return;
            }

            if (interaction.isModalSubmit()) {
                if (!requireManageGuild(interaction)) {
                    await interaction.reply({ content: 'You need **Manage Server** permission.', ephemeral: true });
                    return;
                }

                if (interaction.customId === 'setup:add-mapping-modal') {
                    const guildId = interaction.fields.getTextInputValue('setup:guild').trim();
                    const webhookUrl = interaction.fields.getTextInputValue('setup:webhook').trim();

                    if (!/^\d{5,}$/.test(guildId)) {
                        await interaction.reply({ content: 'Please provide a valid numeric guild ID.', ephemeral: true });
                        return;
                    }

                    try {
                        const u = new URL(webhookUrl);
                        if (!u.hostname.includes('discord.com')) {
                            throw new Error('Not a Discord webhook URL');
                        }
                    } catch (err) {
                        await interaction.reply({ content: `Webhook URL was invalid: ${err?.message ?? err}`, ephemeral: true });
                        return;
                    }

                    const next = { ...mapping, [guildId]: webhookUrl };
                    setMapping(next);
                    persistConfig(config, logger);
                    await interaction.reply({ content: `Mapping for **${guildId}** saved.`, ephemeral: true });
                    await refreshPanelForUser(userId, buildSetupPanel(config));
                    return;
                }

                if (interaction.customId === 'setup:set-sample-modal') {
                    const raw = interaction.fields.getTextInputValue('setup:sample').trim();
                    const value = Number(raw);
                    if (!Number.isFinite(value) || value < 0 || value > 1) {
                        await interaction.reply({ content: 'Sample rate must be a number between 0 and 1.', ephemeral: true });
                        return;
                    }

                    config.sampleRate = value;
                    persistConfig(config, logger);
                    await interaction.reply({ content: `Sample rate updated to ${value}.`, ephemeral: true });
                    await refreshPanelForUser(userId, buildSetupPanel(config));
                    return;
                }
            }
        } catch (err) {
            logger.error?.(`[setup] Interaction handling failed: ${err?.message ?? err}`);
            try {
                if (interaction.isRepliable() && !interaction.replied) {
                    await interaction.reply({ content: 'Something went wrong while handling that action.', ephemeral: true });
                }
            } catch {}
        }
    });
}
