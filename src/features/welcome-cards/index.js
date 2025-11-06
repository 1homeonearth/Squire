// src/features/welcome-cards/index.js
import { createCanvas, loadImage as loadCanvasImage } from '@napi-rs/canvas';
import { AttachmentBuilder, PermissionFlagsBits } from 'discord.js';
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
    const borderWidth = Math.max(6, Math.round(size * 0.08));
    const radius = size / 2;
    const innerRadius = radius - borderWidth / 2;
    const innerSize = innerRadius * 2;

    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, innerRadius, 0, Math.PI * 2);
    ctx.closePath();
    ctx.clip();
    ctx.drawImage(img, x - innerRadius, y - innerRadius, innerSize, innerSize);
    ctx.restore();

    ctx.lineWidth = borderWidth;
    ctx.strokeStyle = '#2563EB';
    ctx.beginPath();
    ctx.arc(x, y, innerRadius, 0, Math.PI * 2);
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

async function buildWelcomeImage(member, headerConfig, logger) {
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
    ctx.fillStyle = '#0B1220';
    ctx.fillRect(0, 0, width, height);
    fillRoundedRect(ctx, 28, 32, width - 56, height - 64, 44, '#152032');

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

    const headerLine1 = String(headerConfig?.line1 ?? 'Welcome');
    const usernameText = member.user?.username
        ?? member.displayName
        ?? member.user?.tag
        ?? member.id;
    const headerLine2 = String(headerConfig?.line2 ?? usernameText);

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    const titleFont = fitFont(ctx, '700', 'Manrope, "Inter", sans-serif', headerLine1, width - 240, 64, 44);
    ctx.font = `700 ${titleFont}px "Manrope", "Inter", sans-serif`;
    ctx.fillStyle = '#FFFFFF';
    ctx.fillText(headerLine1, centerX, avatarCenterY + avatarSize / 2 + 52);

    const welcomeFont = fitFont(ctx, '600', 'Manrope, "Inter", sans-serif', headerLine2, width - 260, 40, 28);
    ctx.font = `600 ${welcomeFont}px "Manrope", "Inter", sans-serif`;
    ctx.fillStyle = '#E5E7EB';
    ctx.fillText(headerLine2, centerX, avatarCenterY + avatarSize / 2 + 120);

    const png = await canvas.encode('png');
    const buffer = Buffer.isBuffer(png) ? png : Buffer.from(png);
    return new AttachmentBuilder(buffer, { name: 'welcome.png' });
}

