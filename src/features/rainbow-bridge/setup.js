// src/features/rainbow-bridge/setup.js
// Setup panel integration for the Rainbow Bridge module.
import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    ModalBuilder,
    StringSelectMenuBuilder,
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
import { pruneBridgeChannels } from './setup-helpers.js';

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
                    await updateView('default', { action: 'select-bridge' });
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
                    await updateView('manage', { bridgeId, action: 'remove' });
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
                case 'toggleDirection': {
                    if (!bridgeId || !bridges[bridgeId]) {
                        await interaction.reply({ content: 'That bridge no longer exists.', ephemeral: true });
                        return;
                    }
                    const bridge = bridges[bridgeId];
                    const current = bridge.direction === 'one-way' ? 'one-way' : 'two-way';
                    if (current === 'one-way') {
                        bridge.direction = 'two-way';
                        delete bridge.sourceGuildIds;
                    } else {
                        bridge.direction = 'one-way';
                        const availableGuildIds = new Set(
                            (bridge.channels ?? [])
                                .map((channel) => channel?.guildId ? String(channel.guildId) : null)
                                .filter(Boolean)
                        );
                        const existingSources = new Set(
                            Array.isArray(bridge.sourceGuildIds)
                                ? bridge.sourceGuildIds.map((value) => value ? String(value) : null).filter(Boolean)
                                : []
                        );
                        const normalizedSources = [...existingSources].filter((id) => availableGuildIds.has(id));
                        if (!normalizedSources.length && availableGuildIds.size) {
                            normalizedSources.push(Array.from(availableGuildIds)[0]);
                        }
                        bridge.sourceGuildIds = normalizedSources;
                        if (!bridge.sourceGuildIds.length) {
                            bridge.direction = 'two-way';
                        }
                    }

                    config.rainbowBridge = normalizeRainbowBridgeConfig(config.rainbowBridge);
                    const normalizedBridge = config.rainbowBridge?.bridges?.[bridgeId] ?? null;
                    const direction = normalizedBridge?.direction === 'one-way' ? 'one-way' : 'two-way';
                    refreshRainbowBridge();
                    saveConfig(config, logger);
                    const nextContext = direction === 'one-way'
                        ? { bridgeId, action: 'edit-sources' }
                        : { bridgeId };
                    await updateView('manage', nextContext);
                    const response = direction === 'one-way'
                        ? 'Bridge is now in one-way mode. Select the source servers to control which guilds broadcast out.'
                        : 'Bridge is now in two-way mode. Messages will sync across every linked server.';
                    await interaction.followUp({ content: response, ephemeral: true }).catch(() => {});
                    return;
                }
                case 'editSources': {
                    if (!bridgeId || !bridges[bridgeId]) {
                        await interaction.reply({ content: 'That bridge no longer exists.', ephemeral: true });
                        return;
                    }
                    const bridge = bridges[bridgeId];
                    const direction = bridge.direction === 'one-way' ? 'one-way' : 'two-way';
                    if (direction !== 'one-way') {
                        await interaction.reply({ content: 'Switch the bridge to one-way mode before choosing source servers.', ephemeral: true });
                        return;
                    }
                    await updateView('manage', { bridgeId, action: 'edit-sources' });
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
            if (interaction.customId === 'setup:rainbow:selectBridge') {
                const selected = sanitizeBridgeId(interaction.values?.[0] ?? '');
                if (!selected || !bridges[selected]) {
                    await interaction.deferUpdate().catch(() => {});
                    await interaction.followUp({ content: 'That bridge no longer exists.', ephemeral: true }).catch(() => {});
                    return;
                }
                const bridge = bridges[selected];
                await updateView('manage', { bridgeId: selected });
                await interaction.followUp({
                    content: `Managing bridge **${truncateName(bridge.name ?? selected, 80)}**.`,
                    ephemeral: true
                }).catch(() => {});
                return;
            }

            if (interaction.customId.startsWith('setup:rainbow:removeChannelSelect:')) {
                const parts = interaction.customId.split(':');
                const bridgeId = parts[3] || null;
                if (!bridgeId || !bridges[bridgeId]) {
                    await interaction.deferUpdate().catch(() => {});
                    await interaction.followUp({ content: 'That bridge no longer exists.', ephemeral: true }).catch(() => {});
                    return;
                }

                const selections = new Set(interaction.values ?? []);
                if (!selections.size) {
                    await interaction.deferUpdate().catch(() => {});
                    await interaction.followUp({ content: 'Select at least one channel to remove.', ephemeral: true }).catch(() => {});
                    return;
                }

                const { removed } = pruneBridgeChannels(bridges[bridgeId], selections);
                config.rainbowBridge = normalizeRainbowBridgeConfig(config.rainbowBridge);
                refreshRainbowBridge();
                saveConfig(config, logger);
                await updateView('manage', { bridgeId, action: 'remove' });
                await interaction.followUp({
                    content: removed
                        ? `Removed ${removed} channel${removed === 1 ? '' : 's'} from the bridge.`
                        : 'No matching channels were removed.',
                    ephemeral: true
                }).catch(() => {});
                return;
            }

            if (interaction.customId.startsWith('setup:rainbow:editSourcesSelect:')) {
                const parts = interaction.customId.split(':');
                const bridgeId = parts[3] || null;
                if (!bridgeId || !bridges[bridgeId]) {
                    await interaction.deferUpdate().catch(() => {});
                    await interaction.followUp({ content: 'That bridge no longer exists.', ephemeral: true }).catch(() => {});
                    return;
                }

                const selections = Array.from(new Set(interaction.values ?? [])).filter(Boolean);
                if (!selections.length) {
                    await interaction.deferUpdate().catch(() => {});
                    await interaction.followUp({ content: 'Select at least one source server.', ephemeral: true }).catch(() => {});
                    return;
                }

                const bridge = bridges[bridgeId];
                const availableGuildIds = new Set(
                    (bridge.channels ?? [])
                        .map((channel) => channel?.guildId ? String(channel.guildId) : null)
                        .filter(Boolean)
                );
                const chosen = selections.filter((guildId) => availableGuildIds.has(guildId));
                if (!chosen.length) {
                    await interaction.deferUpdate().catch(() => {});
                    await interaction.followUp({ content: 'Those servers are no longer linked to the bridge.', ephemeral: true }).catch(() => {});
                    return;
                }

                bridge.sourceGuildIds = chosen;
                bridge.direction = 'one-way';

                config.rainbowBridge = normalizeRainbowBridgeConfig(config.rainbowBridge);
                refreshRainbowBridge();
                saveConfig(config, logger);
                await updateView('manage', { bridgeId });

                const labelMap = new Map((guildOptions ?? []).map((option) => [String(option.id), option.name]));
                const summary = chosen.map((guildId) => labelMap.get(guildId) ?? guildId).join(', ');
                await interaction.followUp({
                    content: `One-way bridge will now mirror messages from: ${summary}.`,
                    ephemeral: true
                }).catch(() => {});
                return;
            }

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

        }
    }

    async function buildView({ config, client, guildOptions: _guildOptions, mode, context }) {
        const guildOptions = Array.isArray(_guildOptions) ? _guildOptions : [];
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

            if (context?.action === 'select-bridge' && bridgeEntries.length) {
                embed.setFooter({ text: 'Select a bridge to manage from the dropdown below.' });
                const selectMenu = new StringSelectMenuBuilder()
                .setCustomId('setup:rainbow:selectBridge')
                .setPlaceholder('Choose a bridge to manage')
                .setMinValues(1)
                .setMaxValues(1)
                .addOptions(
                    bridgeEntries.slice(0, 25).map(([id, entry]) => {
                        const count = entry.channels?.length ?? 0;
                        return {
                            label: truncateName(entry.name ?? id, 75),
                            description: truncateName(`${count} linked channel${count === 1 ? '' : 's'}`, 95),
                            value: id
                        };
                    })
                );
                components.push(new ActionRowBuilder().addComponents(selectMenu));
            }

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
            const direction = bridge.direction === 'one-way' ? 'one-way' : 'two-way';
            const sourceGuildIds = Array.isArray(bridge.sourceGuildIds)
                ? bridge.sourceGuildIds.map((value) => value ? String(value) : null).filter(Boolean)
                : [];
            const sourceGuildSet = new Set(sourceGuildIds);

            embed
            .setTitle(`🌈 Bridge: ${bridge.name ?? bridgeId}`)
            .addFields(
                { name: 'Bridge ID', value: `\`${bridgeId}\``, inline: true },
                { name: 'Bot messages', value: bots ? '✅ Mirrored' : '🚫 Ignored', inline: true },
                {
                    name: 'Direction',
                    value: direction === 'one-way'
                        ? '➡️ One-way — receiving servers keep their own messages.'
                        : '🔁 Two-way — every linked server mirrors activity.',
                    inline: true
                }
            );

            const channelLines = [];
            const channelOptions = [];
            const guildCache = new Map();
            const uniqueGuildIds = new Set();
            const sourceNameMap = new Map();
            for (const link of bridge.channels ?? []) {
                const guildKey = link.guildId ? String(link.guildId) : null;
                if (guildKey && !guildCache.has(guildKey)) {
                    const fetched = await fetchGuild(client, guildKey);
                    guildCache.set(guildKey, fetched);
                }
                const guild = guildKey ? guildCache.get(guildKey) : null;
                const guildName = guild?.name ?? guildKey ?? 'Unknown guild';
                if (guildKey) {
                    uniqueGuildIds.add(guildKey);
                }
                let channelDisplay = `<#${link.channelId}>`;
                const channel = guild?.channels?.cache?.get(link.channelId) ?? null;
                if (channel?.isTextBased?.()) {
                    channelDisplay = `<#${channel.id}>`;
                }
                const isSourceGuild = direction === 'one-way' && guildKey && sourceGuildSet.has(guildKey);
                if (isSourceGuild && guildKey && !sourceNameMap.has(guildKey)) {
                    sourceNameMap.set(guildKey, guildName);
                }
                const sourceBadge = isSourceGuild ? ' — **source**' : '';
                channelLines.push(`• ${guildName} — ${channelDisplay}${sourceBadge}`);

                const optionLabel = truncateName(guildName, 75);
                const optionDescription = truncateName(
                    channel?.isTextBased?.() ? `#${channel.name}` : `Channel ${link.channelId}`,
                    95
                );
                if (guildKey) {
                    channelOptions.push({
                        label: optionLabel,
                        description: optionDescription,
                        value: `${guildKey}:${link.channelId}`
                    });
                }
            }

            embed.addFields({
                name: 'Linked channels',
                value: channelLines.length
                    ? channelLines.join('\n').slice(0, 1024)
                    : 'No channels linked yet. Add at least two channels to activate syncing.',
                inline: false
            });

            if (direction === 'one-way') {
                const sourceList = [...sourceGuildSet];
                const sourceLines = sourceList.map((guildId) => {
                    const cachedName = sourceNameMap.get(guildId)
                        ?? guildOptions.find((option) => String(option.id) === guildId)?.name
                        ?? guildId;
                    return `• ${truncateName(cachedName, 80)}`;
                });
                const sourceValue = sourceLines.length
                    ? sourceLines.join('\n').slice(0, 1024)
                    : 'Select at least one source server so outbound messages know where to originate.';
                embed.addFields({ name: 'Source servers', value: sourceValue, inline: false });
            }

            if ((bridge.channels?.length ?? 0) < 2) {
                embed.addFields({ name: 'Status', value: 'Add at least two channels so messages can be mirrored between them.', inline: false });
            }

            if (context?.action === 'add') {
                embed.setFooter({ text: 'Use “Add channel” to paste the guild ID, channel ID, and optional webhook URL.' });
            } else if (context?.action === 'remove') {
                embed.setFooter({ text: channelOptions.length ? 'Pick channels from the dropdown to unlink them from this bridge.' : 'No channels left to remove from this bridge.' });
            } else if (context?.action === 'confirm-delete') {
                embed.setFooter({ text: 'This action cannot be undone. Confirm to delete the bridge.' });
            } else if (context?.action === 'edit-sources') {
                embed.setFooter({
                    text: direction === 'one-way'
                        ? 'Choose which servers should broadcast messages across the bridge.'
                        : 'Switch to one-way mode to choose source servers.'
                });
            }

            const actionsRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`setup:rainbow:addChannel:${bridgeId}`).setLabel('Add channel').setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId(`setup:rainbow:removeChannel:${bridgeId}`).setLabel('Remove channel').setStyle(ButtonStyle.Secondary).setDisabled(!bridge.channels?.length),
                new ButtonBuilder().setCustomId(`setup:rainbow:toggleBots:${bridgeId}`).setLabel(bots ? 'Disable bot mirroring' : 'Enable bot mirroring').setStyle(ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId(`setup:rainbow:deleteBridge:${bridgeId}`).setLabel('Delete bridge').setStyle(ButtonStyle.Danger)
            );

            components.push(actionsRow);
            const directionRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                .setCustomId(`setup:rainbow:toggleDirection:${bridgeId}`)
                .setLabel(direction === 'one-way' ? 'Switch to two-way' : 'Switch to one-way')
                .setStyle(ButtonStyle.Secondary),
                new ButtonBuilder()
                .setCustomId(`setup:rainbow:editSources:${bridgeId}`)
                .setLabel('Edit source servers')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(direction !== 'one-way' || (bridge.channels?.length ?? 0) < 2)
            );
            components.push(directionRow);
            components.push(new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('setup:rainbow:backToList').setLabel('Back to bridges').setStyle(ButtonStyle.Secondary)
            ));

            if (context?.action === 'remove' && channelOptions.length) {
                const removeSelect = new StringSelectMenuBuilder()
                .setCustomId(`setup:rainbow:removeChannelSelect:${bridgeId}`)
                .setPlaceholder('Select channels to remove')
                .setMinValues(1)
                .setMaxValues(Math.min(channelOptions.length, 25))
                .addOptions(channelOptions.slice(0, 25));
                components.push(new ActionRowBuilder().addComponents(removeSelect));
            }

            if (context?.action === 'edit-sources' && direction === 'one-way') {
                const guildOptionEntries = Array.from(uniqueGuildIds)
                    .filter(Boolean)
                    .map((guildId) => {
                        const guild = guildCache.get(guildId);
                        const name = guild?.name
                            ?? guildOptions.find((option) => String(option.id) === guildId)?.name
                            ?? guildId;
                        return {
                            label: truncateName(name, 75),
                            value: String(guildId),
                            description: truncateName(name, 95),
                            default: sourceGuildSet.has(String(guildId))
                        };
                    });
                if (guildOptionEntries.length) {
                    const sourceSelect = new StringSelectMenuBuilder()
                    .setCustomId(`setup:rainbow:editSourcesSelect:${bridgeId}`)
                    .setPlaceholder('Select source servers')
                    .setMinValues(1)
                    .setMaxValues(Math.min(guildOptionEntries.length, 25))
                    .addOptions(guildOptionEntries.slice(0, 25));
                    components.push(new ActionRowBuilder().addComponents(sourceSelect));
                }
            }

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
