import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

const EXPORT_DIR = path.join(repoRoot, 'exports', 'bard');
const FEATURE_DIR = path.join(repoRoot, 'src', 'features');
const MODULES = [
    'logging-forwarder',
    'moderation-logging',
    'spotlight-gallery'
];

const SUPPORT_FILES = [
    path.join('src', 'lib', 'youtube.js'),
    path.join('src', 'lib', 'poll-format.js'),
    path.join('src', 'lib', 'display.js'),
    path.join('src', 'core', 'db.js')
];

async function ensureDir(dir) {
    await fs.mkdir(dir, { recursive: true });
}

async function copyEntry(src, dest) {
    const stat = await fs.stat(src);
    if (stat.isDirectory()) {
        await fs.cp(src, dest, { recursive: true });
        return;
    }
    await ensureDir(path.dirname(dest));
    await fs.copyFile(src, dest);
}

async function loadConfig() {
    const livePath = path.join(repoRoot, 'config.json');
    const samplePath = path.join(repoRoot, 'config.sample.json');

    let raw = '{}';
    try {
        raw = await fs.readFile(livePath, 'utf8');
    } catch {
        raw = await fs.readFile(samplePath, 'utf8');
    }

    try {
        return JSON.parse(raw);
    } catch (err) {
        throw new Error(`Unable to parse configuration JSON: ${err?.message ?? err}`);
    }
}

function extractExportConfig(config) {
    const safeObject = (value) => (value && typeof value === 'object' ? value : {});

    return {
        loggingServerId: config.loggingServerId ?? null,
        loggingChannels: safeObject(config.loggingChannels),
        mapping: safeObject(config.mapping),
        excludeChannels: safeObject(config.excludeChannels),
        excludeCategories: safeObject(config.excludeCategories),
        sampleRate: Number.isFinite(config.sampleRate) ? config.sampleRate : 1,
        forwardBots: !!config.forwardBots,
        moderationLogging: safeObject(config.moderationLogging),
        spotlightGallery: safeObject(config.spotlightGallery)
    };
}

async function writeConfigExport(config) {
    const exportConfig = extractExportConfig(config);
    const target = path.join(EXPORT_DIR, 'config.json');
    await ensureDir(path.dirname(target));
    const contents = JSON.stringify(exportConfig, null, 2);
    await fs.writeFile(target, contents, 'utf8');
}

async function exportModules() {
    await ensureDir(EXPORT_DIR);

    for (const moduleName of MODULES) {
        const srcDir = path.join(FEATURE_DIR, moduleName);
        const destDir = path.join(EXPORT_DIR, 'features', moduleName);
        await copyEntry(srcDir, destDir);
    }

    for (const relative of SUPPORT_FILES) {
        const src = path.join(repoRoot, relative);
        const dest = path.join(EXPORT_DIR, relative);
        await copyEntry(src, dest);
    }

    const config = await loadConfig();
    await writeConfigExport(config);
}

exportModules()
    .then(() => {
        process.stdout.write(`Exported modules to ${EXPORT_DIR}\n`);
    })
    .catch((err) => {
        console.error(`[export] Failed to prepare Bard bundle:`, err);
        process.exit(1);
    });
