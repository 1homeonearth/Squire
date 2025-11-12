// src/features/project-liner/index.js
// Lined project briefs with slash command access.
import {
    EmbedBuilder,
    PermissionFlagsBits,
    SlashCommandBuilder
} from 'discord.js';

export const PROJECT_STATUS_SEQUENCE = ['draft', 'active', 'complete'];
export const DEFAULT_PROJECT_STATUS = 'draft';
export const MAX_PROJECT_LINES = 25;
export const MAX_LINE_LENGTH = 240;
export const MAX_SUMMARY_LENGTH = 1024;

function clampText(value, max) {
    const str = typeof value === 'string' ? value : '';
    if (!str.trim()) return '';
    return str.length > max ? `${str.slice(0, max - 1)}…` : str;
}

export function sanitizeProjectId(value) {
    if (value === undefined || value === null) return null;
    const trimmed = String(value).trim().toLowerCase();
    if (!trimmed) return null;
    const slug = trimmed
        .replace(/[^a-z0-9\s_-]+/g, '-')
        .replace(/[\s_]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-+|-+$/g, '');
    if (!slug) return null;
    return slug.slice(0, 48);
}

export function sanitizeSnowflake(value) {
    if (value === undefined || value === null) return null;
    const trimmed = String(value).trim();
    return /^\d{15,25}$/.test(trimmed) ? trimmed : null;
}

export function sanitizeTitle(value) {
    const str = typeof value === 'string' ? value.trim() : '';
    if (!str) return 'Untitled project';
    return clampText(str, 120);
}

export function sanitizeSummary(value) {
    const str = typeof value === 'string' ? value.trim() : '';
    if (!str) return '';
    return clampText(str, MAX_SUMMARY_LENGTH);
}

export function sanitizeStatus(value) {
    const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
    if (PROJECT_STATUS_SEQUENCE.includes(normalized)) {
        return normalized;
    }
    return DEFAULT_PROJECT_STATUS;
}

export function normalizeLines(value) {
    const base = Array.isArray(value)
        ? value
        : typeof value === 'string'
            ? value.split(/\r?\n/)
            : [];
    const lines = [];
    const seen = new Set();
    for (const entry of base) {
        if (typeof entry !== 'string') continue;
        const trimmed = entry.trim();
        if (!trimmed) continue;
        const truncated = clampText(trimmed, MAX_LINE_LENGTH);
        const key = truncated.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        lines.push(truncated);
        if (lines.length >= MAX_PROJECT_LINES) break;
    }
    return lines;
}

function uniqueId(base, existing) {
    let candidate = base || 'project';
    let suffix = 2;
    while (existing.has(candidate)) {
        candidate = `${base}-${suffix}`;
        suffix += 1;
    }
    return candidate;
}

export function generateProjectId(rawId, fallbackTitle, existingIds = []) {
    const pool = new Set(existingIds);
    const baseId = sanitizeProjectId(rawId) ?? sanitizeProjectId(fallbackTitle) ?? 'project';
    let candidate = baseId;
    let counter = 2;
    while (pool.has(candidate)) {
        candidate = `${baseId}-${counter}`;
        counter += 1;
    }
    return candidate;
}

export function normalizeProject(source, { existingIds = new Set(), fallbackId } = {}) {
    const input = source && typeof source === 'object' ? source : {};
    const title = sanitizeTitle(input.title ?? input.name ?? '');
    let baseId = input.id ?? input.slug ?? input.key ?? input.projectId ?? null;
    if (!baseId && fallbackId) {
        baseId = fallbackId;
    }
    let id = sanitizeProjectId(baseId) ?? sanitizeProjectId(title);
    if (!id) {
        id = uniqueId('project', existingIds);
    }
    if (existingIds.has(id)) {
        id = uniqueId(id, existingIds);
    }
    existingIds.add(id);

    const summary = sanitizeSummary(input.summary ?? input.description ?? '');
    const status = sanitizeStatus(input.status);
    const lines = normalizeLines(input.lines ?? input.entries ?? input.tasks ?? []);

    const ownerId = sanitizeSnowflake(input.ownerId ?? input.owner ?? null);
    const lastUpdatedBy = sanitizeSnowflake(input.lastUpdatedBy ?? null);

    return {
        id,
        title,
        summary,
        status,
        lines,
        ownerId,
        lastUpdatedBy
    };
}

export function normalizeProjectLinerConfig(source) {
    const existingIds = new Set();
    const normalized = {
        projects: [],
        activeProjectId: null,
        defaultChannelId: sanitizeSnowflake(source?.defaultChannelId ?? null)
    };

    if (!source || typeof source !== 'object') {
        source = {};
    }

    const rawEntries = Array.isArray(source.projects)
        ? source.projects
        : source.projects && typeof source.projects === 'object'
            ? Object.entries(source.projects).map(([key, value]) => ({ key, value }))
            : [];

    for (const entry of rawEntries) {
        if (entry && typeof entry === 'object' && Object.prototype.hasOwnProperty.call(entry, 'value')) {
            const project = normalizeProject(entry.value, { existingIds, fallbackId: entry.key });
            normalized.projects.push(project);
            continue;
        }
        const project = normalizeProject(entry, { existingIds });
        normalized.projects.push(project);
    }

    const explicitActive = sanitizeProjectId(source.activeProjectId ?? null);
    const providedValue = Object.prototype.hasOwnProperty.call(source, 'activeProjectId')
        ? source.activeProjectId
        : undefined;
    const foundActive = explicitActive && normalized.projects.some(project => project.id === explicitActive)
        ? explicitActive
        : null;
    if (providedValue === null) {
        normalized.activeProjectId = null;
    } else {
        normalized.activeProjectId = foundActive ?? normalized.projects[0]?.id ?? null;
    }

    return normalized;
}

