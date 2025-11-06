// src/features/embed-builder/setup.js
// Setup panel integration for the embed builder utility.
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
    collectTextChannels,
    formatChannel,
    sanitizeSnowflakeId,
    truncateName
} from '../setup/shared.js';

const DEFAULT_COLOR = '#5865F2';

const COLOR_OPTIONS = [
    { label: 'Red', value: '#ff0000', emoji: '🟥' },
    { label: 'Orange', value: '#ff7f00', emoji: '🟧' },
    { label: 'Yellow', value: '#ffff00', emoji: '🟨' },
    { label: 'Green', value: '#00ff00', emoji: '🟩' },
    { label: 'Blue', value: '#0000ff', emoji: '🟦' },
    { label: 'Indigo', value: '#4b0082', emoji: '🟪' },
    { label: 'Violet', value: '#8f00ff', emoji: '🟣' }
];

const BUTTON_LIMIT = 5;
const DESCRIPTION_MAX_LENGTH = 4000;

export function createEmbedBuilderSetup({ panelStore, saveConfig, fetchGuild }) {
    function prepareConfig(config) {
        config.embedBuilder = normalizeEmbedBuilder(config.embedBuilder);
    }

    async function handleInteraction({ interaction, entry, config, client, key, logger }) {
        const availableGuildIds = Array.isArray(entry?.availableGuildIds) && entry.availableGuildIds.length
            ? entry.availableGuildIds
            : collectEligibleGuildIds(config);

        const embedConfig = ensureEmbedConfig(config);
        const entryGuildId = entry?.guildId ?? null;
        const currentGuildId = entryGuildId
            ?? (embedConfig.guildId ? sanitizeSnowflakeId(embedConfig.guildId) : null)
            ?? (availableGuildIds[0] ?? null);

        const baseContext = entry?.context ?? {};
        const currentMode = entry?.mode ?? 'default';

        const persistState = (message, overrides = {}) => {
            panelStore.set(key, {
                message,
                guildId: overrides.guildId ?? currentGuildId ?? null,
                mode: overrides.mode ?? currentMode,
                context: overrides.context ?? baseContext,
                availableGuildIds
            });
        };

        const refreshFromStore = async (overrides = {}) => {
            const state = panelStore.get(key) ?? {};
            const guildId = overrides.guildId ?? state.guildId ?? currentGuildId ?? null;
            const mode = overrides.mode ?? state.mode ?? 'default';
            const context = overrides.context ?? state.context ?? {};
            const guild = guildId ? await fetchGuild(client, guildId).catch(() => null) : null;
            const eligible = overrides.availableGuildIds ?? state.availableGuildIds ?? availableGuildIds;
            if (!state.message) return;
            const view = await buildView({
                config,
                client,
                guild,
                mode,
                context,
                availableGuildIds: eligible
            });
            try {
                const message = await state.message.edit(view);
                panelStore.set(key, {
                    message,
                    guildId,
                    mode,
                    context,
                    availableGuildIds: eligible
                });
            } catch {}
        };

        if (interaction.isButton()) {
            switch (interaction.customId) {
                case 'setup:embed:openChannelSelect': {
                    if (!currentGuildId) {
                        await interaction.reply({ content: 'Select a server before choosing a channel.', ephemeral: true });
                        return;
                    }
                    const guild = await fetchGuild(client, currentGuildId).catch(() => null);
                    if (!guild) {
                        await interaction.reply({ content: 'Could not load the selected server. Try again.', ephemeral: true });
                        return;
                    }
                    const view = await buildView({
                        config,
                        client,
                        guild,
                        mode: 'select-channel',
                        context: baseContext,
                        availableGuildIds
                    });
                    const message = await interaction.update(view);
                    persistState(message, { guildId: currentGuildId, mode: 'select-channel', context: baseContext });
                    return;
                }
                case 'setup:embed:openManage': {
                    const guild = currentGuildId ? await fetchGuild(client, currentGuildId).catch(() => null) : null;
                    const view = await buildView({
                        config,
                        client,
                        guild,
                        mode: 'manage-buttons',
                        context: baseContext,
                        availableGuildIds
                    });
                    const message = await interaction.update(view);
                    persistState(message, { guildId: currentGuildId, mode: 'manage-buttons', context: baseContext });
                    return;
                }
                case 'setup:embed:returnDefault': {
                    const guild = currentGuildId ? await fetchGuild(client, currentGuildId).catch(() => null) : null;
                    const view = await buildView({
                        config,
                        client,
                        guild,
                        mode: 'default',
                        context: baseContext,
                        availableGuildIds
                    });
                    const message = await interaction.update(view);
                    persistState(message, { guildId: currentGuildId, mode: 'default', context: baseContext });
                    return;
                }
                case 'setup:embed:setPreface': {
                    const modal = new ModalBuilder()
                    .setCustomId('setup:embed:prefaceModal')
                    .setTitle('Set pre-text')
                    .addComponents(
                        new ActionRowBuilder().addComponents(
                            new TextInputBuilder()
                            .setCustomId('setup:embed:prefaceInput')
                            .setLabel('Message text before the embed')
                            .setStyle(TextInputStyle.Paragraph)
                            .setRequired(false)
                            .setMaxLength(2000)
                            .setValue(embedConfig.preface ?? '')
                        )
                    );
                    await interaction.showModal(modal);
                    return;
                }
                case 'setup:embed:setTitle': {
                    const modal = new ModalBuilder()
                    .setCustomId('setup:embed:titleModal')
                    .setTitle('Set embed title')
                    .addComponents(
                        new ActionRowBuilder().addComponents(
                            new TextInputBuilder()
                            .setCustomId('setup:embed:titleInput')
                            .setLabel('Embed title (optional)')
                            .setStyle(TextInputStyle.Short)
                            .setRequired(false)
                            .setMaxLength(256)
                            .setValue(embedConfig.embed.title ?? '')
                        )
                    );
                    await interaction.showModal(modal);
                    return;
                }
                case 'setup:embed:setDescription': {
                    const modal = new ModalBuilder()
                    .setCustomId('setup:embed:descriptionModal')
                    .setTitle('Set embed content')
                    .addComponents(
                        new ActionRowBuilder().addComponents(
                            new TextInputBuilder()
                            .setCustomId('setup:embed:descriptionInput')
                            .setLabel('Embed description (supports Markdown)')
                            .setStyle(TextInputStyle.Paragraph)
                            .setRequired(false)
                            .setMaxLength(DESCRIPTION_MAX_LENGTH)
                            .setValue(embedConfig.embed.description ?? '')
                        )
                    );
                    await interaction.showModal(modal);
                    return;
                }
                case 'setup:embed:addButton': {
                    if ((embedConfig.buttons ?? []).length >= BUTTON_LIMIT) {
                        await interaction.reply({ content: `You can only configure up to ${BUTTON_LIMIT} buttons.`, ephemeral: true });
                        return;
                    }
                    const modal = new ModalBuilder()
                    .setCustomId('setup:embed:addButtonModal')
                    .setTitle('Add link button')
                    .addComponents(
                        new ActionRowBuilder().addComponents(
                            new TextInputBuilder()
                            .setCustomId('setup:embed:buttonLabel')
                            .setLabel('Button label')
                            .setStyle(TextInputStyle.Short)
                            .setRequired(true)
                            .setMaxLength(80)
                        )
                    )
                    .addComponents(
                        new ActionRowBuilder().addComponents(
                            new TextInputBuilder()
                            .setCustomId('setup:embed:buttonUrl')
                            .setLabel('Button URL (https://…)')
                            .setStyle(TextInputStyle.Short)
                            .setRequired(true)
                            .setMaxLength(512)
                        )
                    );
                    await interaction.showModal(modal);
                    return;
                }
                case 'setup:embed:postEmbed': {
                    if (!currentGuildId) {
                        await interaction.reply({ content: 'Select a server before posting the embed.', ephemeral: true });
                        return;
                    }
                    if (!embedConfig.channelId) {
                        await interaction.reply({ content: 'Choose a target channel before posting the embed.', ephemeral: true });
                        return;
                    }
                    const guild = await fetchGuild(client, currentGuildId).catch(() => null);
                    if (!guild) {
                        await interaction.reply({ content: 'Could not load the selected server. Try again.', ephemeral: true });
                        return;
                    }
                    const channelId = embedConfig.channelId;
                    let channel = guild.channels?.cache?.get(channelId) ?? null;
                    if (!channel && typeof guild.channels?.fetch === 'function') {
                        channel = await guild.channels.fetch(channelId).catch(() => null);
                    }
                    if (!channel || typeof channel.isTextBased !== 'function' || !channel.isTextBased()) {
                        await interaction.reply({ content: 'The configured channel could not be accessed. Pick another channel.', ephemeral: true });
                        return;
                    }

                    const { payload, error } = buildEmbedPostPayload(embedConfig);
                    if (error) {
                        await interaction.reply({ content: error, ephemeral: true });
                        return;
                    }

                    await interaction.deferReply({ ephemeral: true });
                    try {
                        await channel.send(payload);
                        await interaction.editReply({ content: `Embed posted to <#${channel.id}>.` });
                    } catch (err) {
                        const message = err?.message ?? String(err ?? 'unknown error');
                        logger?.warn?.(`[embed] Failed to post embed in ${guild.id}:${channel.id} — ${message}`);
                        await interaction.editReply({ content: `Failed to post embed: ${message}` });
                    }
                    return;
                }
                case 'setup:embed:clearButtons': {
                    embedConfig.buttons = [];
                    saveConfig(config, logger);
                    const guild = currentGuildId ? await fetchGuild(client, currentGuildId).catch(() => null) : null;
                    const view = await buildView({
                        config,
                        client,
                        guild,
                        mode: currentMode,
                        context: baseContext,
                        availableGuildIds
                    });
                    const message = await interaction.update(view);
                    persistState(message, { mode: currentMode, context: baseContext });
                    await interaction.followUp({ content: 'All buttons cleared.', ephemeral: true }).catch(() => {});
                    return;
                }
                default:
                    return;
            }
        }

        if (interaction.isAnySelectMenu()) {
            const [, , action] = interaction.customId.split(':');
            switch (action) {
                case 'selectGuild': {
                    const choice = interaction.values?.[0] ?? null;
                    const nextGuildId = choice && choice !== 'noop' ? choice : null;
                    if (nextGuildId !== currentGuildId) {
                        embedConfig.channelId = null;
                    }
                    embedConfig.guildId = nextGuildId;
                    saveConfig(config, logger);
                    const nextMode = currentMode === 'manage-buttons'
                        ? 'manage-buttons'
                        : (currentMode === 'select-channel' ? 'select-channel' : 'default');
                    const guild = nextGuildId ? await fetchGuild(client, nextGuildId).catch(() => null) : null;
                    const view = await buildView({
                        config,
                        client,
                        guild,
                        mode: nextMode,
                        context: baseContext,
                        availableGuildIds
                    });
                    const message = await interaction.update(view);
                    persistState(message, { guildId: nextGuildId, mode: nextMode, context: baseContext });
                    return;
                }
                case 'selectChannel': {
                    const channelId = interaction.values?.[0] ?? null;
                    if (!channelId || channelId === 'noop') {
                        await interaction.reply({ content: 'Select a valid channel.', ephemeral: true });
                        return;
                    }
                    if (!currentGuildId) {
                        await interaction.reply({ content: 'Choose a server before selecting a channel.', ephemeral: true });
                        return;
                    }
                    const guild = await fetchGuild(client, currentGuildId).catch(() => null);
                    const channels = await collectTextChannels(guild);
                    if (!channels.find(ch => ch.id === channelId)) {
                        await interaction.reply({ content: 'That channel could not be accessed. Pick another channel.', ephemeral: true });
                        return;
                    }
                    embedConfig.channelId = channelId;
                    saveConfig(config, logger);
                    const view = await buildView({
                        config,
                        client,
                        guild,
                        mode: 'default',
                        context: baseContext,
                        availableGuildIds
                    });
                    const message = await interaction.update(view);
                    persistState(message, { guildId: currentGuildId, mode: 'default', context: baseContext });
                    await interaction.followUp({ content: `Embed channel set to <#${channelId}>.`, ephemeral: true }).catch(() => {});
                    return;
                }
                case 'selectColor': {
                    const choice = interaction.values?.[0] ?? null;
                    const resolved = resolveColor(choice) ?? DEFAULT_COLOR;
                    embedConfig.embed.color = resolved;
                    saveConfig(config, logger);
                    const guild = currentGuildId ? await fetchGuild(client, currentGuildId).catch(() => null) : null;
                    const view = await buildView({
                        config,
                        client,
                        guild,
                        mode: currentMode,
                        context: baseContext,
                        availableGuildIds
                    });
                    const message = await interaction.update(view);
                    persistState(message, { guildId: currentGuildId, mode: currentMode, context: baseContext });
                    return;
                }
                case 'removeButton': {
                    const selections = (interaction.values ?? []).map(val => Number.parseInt(val, 10)).filter(Number.isInteger);
                    if (!selections.length) {
                        await interaction.deferUpdate().catch(() => {});
                        return;
                    }
                    const unique = Array.from(new Set(selections)).filter(idx => idx >= 0 && idx < embedConfig.buttons.length);
                    if (!unique.length) {
                        await interaction.reply({ content: 'Select at least one valid button to remove.', ephemeral: true });
                        return;
                    }
                    unique.sort((a, b) => b - a);
                    for (const idx of unique) {
                        embedConfig.buttons.splice(idx, 1);
                    }
                    saveConfig(config, logger);
                    const guild = currentGuildId ? await fetchGuild(client, currentGuildId).catch(() => null) : null;
                    const view = await buildView({
                        config,
                        client,
                        guild,
                        mode: currentMode,
                        context: baseContext,
                        availableGuildIds
                    });
                    const message = await interaction.update(view);
                    persistState(message, { guildId: currentGuildId, mode: currentMode, context: baseContext });
                    await interaction.followUp({ content: 'Selected buttons removed.', ephemeral: true }).catch(() => {});
                    return;
                }
                default:
                    return;
            }
        }

        if (interaction.isModalSubmit()) {
            if (interaction.customId === 'setup:embed:prefaceModal') {
                const raw = interaction.fields.getTextInputValue('setup:embed:prefaceInput') ?? '';
                embedConfig.preface = sanitizeText(raw, 2000);
                saveConfig(config, logger);
                await interaction.reply({ content: 'Pre-text updated.', ephemeral: true });
                await refreshFromStore();
                return;
            }

            if (interaction.customId === 'setup:embed:titleModal') {
                const raw = interaction.fields.getTextInputValue('setup:embed:titleInput') ?? '';
                embedConfig.embed.title = sanitizeText(raw, 256);
                saveConfig(config, logger);
                await interaction.reply({ content: 'Embed title updated.', ephemeral: true });
                await refreshFromStore();
                return;
            }

            if (interaction.customId === 'setup:embed:descriptionModal') {
                const raw = interaction.fields.getTextInputValue('setup:embed:descriptionInput') ?? '';
                embedConfig.embed.description = sanitizeText(raw, DESCRIPTION_MAX_LENGTH);
                saveConfig(config, logger);
                await interaction.reply({ content: 'Embed content updated.', ephemeral: true });
                await refreshFromStore();
                return;
            }

            if (interaction.customId === 'setup:embed:addButtonModal') {
                const labelRaw = interaction.fields.getTextInputValue('setup:embed:buttonLabel') ?? '';
                const urlRaw = interaction.fields.getTextInputValue('setup:embed:buttonUrl') ?? '';
                const label = sanitizeButtonLabel(labelRaw);
                const url = sanitizeButtonUrl(urlRaw);
                if (!label) {
                    await interaction.reply({ content: 'Provide a button label.', ephemeral: true });
                    return;
                }
                if (!url) {
                    await interaction.reply({ content: 'Provide a valid https:// URL for the button.', ephemeral: true });
                    return;
                }
                if ((embedConfig.buttons ?? []).length >= BUTTON_LIMIT) {
                    await interaction.reply({ content: `You can only configure up to ${BUTTON_LIMIT} buttons.`, ephemeral: true });
                    return;
                }
                embedConfig.buttons.push({ label, url });
                saveConfig(config, logger);
                await interaction.reply({ content: `Added button **${label}**.`, ephemeral: true });
                await refreshFromStore();
                return;
            }
        }
    }

    async function buildView({ config, client, guild, mode, context: _context, availableGuildIds = [] }) {
        const embedConfig = ensureEmbedConfig(config);
        const selectedGuild = guild ?? (embedConfig.guildId ? await fetchGuild(client, embedConfig.guildId).catch(() => null) : null);
        const selectedGuildId = selectedGuild?.id ?? embedConfig.guildId ?? null;
        const eligibleGuilds = availableGuildIds.length ? availableGuildIds : collectEligibleGuildIds(config);
        if (selectedGuildId && !eligibleGuilds.includes(selectedGuildId)) {
            eligibleGuilds.push(selectedGuildId);
        }

        const summary = new EmbedBuilder()
        .setTitle('Embed builder')
        .setDescription('Configure an embed template with optional pre-text and link buttons. Changes save automatically when you update a field.')
        .addFields(
            {
                name: 'Target server',
                value: selectedGuild
                    ? `${selectedGuild.name} (${selectedGuild.id})`
                    : 'Select a server from the dropdown.',
                inline: false
            },
            {
                name: 'Target channel',
                value: formatChannel(selectedGuild, embedConfig.channelId),
                inline: false
            },
            {
                name: 'Pre-text',
                value: embedConfig.preface ? truncateEmbedField(embedConfig.preface, 1024) : 'None configured',
                inline: false
            },
            {
                name: 'Embed title',
                value: embedConfig.embed.title ? truncateEmbedField(embedConfig.embed.title, 256) : 'None configured',
                inline: true
            },
            {
                name: 'Embed color',
                value: (embedConfig.embed.color || DEFAULT_COLOR).toUpperCase(),
                inline: true
            },
            {
                name: 'Buttons',
                value: summarizeButtons(embedConfig.buttons),
                inline: false
            }
        );

        const colorValue = resolveColor(embedConfig.embed.color);
        const preview = new EmbedBuilder();
        if (embedConfig.embed.title) {
            preview.setTitle(embedConfig.embed.title);
        }
        if (embedConfig.embed.description) {
            preview.setDescription(embedConfig.embed.description);
        } else {
            preview.setDescription('_No embed description configured yet._');
        }
        if (colorValue !== null) {
            preview.setColor(colorValue);
        }
        preview.setFooter({ text: 'Preview' });

        const components = [];
        const effectiveMode = mode === 'manage-buttons'
            ? 'manage-buttons'
            : (mode === 'select-channel' ? 'select-channel' : 'default');

        const serverMenu = new StringSelectMenuBuilder()
        .setCustomId('setup:embed:selectGuild')
        .setPlaceholder(eligibleGuilds.length ? 'Select target server…' : 'Add servers from the overview page')
        .setMinValues(1)
        .setMaxValues(1)
        .setDisabled(!eligibleGuilds.length);

        if (eligibleGuilds.length) {
            const options = [];
            for (const id of eligibleGuilds.slice(0, 25)) {
                const g = client.guilds.cache.get(id) ?? await fetchGuild(client, id).catch(() => null);
                options.push({
                    label: truncateName(g?.name ?? id, 100),
                    description: `ID: ${id}`.slice(0, 100),
                    value: id,
                    default: id === selectedGuildId
                });
            }
            serverMenu.addOptions(options);
        } else {
            serverMenu.addOptions({ label: 'No servers available', value: 'noop', default: true });
        }
        components.push(new ActionRowBuilder().addComponents(serverMenu));

        if (effectiveMode === 'select-channel' && selectedGuild) {
            const channels = await collectTextChannels(selectedGuild);
            const channelMenu = new StringSelectMenuBuilder()
            .setCustomId('setup:embed:selectChannel')
            .setPlaceholder(channels.length ? 'Select target channel…' : 'No text channels available')
            .setMinValues(1)
            .setMaxValues(1)
            .setDisabled(!channels.length);
            if (channels.length) {
                const options = channels.slice(0, 25).map(ch => ({
                    label: truncateName(ch.name ?? ch.id, 100),
                    description: `ID: ${ch.id}`.slice(0, 100),
                    value: ch.id,
                    default: ch.id === embedConfig.channelId
                }));
                if (embedConfig.channelId && !options.find(opt => opt.value === embedConfig.channelId)) {
                    options.unshift({
                        label: truncateName(`#${embedConfig.channelId}`, 100),
                        description: `ID: ${embedConfig.channelId}`.slice(0, 100),
                        value: embedConfig.channelId,
                        default: true
                    });
                }
                channelMenu.addOptions(options);
            } else {
                channelMenu.addOptions({ label: 'No available channels', value: 'noop', default: true });
            }
            components.push(new ActionRowBuilder().addComponents(channelMenu));
        }

        const hasPostableContent = Boolean((embedConfig.preface ?? '').trim())
            || Boolean(embedConfig.embed?.title)
            || Boolean(embedConfig.embed?.description);
        const postButtonDisabled = !embedConfig.channelId || !hasPostableContent;

        if (effectiveMode === 'default') {
            const editRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                .setCustomId('setup:embed:openChannelSelect')
                .setLabel('Set channel')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(!selectedGuild),
                new ButtonBuilder()
                .setCustomId('setup:embed:setPreface')
                .setLabel('Set pre-text')
                .setStyle(ButtonStyle.Secondary),
                new ButtonBuilder()
                .setCustomId('setup:embed:setTitle')
                .setLabel('Set title')
                .setStyle(ButtonStyle.Secondary),
                new ButtonBuilder()
                .setCustomId('setup:embed:setDescription')
                .setLabel('Set content')
                .setStyle(ButtonStyle.Secondary)
            );
            const navRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                .setCustomId('setup:embed:openManage')
                .setLabel('Manage buttons')
                .setStyle(ButtonStyle.Primary),
                new ButtonBuilder()
                .setCustomId('setup:embed:postEmbed')
                .setLabel('Post embed')
                .setStyle(ButtonStyle.Success)
                .setDisabled(postButtonDisabled),
                createHomeButton()
            );
            components.push(editRow, navRow);
        } else if (effectiveMode === 'select-channel') {
            const channelRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                .setCustomId('setup:embed:returnDefault')
                .setLabel('Done selecting channel')
                .setStyle(ButtonStyle.Primary),
                new ButtonBuilder()
                .setCustomId('setup:embed:setPreface')
                .setLabel('Set pre-text')
                .setStyle(ButtonStyle.Secondary),
                new ButtonBuilder()
                .setCustomId('setup:embed:setTitle')
                .setLabel('Set title')
                .setStyle(ButtonStyle.Secondary),
                new ButtonBuilder()
                .setCustomId('setup:embed:setDescription')
                .setLabel('Set content')
                .setStyle(ButtonStyle.Secondary)
            );
            const navRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                .setCustomId('setup:embed:openManage')
                .setLabel('Manage buttons')
                .setStyle(ButtonStyle.Secondary),
                new ButtonBuilder()
                .setCustomId('setup:embed:postEmbed')
                .setLabel('Post embed')
                .setStyle(ButtonStyle.Success)
                .setDisabled(postButtonDisabled),
                createHomeButton()
            );
            components.push(channelRow, navRow);
        } else if (effectiveMode === 'manage-buttons') {
            const manageRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                .setCustomId('setup:embed:addButton')
                .setLabel('Add link button')
                .setStyle(ButtonStyle.Primary)
                .setDisabled((embedConfig.buttons ?? []).length >= BUTTON_LIMIT),
                new ButtonBuilder()
                .setCustomId('setup:embed:clearButtons')
                .setLabel('Clear buttons')
                .setStyle(ButtonStyle.Danger)
                .setDisabled(!(embedConfig.buttons ?? []).length),
                new ButtonBuilder()
                .setCustomId('setup:embed:returnDefault')
                .setLabel('Back to embed')
                .setStyle(ButtonStyle.Secondary),
                new ButtonBuilder()
                .setCustomId('setup:embed:postEmbed')
                .setLabel('Post embed')
                .setStyle(ButtonStyle.Success)
                .setDisabled(postButtonDisabled),
                createHomeButton()
            );
            components.push(manageRow);
        }

        const colorMenu = new StringSelectMenuBuilder()
        .setCustomId('setup:embed:selectColor')
        .setPlaceholder('Select embed color…')
        .setMinValues(1)
        .setMaxValues(1);
        const currentColor = (embedConfig.embed.color || DEFAULT_COLOR).toLowerCase();
        colorMenu.addOptions(COLOR_OPTIONS.map(opt => ({
            label: opt.label,
            value: opt.value,
            emoji: opt.emoji,
            default: opt.value === currentColor
        })));
        components.push(new ActionRowBuilder().addComponents(colorMenu));

        if (effectiveMode === 'manage-buttons' && (embedConfig.buttons ?? []).length) {
            const removeMenu = new StringSelectMenuBuilder()
            .setCustomId('setup:embed:removeButton')
            .setPlaceholder('Select buttons to remove…')
            .setMinValues(1)
            .setMaxValues(Math.min(embedConfig.buttons.length, 25));
            removeMenu.addOptions(embedConfig.buttons.map((btn, idx) => ({
                label: truncateName(btn.label || `Button ${idx + 1}`, 100),
                description: (btn.url ?? '').slice(0, 100) || 'Link button',
                value: String(idx)
            })));
            components.push(new ActionRowBuilder().addComponents(removeMenu));
        }

        const embeds = [summary, preview];
        return { embeds, components };
    }

    return {
        prepareConfig,
        handleInteraction,
        buildView,
        collectEligibleGuildIds
    };
}

