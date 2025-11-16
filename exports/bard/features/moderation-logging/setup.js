// src/features/moderation-logging/setup.js
// Setup panel integration for the moderation logging module.
import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    StringSelectMenuBuilder
} from 'discord.js';

import {
    appendHomeButtonRow,
    collectTextChannels,
    formatChannel,
    sanitizeSnowflakeId,
    truncateName
} from '../setup/shared.js';

function ensureModerationLogging(config) {
    if (!config.moderationLogging || typeof config.moderationLogging !== 'object') {
        config.moderationLogging = {};
    }
    const base = config.moderationLogging;
    base.categoryChannelId = sanitizeSnowflakeId(base.categoryChannelId);
    base.actionChannelId = sanitizeSnowflakeId(base.actionChannelId);
}

export function createModerationLoggingSetup({ panelStore, saveConfig, fetchGuild }) {
    function prepareConfig(config) {
        ensureModerationLogging(config);
    }

    async function buildView({ config, client }) {
        ensureModerationLogging(config);

        const loggingServerId = config.loggingServerId ?? null;
        const loggingGuild = loggingServerId ? await fetchGuild(client, loggingServerId) : null;
        const modConfig = config.moderationLogging;

        const embed = new EmbedBuilder()
        .setTitle('Moderation logging')
        .setDescription('Assign logging channels for moderator category changes and actions.');

        const categoryDisplay = loggingGuild
            ? formatChannel(loggingGuild, modConfig.categoryChannelId)
            : (modConfig.categoryChannelId ? `<#${modConfig.categoryChannelId}>` : 'Not configured');
        const actionDisplay = loggingGuild
            ? formatChannel(loggingGuild, modConfig.actionChannelId)
            : (modConfig.actionChannelId ? `<#${modConfig.actionChannelId}>` : 'Not configured');

        embed.addFields(
            {
                name: 'Logging server',
                value: loggingGuild ? `${loggingGuild.name} (${loggingGuild.id})` : 'Set a logging server on the overview tab.',
                inline: false
            },
            {
                name: 'Category updates',
                value: categoryDisplay,
                inline: false
            },
            {
                name: 'Moderator actions',
                value: actionDisplay,
                inline: false
            }
        );

        const components = [];

        const textChannels = loggingGuild ? await collectTextChannels(loggingGuild) : [];

        const categoryMenu = new StringSelectMenuBuilder()
        .setCustomId('setup:modlog:categoryChannel')
        .setPlaceholder('Select category log channel…')
        .setMinValues(1)
        .setMaxValues(1)
        .setDisabled(!loggingGuild || textChannels.length === 0);

        const actionMenu = new StringSelectMenuBuilder()
        .setCustomId('setup:modlog:actionChannel')
        .setPlaceholder('Select action log channel…')
        .setMinValues(1)
        .setMaxValues(1)
        .setDisabled(!loggingGuild || textChannels.length === 0);

        const options = textChannels.slice(0, 24).map(channel => ({
            label: truncateName(`#${channel.name ?? channel.id}`, 100),
            description: `ID: ${channel.id}`.slice(0, 100),
            value: channel.id
        }));

        if (options.length) {
            categoryMenu.addOptions(
                { label: '⛔ Clear selection', value: '__clear__', description: 'Stop logging category changes.' },
                ...options.map(opt => ({ ...opt, default: opt.value === modConfig.categoryChannelId }))
            );
            actionMenu.addOptions(
                { label: '⛔ Clear selection', value: '__clear__', description: 'Stop logging moderator actions.' },
                ...options.map(opt => ({ ...opt, default: opt.value === modConfig.actionChannelId }))
            );
        } else {
            categoryMenu.addOptions({ label: 'No text channels available', value: 'noop', default: true });
            actionMenu.addOptions({ label: 'No text channels available', value: 'noop', default: true });
        }

        components.push(new ActionRowBuilder().addComponents(categoryMenu));
        components.push(new ActionRowBuilder().addComponents(actionMenu));

        components.push(new ActionRowBuilder().addComponents(
            new ButtonBuilder()
            .setCustomId('setup:modlog:refresh')
            .setLabel('🔄 Refresh')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(!loggingGuild)
        ));

        appendHomeButtonRow(components);

        return { embeds: [embed], components };
    }

    async function handleInteraction({ interaction, config, client, key, logger }) {
        ensureModerationLogging(config);

        const persistState = (message) => {
            panelStore.set(key, { message });
        };

        if (interaction.isButton() && interaction.customId === 'setup:modlog:refresh') {
            const view = await buildView({ config, client });
            const message = await interaction.update(view);
            persistState(message);
            return;
        }

        if (interaction.isStringSelectMenu()) {
            const choice = interaction.values?.[0] ?? null;
            if (interaction.customId === 'setup:modlog:categoryChannel') {
                if (!choice || choice === 'noop') {
                    await interaction.deferUpdate().catch(() => {});
                    return;
                }
                config.moderationLogging.categoryChannelId = choice === '__clear__'
                    ? null
                    : sanitizeSnowflakeId(choice);
                saveConfig(config, logger);
                const view = await buildView({ config, client });
                const message = await interaction.update(view);
                persistState(message);
                return;
            }

            if (interaction.customId === 'setup:modlog:actionChannel') {
                if (!choice || choice === 'noop') {
                    await interaction.deferUpdate().catch(() => {});
                    return;
                }
                config.moderationLogging.actionChannelId = choice === '__clear__'
                    ? null
                    : sanitizeSnowflakeId(choice);
                saveConfig(config, logger);
                const view = await buildView({ config, client });
                const message = await interaction.update(view);
                persistState(message);
                return;
            }
        }
    }

    return { prepareConfig, buildView, handleInteraction };
}
