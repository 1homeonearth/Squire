// src/features/project-liner/setup.js
// Setup panel integration for lined project briefs.
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

import { appendHomeButtonRow } from '../setup/shared.js';

import {
    DEFAULT_PROJECT_STATUS,
    MAX_PROJECT_LINES,
    MAX_SUMMARY_LENGTH,
    PROJECT_STATUS_SEQUENCE,
    generateProjectId,
    normalizeLines,
    normalizeProject,
    normalizeProjectLinerConfig,
    sanitizeProjectId,
    sanitizeSummary,
    sanitizeTitle
} from './index.js';

const MAX_LINE_INPUT_LENGTH = 1900;

function nextStatus(current) {
    const idx = PROJECT_STATUS_SEQUENCE.indexOf(current);
    if (idx === -1) {
        return DEFAULT_PROJECT_STATUS;
    }
    return PROJECT_STATUS_SEQUENCE[(idx + 1) % PROJECT_STATUS_SEQUENCE.length];
}

function summarizeProjects(projects) {
    if (!projects.length) {
        return 'No projects yet. Create your first lined project to get started.';
    }
    return projects
        .map(project => `• ${project.title} — \`${project.id}\``)
        .slice(0, 10)
        .join('\n');
}

function limitField(value, max = 1024) {
    if (!value) return 'None yet.';
    const str = String(value);
    if (str.length <= max) return str;
    return `${str.slice(0, max - 1)}…`;
}