function buildEmbedPostPayload(embedConfig) {
    const preface = typeof embedConfig.preface === 'string' ? embedConfig.preface.trim() : '';
    const title = embedConfig.embed?.title ?? '';
    const description = embedConfig.embed?.description ?? '';
    const hasTitle = Boolean(title);
    const hasDescription = Boolean(description);
    const hasEmbedContent = hasTitle || hasDescription;
    const hasPreface = Boolean(preface);

    if (!hasEmbedContent && !hasPreface) {
        return { error: 'Add pre-text or embed content before posting.' };
    }

    const payload = {};

    if (hasPreface) {
        payload.content = preface;
    }

    if (hasEmbedContent) {
        const outgoingEmbed = new EmbedBuilder();
        if (hasTitle) {
            outgoingEmbed.setTitle(title);
        }
        if (hasDescription) {
            outgoingEmbed.setDescription(description);
        }
        const colorValue = resolveColor(embedConfig.embed?.color);
        if (colorValue !== null) {
            outgoingEmbed.setColor(colorValue);
        }
        payload.embeds = [outgoingEmbed];
    }

    const buttonRows = buildButtonRows(embedConfig.buttons);
    if (buttonRows.length) {
        payload.components = buttonRows;
    }

    return { payload };
}

function buildButtonRows(buttons) {
    if (!Array.isArray(buttons) || !buttons.length) {
        return [];
    }
    const rows = [];
    const slice = buttons.slice(0, BUTTON_LIMIT);
    const row = new ActionRowBuilder();
    for (const btn of slice) {
        const label = btn?.label ?? '';
        const url = btn?.url ?? '';
        if (!label || !url) continue;
        row.addComponents(
            new ButtonBuilder()
            .setLabel(label)
            .setURL(url)
            .setStyle(ButtonStyle.Link)
        );
    }
    if (row.components.length) {
        rows.push(row);
    }
    return rows;
}

