// src/features/rainbow-bridge/setup-helpers.js
// Helper utilities for the Rainbow Bridge setup workflow.

function normalizeSelectionTokens(selectionIterable) {
    const tokens = new Set();
    if (!selectionIterable) {
        return tokens;
    }

    for (const raw of selectionIterable) {
        if (typeof raw !== 'string') continue;
        const [guildId, channelId] = raw.split(':');
        if (!guildId || !channelId) continue;
        tokens.add(`${guildId}:${channelId}`);
    }

    return tokens;
}

export function pruneBridgeChannels(bridge, selections) {
    if (!bridge || typeof bridge !== 'object') {
        return { removed: 0 };
    }

    const selectionTokens = selections instanceof Set
        ? normalizeSelectionTokens(selections)
        : normalizeSelectionTokens(selections ? Array.from(selections) : null);

    if (!selectionTokens.size) {
        return { removed: 0 };
    }

    const before = Array.isArray(bridge.channels) ? bridge.channels.length : 0;
    if (Array.isArray(bridge.channels)) {
        bridge.channels = bridge.channels.filter((channel) => {
            if (!channel || typeof channel !== 'object') return true;
            const guildId = channel.guildId ? String(channel.guildId) : null;
            const channelId = channel.channelId ? String(channel.channelId) : null;
            if (!guildId || !channelId) return true;
            const token = `${guildId}:${channelId}`;
            return !selectionTokens.has(token);
        });
    }

    if (bridge.forms && typeof bridge.forms === 'object') {
        for (const [formKey, form] of Object.entries(bridge.forms)) {
            if (!form || typeof form !== 'object') continue;
            const guildId = form.guildId ? String(form.guildId) : (formKey ? String(formKey) : null);
            const channelId = form.channelId ? String(form.channelId) : null;
            if (!guildId || !channelId) continue;
            const token = `${guildId}:${channelId}`;
            if (selectionTokens.has(token)) {
                delete bridge.forms[formKey];
            }
        }
    }

    const after = Array.isArray(bridge.channels) ? bridge.channels.length : 0;
    const removed = before - after;
    return { removed: removed > 0 ? removed : 0 };
}

export function __testables() {
    return { normalizeSelectionTokens };
}
