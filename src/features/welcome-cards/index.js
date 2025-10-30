// src/features/welcome-cards/index.js
import { createCanvas, loadImage as loadCanvasImage } from '@napi-rs/canvas';
import { AttachmentBuilder } from 'discord.js';
import { loadImage, Font } from 'canvacord';

import {
    DEFAULT_WELCOME_MESSAGE,
    sanitizeWelcomeMessage
} from './template.js';

// Load the built-in font once
Font.loadDefault();

// ---- Utility to find channels by name (case-insensitive)
function findByName(guild, name) {
    const n = name.toLowerCase();
    return guild.channels.cache.find(ch => ch.isTextBased?.() && ch.name.toLowerCase() === n) || null;
}

function mentionFromConfig(guild, canon, mapping) {
    const configured = mapping?.[canon];
    if (configured) {
        return `<#${String(configured)}>`;
    }
    const ch = findByName(guild, canon);
    return ch ? `<#${ch.id}>` : `#${canon}`;
}

function renderWelcomeTemplate(template, replacements) {
    if (!template || typeof template !== 'string') {
        return DEFAULT_WELCOME_MESSAGE;
    }
    const map = { ...replacements };
    return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key) => {
        const lower = key.toLowerCase();
        return Object.prototype.hasOwnProperty.call(map, lower) ? map[lower] : match;
    });
}

async function findWelcomeChannel(guild, channelId) {
    if (channelId) {
        const cached = guild.channels.cache.get(channelId);
        if (cached && cached.isTextBased?.()) return cached;
        try {
            const fetched = await guild.channels.fetch(channelId);
            if (fetched && fetched.isTextBased?.()) {
                return fetched;
            }
        } catch {}
    }
    return findByName(guild, 'welcome') || guild.systemChannel || null;
}


function fillRoundedRect(ctx, x, y, width, height, radius, fillStyle) {
    const r = Math.min(radius, width / 2, height / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + width, y, x + width, y + height, r);
    ctx.arcTo(x + width, y + height, x, y + height, r);
    ctx.arcTo(x, y + height, x, y, r);
    ctx.arcTo(x, y, x + width, y, r);
    ctx.closePath();
    ctx.fillStyle = fillStyle;
    ctx.fill();
}

function drawAvatar(ctx, img, x, y, size) {
    const radius = size / 2;
    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.closePath();
    ctx.clip();
    ctx.drawImage(img, x - radius, y - radius, size, size);
    ctx.restore();

    ctx.lineWidth = 10;
    ctx.strokeStyle = '#2563EB';
    ctx.beginPath();
    ctx.arc(x, y, radius - 5, 0, Math.PI * 2);
    ctx.closePath();
    ctx.stroke();
}

async function buildWelcomeImage(member, logger) {
    // Ensure we have the freshest user data (banners often require an explicit fetch)
    try { await member.user.fetch(true); } catch {}

    const avatarURL = member.displayAvatarURL({ extension: 'png', size: 512 });

    let avatarImg = null;
    try {
        const fetched = await loadImage(avatarURL);
        avatarImg = await loadCanvasImage(fetched.data);
    } catch (err) {
        logger?.warn?.(`[welcome] failed to load avatar for ${member.user?.tag ?? member.id}: ${err?.message ?? err}`);
        return null;
    }

    const width = 1000;
    const height = 360;
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');

    // Background layers
    ctx.fillStyle = '#111827';
    ctx.fillRect(0, 0, width, height);
    fillRoundedRect(ctx, 24, 24, width - 48, height - 48, 36, '#1F2933');

    // Subtle inner highlight
    ctx.save();
    ctx.globalAlpha = 0.35;
    fillRoundedRect(ctx, 24, 24, width - 48, height / 2, 36, '#27323F');
    ctx.restore();

    const centerX = width / 2;
    const avatarSize = 190;
    const avatarCenterY = 150;
    drawAvatar(ctx, avatarImg, centerX, avatarCenterY, avatarSize);

    const displayName = member.displayName || member.user.username;

    ctx.fillStyle = '#FFFFFF';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    ctx.font = '700 64px "Manrope", "Inter", sans-serif';
    ctx.fillText('WELCOME', centerX, avatarCenterY + avatarSize / 2 + 44);

    ctx.font = '600 48px "Manrope", "Inter", sans-serif';
    ctx.fillStyle = '#E5E7EB';
    ctx.fillText(`Welcome, ${displayName}!`, centerX, avatarCenterY + avatarSize / 2 + 120);

    const png = await canvas.encode('png');
    const buffer = Buffer.isBuffer(png) ? png : Buffer.from(png);
    return new AttachmentBuilder(buffer, { name: 'welcome.png' });
}

export function init({ client, logger, config }) {
    if (!config.welcome || typeof config.welcome !== 'object') {
        config.welcome = {};
    }

    client.on('guildMemberAdd', async (member) => {
        try {
            if (!member.guild) return;
            const welcomeCfg = config?.welcome?.[member.guild.id] || {};
            const mentionMap = welcomeCfg.mentions || {};
            const ch = await findWelcomeChannel(member.guild, welcomeCfg.channelId);
            if (!ch) return;

            // Plain helper line above the image
            const rules  = mentionFromConfig(member.guild, 'rules', mentionMap);
            const roles  = mentionFromConfig(member.guild, 'roles', mentionMap);
            const verify = mentionFromConfig(member.guild, 'verify', mentionMap);
            const messageTemplate = sanitizeWelcomeMessage(welcomeCfg.message);
            const rendered = renderWelcomeTemplate(messageTemplate, {
                user: `<@${member.id}>`,
                username: member.user?.username ?? member.user?.tag ?? member.id,
                usertag: member.user?.tag ?? member.user?.username ?? member.id,
                displayname: member.displayName ?? member.user?.globalName ?? member.user?.username ?? member.id,
                guild: member.guild.name ?? 'this server',
                rules,
                roles,
                verify,
                membercount: String(member.guild.memberCount ?? member.guild.approximateMemberCount ?? '')
            });
            await ch.send(rendered);

            const image = await buildWelcomeImage(member, logger);
            if (image) {
                await ch.send({ files: [image] });
            }
        } catch (e) {
            const name = member.guild?.name ?? member.guild?.id ?? 'unknown guild';
            const msg = e?.message || e;
            logger?.error?.(`[welcome] failed to send welcome in ${name}: ${msg}`);
        }
    });

    client.on('guildMemberRemove', async (member) => {
        try {
            if (!member.guild) return;
            const welcomeCfg = config?.welcome?.[member.guild.id] || {};
            const ch = await findWelcomeChannel(member.guild, welcomeCfg.channelId);
            if (!ch) return;
            const name = member.displayName || member.user?.username || 'A member';
            await ch.send(`👋 ${name} left the server.`);
        } catch (e) {
            const guildName = member.guild?.name ?? member.guild?.id ?? 'unknown guild';
            const msg = e?.message || e;
            logger?.error?.(`[welcome] failed to send goodbye in ${guildName}: ${msg}`);
        }
    });
}
