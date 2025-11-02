// src/features/rainbow-bridge/setup.js
// Setup panel integration for the Rainbow Bridge module.
import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle
} from 'discord.js';
import {
    appendHomeButtonRow,
    isValidWebhookUrl,
    sanitizeBridgeId,
    sanitizeSnowflakeId,
    truncateName
} from '../setup/shared.js';
import {
    normalizeRainbowBridgeConfig,
    refresh as refreshRainbowBridge
} from './index.js';

export function createRainbowBridgeSetup({ panelStore, saveConfig, fetchGuild, collectManageableGuilds }) {
    function prepareConfig(config) {
        config.rainbowBridge = normalizeRainbowBridgeConfig(config.rainbowBridge);
    }

    async function handleInteraction({ interaction, entry, config, key, client, logger }) {
        const guildOptions = entry?.guildOptions ?? await collectManageableGuilds({ client, userId: interaction.user.id });
        const bridges = config.rainbowBridge?.bridges ?? {};

        const updateView = async (mode, context) => {
            const view = await buildView({ config, client, guildOptions, mode, context });
            const message = await interaction.update(view);
            panelStore.set(key, { message, guildOptions, mode, context });
        };

        const setStateOnly = (mode, context) => {
            panelStore.set(key, {
                message: entry?.message ?? null,
                guildOptions,
                mode,
                context
            });
        };

        if (interaction.isButton()) {
            const parts = interaction.customId.split(':');
            const action = parts[2];
            const bridgeId = parts[3] || null;

            switch (action) {
                case 'createBridge': {
                    const modal = new ModalBuilder()
                    .setCustomId('setup:rainbow:createBridgeModal')
                    .setTitle('Create a new bridge')
                    .addComponents(
                        new ActionRowBuilder().addComponents(
                            new TextInputBuilder()
                            .setCustomId('setup:rainbow:bridgeId')
                            .setLabel('Bridge ID (letters, numbers, - or _)')
                            .setStyle(TextInputStyle.Short)
                            .setRequired(true)
                        ),
                        new ActionRowBuilder().addComponents(
                            new TextInputBuilder()
                            .setCustomId('setup:rainbow:bridgeName')
                            .setLabel('Display name (optional)')
                            .setStyle(TextInputStyle.Short)
                            .setRequired(false)
                        )
                    );
                    setStateOnly(entry?.mode ?? 'default', entry?.context ?? {});
                    await interaction.showModal(modal);
                    return;
                }
                case 'manageBridge': {
                    if (!Object.keys(bridges).length) {
                        await interaction.reply({ content: 'Create a bridge first, then manage it.', ephemeral: true });
                        return;
                    }
                    const modal = new ModalBuilder()
                    .setCustomId('setup:rainbow:manageBridgeModal')
                    .setTitle('Manage a bridge')
                    .addComponents(
                        new ActionRowBuilder().addComponents(
                            new TextInputBuilder()
                            .setCustomId('setup:rainbow:manageBridgeId')
                            .setLabel('Bridge ID')
                            .setStyle(TextInputStyle.Short)
                            .setRequired(true)
                            .setPlaceholder('example-bridge')
                        )
                    );
                    setStateOnly(entry?.mode ?? 'default', entry?.context ?? {});
                    await interaction.showModal(modal);
                    return;
                }
                case 'refresh': {
                    await updateView('default', {});
                    return;
                }
                case 'addChannel': {
                    if (!bridgeId || !bridges[bridgeId]) {
                        await interaction.reply({ content: 'That bridge no longer exists.', ephemeral: true });
                        return;
                    }
                    const modalContext = { bridgeId, action: 'add' };
                    if (entry?.message) {
                        try {
                            const view = await buildView({ config, client, guildOptions, mode: 'manage', context: modalContext });
                            const message = await entry.message.edit(view);
                            panelStore.set(key, { message, guildOptions, mode: 'manage', context: modalContext });
                        } catch {}
                    } else {
                        panelStore.set(key, { message: entry?.message ?? null, guildOptions, mode: 'manage', context: modalContext });
                    }
                    const modal = new ModalBuilder()
                    .setCustomId(`setup:rainbow:addChannelModal:${bridgeId}`)
                    .setTitle('Add channel to bridge')
                    .addComponents(
                        new ActionRowBuilder().addComponents(
                            new TextInputBuilder()
                            .setCustomId('setup:rainbow:addChannelGuildId')
                            .setLabel('Guild ID')
                            .setStyle(TextInputStyle.Short)
                            .setRequired(true)
                        ),
                        new ActionRowBuilder().addComponents(
                            new TextInputBuilder()
                            .setCustomId('setup:rainbow:addChannelId')
                            .setLabel('Channel ID')
                            .setStyle(TextInputStyle.Short)
                            .setRequired(true)
                        ),
                        new ActionRowBuilder().addComponents(
                            new TextInputBuilder()
                            .setCustomId('setup:rainbow:addChannelWebhook')
                            .setLabel('Webhook URL (optional)')
                            .setStyle(TextInputStyle.Short)
                            .setRequired(false)
                        )
                    );
                    await interaction.showModal(modal);
                    return;
                }
                case 'removeChannel': {
                    if (!bridgeId || !bridges[bridgeId]) {
                        await interaction.reply({ content: 'That bridge no longer exists.', ephemeral: true });
                        return;
                    }
                    const modalContext = { bridgeId, action: 'remove' };
                    if (entry?.message) {
                        try {
                            const view = await buildView({ config, client, guildOptions, mode: 'manage', context: modalContext });
                            const message = await entry.message.edit(view);
                            panelStore.set(key, { message, guildOptions, mode: 'manage', context: modalContext });
                        } catch {}
                    } else {
                        panelStore.set(key, { message: entry?.message ?? null, guildOptions, mode: 'manage', context: modalContext });
                    }
                    const modal = new ModalBuilder()
                    .setCustomId(`setup:rainbow:removeChannelModal:${bridgeId}`)
                    .setTitle('Remove channels from bridge')
                    .addComponents(
                        new ActionRowBuilder().addComponents(
                            new TextInputBuilder()
                            .setCustomId('setup:rainbow:removeChannelIds')
                            .setLabel('Channel IDs (one per line or guild:channel)')
                            .setStyle(TextInputStyle.Paragraph)
                            .setRequired(true)
                        )
                    );
                    await interaction.showModal(modal);
                    return;
                }
                case 'toggleBots': {
                    if (!bridgeId || !bridges[bridgeId]) {
                        await interaction.reply({ content: 'That bridge no longer exists.', ephemeral: true });
                        return;
                    }
                    const bridge = bridges[bridgeId];
                    const inherited = config.rainbowBridge.forwardBots !== false;
                    const current = bridge.forwardBots === undefined ? inherited : bridge.forwardBots !== false;
                    const next = !current;
                    bridge.forwardBots = next;
                    config.rainbowBridge = normalizeRainbowBridgeConfig(config.rainbowBridge);
                    refreshRainbowBridge();
                    saveConfig(config, logger);
                    await updateView('manage', { bridgeId });
                    await interaction.followUp({
                        content: next
                            ? 'Bot messages will now be mirrored for this bridge.'
                            : 'Bot messages will no longer be mirrored for this bridge.',
                        ephemeral: true
                    }).catch(() => {});
                    return;
                }
                case 'deleteBridge': {
                    if (!bridgeId || !bridges[bridgeId]) {
                        await interaction.reply({ content: 'That bridge no longer exists.', ephemeral: true });
                        return;
                    }
                    await updateView('manage', { bridgeId, action: 'confirm-delete' });
                    return;
                }
                case 'confirmDelete': {
                    if (!bridgeId || !bridges[bridgeId]) {
                        await interaction.reply({ content: 'That bridge no longer exists.', ephemeral: true });
                        return;
                    }
                    const name = bridges[bridgeId].name ?? bridgeId;
                    delete bridges[bridgeId];
                    config.rainbowBridge = normalizeRainbowBridgeConfig(config.rainbowBridge);
                    refreshRainbowBridge();
                    saveConfig(config, logger);
                    await updateView('default', {});
                    await interaction.followUp({ content: `Bridge **${name}** deleted.`, ephemeral: true }).catch(() => {});
                    return;
                }
                case 'cancelDelete': {
                    if (!bridgeId) {
                        await updateView('default', {});
                        return;
                    }
                    await updateView('manage', { bridgeId });
                    return;
                }
                case 'backToList': {
                    await updateView('default', {});
                    return;
                }
                default:
                    return;
            }
        }

        if (interaction.isStringSelectMenu()) {
            await interaction.reply({
                content: 'Rainbow Bridge management now uses text entry forms. Use the buttons below to open the appropriate form.',
                ephemeral: true
            }).catch(() => {});
            return;
        }

        if (interaction.isModalSubmit()) {
            if (interaction.customId === 'setup:rainbow:createBridgeModal') {
                const rawId = interaction.fields.getTextInputValue('setup:rainbow:bridgeId')?.trim();
                const rawName = interaction.fields.getTextInputValue('setup:rainbow:bridgeName')?.trim();
                const bridgeId = sanitizeBridgeId(rawId);
                if (!bridgeId) {
                    await interaction.reply({ content: 'Bridge ID must contain only letters, numbers, hyphens, or underscores.', ephemeral: true });
                    return;
                }
                if (bridges[bridgeId]) {
                    await interaction.reply({ content: 'A bridge with that ID already exists.', ephemeral: true });
                    return;
                }
                const displayName = rawName?.length ? rawName : (rawId?.length ? rawId : bridgeId);
                config.rainbowBridge.bridges = config.rainbowBridge.bridges || {};
                config.rainbowBridge.bridges[bridgeId] = { name: displayName, channels: [] };
                config.rainbowBridge = normalizeRainbowBridgeConfig(config.rainbowBridge);
                refreshRainbowBridge();
                saveConfig(config, logger);
                await interaction.reply({ content: `Bridge **${displayName}** created. Add at least two channels to activate it.`, ephemeral: true });
                if (entry?.message) {
                    try {
                        const view = await buildView({ config, client, guildOptions, mode: 'manage', context: { bridgeId } });
                        const message = await entry.message.edit(view);
                        panelStore.set(key, { message, guildOptions, mode: 'manage', context: { bridgeId } });
                    } catch {}
                }
                return;
            }

            if (interaction.customId === 'setup:rainbow:manageBridgeModal') {
                const rawId = interaction.fields.getTextInputValue('setup:rainbow:manageBridgeId')?.trim();
                const bridgeId = sanitizeBridgeId(rawId);
                if (!bridgeId || !bridges[bridgeId]) {
                    await interaction.reply({ content: 'That bridge could not be found. Check the ID and try again.', ephemeral: true });
                    return;
                }
                const bridge = bridges[bridgeId];
                if (entry?.message) {
                    try {
                        const view = await buildView({ config, client, guildOptions, mode: 'manage', context: { bridgeId } });
                        const message = await entry.message.edit(view);
                        panelStore.set(key, { message, guildOptions, mode: 'manage', context: { bridgeId } });
                    } catch {}
                } else {
                    panelStore.set(key, { message: entry?.message ?? null, guildOptions, mode: 'manage', context: { bridgeId } });
                }
                await interaction.reply({ content: `Managing bridge **${truncateName(bridge.name ?? bridgeId, 80)}**.`, ephemeral: true });
                return;
            }

            if (interaction.customId.startsWith('setup:rainbow:addChannelModal:')) {
                const parts = interaction.customId.split(':');
                const bridgeId = parts[3] || null;
                if (!bridgeId || !bridges[bridgeId]) {
                    await interaction.reply({ content: 'That bridge no longer exists.', ephemeral: true });
                    return;
                }
                const rawGuildId = interaction.fields.getTextInputValue('setup:rainbow:addChannelGuildId')?.trim();
                const rawChannelId = interaction.fields.getTextInputValue('setup:rainbow:addChannelId')?.trim();
                const rawWebhook = interaction.fields.getTextInputValue('setup:rainbow:addChannelWebhook')?.trim();

                const guildId = sanitizeSnowflakeId(rawGuildId);
                const channelId = sanitizeSnowflakeId(rawChannelId);
                if (!guildId) {
                    await interaction.reply({ content: 'Enter a valid guild ID.', ephemeral: true });
                    return;
                }
                if (!channelId) {
                    await interaction.reply({ content: 'Enter a valid channel ID.', ephemeral: true });
                    return;
                }

                const bridge = bridges[bridgeId];
                if (bridge.channels?.some(ch => ch.channelId === channelId)) {
                    await interaction.reply({ content: 'That channel is already part of this bridge.', ephemeral: true });
                    return;
                }

                const guild = await fetchGuild(client, guildId);
                if (!guild) {
                    await interaction.reply({ content: 'I could not access that server. Make sure the bot is still in it.', ephemeral: true });
                    return;
                }

                let channel = guild.channels?.cache?.get(channelId) ?? null;
                if (!channel && typeof guild.channels?.fetch === 'function') {
                    channel = await guild.channels.fetch(channelId).catch(() => null);
                }
                if (!channel || typeof channel.isTextBased !== 'function' || !channel.isTextBased() || channel.isThread?.()) {
                    await interaction.reply({ content: 'That channel is not a standard text channel.', ephemeral: true });
                    return;
                }

                let webhookUrl = null;
                if (rawWebhook) {
                    if (!isValidWebhookUrl(rawWebhook)) {
                        await interaction.reply({ content: 'That does not look like a valid Discord webhook URL.', ephemeral: true });
                        return;
                    }
                    webhookUrl = rawWebhook;
                } else {
                    try {
                        const desiredName = `Rainbow Bridge • ${truncateName(guild.name ?? guildId, 32)}`;
                        const webhook = await channel.createWebhook({
                            name: desiredName,
                            reason: 'Configured via /setup rainbow bridge'
                        });
                        webhookUrl = `https://discord.com/api/webhooks/${webhook.id}/${webhook.token}`;
                    } catch (err) {
                        logger?.warn?.(`[setup] Failed to create webhook for bridge ${bridgeId} in channel ${channelId}: ${err?.message ?? err}`);
                        await interaction.reply({ content: 'I could not create a webhook automatically. Please provide an existing webhook URL when adding the channel.', ephemeral: true });
                        return;
                    }
                }

                bridge.channels = Array.isArray(bridge.channels) ? bridge.channels : [];
                bridge.channels.push({ guildId, channelId, webhookUrl });
                config.rainbowBridge = normalizeRainbowBridgeConfig(config.rainbowBridge);
                refreshRainbowBridge();
                saveConfig(config, logger);

                const guildName = guild?.name ?? guildId;
                const channelDisplay = channel?.isTextBased?.() ? `<#${channel.id}>` : `#${channelId}`;
                await interaction.reply({ content: `Linked ${channelDisplay} from **${guildName}** to **${bridge.name ?? bridgeId}**.`, ephemeral: true });

                if (entry?.message) {
                    try {
                        const view = await buildView({ config, client, guildOptions, mode: 'manage', context: { bridgeId } });
                        const message = await entry.message.edit(view);
                        panelStore.set(key, { message, guildOptions, mode: 'manage', context: { bridgeId } });
                    } catch {}
                } else {
                    panelStore.set(key, { message: entry?.message ?? null, guildOptions, mode: 'manage', context: { bridgeId } });
                }
                return;
            }

            if (interaction.customId.startsWith('setup:rainbow:removeChannelModal:')) {
                const parts = interaction.customId.split(':');
                const bridgeId = parts[3] || null;
                if (!bridgeId || !bridges[bridgeId]) {
                    await interaction.reply({ content: 'That bridge no longer exists.', ephemeral: true });
                    return;
                }
                const raw = interaction.fields.getTextInputValue('setup:rainbow:removeChannelIds')?.trim() ?? '';
                const tokens = raw.split(/[\s,]+/).map(token => token.trim()).filter(Boolean);
                const channelIds = new Set();
                const pairIds = new Set();
                for (const token of tokens) {
                    if (!token) continue;
                    if (token.includes(':')) {
                        const [rawGuild, rawChannel] = token.split(':', 2);
                        const channelId = sanitizeSnowflakeId(rawChannel);
                        if (!channelId) continue;
                        const guildId = sanitizeSnowflakeId(rawGuild);
                        if (guildId) {
                            pairIds.add(`${guildId}:${channelId}`);
                        }
                        channelIds.add(channelId);
                    } else {
                        const channelId = sanitizeSnowflakeId(token);
                        if (channelId) {
                            channelIds.add(channelId);
                        }
                    }
                }

                if (!channelIds.size && !pairIds.size) {
                    await interaction.reply({ content: 'Provide at least one valid channel ID to remove.', ephemeral: true });
                    return;
                }

                const before = bridges[bridgeId].channels?.length ?? 0;
                bridges[bridgeId].channels = (bridges[bridgeId].channels || []).filter((channel) => {
                    const matchPair = `${channel.guildId}:${channel.channelId}`;
                    if (pairIds.has(matchPair)) return false;
                    if (channelIds.has(channel.channelId)) return false;
                    return true;
                });
                const after = bridges[bridgeId].channels.length;
                const removed = Math.max(0, before - after);
                config.rainbowBridge = normalizeRainbowBridgeConfig(config.rainbowBridge);
                refreshRainbowBridge();
                saveConfig(config, logger);
                await interaction.reply({ content: `Removed ${removed} channel${removed === 1 ? '' : 's'} from the bridge.`, ephemeral: true });
                if (entry?.message) {
                    try {
                        const view = await buildView({ config, client, guildOptions, mode: 'manage', context: { bridgeId } });
                        const message = await entry.message.edit(view);
                        panelStore.set(key, { message, guildOptions, mode: 'manage', context: { bridgeId } });
                    } catch {}
                }
                return;
            }
        }
    }

    async function buildView({ config, client, guildOptions: _guildOptions, mode, context }) {
        const embed = new EmbedBuilder()
        .setTitle('🌈 Rainbow Bridge setup')
        .setDescription('Synchronize messages, edits, and deletions across channels in different servers.');

        const components = [];
        const bridges = config.rainbowBridge?.bridges ?? {};
        const bridgeEntries = Object.entries(bridges);
        if (mode === 'default') {
            const summary = bridgeEntries.length
                ? bridgeEntries.map(([id, entry]) => {
                    const count = entry.channels?.length ?? 0;
                    return `• **${truncateName(entry.name ?? id, 60)}** (\`${id}\`) — ${count} channel${count === 1 ? '' : 's'}`;
                }).join('\n')
                : 'No bridges configured yet. Create one to begin linking channels.';

            embed.addFields({ name: 'Configured bridges', value: summary.slice(0, 1024), inline: false });

            const actionsRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('setup:rainbow:createBridge').setLabel('Create bridge').setStyle(ButtonStyle.Primary),
                new ButtonBuilder()
                .setCustomId('setup:rainbow:manageBridge')
                .setLabel('Manage bridge')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(!bridgeEntries.length),
                new ButtonBuilder().setCustomId('setup:rainbow:refresh').setLabel('Refresh').setStyle(ButtonStyle.Secondary)
            );

            components.push(actionsRow);

            appendHomeButtonRow(components);
            return { embeds: [embed], components };
        }

        if (mode === 'manage') {
            const bridgeId = context?.bridgeId ?? null;
            const bridge = bridgeId ? bridges[bridgeId] : null;
            if (!bridge) {
                embed.addFields({ name: 'Status', value: 'The selected bridge could not be found. Return to the list and choose another.', inline: false });
                components.push(new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId('setup:rainbow:backToList').setLabel('Back to bridges').setStyle(ButtonStyle.Secondary)
                ));
                appendHomeButtonRow(components);
                return { embeds: [embed], components };
            }

            const inherited = config.rainbowBridge.forwardBots !== false;
            const bots = bridge.forwardBots === undefined ? inherited : bridge.forwardBots;

            embed
            .setTitle(`🌈 Bridge: ${bridge.name ?? bridgeId}`)
            .addFields(
                { name: 'Bridge ID', value: `\`${bridgeId}\``, inline: true },
                { name: 'Bot messages', value: bots ? '✅ Mirrored' : '🚫 Ignored', inline: true }
            );

            const channelLines = [];
            const guildCache = new Map();
            for (const link of bridge.channels ?? []) {
                if (!guildCache.has(link.guildId)) {
                    const fetched = await fetchGuild(client, link.guildId);
                    guildCache.set(link.guildId, fetched);
                }
                const guild = guildCache.get(link.guildId);
                const guildName = guild?.name ?? link.guildId;
                let channelDisplay = `<#${link.channelId}>`;
                const channel = guild?.channels?.cache?.get(link.channelId) ?? null;
                if (channel?.isTextBased?.()) {
                    channelDisplay = `<#${channel.id}>`;
                }
                channelLines.push(`• ${guildName} — ${channelDisplay}`);
            }

            embed.addFields({
                name: 'Linked channels',
                value: channelLines.length
                    ? channelLines.join('\n').slice(0, 1024)
                    : 'No channels linked yet. Add at least two channels to activate syncing.',
                inline: false
            });

            if ((bridge.channels?.length ?? 0) < 2) {
                embed.addFields({ name: 'Status', value: 'Add at least two channels so messages can be mirrored between them.', inline: false });
            }

            if (context?.action === 'add') {
                embed.setFooter({ text: 'Use “Add channel” to paste the guild ID, channel ID, and optional webhook URL.' });
            } else if (context?.action === 'remove') {
                embed.setFooter({ text: 'Use “Remove channel” to paste the channel IDs you want to unlink from this bridge.' });
            } else if (context?.action === 'confirm-delete') {
                embed.setFooter({ text: 'This action cannot be undone. Confirm to delete the bridge.' });
            }

            const actionsRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`setup:rainbow:addChannel:${bridgeId}`).setLabel('Add channel').setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId(`setup:rainbow:removeChannel:${bridgeId}`).setLabel('Remove channel').setStyle(ButtonStyle.Secondary).setDisabled(!bridge.channels?.length),
                new ButtonBuilder().setCustomId(`setup:rainbow:toggleBots:${bridgeId}`).setLabel(bots ? 'Disable bot mirroring' : 'Enable bot mirroring').setStyle(ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId(`setup:rainbow:deleteBridge:${bridgeId}`).setLabel('Delete bridge').setStyle(ButtonStyle.Danger)
            );

            components.push(actionsRow);
            components.push(new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('setup:rainbow:backToList').setLabel('Back to bridges').setStyle(ButtonStyle.Secondary)
            ));

            if (context?.action === 'confirm-delete') {
                components.push(new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId(`setup:rainbow:confirmDelete:${bridgeId}`).setLabel('Yes, delete bridge').setStyle(ButtonStyle.Danger),
                    new ButtonBuilder().setCustomId(`setup:rainbow:cancelDelete:${bridgeId}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary)
                ));
            }

            appendHomeButtonRow(components);
            return { embeds: [embed], components };
        }

        appendHomeButtonRow(components);
        return { embeds: [embed], components };
    }

    return {
        prepareConfig,
        handleInteraction,
        buildView
    };
}
