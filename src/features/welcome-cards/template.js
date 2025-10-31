export const LEGACY_DEFAULT_WELCOME_MESSAGE = 'Welcome {{user}} to {{guild}}!\nPlease read our {{rules}}, select your {{roles}}, and then {{verify}} to unlock the full server.';

export const DEFAULT_WELCOME_MESSAGE = `${LEGACY_DEFAULT_WELCOME_MESSAGE}\n`;

export const WELCOME_TEMPLATE_PLACEHOLDERS = [
    { token: '{{user}}', description: 'Mentions the new member.' },
    { token: '{{username}}', description: 'Discord username of the new member.' },
    { token: '{{usertag}}', description: 'Legacy username#discriminator tag if available.' },
    { token: '{{displayname}}', description: 'Server display name or global name for the member.' },
    { token: '{{guild}}', description: 'Name of the server that the member joined.' },
    { token: '{{rules}}', description: 'Configured rules channel mention or fallback text.' },
    { token: '{{roles}}', description: 'Configured roles channel mention or fallback text.' },
    { token: '{{verify}}', description: 'Configured verify channel mention or fallback text.' },
    { token: '{{membercount}}', description: 'Current cached member count for the server.' }
];

export function sanitizeWelcomeMessage(value) {
    if (typeof value !== 'string') {
        return DEFAULT_WELCOME_MESSAGE;
    }
    const normalized = value.replace(/\r\n/g, '\n');
    if (!normalized.trim()) {
        return DEFAULT_WELCOME_MESSAGE;
    }
    const limited = normalized.length > 2000 ? normalized.slice(0, 2000) : normalized;
    return limited;
}