function projectStatusEmoji(status) {
    switch (status) {
        case 'active':
            return '🟢';
        case 'complete':
            return '🔵';
        default:
            return '⚪';
    }
}

function renderLines(project) {
    if (!project?.lines?.length) {
        return 'No lines added yet.';
    }
    const pieces = [];
    let remaining = 1000;
    for (let i = 0; i < project.lines.length; i += 1) {
        const prefix = `${i + 1}. `;
        const text = project.lines[i];
        const chunk = `${prefix}${text}`;
        if (chunk.length > remaining) {
            pieces.push('…');
            break;
        }
        pieces.push(chunk);
        remaining -= chunk.length + 1;
        if (pieces.length >= 12) {
            if (i < project.lines.length - 1) {
                const remainingCount = project.lines.length - pieces.length;
                pieces.push(`…and ${remainingCount} more`);
            }
            break;
        }
    }
    return pieces.join('\n');
}

export const commands = [
    new SlashCommandBuilder()
    .setName('project')
    .setDescription('View lined project briefs configured in /setup')
    .setDMPermission(false)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand(sub =>
        sub
        .setName('list')
        .setDescription('List available lined projects')
    )
    .addSubcommand(sub =>
        sub
        .setName('view')
        .setDescription('Display a lined project')
        .addStringOption(opt =>
            opt
            .setName('id')
            .setDescription('Project ID to display (leave blank for the active project)')
            .setRequired(false)
        )
    )
];

export function init({ client, config, logger }) {
    let projectState = normalizeProjectLinerConfig(config.projectLiner);
    config.projectLiner = projectState;

    function refreshState(nextSource) {
        projectState = normalizeProjectLinerConfig(nextSource ?? projectState);
        config.projectLiner = projectState;
    }

    client.on('squire:configUpdated', (nextConfig) => {
        try {
            refreshState(nextConfig?.projectLiner ?? config.projectLiner);
        } catch (err) {
            logger?.warn?.(`[project-liner] Failed to sync config: ${err?.message ?? err}`);
        }
    });

    client.on('interactionCreate', async (interaction) => {
        try {
            if (!interaction.isChatInputCommand() || interaction.commandName !== 'project') {
                return;
            }

            refreshState(config.projectLiner);

            const sub = interaction.options.getSubcommand();

            if (sub === 'list') {
                if (!projectState.projects.length) {
                    await interaction.reply({
                        content: 'No lined projects are configured yet. Visit **/setup → Lined projects** to add one.',
                        ephemeral: true
                    });
                    return;
                }

                const summary = projectState.projects
                    .map(project => `${projectStatusEmoji(project.status)} ${project.title} — \`${project.id}\``)
                    .join('\n');

                const embed = new EmbedBuilder()
                .setTitle('Lined projects')
                .setDescription(summary)
                .setFooter({ text: projectState.activeProjectId ? `Active project: ${projectState.activeProjectId}` : 'No active project selected' })
                .setColor(0x5865F2);

                await interaction.reply({
                    embeds: [embed],
                    ephemeral: true
                });
                return;
            }

            const requestedIdRaw = interaction.options.getString('id');
            const requestedId = sanitizeProjectId(requestedIdRaw);
            const projectId = requestedId
                ?? projectState.activeProjectId
                ?? projectState.projects[0]?.id
                ?? null;

            if (!projectId) {
                await interaction.reply({
                    content: 'No lined projects are available yet. Use **/setup → Lined projects** to create one first.',
                    ephemeral: true
                });
                return;
            }

            const project = projectState.projects.find(entry => entry.id === projectId);
            if (!project) {
                await interaction.reply({
                    content: requestedId
                        ? `No project found with ID \`${requestedId}\`. Try **/project list** to see available IDs.`
                        : 'The active project is no longer available. Use **/project list** to choose another.',
                    ephemeral: true
                });
                return;
            }

            const embed = new EmbedBuilder()
            .setTitle(project.title)
            .setColor(project.status === 'active' ? 0x2ECC71 : project.status === 'complete' ? 0x3498DB : 0x95A5A6)
            .addFields(
                { name: 'Project ID', value: `\`${project.id}\``, inline: true },
                { name: 'Status', value: `${projectStatusEmoji(project.status)} ${project.status}`, inline: true }
            );

            if (project.summary) {
                embed.setDescription(project.summary);
            }

            embed.addFields({
                name: 'Lines',
                value: renderLines(project)
            });

            if (project.ownerId) {
                embed.addFields({
                    name: 'Owner',
                    value: `<@${project.ownerId}>`,
                    inline: false
                });
            }

            await interaction.reply({
                embeds: [embed],
                allowedMentions: { parse: [] }
            });
        } catch (err) {
            logger?.error?.(`[project-liner] Command handling error: ${err?.message ?? err}`);
            if (interaction.isRepliable()) {
                const payload = {
                    content: 'Something went wrong displaying that project.',
                    ephemeral: true
                };
                if (interaction.deferred || interaction.replied) {
                    await interaction.followUp(payload).catch(() => {});
                } else {
                    await interaction.reply(payload).catch(() => {});
                }
            }
        }
    });
}