function createHomeButton() {
    return new ButtonBuilder()
    .setCustomId('setup:navigate:home')
    .setLabel('⬅ Back to overview')
    .setStyle(ButtonStyle.Secondary);
}

function ensureEmbedConfig(config) {
    if (!config.embedBuilder || typeof config.embedBuilder !== 'object') {
        config.embedBuilder = normalizeEmbedBuilder(null);
    }
    return config.embedBuilder;
}

function normalizeEmbedBuilder(value) {
    const base = {
        guildId: null,
        channelId: null,
        preface: '',
        embed: {
            color: DEFAULT_COLOR,
            title: '',
            description: ''
        },
        buttons: []
    };

    if (!value || typeof value !== 'object') {
        return base;
    }

    const normalized = { ...base };
    normalized.guildId = sanitizeSnowflakeId(value.guildId) ?? null;
    normalized.channelId = sanitizeSnowflakeId(value.channelId) ?? null;
    normalized.preface = sanitizeText(value.preface, 2000);
    const incomingEmbed = value.embed && typeof value.embed === 'object' ? value.embed : {};
    normalized.embed = {
        color: resolveColor(incomingEmbed.color) ?? DEFAULT_COLOR,
        title: sanitizeText(incomingEmbed.title, 256),
        description: sanitizeText(incomingEmbed.description, DESCRIPTION_MAX_LENGTH)
    };
    normalized.buttons = Array.isArray(value.buttons)
        ? value.buttons
        .map(btn => ({
            label: sanitizeButtonLabel(btn?.label),
            url: sanitizeButtonUrl(btn?.url)
        }))
        .filter(btn => btn.label && btn.url)
        .slice(0, BUTTON_LIMIT)
        : [];
    return normalized;
}

