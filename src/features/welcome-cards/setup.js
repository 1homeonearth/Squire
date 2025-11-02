// src/features/welcome-cards/setup.js
// Setup panel integration for the welcome cards module.
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
    collectTextChannels,
    formatChannel,
    formatRole,
    truncateName
} from '../setup/shared.js';
import {
    DEFAULT_WELCOME_MESSAGE,
    LEGACY_DEFAULT_WELCOME_MESSAGE,
    sanitizeWelcomeMessage,
    WELCOME_TEMPLATE_PLACEHOLDERS
} from './template.js';

export function createWelcomeSetup({ panelStore, saveConfig, fetchGuild }) {
    function prepareConfig(config, { fallbackGuilds = [], loggingServerId = null } = {}) {
        config.welcome = normalizeWelcomeMap({
            value: config.welcome,
            fallbackGuilds,
            loggingServerId
        });
    }

    async function handleInteraction({ interaction, entry, config, client, key, logger }) {
        const availableGuildIds = entry?.availableGuildIds ?? config.mainServerIds.filter(id => id !== config.loggingServerId);
        const currentGuildId = entry?.guildId && availableGuildIds.includes(entry.guildId)
            ? entry.guildId
            : null;
        const targetGuild = currentGuildId ? await fetchGuild(client, currentGuildId).catch(() => null) : null;

        const ensureWelcomeEntry = () => {
            if (!currentGuildId) return null;
            if (!config.welcome || typeof config.welcome !== 'object') {
                config.welcome = {};
            }
            if (!config.welcome[currentGuildId]) {
                config.welcome[currentGuildId] = {
                    channelId: null,
                    mentions: {},
                    preImageText: DEFAULT_WELCOME_MESSAGE,
                    isCustomized: false,
                    enabled: true,
                    headerLine1: 'Welcome',
                    headerLine2Template: '{username}',
                    roles: {
                        unverifiedRoleId: null,
                        verifiedRoleId: null,
                        crossVerifiedRoleId: null,
                        moderatorRoleId: null
                    }
                };
            }
            const entryCfg = config.welcome[currentGuildId];
            if (!entryCfg.mentions || typeof entryCfg.mentions !== 'object') {
                entryCfg.mentions = {};
            }
            if (!entryCfg.roles || typeof entryCfg.roles !== 'object') {
                entryCfg.roles = {
                    unverifiedRoleId: null,
                    verifiedRoleId: null,
                    crossVerifiedRoleId: null,
                    moderatorRoleId: null
                };
            }
            entryCfg.preImageText = sanitizeWelcomeMessage(entryCfg.preImageText ?? '');
            if (entryCfg.preImageText === LEGACY_DEFAULT_WELCOME_MESSAGE) {
                entryCfg.preImageText = DEFAULT_WELCOME_MESSAGE;
            }
            if (typeof entryCfg.isCustomized !== 'boolean') {
                entryCfg.isCustomized = entryCfg.preImageText !== DEFAULT_WELCOME_MESSAGE;
            }
            if (!entryCfg.headerLine1) entryCfg.headerLine1 = 'Welcome';
            if (!entryCfg.headerLine2Template) entryCfg.headerLine2Template = '{username}';
            return entryCfg;
        };

        const storePanelState = (message, mode, context, guildOverride = currentGuildId) => {
            panelStore.set(key, {
                message,
                guildId: guildOverride,
                mode,
                context: context ?? {},
                availableGuildIds
            });
        };

        if (interaction.isButton()) {
            const [, , action] = interaction.customId.split(':');

            if (action === 'backToGuilds') {
                const view = await buildView({
                    config,
                    client,
                    guild: null,
                    mode: 'chooseGuild',
                    context: { availableGuildIds }
                });
                const message = await interaction.update(view);
                storePanelState(message, 'chooseGuild', {});
                return;
            }

            if (action === 'configureChannels') {
                if (!currentGuildId || !targetGuild) {
                    await interaction.reply({ content: 'Select a server to configure first.', ephemeral: true });
                    return;
                }
                const view = await buildView({
                    config,
                    client,
                    guild: targetGuild,
                    mode: 'channels',
                    context: { availableGuildIds }
                });
                const message = await interaction.update(view);
                storePanelState(message, 'channels', {});
                return;
            }

            if (action === 'backToRoles') {
                if (!currentGuildId || !targetGuild) {
                    await interaction.reply({ content: 'Select a server to configure first.', ephemeral: true });
                    return;
                }
                const view = await buildView({
                    config,
                    client,
                    guild: targetGuild,
                    mode: 'roles',
                    context: { availableGuildIds }
                });
                const message = await interaction.update(view);
                storePanelState(message, 'roles', {});
                return;
            }

            if (action === 'editMessage') {
                if (!currentGuildId) {
                    await interaction.reply({ content: 'Select a server to configure first.', ephemeral: true });
                    return;
                }
                const entryCfg = ensureWelcomeEntry();
                if (!entryCfg) {
                    await interaction.reply({ content: 'Select a server to configure first.', ephemeral: true });
                    return;
                }
                const modal = new ModalBuilder()
                .setCustomId('setup:welcome:messageModal')
                .setTitle('Edit welcome message')
                .addComponents(
                    new ActionRowBuilder().addComponents(
                        new TextInputBuilder()
                        .setCustomId('setup:welcome:messageInput')
                        .setLabel('Message template')
                        .setStyle(TextInputStyle.Paragraph)
                        .setRequired(false)
                        .setPlaceholder('Use {{user}}, {{guild}}, {{rules}}, etc.')
                        .setMaxLength(2000)
                        .setValue(entryCfg.preImageText ?? DEFAULT_WELCOME_MESSAGE)
                    )
                );
                storePanelState(entry?.message ?? null, entry?.mode ?? 'roles', entry?.context ?? {}, entry?.guildId ?? currentGuildId);
                await interaction.showModal(modal);
                return;
            }

            if (action === 'toggleEnabled') {
                if (!currentGuildId || !targetGuild) {
                    await interaction.reply({ content: 'Select a server to configure first.', ephemeral: true });
                    return;
                }
                const entryCfg = ensureWelcomeEntry();
                if (!entryCfg) {
                    await interaction.reply({ content: 'Select a server to configure first.', ephemeral: true });
                    return;
                }
                entryCfg.enabled = entryCfg.enabled === false;
                saveConfig(config, logger);
                const view = await buildView({
                    config,
                    client,
                    guild: targetGuild,
                    mode: 'roles',
                    context: { availableGuildIds }
                });
                const message = await interaction.update(view);
                storePanelState(message, 'roles', {});
                await interaction.followUp({ content: `Welcome cards are now ${entryCfg.enabled ? 'enabled' : 'disabled'}.`, ephemeral: true }).catch(() => {});
                return;
            }

            return;
        }

        if (interaction.isModalSubmit()) {
            if (interaction.customId === 'setup:welcome:messageModal') {
                const entryCfg = ensureWelcomeEntry();
                if (!entryCfg) {
                    await interaction.reply({ content: 'Select a server to configure first.', ephemeral: true });
                    return;
                }
                const raw = interaction.fields.getTextInputValue('setup:welcome:messageInput') ?? '';
                if (!raw.trim()) {
                    entryCfg.preImageText = DEFAULT_WELCOME_MESSAGE;
                    entryCfg.isCustomized = false;
                } else {
                    const sanitized = sanitizeWelcomeMessage(raw);
                    entryCfg.preImageText = sanitized;
                    entryCfg.isCustomized = sanitized !== DEFAULT_WELCOME_MESSAGE;
                }
                saveConfig(config, logger);
                await interaction.reply({ content: 'Welcome message updated.', ephemeral: true });
                const entryState = panelStore.get(key);
                if (entryState?.message) {
                    try {
                        const guildId = entryState.guildId ?? null;
                        const guildForView = guildId ? await fetchGuild(client, guildId) : null;
                        const view = await buildView({
                            config,
                            client,
                            guild: guildForView,
                            mode: entryState.mode ?? (guildForView ? 'roles' : 'chooseGuild'),
                            context: { availableGuildIds: entryState.availableGuildIds ?? availableGuildIds }
                        });
                        const message = await entryState.message.edit(view);
                        storePanelState(message, entryState.mode ?? (guildForView ? 'roles' : 'chooseGuild'), entryState.context ?? {}, guildId);
                    } catch {}
                }
            }
            return;
        }

        if (interaction.isAnySelectMenu()) {
            const parts = interaction.customId.split(':');
            const action = parts[2];

            if (action === 'selectGuild') {
                const choice = interaction.values?.[0] ?? null;
                const nextGuildId = choice && choice !== 'noop' ? choice : null;
                const guild = nextGuildId ? await fetchGuild(client, nextGuildId).catch(() => null) : null;
                const mode = nextGuildId ? 'roles' : 'chooseGuild';
                const view = await buildView({
                    config,
                    client,
                    guild,
                    mode,
                    context: { availableGuildIds }
                });
                const message = await interaction.update(view);
                panelStore.set(key, {
                    message,
                    guildId: nextGuildId,
                    mode,
                    context: {},
                    availableGuildIds
                });
                return;
            }

            if (action === 'roleChoice') {
                if (!currentGuildId || !targetGuild) {
                    await interaction.reply({ content: 'Select a server to configure first.', ephemeral: true });
                    return;
                }
                const target = parts[3];
                if (!['unverifiedRoleId', 'verifiedRoleId', 'crossVerifiedRoleId', 'moderatorRoleId'].includes(target)) {
                    await interaction.reply({ content: 'Unsupported role selector.', ephemeral: true });
                    return;
                }
                const entryCfg = ensureWelcomeEntry();
                if (!entryCfg) {
                    await interaction.reply({ content: 'Select a server to configure first.', ephemeral: true });
                    return;
                }
                const choice = Array.isArray(interaction.values) && interaction.values.length
                    ? interaction.values[0]
                    : null;
                const nextRoleId = choice && choice !== '__clear__' && choice !== 'noop' ? choice : null;
                entryCfg.roles[target] = nextRoleId;
                saveConfig(config, logger);
                const view = await buildView({
                    config,
                    client,
                    guild: targetGuild,
                    mode: 'roles',
                    context: { availableGuildIds }
                });
                const message = await interaction.update(view);
                storePanelState(message, 'roles', {});
                const text = nextRoleId ? 'Role updated.' : 'Role cleared.';
                await interaction.followUp({ content: text, ephemeral: true }).catch(() => {});
                return;
            }

            if (action === 'channelChoice') {
                if (!currentGuildId || !targetGuild) {
                    await interaction.reply({ content: 'Select a server to configure first.', ephemeral: true });
                    return;
                }
                const target = parts[3];
                if (!['welcome', 'rules', 'roles', 'verify'].includes(target)) {
                    await interaction.reply({ content: 'Unsupported channel selector.', ephemeral: true });
                    return;
                }
                const entryCfg = ensureWelcomeEntry();
                if (!entryCfg) {
                    await interaction.reply({ content: 'Select a server to configure first.', ephemeral: true });
                    return;
                }
                const choice = interaction.values?.[0] ?? null;
                const nextChannelId = choice && choice !== '__clear__' && choice !== 'noop' ? choice : null;
                if (target === 'welcome') {
                    entryCfg.channelId = nextChannelId;
                } else {
                    entryCfg.mentions[target] = nextChannelId;
                }
                saveConfig(config, logger);
                const view = await buildView({
                    config,
                    client,
                    guild: targetGuild,
                    mode: 'channels',
                    context: { availableGuildIds }
                });
                const message = await interaction.update(view);
                storePanelState(message, 'channels', {});
                await interaction.followUp({ content: 'Channel selection updated.', ephemeral: true }).catch(() => {});
                return;
            }
        }
    }

    async function buildView({ config, client, guild, mode, context }) {
        const availableGuildIds = context?.availableGuildIds ?? config.mainServerIds.filter(id => id !== config.loggingServerId);
        const selectedGuild = guild ?? null;
        const selectedGuildId = selectedGuild?.id ?? null;
        const sourceEntry = selectedGuildId ? config.welcome?.[selectedGuildId] : null;

        const welcomeEntry = {
            channelId: sourceEntry?.channelId ?? null,
            mentions: sourceEntry?.mentions && typeof sourceEntry.mentions === 'object' ? { ...sourceEntry.mentions } : {},
            preImageText: sanitizeWelcomeMessage(sourceEntry?.preImageText ?? sourceEntry?.message ?? DEFAULT_WELCOME_MESSAGE),
            isCustomized: typeof sourceEntry?.isCustomized === 'boolean'
                ? sourceEntry.isCustomized
                : sanitizeWelcomeMessage(sourceEntry?.preImageText ?? sourceEntry?.message ?? DEFAULT_WELCOME_MESSAGE) !== DEFAULT_WELCOME_MESSAGE,
            enabled: sourceEntry?.enabled === false ? false : true,
            roles: {
                unverifiedRoleId: sourceEntry?.roles?.unverifiedRoleId ?? null,
                verifiedRoleId: sourceEntry?.roles?.verifiedRoleId ?? null,
                crossVerifiedRoleId: sourceEntry?.roles?.crossVerifiedRoleId ?? null,
                moderatorRoleId: sourceEntry?.roles?.moderatorRoleId ?? null
            }
        };

        if (welcomeEntry.preImageText === LEGACY_DEFAULT_WELCOME_MESSAGE) {
            welcomeEntry.preImageText = DEFAULT_WELCOME_MESSAGE;
            welcomeEntry.isCustomized = false;
        }

        const mentionMap = welcomeEntry.mentions || {};
        const messageFieldValue = selectedGuild
            ? formatWelcomeMessageField(welcomeEntry.preImageText, welcomeEntry.isCustomized)
            : 'Select a server to begin.';
        const placeholderFieldValue = formatPlaceholderField();

        const helpLines = [];
        if (!selectedGuild || mode === 'chooseGuild') {
            helpLines.push('• Pick a main server below to configure welcome cards for that community.');
        } else if (mode === 'channels') {
            helpLines.push('• Use each dropdown to choose which channel ID should receive the welcome content.');
            helpLines.push('• Select **Clear channel** to remove an assignment.');
            helpLines.push('• Use **Back to role settings** to adjust role assignments.');
        } else {
            helpLines.push('• Update the role ID dropdowns to map each automation hook to a Discord role.');
            helpLines.push('• Choose **Clear selection** to remove an assignment.');
            helpLines.push('• Use **Configure channels** to adjust welcome, rules, roles, and verify targets.');
        }
        helpLines.push('• The welcome card image always renders **Welcome** and the member\'s username on the image itself.');
        helpLines.push('• Moderator pings (if configured) and the sentence `User is cross-verified.` appear in the plaintext before the image.');
        const helpFieldValue = helpLines.join('\n');

        const embed = new EmbedBuilder()
        .setTitle('Welcome card setup')
        .setDescription(selectedGuild
            ? `Updating settings for **${selectedGuild.name}**. Use the controls below to adjust welcome automation.`
            : 'Select a server to configure welcome messaging, autoroles, and verification handling.')
        .addFields(
            { name: 'Module status', value: welcomeEntry.enabled ? '✅ Enabled' : '🚫 Disabled', inline: true },
            { name: 'Welcome channel', value: formatChannel(selectedGuild, welcomeEntry.channelId), inline: true },
            { name: 'Rules mention', value: mentionToDisplay(selectedGuild, mentionMap.rules), inline: true },
            { name: 'Roles mention', value: mentionToDisplay(selectedGuild, mentionMap.roles), inline: true },
            { name: 'Verify mention', value: mentionToDisplay(selectedGuild, mentionMap.verify), inline: true },
            { name: 'Autorole (unverified)', value: formatRole(selectedGuild, welcomeEntry.roles.unverifiedRoleId), inline: true },
            { name: 'Verified role (reference)', value: formatRole(selectedGuild, welcomeEntry.roles.verifiedRoleId), inline: true },
            { name: 'Cross-verified role', value: formatRole(selectedGuild, welcomeEntry.roles.crossVerifiedRoleId), inline: true },
            { name: 'Moderator ping role', value: formatRole(selectedGuild, welcomeEntry.roles.moderatorRoleId), inline: true },
            { name: 'Message template', value: messageFieldValue, inline: false },
            { name: 'Template variables', value: placeholderFieldValue, inline: false },
            { name: 'Help', value: helpFieldValue, inline: false }
        );

        const components = [];

        const guildSelect = new StringSelectMenuBuilder()
        .setCustomId('setup:welcome:selectGuild')
        .setPlaceholder(availableGuildIds.length ? 'Select a main server…' : 'Add main servers on the overview page')
        .setMinValues(1)
        .setMaxValues(1)
        .setDisabled(!availableGuildIds.length);

        const options = [];
        for (const id of availableGuildIds.slice(0, 24)) {
            const g = client.guilds.cache.get(id) ?? await fetchGuild(client, id).catch(() => null);
            options.push({
                label: truncateName(g?.name ?? id, 100),
                description: `ID: ${id}`.slice(0, 100),
                value: id,
                default: id === selectedGuildId
            });
        }
        if (selectedGuildId && !options.find(opt => opt.value === selectedGuildId)) {
            const g = client.guilds.cache.get(selectedGuildId) ?? await fetchGuild(client, selectedGuildId).catch(() => null);
            options.unshift({
                label: truncateName(g?.name ?? selectedGuildId, 100),
                description: `ID: ${selectedGuildId}`.slice(0, 100),
                value: selectedGuildId,
                default: true
            });
        }
        if (options.length) {
            guildSelect.addOptions(options);
        } else {
            guildSelect.addOptions({ label: 'No main servers configured', value: 'noop', default: true });
        }

        components.push(new ActionRowBuilder().addComponents(guildSelect));

        if (!selectedGuild) {
            appendHomeButtonRow(components);
            return { embeds: [embed], components };
        }

        if (mode === 'channels') {
            const buttons = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                .setCustomId('setup:welcome:backToRoles')
                .setLabel('Back to role settings')
                .setStyle(ButtonStyle.Secondary),
                new ButtonBuilder()
                .setCustomId('setup:welcome:editMessage')
                .setLabel('Edit welcome message')
                .setStyle(ButtonStyle.Primary)
            );
            components.push(buttons);

            const channels = await collectTextChannels(selectedGuild);
            components.push(new ActionRowBuilder().addComponents(buildChannelSelect({
                customId: 'setup:welcome:channelChoice:welcome',
                placeholder: 'Welcome message channel',
                channels,
                currentId: welcomeEntry.channelId
            })));
            components.push(new ActionRowBuilder().addComponents(buildChannelSelect({
                customId: 'setup:welcome:channelChoice:rules',
                placeholder: 'Rules mention channel',
                channels,
                currentId: mentionMap.rules ?? null
            })));
            components.push(new ActionRowBuilder().addComponents(buildChannelSelect({
                customId: 'setup:welcome:channelChoice:roles',
                placeholder: 'Roles mention channel',
                channels,
                currentId: mentionMap.roles ?? null
            })));
            components.push(new ActionRowBuilder().addComponents(buildChannelSelect({
                customId: 'setup:welcome:channelChoice:verify',
                placeholder: 'Verify mention channel',
                channels,
                currentId: mentionMap.verify ?? null
            })));
            appendHomeButtonRow(components);
            return { embeds: [embed], components };
        }

        const toggleRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
            .setCustomId('setup:welcome:toggleEnabled')
            .setLabel(welcomeEntry.enabled ? 'Disable module' : 'Enable module')
            .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
            .setCustomId('setup:welcome:configureChannels')
            .setLabel('Configure channels')
            .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
            .setCustomId('setup:welcome:editMessage')
            .setLabel('Edit welcome message')
            .setStyle(ButtonStyle.Secondary)
        );
        components.push(toggleRow);

        const roles = await collectRoleOptions(selectedGuild);
        components.push(new ActionRowBuilder().addComponents(buildRoleSelect({
            customId: 'setup:welcome:roleChoice:unverifiedRoleId',
            placeholder: 'Autorole (unverified)',
            roles,
            currentId: welcomeEntry.roles.unverifiedRoleId
        })));
        components.push(new ActionRowBuilder().addComponents(buildRoleSelect({
            customId: 'setup:welcome:roleChoice:verifiedRoleId',
            placeholder: 'Verified role (reference)',
            roles,
            currentId: welcomeEntry.roles.verifiedRoleId
        })));
        components.push(new ActionRowBuilder().addComponents(buildRoleSelect({
            customId: 'setup:welcome:roleChoice:crossVerifiedRoleId',
            placeholder: 'Cross-verified role',
            roles,
            currentId: welcomeEntry.roles.crossVerifiedRoleId
        })));
        components.push(new ActionRowBuilder().addComponents(buildRoleSelect({
            customId: 'setup:welcome:roleChoice:moderatorRoleId',
            placeholder: 'Moderator ping role',
            roles,
            currentId: welcomeEntry.roles.moderatorRoleId
        })));

        appendHomeButtonRow(components);
        return { embeds: [embed], components };
    }

    return {
        prepareConfig,
        handleInteraction,
        buildView
    };
}

