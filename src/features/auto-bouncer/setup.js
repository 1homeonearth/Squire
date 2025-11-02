// src/features/auto-bouncer/setup.js
// Setup panel integration for the auto-bouncer module.
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

export function createAutobouncerSetup({ panelStore, saveConfig, fetchGuild }) {
    function prepareConfig(config) {
        if (!config.autoban || typeof config.autoban !== 'object') {
            config.autoban = {};
        }
        if (!Array.isArray(config.autoban.blockedUsernames)) {
            const value = config.autoban.blockedUsernames;
            config.autoban.blockedUsernames = Array.isArray(value) ? value.map(s => String(s).toLowerCase()) : [];
        } else {
            config.autoban.blockedUsernames = config.autoban.blockedUsernames.map(s => String(s).toLowerCase());
        }
        if (!Array.isArray(config.autoban.notifyWebhookUrls)) {
            const value = config.autoban.notifyWebhookUrls;
            config.autoban.notifyWebhookUrls = Array.isArray(value) ? value.map(String) : [];
        } else {
            config.autoban.notifyWebhookUrls = config.autoban.notifyWebhookUrls.map(String);
        }
        if (!config.autoban.testRoleMap || typeof config.autoban.testRoleMap !== 'object') {
            config.autoban.testRoleMap = {};
        } else {
            const cleaned = {};
            for (const [guildId, roleId] of Object.entries(config.autoban.testRoleMap)) {
                const gid = typeof guildId === 'string' ? guildId.trim() : String(guildId ?? '').trim();
                const rid = typeof roleId === 'string' ? roleId.trim() : String(roleId ?? '').trim();
                if (!gid || !rid) continue;
                cleaned[gid] = rid;
            }
            config.autoban.testRoleMap = cleaned;
        }
        config.autoban.notifyChannelId = config.autoban.notifyChannelId ? String(config.autoban.notifyChannelId) : null;
        config.autoban.scanBio = config.autoban.scanBio === false ? false : true;
    }

    async function handleInteraction({ interaction, entry, config, key, logger, client }) {
        if (interaction.isButton()) {
            switch (interaction.customId) {
                case 'setup:autobouncer:toggle': {
                    config.autoban.enabled = config.autoban.enabled === false;
                    saveConfig(config, logger);
                    const view = await buildView({ config, client, mode: 'default', context: {} });
                    const message = await interaction.update(view);
                    panelStore.set(key, { message, guildId: entry?.guildId ?? null, mode: 'default', context: {} });
                    await interaction.followUp({ content: `Autobouncer is now ${config.autoban.enabled === false ? 'disabled' : 'enabled'}.`, ephemeral: true }).catch(() => {});
                    return;
                }
                case 'setup:autobouncer:toggleBio': {
                    config.autoban.scanBio = config.autoban.scanBio === false ? true : false;
                    saveConfig(config, logger);
                    const view = await buildView({ config, client, mode: 'default', context: {} });
                    const message = await interaction.update(view);
                    panelStore.set(key, { message, guildId: entry?.guildId ?? null, mode: 'default', context: {} });
                    await interaction.followUp({ content: `Autobouncer bio scanning is now ${config.autoban.scanBio === false ? 'disabled' : 'enabled'}.`, ephemeral: true }).catch(() => {});
                    return;
                }
                case 'setup:autobouncer:editKeywords': {
                    const keywords = Array.isArray(config.autoban.blockedUsernames) ? config.autoban.blockedUsernames.join('\n') : '';
                    const modal = new ModalBuilder()
                    .setCustomId('setup:autobouncer:keywordsModal')
                    .setTitle('Edit blocked keywords')
                    .addComponents(
                        new ActionRowBuilder().addComponents(
                            new TextInputBuilder()
                            .setCustomId('setup:autobouncer:keywordsInput')
                            .setLabel('Keywords (one per line)')
                            .setStyle(TextInputStyle.Paragraph)
                            .setRequired(false)
                            .setValue(keywords)
                        )
                    );
                    await interaction.showModal(modal);
                    return;
                }
                case 'setup:autobouncer:refresh': {
                    const currentMode = entry?.mode ?? 'default';
                    const currentContext = entry?.context ?? {};
                    const view = await buildView({ config, client, mode: currentMode, context: currentContext });
                    const message = await interaction.update(view);
                    panelStore.set(key, { message, guildId: entry?.guildId ?? null, mode: currentMode, context: currentContext });
                    return;
                }
                case 'setup:autobouncer:backToOverview': {
                    const view = await buildView({ config, client, mode: 'default', context: {} });
                    const message = await interaction.update(view);
                    panelStore.set(key, { message, guildId: entry?.guildId ?? null, mode: 'default', context: {} });
                    return;
                }
                default: {
                    if (interaction.customId.startsWith('setup:autobouncer:refreshGuild:')) {
                        const guildId = interaction.customId.split(':')[3] ?? null;
                        if (!guildId || guildId === 'unknown') {
                            await interaction.reply({ content: 'The selected server could not be reloaded. Return to the overview and pick it again.', ephemeral: true }).catch(() => {});
                            return;
                        }
                        const view = await buildView({ config, client, mode: 'test-role', context: { guildId } });
                        const message = await interaction.update(view);
                        panelStore.set(key, { message, guildId: entry?.guildId ?? null, mode: 'test-role', context: { guildId } });
                        await interaction.followUp({ content: 'Reloaded the server roles.', ephemeral: true }).catch(() => {});
                        return;
                    }
                    if (interaction.customId.startsWith('setup:autobouncer:clearTestRole:')) {
                        const guildId = interaction.customId.split(':')[3] ?? null;
                        if (!guildId || guildId === 'unknown') {
                            await interaction.reply({ content: 'That server selection expired. Return to the overview and choose it again.', ephemeral: true }).catch(() => {});
                            return;
                        }
                        if (!config.autoban.testRoleMap || typeof config.autoban.testRoleMap !== 'object') {
                            config.autoban.testRoleMap = {};
                        }
                        delete config.autoban.testRoleMap[guildId];
                        saveConfig(config, logger);
                        const view = await buildView({ config, client, mode: 'test-role', context: { guildId } });
                        const message = await interaction.update(view);
                        panelStore.set(key, { message, guildId: entry?.guildId ?? null, mode: 'test-role', context: { guildId } });
                        const guild = await fetchGuild(client, guildId).catch(() => null);
                        const guildName = guild?.name ?? guildId;
                        await interaction.followUp({ content: `Cleared the test role override for **${guildName}**.`, ephemeral: true }).catch(() => {});
                        return;
                    }
                    return;
                }
            }
        }

        if (interaction.isModalSubmit()) {
            if (interaction.customId === 'setup:autobouncer:keywordsModal') {
                const raw = interaction.fields.getTextInputValue('setup:autobouncer:keywordsInput') ?? '';
                const keywords = raw.split(/\r?\n|,/).map(s => s.trim()).filter(Boolean);
                config.autoban.blockedUsernames = Array.from(new Set(keywords.map(s => s.toLowerCase())));
                saveConfig(config, logger);
                await interaction.reply({ content: `Saved ${config.autoban.blockedUsernames.length} keyword(s).`, ephemeral: true });
                const entryState = panelStore.get(key);
                if (entryState?.message) {
                    try {
                        const view = await buildView({
                            config,
                            client,
                            mode: entryState.mode ?? 'default',
                            context: entryState.context ?? {}
                        });
                        const message = await entryState.message.edit(view);
                        panelStore.set(key, {
                            message,
                            guildId: entryState.guildId ?? null,
                            mode: entryState.mode ?? 'default',
                            context: entryState.context ?? {}
                        });
                    } catch {}
                }
            }
        }

        if (interaction.isStringSelectMenu()) {
            const parts = interaction.customId.split(':');
            if (parts[2] === 'setChannel') {
                const choice = interaction.values?.[0] ?? null;
                if (choice === '__clear__') {
                    config.autoban.notifyChannelId = null;
                } else if (choice && choice !== 'noop') {
                    config.autoban.notifyChannelId = choice;
                }
                saveConfig(config, logger);
                const view = await buildView({ config, client, mode: 'default', context: {} });
                const message = await interaction.update(view);
                panelStore.set(key, { message, guildId: entry?.guildId ?? null, mode: 'default', context: {} });
                await interaction.followUp({ content: choice === '__clear__' ? 'Autobouncer notifications disabled.' : 'Autobouncer notifications channel updated.', ephemeral: true }).catch(() => {});
            } else if (parts[2] === 'pickTestRoleGuild') {
                const guildId = interaction.values?.[0] ?? null;
                if (!guildId || guildId === 'noop') {
                    await interaction.reply({ content: 'Select a server to update the test role override.', ephemeral: true }).catch(() => {});
                    return;
                }
                const view = await buildView({ config, client, mode: 'test-role', context: { guildId } });
                const message = await interaction.update(view);
                panelStore.set(key, { message, guildId: entry?.guildId ?? null, mode: 'test-role', context: { guildId } });
                return;
            } else if (parts[2] === 'chooseTestRole') {
                const guildId = parts[3] ?? null;
                const choice = interaction.values?.[0] ?? null;
                if (!guildId || guildId === 'unknown') {
                    await interaction.reply({ content: 'That selection expired. Return to the overview and choose the server again.', ephemeral: true }).catch(() => {});
                    return;
                }
                if (!config.autoban.testRoleMap || typeof config.autoban.testRoleMap !== 'object') {
                    config.autoban.testRoleMap = {};
                }
                const guild = await fetchGuild(client, guildId).catch(() => null);
                const guildName = guild?.name ?? guildId;
                let content;
                if (!choice || choice === 'noop') {
                    await interaction.reply({ content: 'Pick a role or choose **Clear test role override**.', ephemeral: true }).catch(() => {});
                    return;
                }
                if (choice === '__clear__') {
                    delete config.autoban.testRoleMap[guildId];
                    content = `Cleared the test role override for **${guildName}**.`;
                } else {
                    config.autoban.testRoleMap[guildId] = choice;
                    content = `Set the test role override for **${guildName}** to <@&${choice}>.`;
                }
                saveConfig(config, logger);
                const view = await buildView({ config, client, mode: 'test-role', context: { guildId } });
                const message = await interaction.update(view);
                panelStore.set(key, { message, guildId: entry?.guildId ?? null, mode: 'test-role', context: { guildId } });
                await interaction.followUp({ content, ephemeral: true }).catch(() => {});
                return;
            }
        }
    }

    async function buildView({ config, client, mode = 'default', context = {} }) {
        const autobanCfg = config.autoban || {};
        const keywords = Array.isArray(autobanCfg.blockedUsernames) ? autobanCfg.blockedUsernames : [];
        const testRoleMap = autobanCfg.testRoleMap && typeof autobanCfg.testRoleMap === 'object' ? autobanCfg.testRoleMap : {};

        if (mode === 'test-role') {
            const guildId = context?.guildId ?? null;
            const guild = guildId ? await fetchGuild(client, guildId).catch(() => null) : null;
            const roles = guild ? await collectGuildRoles(guild) : [];
            const currentRoleId = guildId && typeof testRoleMap[guildId] === 'string' ? testRoleMap[guildId] : null;

            const embed = new EmbedBuilder()
            .setTitle('Autobouncer test role override')
            .setDescription('Pick which role the autobouncer should treat as “already passed” when running its simulated sweeps for this server.')
            .addFields(
                {
                    name: 'Server',
                    value: guild
                        ? `**${truncateName(guild.name, 70)}**\n\`${guild.id}\``
                        : guildId
                            ? `Server unavailable\n\`${guildId}\``
                            : 'Server selection expired.',
                    inline: false
                },
                {
                    name: 'Current override',
                    value: currentRoleId ? formatRole(guild, currentRoleId) : 'No test role override configured.',
                    inline: false
                }
            );

            const components = [];
            const navRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                .setCustomId('setup:autobouncer:backToOverview')
                .setLabel('⬅ Back to autobouncer')
                .setStyle(ButtonStyle.Secondary)
            );

            if (guildId) {
                navRow.addComponents(
                    new ButtonBuilder()
                    .setCustomId(`setup:autobouncer:refreshGuild:${guildId}`)
                    .setLabel('Refresh roles')
                    .setStyle(ButtonStyle.Secondary)
                    .setDisabled(!guild)
                );
                if (currentRoleId) {
                    navRow.addComponents(
                        new ButtonBuilder()
                        .setCustomId(`setup:autobouncer:clearTestRole:${guildId}`)
                        .setLabel('Clear test role')
                        .setStyle(ButtonStyle.Secondary)
                    );
                }
            }

            components.push(navRow);

            const roleMenu = new StringSelectMenuBuilder()
            .setCustomId(`setup:autobouncer:chooseTestRole:${guildId ?? 'unknown'}`)
            .setPlaceholder(guild ? 'Select a role or clear the override…' : 'Server unavailable')
            .setMinValues(1)
            .setMaxValues(1)
            .setDisabled(!guildId);

            const roleOptions = [
                {
                    label: currentRoleId ? 'Clear test role override' : 'Leave override empty',
                    value: '__clear__',
                    description: 'Fall back to the autorole and welcome defaults.',
                    default: !currentRoleId
                }
            ];

            if (roles.length) {
                for (const role of roles) {
                    if (roleOptions.length >= 25) break;
                    roleOptions.push({
                        label: `ID: ${role.id}`.slice(0, 100),
                        description: truncateName(role.name, 100),
                        value: role.id,
                        default: role.id === currentRoleId
                    });
                }
            } else if (guild) {
                roleOptions.push({
                    label: 'No additional roles available',
                    value: 'noop',
                    description: 'Roles may be managed or hidden from me.',
                    default: false
                });
            } else {
                roleOptions.push({
                    label: 'Unable to load roles',
                    value: 'noop',
                    description: 'Re-open this server after re-inviting Squire.',
                    default: false
                });
            }

            roleMenu.addOptions(roleOptions.slice(0, 25));
            components.push(new ActionRowBuilder().addComponents(roleMenu));
            appendHomeButtonRow(components);
            return { embeds: [embed], components };
        }

        const loggingGuildId = config.loggingServerId ?? null;
        const loggingGuild = loggingGuildId ? await fetchGuild(client, loggingGuildId) : null;
        const channels = loggingGuild ? await collectTextChannels(loggingGuild) : [];
        const notifyChannelId = autobanCfg.notifyChannelId ?? null;

        const embed = new EmbedBuilder()
        .setTitle('Autobouncer setup')
        .setDescription('Manage the keyword list used to automatically remove suspicious accounts and stale-role sweeps.')
        .addFields(
            { name: 'Status', value: autobanCfg.enabled === false ? '🚫 Disabled' : '✅ Enabled', inline: true },
            { name: 'Logging channel', value: loggingGuild ? formatChannel(loggingGuild, notifyChannelId) : (notifyChannelId ? `<#${notifyChannelId}>` : 'Not configured'), inline: true },
            { name: 'Bio scanning', value: autobanCfg.scanBio === false ? '🚫 Disabled' : '✅ Enabled', inline: true },
            { name: 'Keywords', value: keywords.length ? keywords.map(k => `• ${k}`).slice(0, 10).join('\n') + (keywords.length > 10 ? `\n… ${keywords.length - 10} more` : '') : 'No keywords configured.', inline: false }
        );

        const candidateGuildIds = new Set();
        if (Array.isArray(config.mainServerIds)) {
            for (const id of config.mainServerIds) {
                if (id) candidateGuildIds.add(String(id));
            }
        }
        if (config.welcome && typeof config.welcome === 'object') {
            for (const id of Object.keys(config.welcome)) {
                if (id) candidateGuildIds.add(String(id));
            }
        }
        for (const id of Object.keys(testRoleMap)) {
            if (id) candidateGuildIds.add(String(id));
        }

        const guildInfo = [];
        const sortedIds = [...candidateGuildIds].filter(Boolean).sort((a, b) => a.localeCompare(b));
        for (const guildId of sortedIds) {
            const guild = await fetchGuild(client, guildId).catch(() => null);
            const name = guild?.name ?? `Server ${guildId}`;
            const welcomeEntry = config.welcome?.[guildId] ?? {};
            const roles = welcomeEntry?.roles ?? {};
            const unverifiedRoleId = roles?.unverifiedRoleId ? String(roles.unverifiedRoleId) : null;
            const testRoleId = typeof testRoleMap[guildId] === 'string' ? testRoleMap[guildId] : null;
            guildInfo.push({ guildId, guild, name, unverifiedRoleId, testRoleId });
        }
        guildInfo.sort((a, b) => a.name.localeCompare(b.name));

        const summaryTargets = guildInfo.filter(info => info.unverifiedRoleId || info.testRoleId);
        let summaryValue;
        if (summaryTargets.length) {
            const lines = summaryTargets.map(info => {
                const unverifiedDisplay = info.unverifiedRoleId
                    ? formatRole(info.guild, info.unverifiedRoleId)
                    : 'Not configured';
                const testDisplay = info.testRoleId
                    ? formatRole(info.guild, info.testRoleId)
                    : 'Not configured';
                return `• **${truncateName(info.name, 60)}** — unverified: ${unverifiedDisplay} • test: ${testDisplay}`;
            });
            const limited = lines.slice(0, 10);
            summaryValue = limited.join('\n');
            if (lines.length > limited.length) {
                summaryValue += `\n… ${lines.length - limited.length} more`;
            }
            summaryValue = summaryValue.slice(0, 1024);
        } else {
            summaryValue = 'No tracked roles configured yet. Configure the welcome autorole or set a test role override below.';
        }

        embed.addFields({ name: 'Role sweeps', value: summaryValue, inline: false });

        const buttons = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('setup:autobouncer:toggle').setLabel(autobanCfg.enabled === false ? 'Enable' : 'Disable').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('setup:autobouncer:toggleBio').setLabel(autobanCfg.scanBio === false ? 'Enable bio scan' : 'Disable bio scan').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('setup:autobouncer:editKeywords').setLabel('Edit keywords').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('setup:autobouncer:refresh').setLabel('Refresh').setStyle(ButtonStyle.Secondary)
        );
        const channelMenu = new StringSelectMenuBuilder()
        .setCustomId('setup:autobouncer:setChannel')
        .setPlaceholder(loggingGuild ? 'Select a logging channel…' : 'Set logging server first')
        .setMinValues(1)
        .setMaxValues(1)
        .setDisabled(!loggingGuild || channels.length === 0);

        channelMenu.addOptions({ label: 'Leave blank', value: '__clear__', description: 'Disable autobouncer notifications.' });

        if (channels.length) {
            channelMenu.addOptions(channels.slice(0, 24).map(ch => ({
                label: `ID: ${ch.id}`.slice(0, 100),
                description: `#${truncateName(ch.name, 90)}`.slice(0, 100),
                value: ch.id,
                default: notifyChannelId === ch.id
            })));
        } else {
            channelMenu.addOptions({ label: 'No available channels', value: 'noop', default: true });
        }

        const testRoleMenu = new StringSelectMenuBuilder()
        .setCustomId('setup:autobouncer:pickTestRoleGuild')
        .setPlaceholder(guildInfo.length ? 'Select a server to configure test role…' : 'No servers available')
        .setMinValues(1)
        .setMaxValues(1)
        .setDisabled(guildInfo.length === 0);

        if (guildInfo.length) {
            testRoleMenu.addOptions(guildInfo.slice(0, 25).map(info => {
                const description = info.testRoleId
                    ? `Override → ${formatRole(info.guild, info.testRoleId)}`.slice(0, 100)
                    : 'No test role override set';
                return {
                    label: truncateName(info.name, 100),
                    description,
                    value: info.guildId
                };
            }));
        } else {
            testRoleMenu.addOptions({ label: 'No servers available', value: 'noop', default: true });
        }

        const components = [
            buttons,
            new ActionRowBuilder().addComponents(channelMenu),
            new ActionRowBuilder().addComponents(testRoleMenu)
        ];
        appendHomeButtonRow(components);

        return { embeds: [embed], components };
    }

    return {
        prepareConfig,
        handleInteraction,
        buildView
    };
}

async function collectGuildRoles(guild) {
    if (!guild) return [];
    try {
        await guild.roles.fetch();
    } catch {}
    const roles = Array.from(guild.roles?.cache?.values?.() ?? [])
    .filter(role => role && !role.managed && role.id !== guild.id)
    .sort((a, b) => b.position - a.position);
    return roles;
}
