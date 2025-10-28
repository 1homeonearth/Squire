// src/features/welcome-cards/index.js
import { AttachmentBuilder } from 'discord.js';
import { JSX, Builder, Font } from 'canvacord';

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
            avatarSource: '',
            bannerSource: null, // nullable
            headline: '',
            subtext: ''
        });
    }
    setDisplayName(v) { this.options.set('displayName', v); return this; }
    setAvatarSource(v) { this.options.set('avatarSource', v); return this; }
    setBannerSource(v) { this.options.set('bannerSource', v); return this; }
    setHeadline(v) { this.options.set('headline', v); return this; }
    setSubtext(v) { this.options.set('subtext', v); return this; }

    async render() {
        const { displayName, avatarSource, bannerSource, headline, subtext } = this.options.getOptions();
        const safeHeadline = headline || 'WELCOME';
        const safeDisplayName = displayName || 'New Member';
        const safeSubtext = subtext && String(subtext).trim().length > 0 ? subtext : null;

        const backgroundLayer = bannerSource
            ? createElement('img', {
                src: bannerSource,
                style: {
                    position: 'absolute',
                    inset: 0,
                    width: '100%',
                    height: '100%',
                    objectFit: 'cover'
                }
            })
            : createElement('div', {
                style: {
                    position: 'absolute',
                    inset: 0,
                    background: 'linear-gradient(135deg, #101828 0%, #0B1220 50%, #060913 100%)'
                }
            });

        const overlayLayer = createElement('div', {
            style: {
                position: 'absolute',
                inset: 0,
                background: 'linear-gradient(160deg, rgba(15,23,42,0.92) 0%, rgba(8,13,26,0.92) 60%, rgba(3,7,18,0.95) 100%)'
            }
        });

        const avatar = createElement(
            'div',
            {
                style: {
                    width: '168px',
                    height: '168px',
                    borderRadius: '50%',
                    background: 'linear-gradient(135deg, #2563EB 0%, #1D4ED8 100%)',
                    padding: '10px',
                    boxShadow: '0 22px 50px rgba(8,12,24,0.55)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center'
                }
            },
            createElement('img', {
                src: avatarSource,
                style: {
                    width: '100%',
                    height: '100%',
                    borderRadius: '50%'
                }
            })
        );

        const headlineNode = createElement('h1', {
            style: {
                margin: 0,
                marginTop: '32px',
                fontSize: '64px',
                fontWeight: 800,
                letterSpacing: '0.18em',
                textTransform: 'uppercase',
                color: '#FFFFFF',
                textAlign: 'center'
            }
        }, safeHeadline);

        const nameNode = createElement('p', {
            style: {
                margin: 0,
                marginTop: '18px',
                fontSize: '40px',
                fontWeight: 600,
                color: '#FFFFFF',
                textAlign: 'center'
            }
        }, safeDisplayName);

        const subtextNode = safeSubtext ? createElement('p', {
            style: {
                margin: 0,
                marginTop: '12px',
                fontSize: '26px',
                fontWeight: 500,
                color: '#C7D2FE',
                textAlign: 'center',
                letterSpacing: '0.04em'
            }
        }, safeSubtext) : null;

        const content = createElement(
            'div',
            {
                style: {
                    position: 'relative',
                    width: '100%',
                    height: '100%',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center'
                }
            },
            createElement(
                'div',
                {
                    style: {
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'center',
                        justifyContent: 'center',
                        padding: '48px 32px'
                    }
                },
                avatar,
                headlineNode,
                nameNode,
                subtextNode
            )
        );

        return createElement(
            'div',
            {
                style: {
                    position: 'relative',
                    width: '100%',
                    height: '100%',
                    borderRadius: '28px',
                    overflow: 'hidden'
                }
            },
            backgroundLayer,
            overlayLayer,
            content
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

    if (!avatarURL) {
        logger?.warn?.(`[welcome] missing avatar for ${member.user?.tag ?? member.id}`);
        return null;
    }

    const card = new WelcomeCard()
        .setDisplayName(member.displayName || member.user.globalName || member.user.username)
        .setAvatarSource(avatarURL)
        .setBannerSource(bannerURL)
        .setHeadline('WELCOME TO THE SERVER!')
        .setSubtext(`We're glad you're here, ${member.displayName || member.user.username}!`);

    const buffer = await card.build({ format: 'png' });
    return new AttachmentBuilder(buffer, { name: 'welcome.png' });
}

export function init({ client, logger, config }) {
    const welcomeCfg = config?.welcome || {};
    const mentionMap = welcomeCfg.mentions || {};

    client.on('guildMemberAdd', async (member) => {
        try {
            if (!member.guild) return;
            const ch = await findWelcomeChannel(member.guild, welcomeCfg.channelId);
            if (!ch) return;

            // Plain helper line above the image
            const rules  = mentionFromConfig(member.guild, 'rules', mentionMap);
            const roles  = mentionFromConfig(member.guild, 'roles', mentionMap);
            const verify = mentionFromConfig(member.guild, 'verify', mentionMap);
            const plainText = `Please read our ${rules}, select your ${roles}, and then ${verify} to unlock the full server.`;

            const image = await buildWelcomeImage(member, logger);
            if (image) {
                await ch.send({ content: plainText, files: [image] });
            } else {
                await ch.send(plainText);
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