function mentionToDisplay(guild, channelId) {
    if (!channelId) return 'Not configured';
    return formatChannel(guild, channelId);
}

function formatWelcomeMessageField(template, isCustomized) {
    const sanitized = sanitizeWelcomeMessage(template ?? '');
    const previewSource = sanitized.replace(/\s+$/u, '');
    if (!previewSource) {
        return 'Using default message.';
    }
    const lines = previewSource.split('\n');
    let preview = lines.slice(0, 4).join('\n');
    if (preview.length > 180) {
        preview = `${preview.slice(0, 177)}…`;
    }
    const block = `\`\`\`\n${preview || ' '}\n\`\`\``;
    const customized = typeof isCustomized === 'boolean'
        ? isCustomized
        : sanitized !== DEFAULT_WELCOME_MESSAGE;
    return customized
        ? `${block}\nCustom message active.`
        : `${block}\nUsing default message.`;
}

function formatPlaceholderField() {
    return WELCOME_TEMPLATE_PLACEHOLDERS
    .map(entry => `${entry.token} — ${entry.description}`)
    .join('\n');
}

function buildChannelSelect({ customId, placeholder, channels, currentId }) {
    const menu = new StringSelectMenuBuilder()
    .setCustomId(customId)
    .setPlaceholder(placeholder)
    .setMinValues(1)
    .setMaxValues(1);

    const options = [];
    options.push({
        label: 'Clear channel',
        value: '__clear__',
        description: 'Remove the configured channel.',
        default: !currentId
    });

    for (const ch of channels.slice(0, 24)) {
        options.push({
            label: `ID: ${ch.id}`.slice(0, 100),
            description: `#${truncateName(ch.name, 95)}`.slice(0, 100),
            value: ch.id,
            default: ch.id === currentId
        });
    }

    if (!channels.length) {
        options.push({ label: 'No available channels', value: 'noop', default: true });
    }

    menu.addOptions(options.slice(0, 25));
    return menu;
}

