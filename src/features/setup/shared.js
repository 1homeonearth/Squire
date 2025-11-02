// src/features/setup/shared.js
// Shared helpers for setup panels across feature modules.
import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ChannelType
} from 'discord.js';

export function truncateName(name, max) {
    const value = String(name ?? 'Unknown');
    return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

export function formatChannel(guild, channelId) {
    if (!channelId) return 'Not configured';
    const channel = guild?.channels?.cache?.get?.(channelId);
    if (channel?.isTextBased?.()) {
        return `<#${channel.id}>`;
    }
    return `<#${channelId}>`;
}

export function formatRole(guild, roleId) {
    if (!roleId) return 'Not configured';
    const role = guild?.roles?.cache?.get?.(roleId);
    if (role) {
        return `<@&${role.id}>`;
    }
    return `<@&${roleId}>`;
}

export function formatCategory(guild, categoryId) {
    if (!categoryId) return 'Not configured';
    const channel = guild?.channels?.cache?.get?.(categoryId);
    if (channel?.type === ChannelType.GuildCategory) {
        return `📂 ${channel.name}`;
    }
    return categoryId;
}

export async function collectTextChannels(guild) {
    if (!guild) return [];
    try {
        const collection = await guild.channels.fetch();
        return collection
        .filter(ch => ch && typeof ch.isTextBased === 'function' && ch.isTextBased() && !ch.isThread?.())
        .map(ch => ch)
        .sort((a, b) => (a.rawPosition ?? 0) - (b.rawPosition ?? 0));
    } catch {
        return [];
    }
}

export async function collectCategories(guild) {
    if (!guild) return [];
    try {
        const collection = await guild.channels.fetch();
        return collection
        .filter(ch => ch?.type === ChannelType.GuildCategory)
        .map(ch => ch)
        .sort((a, b) => (a.rawPosition ?? 0) - (b.rawPosition ?? 0));
    } catch {
        return [];
    }
}

export function appendHomeButtonRow(components) {
    components.push(new ActionRowBuilder().addComponents(
        new ButtonBuilder()
        .setCustomId('setup:navigate:home')
        .setLabel('⬅ Back to overview')
        .setStyle(ButtonStyle.Secondary)
    ));
}

export function sanitizeBridgeId(value) {
    if (!value) return null;
    const cleaned = String(value).trim().toLowerCase().replace(/\s+/g, '-');
    const safe = cleaned.replace(/[^a-z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^[-_]+|[-_]+$/g, '');
    if (!safe) return null;
    return safe.slice(0, 48);
}

export function sanitizeSnowflakeId(value) {
    if (value === undefined || value === null) return null;
    const trimmed = String(value).trim();
    return /^\d{15,25}$/.test(trimmed) ? trimmed : null;
}

export function isValidWebhookUrl(url) {
    if (typeof url !== 'string') return false;
    const trimmed = url.trim();
    return /^https?:\/\/(?:\w+\.)?discord\.com\/api\/webhooks\/\d+\/[A-Za-z0-9._-]+$/i.test(trimmed);
}
