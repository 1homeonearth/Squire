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

    ctx.lineWidth = 8;
    ctx.strokeStyle = '#2563EB';
    ctx.beginPath();
    ctx.arc(x, y, radius - 6, 0, Math.PI * 2);
    ctx.closePath();
    ctx.stroke();
}

function fitFont(ctx, weight, family, text, maxWidth, startSize, minSize) {
    let size = startSize;
    while (size > minSize) {
        ctx.font = `${weight} ${size}px ${family}`;
        if (ctx.measureText(text).width <= maxWidth) {
            break;
        }
        size -= 2;
    }
    return Math.max(size, minSize);
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
    const height = 460;
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');

    // Background layers
    ctx.fillStyle = '#0F172A';
    ctx.fillRect(0, 0, width, height);
    fillRoundedRect(ctx, 28, 32, width - 56, height - 64, 44, '#1B2637');

    // Accent band across the top
    ctx.save();
    ctx.globalAlpha = 0.55;
    fillRoundedRect(ctx, 28, 32, width - 56, 160, 44, '#223248');
    ctx.restore();

    // Soft glow behind avatar
    const centerX = width / 2;
    const avatarSize = 150;
    const avatarCenterY = 170;
    const gradient = ctx.createRadialGradient(centerX, avatarCenterY, 10, centerX, avatarCenterY, avatarSize);
    gradient.addColorStop(0, 'rgba(37, 99, 235, 0.45)');
    gradient.addColorStop(1, 'rgba(37, 99, 235, 0)');
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(centerX, avatarCenterY, avatarSize * 0.95, 0, Math.PI * 2);
    ctx.fill();

    drawAvatar(ctx, avatarImg, centerX, avatarCenterY, avatarSize);

    const displayName = member.displayName || member.user.username;

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    const titleFont = fitFont(ctx, '700', 'Manrope, "Inter", sans-serif', 'WELCOME', width - 240, 64, 44);
    ctx.font = `700 ${titleFont}px "Manrope", "Inter", sans-serif`;
    ctx.fillStyle = '#FFFFFF';
    ctx.fillText('WELCOME', centerX, avatarCenterY + avatarSize / 2 + 52);

    const welcomeText = `Welcome, ${displayName}!`;
    const welcomeFont = fitFont(ctx, '600', 'Manrope, "Inter", sans-serif', welcomeText, width - 260, 40, 28);
    ctx.font = `600 ${welcomeFont}px "Manrope", "Inter", sans-serif`;
    ctx.fillStyle = '#E5E7EB';
    ctx.fillText(welcomeText, centerX, avatarCenterY + avatarSize / 2 + 120);

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