async function collectRoleOptions(guild) {
    if (!guild) return [];
    try {
        await guild.roles.fetch();
    } catch {}
    const roles = Array.from(guild.roles?.cache?.values?.() ?? [])
    .filter(role => role && !role.managed && role.id !== guild.id)
    .sort((a, b) => b.position - a.position);
    return roles;
}

function buildRoleSelect({ customId, placeholder, roles, currentId }) {
    const menu = new StringSelectMenuBuilder()
    .setCustomId(customId)
    .setPlaceholder(placeholder)
    .setMinValues(1)
    .setMaxValues(1);

    const options = [];
    options.push({
        label: 'Clear selection',
        value: '__clear__',
        description: 'Remove the configured role.',
        default: !currentId
    });

    for (const role of roles) {
        if (options.length >= 25) break;
        options.push({
            label: `ID: ${role.id}`.slice(0, 100),
            description: truncateName(role.name, 100),
            value: role.id,
            default: role.id === currentId
        });
    }

    if (!roles.length) {
        options.push({ label: 'No roles available', value: 'noop', default: true });
    }

    menu.addOptions(options.slice(0, 25));
    return menu;
}

function normalizeWelcomeMap({ value, fallbackGuilds, loggingServerId }) {
    const out = {};
    if (!value || typeof value !== 'object') {
        return out;
    }

    const entries = Object.entries(value);
    const looksLegacy = 'channelId' in value || 'mentions' in value;
    const looksMap = entries.every(([, v]) => typeof v === 'object' && !Array.isArray(v));

    if (looksLegacy) {
        const targetGuildId = fallbackGuilds?.find(id => id) || loggingServerId || null;
        if (targetGuildId) {
            out[targetGuildId] = normalizeWelcomeEntry(value);
        }
        return out;
    }

    if (!looksMap) {
        return out;
    }

    for (const [guildId, entry] of entries) {
        if (!guildId) continue;
        out[String(guildId)] = normalizeWelcomeEntry(entry);
    }
    return out;
}