export function init({ client, logger, config }) {
    if (!config.welcome || typeof config.welcome !== 'object') {
        config.welcome = {};
    }

    let currentConfig = config;
    let crossIndex = buildCrossVerificationIndex(currentConfig);
    const autobannedMembers = new Map(); // key -> timeout handle
    const welcomeMessages = new Map(); // key -> { channelId, messageId, messageRef, timeout }
    const welcomeCleanupTimers = new Map();

    const rememberAutoban = (guildId, userId) => {
        if (!guildId || !userId) return;
        const key = `${guildId}:${userId}`;
        const existing = autobannedMembers.get(key);
        if (existing) clearTimeout(existing);
        const timeout = setTimeout(() => {
            autobannedMembers.delete(key);
        }, 5 * 60 * 1000);
        autobannedMembers.set(key, timeout);
    };

    const isMarkedAutoban = (guildId, userId) => {
        if (!guildId || !userId) return false;
        const key = `${guildId}:${userId}`;
        return autobannedMembers.has(key);
    };

    const clearAutoban = (guildId, userId) => {
        if (!guildId || !userId) return;
        const key = `${guildId}:${userId}`;
        const handle = autobannedMembers.get(key);
        if (handle) {
            clearTimeout(handle);
            autobannedMembers.delete(key);
        }
    };

    const wasAutobanned = (guildId, userId) => {
        const key = `${guildId}:${userId}`;
        const handle = autobannedMembers.get(key);
        if (!handle) return false;
        clearTimeout(handle);
        autobannedMembers.delete(key);
        return true;
    };

    const trackWelcomeMessage = (guildId, userId, message) => {
        if (!guildId || !userId || !message) return;
        const messageId = message.id ?? null;
        const channelId = message.channelId ?? message.channel?.id ?? null;
        if (!messageId || !channelId) return;
        const key = `${guildId}:${userId}`;
        const existing = welcomeMessages.get(key);
        if (existing?.timeout) clearTimeout(existing.timeout);
        const timeout = setTimeout(() => {
            welcomeMessages.delete(key);
        }, 10 * 60 * 1000);
        welcomeMessages.set(key, {
            channelId,
            messageId,
            messageRef: typeof message.delete === 'function' ? message : null,
            timeout
        });
    };

    const clearTrackedWelcomeMessage = (key) => {
        const entry = welcomeMessages.get(key);
        if (entry?.timeout) {
            clearTimeout(entry.timeout);
        }
        welcomeMessages.delete(key);
        const retryTimer = welcomeCleanupTimers.get(key);
        if (retryTimer) {
            clearTimeout(retryTimer);
            welcomeCleanupTimers.delete(key);
        }
        return entry ?? null;
    };

    const scheduleCleanupRetry = (guildId, userId, attempt, maxAttempts, channelHint) => {
        const key = `${guildId}:${userId}`;
        const delay = Math.min(1000, 250 * (attempt + 1));
        const existing = welcomeCleanupTimers.get(key);
        if (existing) clearTimeout(existing);
        const timer = setTimeout(() => {
            welcomeCleanupTimers.delete(key);
            purgeWelcomeMessage(guildId, userId, { attempt: attempt + 1, maxAttempts, channelHint });
        }, delay);
        welcomeCleanupTimers.set(key, timer);
    };

    async function purgeWelcomeMessage(guildId, userId, { attempt = 0, maxAttempts = 6, channelHint = null } = {}) {
        if (!guildId || !userId) return;
        const key = `${guildId}:${userId}`;
        const entry = clearTrackedWelcomeMessage(key);

        if (!entry) {
            if (attempt < maxAttempts) {
                scheduleCleanupRetry(guildId, userId, attempt, maxAttempts, channelHint);
            }
            return;
        }

        const candidateChannelId = entry.channelId ?? channelHint ?? null;

        if (entry.messageRef && typeof entry.messageRef.delete === 'function') {
            try {
                await entry.messageRef.delete();
                return;
            } catch (err) {
                logger?.warn?.(`[welcome] Failed to delete welcome card message ${entry.messageId} directly: ${err?.message ?? err}`);
            }
        }

        if (!candidateChannelId) {
            return;
        }

        let channel = client.channels?.cache?.get?.(candidateChannelId) ?? null;
        if (!channel && typeof client.channels?.fetch === 'function') {
            try {
                channel = await client.channels.fetch(candidateChannelId);
            } catch {}
        }
        if (!channel?.isTextBased?.()) {
            return;
        }

        try {
            const messagesManager = channel.messages ?? null;
            if (!messagesManager) return;
            let message = messagesManager.cache?.get?.(entry.messageId) ?? null;
            if (!message && typeof messagesManager.fetch === 'function') {
                try {
                    message = await messagesManager.fetch(entry.messageId);
                } catch {}
            }

            if (message && typeof message.delete === 'function') {
                await message.delete();
                return;
            }

            if (typeof messagesManager.delete === 'function') {
                await messagesManager.delete(entry.messageId);
            }
        } catch (err) {
            logger?.warn?.(`[welcome] Failed to remove welcome card ${entry.messageId} from ${candidateChannelId}: ${err?.message ?? err}`);
        }
    }

    client.on('squire:configUpdated', (nextConfig) => {
        if (!nextConfig) return;
        currentConfig = nextConfig;
        crossIndex = buildCrossVerificationIndex(currentConfig);
    });

    const markAutoban = (payload) => {
        const guildId = payload?.guildId;
        const userId = payload?.userId;
        rememberAutoban(guildId, userId);
    };

    client.on('squire:autoban:pending', markAutoban);

    client.on('squire:autoban:banned', (payload) => {
        const guildId = payload?.guildId;
        const userId = payload?.userId;
        const welcomeChannelId = payload?.welcomeChannelId ?? null;
        rememberAutoban(guildId, userId);
        purgeWelcomeMessage(guildId, userId, { channelHint: welcomeChannelId });
    });

    client.on('squire:autoban:failed', (payload) => {
        const guildId = payload?.guildId;
        const userId = payload?.userId;
        clearAutoban(guildId, userId);
    });

    client.on('guildMemberAdd', async (member) => {
        try {
            if (!member.guild) return;

            if (wasAutobanned(member.guild.id, member.id)) {
                logger?.debug?.(`[welcome] Skipping welcome flow for ${member.id} in ${member.guild.id} due to autoban.`);
                return;
            }

            const guildEntry = currentConfig?.welcome?.[member.guild.id];
            if (!guildEntry || guildEntry.enabled === false) {
                return;
            }

            const channel = await findWelcomeChannel(member.guild, guildEntry.channelId);
            if (!channel) {
                logger?.warn?.(`[welcome] No accessible welcome channel for ${member.guild.name ?? member.guild.id}.`);
                return;
            }

            const mentionMap = guildEntry.mentions && typeof guildEntry.mentions === 'object'
                ? guildEntry.mentions
                : {};

            const preImageText = guildEntry.isCustomized === false
                ? DEFAULT_WELCOME_MESSAGE
                : sanitizeWelcomeMessage(guildEntry.preImageText ?? guildEntry.message ?? DEFAULT_WELCOME_MESSAGE);

            const rendered = renderWelcomeTemplate(preImageText, {
                user: `<@${member.id}>`,
                username: member.user?.username ?? member.user?.tag ?? member.id,
                usertag: member.user?.tag ?? member.user?.username ?? member.id,
                displayname: member.displayName ?? member.user?.globalName ?? member.user?.username ?? member.id,
                guild: member.guild.name ?? 'this server',
                rules: mentionFromConfig(member.guild, 'rules', mentionMap),
                roles: mentionFromConfig(member.guild, 'roles', mentionMap),
                verify: mentionFromConfig(member.guild, 'verify', mentionMap),
                membercount: String(member.guild.memberCount ?? member.guild.approximateMemberCount ?? '')
            });

            const crossResult = await determineCrossVerification({
                client,
                member,
                currentGuildId: member.guild.id,
                index: crossIndex
            });

            const rolesConfig = guildEntry.roles || {};
            const moderatorRoleId = rolesConfig.moderatorRoleId ?? null;
            const crossVerifiedRoleId = rolesConfig.crossVerifiedRoleId ?? null;
            const unverifiedRoleId = rolesConfig.unverifiedRoleId ?? null;

            const roleMentions = [];
            const contentParts = [];

            if (crossResult.isCrossVerified) {
                if (moderatorRoleId) {
                    const moderatorRole = await resolveRole(member.guild, moderatorRoleId);
                    if (moderatorRole) {
                        if (canMentionRole(channel, moderatorRole)) {
                            roleMentions.push(moderatorRoleId);
                            contentParts.push(`<@&${moderatorRoleId}> User is cross-verified.`);
                        } else {
                            logger?.warn?.(`[welcome] Cannot mention moderator role ${moderatorRoleId} in ${member.guild.id}; missing permissions or role not mentionable.`);
                        }
                    } else {
                        logger?.warn?.(`[welcome] Configured moderator role ${moderatorRoleId} missing in ${member.guild.id}.`);
                    }
                }

                if (crossVerifiedRoleId) {
                    const success = await assignRoleWithRetry(member, crossVerifiedRoleId, logger, { label: 'cross-verified role' });
                    if (!success) {
                        logger?.warn?.(`[welcome] Failed to assign cross-verified role ${crossVerifiedRoleId} to ${member.id} in ${member.guild.id}.`);
                    }
                } else {
                    logger?.warn?.(`[welcome] ${member.id} is cross-verified but no cross-verified role configured in ${member.guild.id}.`);
                }
            } else if (unverifiedRoleId) {
                const success = await assignRoleWithRetry(member, unverifiedRoleId, logger, { label: 'unverified role' });
                if (!success) {
                    logger?.warn?.(`[welcome] Failed to assign unverified role ${unverifiedRoleId} to ${member.id} in ${member.guild.id}.`);
                }
            } else {
                logger?.warn?.(`[welcome] No unverified autorole configured for ${member.guild.id}.`);
            }

            contentParts.push(rendered);
            const content = contentParts.join('\n');

            const headerLine2 = buildHeaderLine2(guildEntry, member);
            const headerConfig = {
                line1: guildEntry.headerLine1 || 'Welcome',
                line2: headerLine2
            };
            const image = await buildWelcomeImage(member, headerConfig, logger);

            const allowedMentions = { users: [member.id] };
            if (roleMentions.length) {
                allowedMentions.roles = Array.from(new Set(roleMentions));
            }

            const payload = {
                content: content || ' ',
                allowedMentions
            };
            if (image) {
                payload.files = [image];
            }

            const sentMessage = await channel.send(payload);
            trackWelcomeMessage(member.guild.id, member.id, sentMessage);
        } catch (e) {
            const name = member.guild?.name ?? member.guild?.id ?? 'unknown guild';
            const msg = e?.message || e;
            logger?.error?.(`[welcome] failed to send welcome in ${name}: ${msg}`);
        }
    });

    client.on('guildMemberRemove', async (member) => {
        try {
            if (!member.guild) return;
            if (isMarkedAutoban(member.guild.id, member.id)) {
                logger?.debug?.(`[welcome] Suppressing farewell for ${member.id} in ${member.guild.id} due to autoban.`);
                clearAutoban(member.guild.id, member.id);
                return;
            }
            const welcomeCfg = currentConfig?.welcome?.[member.guild.id] || {};
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

function buildCrossVerificationIndex(config) {
    const welcomeConfig = config?.welcome && typeof config.welcome === 'object' ? config.welcome : {};
    const allowedGuilds = new Set((config?.mainServerIds ?? []).map(String));
    const entries = [];
    for (const [guildId, entry] of Object.entries(welcomeConfig)) {
        if (!guildId) continue;
        if (allowedGuilds.size && !allowedGuilds.has(guildId)) continue;
        const verifiedRoleId = entry?.roles?.verifiedRoleId ?? null;
        if (verifiedRoleId) {
            entries.push({ guildId, verifiedRoleId });
        }
    }
    return entries;
}

async function determineCrossVerification({ client, member, currentGuildId, index }) {
    if (!Array.isArray(index) || index.length === 0) {
        return { isCrossVerified: false, guilds: [] };
    }

    const matches = [];
    for (const entry of index) {
        if (!entry?.guildId || entry.guildId === currentGuildId || !entry.verifiedRoleId) continue;
        const guild = client.guilds.cache.get(entry.guildId) ?? await client.guilds.fetch(entry.guildId).catch(() => null);
        if (!guild) continue;
        let otherMember = guild.members.cache.get(member.id);
        if (!otherMember) {
            try {
                otherMember = await guild.members.fetch({ user: member.id, force: false });
            } catch {}
        }
        if (!otherMember) continue;
        if (otherMember.roles?.cache?.has(entry.verifiedRoleId)) {
            matches.push({ guildId: entry.guildId, guildName: guild.name ?? entry.guildId });
        }
    }

    return { isCrossVerified: matches.length > 0, guilds: matches };
}

async function assignRoleWithRetry(member, roleId, logger, { label = 'role', attempts = 3, delayMs = 500 } = {}) {
    if (!roleId || !member?.roles?.add) return false;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
            await member.roles.add(roleId);
            return true;
        } catch (err) {
            const lastAttempt = attempt === attempts;
            logger?.warn?.(`[welcome] Failed to assign ${label} ${roleId} to ${member.id} (attempt ${attempt}/${attempts}): ${err?.message ?? err}`);
            if (lastAttempt) {
                return false;
            }
            await new Promise(resolve => setTimeout(resolve, delayMs * attempt));
        }
    }
    return false;
}

async function resolveRole(guild, roleId) {
    if (!guild || !roleId) return null;
    const cached = guild.roles.cache.get(roleId);
    if (cached) return cached;
    try {
        return await guild.roles.fetch(roleId);
    } catch {
        return null;
    }
}

function canMentionRole(channel, role) {
    if (!channel || !role) return false;
    if (role.mentionable) return true;
    const me = channel.guild?.members?.me ?? null;
    if (!me) return false;
    const perms = typeof channel.permissionsFor === 'function' ? channel.permissionsFor(me) : null;
    return perms?.has?.(PermissionFlagsBits.MentionEveryone) ?? false;
}

function buildHeaderLine2(entry, member) {
    const template = typeof entry?.headerLine2Template === 'string' ? entry.headerLine2Template : '{username}';
    const username = member.user?.username ?? member.displayName ?? member.user?.tag ?? member.id;
    return template.replace('{username}', username);
}