export function createProjectLinerSetup({ panelStore, saveConfig }) {
    function prepareConfig(config) {
        config.projectLiner = normalizeProjectLinerConfig(config.projectLiner);
    }

    async function buildView({ config, mode = 'default', context = {} }) {
        void mode;
        const normalized = normalizeProjectLinerConfig(config.projectLiner);
        config.projectLiner = normalized;

        const projects = normalized.projects;
        const requestedId = sanitizeProjectId(context.selectedId ?? null);
        const selectedId = requestedId && projects.some(project => project.id === requestedId)
            ? requestedId
            : (normalized.activeProjectId ?? projects[0]?.id ?? null);
        const selectedProject = selectedId
            ? projects.find(project => project.id === selectedId) ?? null
            : null;

        const embed = new EmbedBuilder()
        .setTitle('Lined projects')
        .setDescription('Organise multi-line project briefs. Staff can read them with **/project**.')
        .addFields(
            { name: 'Total projects', value: `${projects.length}`, inline: true },
            { name: 'Active project', value: normalized.activeProjectId ? `\`${normalized.activeProjectId}\`` : 'Not selected', inline: true }
        );

        embed.addFields({
            name: 'Overview',
            value: limitField(summarizeProjects(projects))
        });

        if (selectedProject) {
            const linePreview = selectedProject.lines.length
                ? selectedProject.lines.map((line, idx) => `${idx + 1}. ${line}`).join('\n')
                : 'No lines added yet.';
            embed.addFields(
                { name: 'Selected project', value: `**${selectedProject.title}** (\`${selectedProject.id}\`)`, inline: false },
                { name: 'Status', value: selectedProject.status, inline: true },
                { name: 'Line count', value: `${selectedProject.lines.length}/${MAX_PROJECT_LINES}`, inline: true },
                { name: 'Summary', value: limitField(selectedProject.summary || 'None yet.'), inline: false },
                { name: 'Lines', value: limitField(linePreview), inline: false }
            );
        } else {
            embed.addFields({
                name: 'Selected project',
                value: 'Select a project to see details or create a new one.',
                inline: false
            });
        }

        const components = [];

        const selectMenu = new StringSelectMenuBuilder()
        .setCustomId('setup:projectliner:select')
        .setPlaceholder(projects.length ? 'Select project…' : 'No projects available yet')
        .setMinValues(1)
        .setMaxValues(1)
        .setDisabled(!projects.length);

        if (projects.length) {
            for (const project of projects.slice(0, 25)) {
                selectMenu.addOptions({
                    label: project.title.slice(0, 100),
                    value: project.id,
                    description: project.summary ? project.summary.slice(0, 100) : `Status: ${project.status}`,
                    default: project.id === selectedId
                });
            }
        } else {
            selectMenu.addOptions({ label: 'No projects yet', value: 'noop', default: true });
        }

        components.push(new ActionRowBuilder().addComponents(selectMenu));

        const manageRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
            .setCustomId('setup:projectliner:create')
            .setLabel('Create project')
            .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
            .setCustomId('setup:projectliner:rename')
            .setLabel('Rename project')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(!selectedProject),
            new ButtonBuilder()
            .setCustomId('setup:projectliner:summary')
            .setLabel('Edit summary')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(!selectedProject),
            new ButtonBuilder()
            .setCustomId('setup:projectliner:lines')
            .setLabel('Edit lines')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(!selectedProject),
            new ButtonBuilder()
            .setCustomId('setup:projectliner:status')
            .setLabel('Cycle status')
            .setStyle(ButtonStyle.Primary)
            .setDisabled(!selectedProject)
        );
        components.push(manageRow);

        const stateRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
            .setCustomId('setup:projectliner:setActive')
            .setLabel('Set active project')
            .setStyle(ButtonStyle.Primary)
            .setDisabled(!selectedProject || selectedId === normalized.activeProjectId),
            new ButtonBuilder()
            .setCustomId('setup:projectliner:clearActive')
            .setLabel('Clear active project')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(!normalized.activeProjectId),
            new ButtonBuilder()
            .setCustomId('setup:projectliner:delete')
            .setLabel('Delete project')
            .setStyle(ButtonStyle.Danger)
            .setDisabled(!selectedProject),
            new ButtonBuilder()
            .setCustomId('setup:projectliner:refresh')
            .setLabel('Refresh view')
            .setStyle(ButtonStyle.Secondary)
        );
        components.push(stateRow);

        appendHomeButtonRow(components);

        return {
            view: { embeds: [embed], components },
            selectedId
        };
    }

    async function handleInteraction({ interaction, entry, config, key, logger }) {
        let working = normalizeProjectLinerConfig(config.projectLiner);
        config.projectLiner = working;

        const ensureSelected = (value) => {
            const candidate = sanitizeProjectId(value ?? null);
            if (candidate && working.projects.some(project => project.id === candidate)) {
                return candidate;
            }
            return working.activeProjectId ?? working.projects[0]?.id ?? null;
        };

        const state = panelStore.get(key) ?? {};
        const currentSelected = ensureSelected(entry?.selectedId ?? state.selectedId ?? null);

        const storeState = (message, selectedId) => {
            const chosen = ensureSelected(selectedId);
            panelStore.set(key, {
                message,
                mode: 'default',
                context: { selectedId: chosen },
                selectedId: chosen
            });
        };

        const refreshState = async ({ selectedId } = {}) => {
            const stored = panelStore.get(key) ?? {};
            const messageRef = stored.message;
            if (!messageRef) return;
            const desired = ensureSelected(selectedId ?? stored.selectedId ?? currentSelected);
            const built = await buildView({ config, mode: 'default', context: { selectedId: desired } });
            try {
                const message = await messageRef.edit(built.view ?? built);
                working = normalizeProjectLinerConfig(config.projectLiner);
                config.projectLiner = working;
                storeState(message, built.selectedId ?? desired);
            } catch {}
        };

        const persistAndRefresh = async ({ selectedId, successMessage }) => {
            working = normalizeProjectLinerConfig(working);
            config.projectLiner = working;
            if (!saveConfig(config, logger)) {
                await interaction.reply({
                    content: 'Failed to save changes. Please try again.',
                    ephemeral: true
                }).catch(() => {});
                await refreshState();
                return;
            }
            if (successMessage) {
                await interaction.reply({ content: successMessage, ephemeral: true }).catch(() => {});
            }
            await refreshState({ selectedId });
        };

        if (interaction.isStringSelectMenu()) {
            if (interaction.customId === 'setup:projectliner:select') {
                const choice = interaction.values?.[0] ?? null;
                const selected = ensureSelected(choice);
                const built = await buildView({ config, mode: 'default', context: { selectedId: selected } });
                const message = await interaction.update(built.view ?? built);
                working = normalizeProjectLinerConfig(config.projectLiner);
                config.projectLiner = working;
                storeState(message, built.selectedId ?? selected);
                return;
            }
        }

        if (interaction.isButton()) {
            switch (interaction.customId) {
                case 'setup:projectliner:create': {
                    const modal = new ModalBuilder()
                    .setCustomId('setup:projectliner:modal:create')
                    .setTitle('Create lined project')
                    .addComponents(
                        new ActionRowBuilder().addComponents(
                            new TextInputBuilder()
                            .setCustomId('setup:projectliner:title')
                            .setLabel('Project title')
                            .setRequired(true)
                            .setMaxLength(120)
                            .setStyle(TextInputStyle.Short)
                        ),
                        new ActionRowBuilder().addComponents(
                            new TextInputBuilder()
                            .setCustomId('setup:projectliner:id')
                            .setLabel('Project ID (optional)')
                            .setRequired(false)
                            .setMaxLength(48)
                            .setStyle(TextInputStyle.Short)
                        ),
                        new ActionRowBuilder().addComponents(
                            new TextInputBuilder()
                            .setCustomId('setup:projectliner:summary')
                            .setLabel('Summary (optional)')
                            .setRequired(false)
                            .setMaxLength(MAX_SUMMARY_LENGTH)
                            .setStyle(TextInputStyle.Paragraph)
                        ),
                        new ActionRowBuilder().addComponents(
                            new TextInputBuilder()
                            .setCustomId('setup:projectliner:lines')
                            .setLabel(`Lines (one per line, up to ${MAX_PROJECT_LINES})`)
                            .setRequired(false)
                            .setMaxLength(MAX_LINE_INPUT_LENGTH)
                            .setStyle(TextInputStyle.Paragraph)
                        )
                    );
                    await interaction.showModal(modal);
                    return;
                }
                case 'setup:projectliner:rename': {
                    const selected = ensureSelected(currentSelected);
                    if (!selected) {
                        await interaction.reply({ content: 'Create a project before renaming.', ephemeral: true });
                        return;
                    }
                    const project = working.projects.find(p => p.id === selected);
                    if (!project) {
                        await interaction.reply({ content: 'Project not found.', ephemeral: true });
                        return;
                    }
                    const modal = new ModalBuilder()
                    .setCustomId('setup:projectliner:modal:rename')
                    .setTitle('Rename lined project')
                    .addComponents(
                        new ActionRowBuilder().addComponents(
                            new TextInputBuilder()
                            .setCustomId('setup:projectliner:renameTitle')
                            .setLabel('Project title')
                            .setRequired(true)
                            .setMaxLength(120)
                            .setStyle(TextInputStyle.Short)
                            .setValue(project.title.slice(0, 120))
                        ),
                        new ActionRowBuilder().addComponents(
                            new TextInputBuilder()
                            .setCustomId('setup:projectliner:renameId')
                            .setLabel('Project ID (optional)')
                            .setRequired(false)
                            .setMaxLength(48)
                            .setStyle(TextInputStyle.Short)
                            .setValue(project.id.slice(0, 48))
                        )
                    );
                    await interaction.showModal(modal);
                    return;
                }
                case 'setup:projectliner:summary': {
                    const selected = ensureSelected(currentSelected);
                    if (!selected) {
                        await interaction.reply({ content: 'Create a project before editing the summary.', ephemeral: true });
                        return;
                    }
                    const project = working.projects.find(p => p.id === selected);
                    if (!project) {
                        await interaction.reply({ content: 'Project not found.', ephemeral: true });
                        return;
                    }
                    const modal = new ModalBuilder()
                    .setCustomId('setup:projectliner:modal:summary')
                    .setTitle('Edit project summary')
                    .addComponents(
                        new ActionRowBuilder().addComponents(
                            new TextInputBuilder()
                            .setCustomId('setup:projectliner:summaryText')
                            .setLabel('Summary')
                            .setRequired(false)
                            .setMaxLength(MAX_SUMMARY_LENGTH)
                            .setStyle(TextInputStyle.Paragraph)
                            .setValue(project.summary.slice(0, MAX_SUMMARY_LENGTH))
                        )
                    );
                    await interaction.showModal(modal);
                    return;
                }
                case 'setup:projectliner:lines': {
                    const selected = ensureSelected(currentSelected);
                    if (!selected) {
                        await interaction.reply({ content: 'Create a project before editing lines.', ephemeral: true });
                        return;
                    }
                    const project = working.projects.find(p => p.id === selected);
                    if (!project) {
                        await interaction.reply({ content: 'Project not found.', ephemeral: true });
                        return;
                    }
                    const modal = new ModalBuilder()
                    .setCustomId('setup:projectliner:modal:lines')
                    .setTitle('Edit project lines')
                    .addComponents(
                        new ActionRowBuilder().addComponents(
                            new TextInputBuilder()
                            .setCustomId('setup:projectliner:linesText')
                            .setLabel('Lines (one per line)')
                            .setRequired(false)
                            .setMaxLength(MAX_LINE_INPUT_LENGTH)
                            .setStyle(TextInputStyle.Paragraph)
                            .setValue(project.lines.join('\n').slice(0, MAX_LINE_INPUT_LENGTH))
                        )
                    );
                    await interaction.showModal(modal);
                    return;
                }
                case 'setup:projectliner:status': {
                    const selected = ensureSelected(currentSelected);
                    if (!selected) {
                        await interaction.reply({ content: 'Select a project first.', ephemeral: true });
                        return;
                    }
                    const project = working.projects.find(p => p.id === selected);
                    if (!project) {
                        await interaction.reply({ content: 'Project not found.', ephemeral: true });
                        return;
                    }
                    project.status = nextStatus(project.status);
                    project.lastUpdatedBy = interaction.user?.id ?? null;
                    await persistAndRefresh({
                        selectedId: selected,
                        successMessage: `Status updated to **${project.status}**.`
                    });
                    return;
                }
                case 'setup:projectliner:setActive': {
                    const selected = ensureSelected(currentSelected);
                    if (!selected) {
                        await interaction.reply({ content: 'Select a project first.', ephemeral: true });
                        return;
                    }
                    working.activeProjectId = selected;
                    await persistAndRefresh({
                        selectedId: selected,
                        successMessage: `Active project set to \`${selected}\`.`
                    });
                    return;
                }
                case 'setup:projectliner:clearActive': {
                    working.activeProjectId = null;
                    await persistAndRefresh({
                        selectedId: currentSelected,
                        successMessage: 'Active project cleared.'
                    });
                    return;
                }
                case 'setup:projectliner:delete': {
                    const selected = ensureSelected(currentSelected);
                    if (!selected) {
                        await interaction.reply({ content: 'Select a project to delete.', ephemeral: true });
                        return;
                    }
                    const project = working.projects.find(p => p.id === selected);
                    if (!project) {
                        await interaction.reply({ content: 'Project not found.', ephemeral: true });
                        return;
                    }
                    const modal = new ModalBuilder()
                    .setCustomId('setup:projectliner:modal:delete')
                    .setTitle('Delete lined project')
                    .addComponents(
                        new ActionRowBuilder().addComponents(
                            new TextInputBuilder()
                            .setCustomId('setup:projectliner:deleteConfirm')
                            .setLabel(`Type the project ID (${project.id}) to confirm`)
                            .setRequired(true)
                            .setMaxLength(48)
                            .setStyle(TextInputStyle.Short)
                        )
                    );
                    await interaction.showModal(modal);
                    return;
                }
                case 'setup:projectliner:refresh': {
                    await interaction.deferUpdate().catch(() => {});
                    await refreshState();
                    return;
                }
                default:
                    break;
            }
        }

        if (interaction.isModalSubmit()) {
            if (interaction.customId === 'setup:projectliner:modal:create') {
                const titleRaw = interaction.fields.getTextInputValue('setup:projectliner:title');
                const idRaw = interaction.fields.getTextInputValue('setup:projectliner:id');
                const summaryRaw = interaction.fields.getTextInputValue('setup:projectliner:summary');
                const linesRaw = interaction.fields.getTextInputValue('setup:projectliner:lines');

                const title = sanitizeTitle(titleRaw);
                const summary = sanitizeSummary(summaryRaw);
                const lines = normalizeLines(linesRaw);
                const existingIds = working.projects.map(project => project.id);
                const desiredId = generateProjectId(idRaw, title, existingIds);
                const project = normalizeProject({
                    id: desiredId,
                    title,
                    summary,
                    lines,
                    status: DEFAULT_PROJECT_STATUS,
                    ownerId: interaction.user?.id ?? null,
                    lastUpdatedBy: interaction.user?.id ?? null
                }, { existingIds: new Set(existingIds) });

                working.projects.push(project);
                if (!working.activeProjectId) {
                    working.activeProjectId = project.id;
                }

                await persistAndRefresh({
                    selectedId: project.id,
                    successMessage: `Created project **${project.title}**.`
                });
                return;
            }

            if (interaction.customId === 'setup:projectliner:modal:rename') {
                const selected = ensureSelected(currentSelected);
                if (!selected) {
                    await interaction.reply({ content: 'Select a project first.', ephemeral: true });
                    return;
                }
                const project = working.projects.find(p => p.id === selected);
                if (!project) {
                    await interaction.reply({ content: 'Project not found.', ephemeral: true });
                    return;
                }
                const titleRaw = interaction.fields.getTextInputValue('setup:projectliner:renameTitle');
                const idRaw = interaction.fields.getTextInputValue('setup:projectliner:renameId');
                const title = sanitizeTitle(titleRaw);
                const normalizedId = sanitizeProjectId(idRaw) ?? project.id;
                const existingIds = working.projects
                    .filter(p => p.id !== project.id)
                    .map(p => p.id);
                const resolvedId = generateProjectId(normalizedId, title, existingIds);
                project.title = title;
                project.id = resolvedId;
                project.lastUpdatedBy = interaction.user?.id ?? null;
                if (working.activeProjectId === selected) {
                    working.activeProjectId = resolvedId;
                }
                await persistAndRefresh({
                    selectedId: resolvedId,
                    successMessage: 'Project updated.'
                });
                return;
            }

            if (interaction.customId === 'setup:projectliner:modal:summary') {
                const selected = ensureSelected(currentSelected);
                if (!selected) {
                    await interaction.reply({ content: 'Select a project first.', ephemeral: true });
                    return;
                }
                const project = working.projects.find(p => p.id === selected);
                if (!project) {
                    await interaction.reply({ content: 'Project not found.', ephemeral: true });
                    return;
                }
                const summaryRaw = interaction.fields.getTextInputValue('setup:projectliner:summaryText');
                project.summary = sanitizeSummary(summaryRaw);
                project.lastUpdatedBy = interaction.user?.id ?? null;
                await persistAndRefresh({
                    selectedId: project.id,
                    successMessage: 'Summary updated.'
                });
                return;
            }

            if (interaction.customId === 'setup:projectliner:modal:lines') {
                const selected = ensureSelected(currentSelected);
                if (!selected) {
                    await interaction.reply({ content: 'Select a project first.', ephemeral: true });
                    return;
                }
                const project = working.projects.find(p => p.id === selected);
                if (!project) {
                    await interaction.reply({ content: 'Project not found.', ephemeral: true });
                    return;
                }
                const linesRaw = interaction.fields.getTextInputValue('setup:projectliner:linesText');
                const lines = normalizeLines(linesRaw);
                if (!lines.length) {
                    project.lines = [];
                } else {
                    project.lines = lines;
                }
                project.lastUpdatedBy = interaction.user?.id ?? null;
                await persistAndRefresh({
                    selectedId: project.id,
                    successMessage: `Saved ${project.lines.length} line${project.lines.length === 1 ? '' : 's'}.`
                });
                return;
            }

            if (interaction.customId === 'setup:projectliner:modal:delete') {
                const selected = ensureSelected(currentSelected);
                if (!selected) {
                    await interaction.reply({ content: 'Select a project first.', ephemeral: true });
                    return;
                }
                const confirmation = interaction.fields.getTextInputValue('setup:projectliner:deleteConfirm') ?? '';
                if (sanitizeProjectId(confirmation) !== selected) {
                    await interaction.reply({ content: 'Confirmation does not match the project ID.', ephemeral: true });
                    return;
                }
                working.projects = working.projects.filter(project => project.id !== selected);
                if (working.activeProjectId === selected) {
                    working.activeProjectId = null;
                }
                await persistAndRefresh({
                    selectedId: working.projects[0]?.id ?? null,
                    successMessage: 'Project deleted.'
                });
                return;
            }
        }
    }

    return {
        prepareConfig,
        buildView,
        handleInteraction
    };
}

