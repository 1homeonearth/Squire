import { describe, expect, it } from 'vitest';

import {
    DEFAULT_PROJECT_STATUS,
    MAX_PROJECT_LINES,
    generateProjectId,
    normalizeLines,
    normalizeProject,
    normalizeProjectLinerConfig,
    sanitizeProjectId,
    sanitizeSummary,
    sanitizeTitle
} from '../src/features/project-liner/index.js';

describe('project-liner normalization', () => {
    it('sanitizes titles, summaries, and lines when normalizing a project', () => {
        const source = {
            id: '  Launch  Plan  ',
            title: '  Launch Plan  ',
            summary: '  Coordinate everything for release.  ',
            lines: [' first item ', 'SECOND ITEM', 'second item'],
            status: 'active'
        };

        const normalized = normalizeProject(source);

        expect(normalized.id).toBe('launch-plan');
        expect(normalized.title).toBe('Launch Plan');
        expect(normalized.summary).toBe('Coordinate everything for release.');
        expect(normalized.lines).toEqual(['first item', 'SECOND ITEM']);
        expect(normalized.status).toBe('active');
    });

    it('generates unique identifiers when collisions occur', () => {
        const existing = ['launch-plan', 'launch-plan-2'];
        const next = generateProjectId('Launch Plan', 'Launch Plan', existing);
        expect(next).toBe('launch-plan-3');
    });

    it('limits projects to the configured maximum number of lines', () => {
        const lines = Array.from({ length: MAX_PROJECT_LINES + 5 }, (_, idx) => `Line ${idx}`);
        const normalized = normalizeLines(lines);
        expect(normalized.length).toBe(MAX_PROJECT_LINES);
    });

    it('keeps the active project nullable when explicitly cleared', () => {
        const config = normalizeProjectLinerConfig({
            projects: [
                { id: 'alpha', title: 'Alpha', lines: ['One'], status: DEFAULT_PROJECT_STATUS }
            ],
            activeProjectId: null
        });

        expect(config.activeProjectId).toBeNull();
    });

    it('falls back to the first project when the active id is invalid', () => {
        const config = normalizeProjectLinerConfig({
            projects: [
                { id: 'alpha', title: 'Alpha', lines: ['One'] },
                { id: 'beta', title: 'Beta', lines: ['Two'] }
            ],
            activeProjectId: 'missing'
        });

        expect(config.activeProjectId).toBe('alpha');
    });
});

describe('project-liner sanitizers', () => {
    it('sanitizes project ids consistently', () => {
        expect(sanitizeProjectId('  Fancy Name!!! ')).toBe('fancy-name');
        expect(sanitizeProjectId('')).toBeNull();
    });

    it('sanitizes titles and summaries', () => {
        expect(sanitizeTitle('   ')).toBe('Untitled project');
        expect(sanitizeSummary('  keep me  ')).toBe('keep me');
    });
});
