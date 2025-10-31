import { describe, expect, it } from 'vitest';

import { sanitizeWelcomeMessage } from '../src/features/welcome-cards/template.js';

describe('sanitizeWelcomeMessage', () => {
    it('converts literal \n sequences into newline characters', () => {
        const input = 'Welcome {{user}}!\\nLine two';
        const result = sanitizeWelcomeMessage(input);
        expect(result).toBe('Welcome {{user}}!\nLine two');
    });
});
