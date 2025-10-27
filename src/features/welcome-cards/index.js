// src/features/welcome-cards/index.js
import { AttachmentBuilder } from 'discord.js';
import { JSX, Builder, loadImage, Font } from 'canvacord';

// Load the built-in font once
Font.loadDefault();

// ---- Utility to find channels by name (case-insensitive)
function findByName(guild, name) {
    const n = name.toLowerCase();
    return guild.channels.cache.find(ch => ch.isTextBased?.() && ch.name.toLowerCase() === n) || null;
}

function mentionOrHash(guild, canon) {
    const ch = findByName(guild, canon);
    return ch ? `<#${ch.id}>` : `#${canon}`;
}

function findWelcomeChannel(guild) {
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

        return (
            <div className="w-full h-full rounded-xl overflow-hidden relative">
            {/* Background: banner if we have it, else a subtle gradient */}
            {bannerDataURL
                ? <img src={bannerDataURL} className="absolute inset-0 w-full h-full object-cover" />
                : <div className="absolute inset-0 bg-gradient-to-r from-[#23272A] to-[#2B2F35]" />}

                {/* Dark scrim so text stays readable */}
                <div className="absolute inset-0 bg-[#00000066]" />

                {/* Foreground */}
                <div className="relative w-full h-full flex flex-col items-center justify-center">
                <img src={avatarDataURL} className="h-[144] w-[144] rounded-full border-[8] border-[#FFFFFF] shadow-xl" />
                <h1 className="m-0 mt-5 text-[40] font-bold text-white tracking-wide">
                {headline}
                </h1>
                <p className="m-0 mt-2 text-[28] text-[#D1D5DB]">{displayName}</p>
                </div>
                </div>
        );
    }
}

async function buildWelcomeImage(member) {
    // Ensure we have the freshest user data (banners often require an explicit fetch)
    try { await member.user.fetch(true); } catch {}

    const avatarURL = member.displayAvatarURL({ extension: 'png', size: 512 });
    const bannerURL =
    member.user.bannerURL?.({ size: 2048, extension: 'png', dynamic: true }) ||
    member.displayBannerURL?.({ size: 2048, extension: 'png', dynamic: true }) ||
    null;

    const avatarImg = await loadImage(avatarURL);
    const bannerImg = bannerURL ? await loadImage(bannerURL).catch(() => null) : null;

    const card = new WelcomeCard()
    .setDisplayName(member.displayName || member.user.username)
    .setAvatarDataURL(avatarImg.toDataURL())
    .setBannerDataURL(bannerImg ? bannerImg.toDataURL() : null)
    .setHeadline('just joined the server!');

    const buffer = await card.build({ format: 'png' });
    return new AttachmentBuilder(buffer, { name: 'welcome.png' });
}

export function init(client) {
    client.on('guildMemberAdd', async (member) => {
        try {
            const ch = findWelcomeChannel(member.guild);
            if (!ch) return;

            // Plain helper line above the image
            const rules  = mentionOrHash(member.guild, 'rules');
            const roles  = mentionOrHash(member.guild, 'roles');
            const verify = mentionOrHash(member.guild, 'verify');
            await ch.send(`Please read our ${rules}, select your ${roles}, and then ${verify} to unlock the full server.`);

            const image = await buildWelcomeImage(member);
            await ch.send({ files: [image] });
        } catch (e) {
            console.error(`[welcome] failed to send welcome in ${member.guild?.name}:`, e?.message || e);
        }
    });

    client.on('guildMemberRemove', async (member) => {
        try {
            const ch = findWelcomeChannel(member.guild);
            if (!ch) return;
            const name = member.displayName || member.user?.username || 'A member';
            await ch.send(`👋 ${name} left the server.`);
        } catch (e) {
            console.error(`[welcome] failed to send goodbye in ${member.guild?.name}:`, e?.message || e);
        }
    });
}