function collectEligibleGuildIds(config) {
    const set = new Set();
    const embedConfig = config.embedBuilder && typeof config.embedBuilder === 'object'
        ? config.embedBuilder
        : {};
    if (Array.isArray(config.mainServerIds)) {
        for (const id of config.mainServerIds) {
            const cleaned = sanitizeSnowflakeId(id);
            if (cleaned) set.add(cleaned);
        }
    }
    const logging = sanitizeSnowflakeId(config.loggingServerId);
    if (logging) set.add(logging);
    const configuredGuild = sanitizeSnowflakeId(embedConfig.guildId);
    if (configuredGuild) set.add(configuredGuild);
    return Array.from(set);
}

function resolveColor(input) {
    if (typeof input !== 'string') return null;
    const trimmed = input.trim().toLowerCase();
    if (/^#?[0-9a-f]{6}$/i.test(trimmed)) {
        const hex = trimmed.startsWith('#') ? trimmed.slice(1) : trimmed;
        return `#${hex}`.toLowerCase();
    }
    const match = COLOR_OPTIONS.find(opt => opt.label.toLowerCase() === trimmed);
    if (match) {
        return match.value;
    }
    return null;
}

function sanitizeText(value, maxLength) {
    if (typeof value !== 'string') return '';
    const trimmed = value.trim();
    if (!trimmed) return '';
    return trimmed.slice(0, maxLength);
}

function sanitizeButtonLabel(value) {
    if (typeof value !== 'string') return '';
    const trimmed = value.trim();
    if (!trimmed) return '';
    return trimmed.slice(0, 80);
}

function sanitizeButtonUrl(value) {
    if (typeof value !== 'string') return '';
    const trimmed = value.trim();
    if (!trimmed) return '';
    try {
        const parsed = new URL(trimmed);
        if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return '';
        return parsed.toString();
    } catch {
        return '';
    }
}

function truncateEmbedField(value, max) {
    if (typeof value !== 'string' || !value) return 'None configured';
    return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function summarizeButtons(buttons) {
    if (!Array.isArray(buttons) || !buttons.length) {
        return 'No buttons configured.';
    }
    const parts = buttons.map((btn, idx) => `${idx + 1}. [${btn.label}](${btn.url})`);
    const joined = parts.join('\n');
    if (joined.length <= 1024) {
        return joined;
    }
    let output = '';
    for (const part of parts) {
        if ((output + part).length > 1020) break;
        output += (output ? '\n' : '') + part;
    }
    return `${output}\n… ${parts.length - output.split('\n').length} more`;
}
