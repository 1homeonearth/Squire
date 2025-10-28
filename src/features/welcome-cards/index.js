// src/features/welcome-cards/index.js
import { AttachmentBuilder } from 'discord.js';
import { JSX, Builder, loadImage, Font } from 'canvacord';

const { createElement } = JSX;

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

// ---- Welcome Card builder (avatar on top of user banner)
class WelcomeCard extends Builder {
    constructor() {
        super(1000, 360);
        this.bootstrap({
            displayName: '',
            avatarDataURL: '',
            bannerDataURL: null, // nullable
            headline: ''
        });
    }
    setDisplayName(v) { this.options.set('displayName', v); return this; }
    setAvatarDataURL(v) { this.options.set('avatarDataURL', v); return this; }
    setBannerDataURL(v) { this.options.set('bannerDataURL', v); return this; }
    setHeadline(v) { this.options.set('headline', v); return this; }

    async render() {
        const { displayName, avatarDataURL, bannerDataURL, headline } = this.options.getOptions();

        const background = bannerDataURL
            ? createElement('img', {
                src: bannerDataURL,
                className: 'absolute inset-0 w-full h-full object-cover'
            })
            : createElement('div', {
                className: 'absolute inset-0 bg-linear-to-r from-[#23272A] to-[#2B2F35]'
            });

        return createElement(
            'div',
            { className: 'w-full h-full rounded-xl overflow-hidden relative' },
            background,
            createElement('div', {
                className: 'absolute inset-0 bg-[#00000066]'
            }),
            createElement(
                'div',
                { className: 'relative w-full h-full flex flex-col items-center justify-center' },
                createElement('img', {
                    src: avatarDataURL,
                    className: 'h-[144] w-[144] rounded-full border-[8] border-[#FFFFFF] shadow-xl'
                }),
                createElement(
                    'h1',
                    { className: 'm-0 mt-5 text-[40] font-bold text-white tracking-wide' },
                    headline
                ),
                createElement(
                    'p',
                    { className: 'm-0 mt-2 text-[28] text-[#D1D5DB]' },
                    displayName
                )
            )
        );
    }
}

async function buildWelcomeImage(member, logger) {
    // Ensure we have the freshest user data (banners often require an explicit fetch)
    try { await member.user.fetch(true); } catch {}

    const avatarURL = member.displayAvatarURL({ extension: 'png', size: 512 });
    const bannerURL =
    member.user.bannerURL?.({ size: 2048, extension: 'png', dynamic: true }) ||
    member.displayBannerURL?.({ size: 2048, extension: 'png', dynamic: true }) ||
    null;

    let avatarImg = null;
    try {
        avatarImg = await loadImage(avatarURL);
    } catch (err) {
        logger?.warn?.(`[welcome] failed to load avatar for ${member.user?.tag ?? member.id}: ${err?.message ?? err}`);
        return null;
    }

    const bannerImg = bannerURL ? await loadImage(bannerURL).catch(() => null) : null;

    const card = new WelcomeCard()
        .setDisplayName(member.displayName || member.user.username)
        .setAvatarDataURL(avatarImg.toDataURL())
        .setBannerDataURL(bannerImg ? bannerImg.toDataURL() : null)
        .setHeadline('WELCOME');

    const buffer = await card.build({ format: 'png' });
    return new AttachmentBuilder(buffer, { name: 'welcome.png' });
}

export function init({ client, logger, config }) {
    if (!config.welcome || typeof config.welcome !== 'object') {
        config.welcome = {};
    }

    client.on('guildMemberAdd', async (member) => {
        try {
            if (!member.guild) return;
            const welcomeCfg = config?.welcome || {};
            const mentionMap = welcomeCfg.mentions || {};
            const ch = await findWelcomeChannel(member.guild, welcomeCfg.channelId);
            if (!ch) return;

            // Plain helper line above the image
            const rules  = mentionFromConfig(member.guild, 'rules', mentionMap);
            const roles  = mentionFromConfig(member.guild, 'roles', mentionMap);
            const verify = mentionFromConfig(member.guild, 'verify', mentionMap);
            await ch.send(`Please read our ${rules}, select your ${roles}, and then ${verify} to unlock the full server.`);

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
            const welcomeCfg = config?.welcome || {};
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
