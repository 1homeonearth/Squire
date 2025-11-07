// src/features/moderation-commands/setup.js
// Setup panel integration for moderation command role management.

import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    StringSelectMenuBuilder
} from 'discord.js';

import {
    appendHomeButtonRow,
    formatRole,
    truncateName
} from '../setup/shared.js';

function sanitizeRoleList(values) {
    if (!Array.isArray(values)) return [];
    const seen = new Set();
    const out = [];
    for (const value of values) {
        const str = String(value ?? '').trim();
        if (!str || seen.has(str)) continue;
        seen.add(str);
        out.push(str);
    }
    return out;
}

export function createModerationSetup({ panelStore, saveConfig, fetchGuild, collectManageableGuilds }) {
    function prepareConfig(config) {
        if (!config.moderationCommands || typeof config.moderationCommands !== 'object') {
            config.moderationCommands = {};
        }
        const rawMap = config.moderationCommands.roleMap;
        const cleaned = {};
        if (rawMap && typeof rawMap === 'object') {
            for (const [guildId, values] of Object.entries(rawMap)) {
                const key = String(guildId ?? '').trim();
                if (!key) continue;
                cleaned[key] = sanitizeRoleList(Array.isArray(values) ? values : [values]);
            }
        }
        config.moderationCommands.roleMap = cleaned;
    }

    async function collectGuildOptions({ client, userId }) {
        try {
            return await collectManageableGuilds({ client, userId });
        } catch {
            return [];
        }
    }

    async function buildView({ config, client, guildOptions = [], context = {} }) {
        const options = Array.isArray(guildOptions) ? guildOptions : [];
        const optionIds = new Set(options.map(opt => opt.id));
        const desiredGuildId = context.guildId && optionIds.has(context.guildId)
            ? context.guildId
            : (options[0]?.id ?? null);
        const guild = desiredGuildId ? await fetchGuild(client, desiredGuildId) : null;
        const roleMap = config.moderationCommands?.roleMap ?? {};
        const selectedRoles = desiredGuildId ? (roleMap[desiredGuildId] ?? []) : [];

        const embed = new EmbedBuilder()
        .setTitle('Moderation command access')
        .setDescription('Choose which roles in each server can run Squire\'s moderation slash commands.');

        if (desiredGuildId) {
            embed.addFields({
                name: 'Server',
                value: guild ? `${guild.name} (${guild.id})` : desiredGuildId,
                inline: false
            });
            const roleSummary = selectedRoles.length
                ? selectedRoles.map(roleId => `• ${formatRole(guild, roleId)} (${roleId})`).join('\n')
                : 'No moderator roles selected yet.';
            embed.addFields({
                name: 'Moderator roles',
                value: roleSummary,
                inline: false
            });
            embed.addFields({
                name: 'Tips',
                value: 'Members keep access automatically if they have **Administrator** or **Manage Server** permission.',
                inline: false
            });
        } else {
            embed.addFields({
                name: 'Server',
                value: 'Select a server to configure moderator access.',
                inline: false
            });
        }

        const components = [];

        const guildMenu = new StringSelectMenuBuilder()
        .setCustomId('setup:moderation:guild')
        .setPlaceholder(options.length ? 'Select a server…' : 'No servers available')
        .setMinValues(1)
        .setMaxValues(1)
        .setDisabled(!options.length);

        if (options.length) {
            for (const opt of options.slice(0, 25)) {
                guildMenu.addOptions({
                    label: truncateName(opt.name, 100),
                    description: `ID: ${opt.id}`.slice(0, 100),
                    value: opt.id,
                    default: opt.id === desiredGuildId
                });
            }
        } else {
            guildMenu.addOptions({ label: 'No servers found', value: 'noop', default: true });
        }

        components.push(new ActionRowBuilder().addComponents(guildMenu));

        const roleRow = new ActionRowBuilder();
        const roleMenu = new StringSelectMenuBuilder()
        .setCustomId('setup:moderation:roles')
        .setPlaceholder(desiredGuildId ? 'Select moderator roles…' : 'Select a server first')
        .setMinValues(0)
        .setMaxValues(desiredGuildId ? 25 : 1)
        .setDisabled(!desiredGuildId);

        if (desiredGuildId && guild) {
            try {
                const collection = await guild.roles.fetch();
                const roles = collection
                .filter(role => role && role.id !== guild.id)
                .map(role => role)
                .sort((a, b) => (b.position ?? 0) - (a.position ?? 0));

                const mapped = roles.slice(0, 24).map(role => ({
                    label: truncateName(role.name, 100),
                    description: `ID: ${role.id}`.slice(0, 100),
                    value: role.id,
                    default: selectedRoles.includes(role.id)
                }));

                for (const roleId of selectedRoles) {
                    if (!mapped.some(opt => opt.value === roleId)) {
                        mapped.unshift({
                            label: truncateName(`(missing) ${roleId}`, 100),
                            value: roleId,
                            description: 'Role not currently available',
                            default: true
                        });
                    }
                }

                if (mapped.length) {
                    for (const opt of mapped.slice(0, 25)) {
                        roleMenu.addOptions(opt);
                    }
                } else {
                    roleMenu.addOptions({ label: 'No roles found', value: 'noop', default: true });
                    roleMenu.setDisabled(true);
                }
            } catch {
                roleMenu.addOptions({ label: 'Unable to load roles', value: 'noop', default: true });
                roleMenu.setDisabled(true);
            }
        } else {
            roleMenu.addOptions({ label: 'Select a server first', value: 'noop', default: true });
        }

        roleRow.addComponents(roleMenu);
        components.push(roleRow);

        const buttonRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
            .setCustomId('setup:moderation:refresh')
            .setLabel('Refresh roles')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(!desiredGuildId)
        );
        components.push(buttonRow);

        appendHomeButtonRow(components);

        return {
            view: { embeds: [embed], components },
            desiredGuildId
        };
    }

    async function handleInteraction({ interaction, entry, config, client, key, logger }) {
        const guildOptions = entry?.guildOptions ?? await collectGuildOptions({ client, userId: interaction.user?.id });
        const currentGuildId = entry?.guildId && guildOptions.some(opt => opt.id === entry.guildId)
            ? entry.guildId
            : (guildOptions[0]?.id ?? null);

        const applyAndStore = async ({ view, guildId, responder }) => {
            const responderFn = responder ?? (interaction.isModalSubmit()
                ? interaction.editReply.bind(interaction)
                : (interaction.deferred || interaction.replied)
                    ? interaction.editReply.bind(interaction)
                    : interaction.update.bind(interaction));
            const message = await responderFn(view.view ?? view);
            panelStore.set(key, {
                message,
                guildId,
                guildOptions,
                mode: 'overview',
                context: { guildId }
            });
        };

        if (interaction.isStringSelectMenu()) {
            if (interaction.customId === 'setup:moderation:guild') {
                const choice = interaction.values?.[0] ?? null;
                const nextGuildId = choice && choice !== 'noop' ? choice : null;
                const built = await buildView({ config, client, guildOptions, context: { guildId: nextGuildId } });
                await applyAndStore({ view: built.view, guildId: built.desiredGuildId, responder: interaction.update.bind(interaction) });
                return;
            }

            if (interaction.customId === 'setup:moderation:roles') {
                if (!currentGuildId) {
                    await interaction.reply({ content: 'Select a server first.', ephemeral: true });
                    return;
                }
                const values = Array.isArray(interaction.values) ? interaction.values : [];
                const sanitized = sanitizeRoleList(values).slice(0, 25);

                if (!config.moderationCommands || typeof config.moderationCommands !== 'object') {
                    config.moderationCommands = {};
                }
                if (!config.moderationCommands.roleMap || typeof config.moderationCommands.roleMap !== 'object') {
                    config.moderationCommands.roleMap = {};
                }
                config.moderationCommands.roleMap[currentGuildId] = sanitized;
                saveConfig(config, logger);

                const built = await buildView({ config, client, guildOptions, context: { guildId: currentGuildId } });
                await applyAndStore({ view: built.view, guildId: currentGuildId, responder: interaction.update.bind(interaction) });
                const message = sanitized.length
                    ? `Saved ${sanitized.length} moderator role${sanitized.length === 1 ? '' : 's'}.`
                    : 'Cleared moderator roles for this server.';
                await interaction.followUp({ content: message, ephemeral: true }).catch(() => {});
                return;
            }
        }

        if (interaction.isButton()) {
            if (interaction.customId === 'setup:moderation:refresh') {
                const built = await buildView({ config, client, guildOptions, context: { guildId: currentGuildId } });
                await applyAndStore({ view: built.view, guildId: currentGuildId, responder: interaction.update.bind(interaction) });
                await interaction.followUp({ content: 'Reloaded server roles.', ephemeral: true }).catch(() => {});
                return;
            }
        }

        if (!interaction.deferred && !interaction.replied) {
            const built = await buildView({ config, client, guildOptions, context: { guildId: currentGuildId } });
            await applyAndStore({ view: built.view, guildId: currentGuildId, responder: interaction.reply.bind(interaction) });
        }
    }

    return {
        prepareConfig,
        buildView,
        handleInteraction
    };
}