function normalizeWelcomeEntry(entry) {
    const obj = entry && typeof entry === 'object' ? entry : {};
    const channelId = obj.channelId ? String(obj.channelId) : null;
    const mentions = {};
    const rawMentions = obj.mentions && typeof obj.mentions === 'object' ? obj.mentions : {};
    for (const key of ['rules', 'roles', 'verify']) {
        if (rawMentions[key]) {
            mentions[key] = String(rawMentions[key]);
        }
    }

    const rolesSource = obj.roles && typeof obj.roles === 'object' ? obj.roles : obj;
    const roles = {
        unverifiedRoleId: rolesSource.unverifiedRoleId ? String(rolesSource.unverifiedRoleId) : null,
        verifiedRoleId: rolesSource.verifiedRoleId ? String(rolesSource.verifiedRoleId) : null,
        crossVerifiedRoleId: rolesSource.crossVerifiedRoleId ? String(rolesSource.crossVerifiedRoleId) : null,
        moderatorRoleId: rolesSource.moderatorRoleId ? String(rolesSource.moderatorRoleId) : null
    };

    const rawPreImage = typeof obj.preImageText === 'string'
        ? obj.preImageText
        : (typeof obj.message === 'string' ? obj.message : null);

    let preImageText = sanitizeWelcomeMessage(rawPreImage ?? '');
    let isCustomized;

    if (typeof obj.isCustomized === 'boolean') {
        isCustomized = obj.isCustomized;
    } else if (!rawPreImage || !rawPreImage.trim()) {
        preImageText = DEFAULT_WELCOME_MESSAGE;
        isCustomized = false;
    } else {
        const normalizedRaw = rawPreImage.replace(/\r\n/g, '\n');
        if (normalizedRaw === LEGACY_DEFAULT_WELCOME_MESSAGE) {
            preImageText = DEFAULT_WELCOME_MESSAGE;
            isCustomized = false;
        } else if (preImageText === LEGACY_DEFAULT_WELCOME_MESSAGE) {
            preImageText = DEFAULT_WELCOME_MESSAGE;
            isCustomized = false;
        } else if (preImageText === DEFAULT_WELCOME_MESSAGE) {
            isCustomized = false;
        } else {
            isCustomized = true;
        }
    }

    if (preImageText === LEGACY_DEFAULT_WELCOME_MESSAGE) {
        preImageText = DEFAULT_WELCOME_MESSAGE;
    }

    const enabled = obj.enabled === false ? false : true;

    return {
        channelId,
        mentions,
        preImageText,
        isCustomized: Boolean(isCustomized),
        enabled,
        headerLine1: 'Welcome',
        headerLine2Template: '{username}',
        roles
    };
}
