import fs from 'node:fs';
import path from 'node:path';

const appDir = path.resolve(process.cwd());
const samplePath = path.join(appDir, 'config.sample.json');
const existingPath = path.join(appDir, 'config.json');
const outPath = path.join(appDir, 'config.rendered.json');

function deepMerge(a, b) {
  if (Array.isArray(a) && Array.isArray(b)) return b.slice();
  if (a && typeof a === 'object' && b && typeof b === 'object') {
    const out = { ...a };
    for (const k of Object.keys(b)) out[k] = deepMerge(a?.[k], b[k]);
    return out;
  }
  return b === undefined ? a : b;
}

function resolveEnv(value, missing) {
  if (typeof value === 'string') {
    const m = value.match(/^\$ENV\{([A-Z0-9_]+)\}$/);
    if (m) {
      const key = m[1];
      const v = process.env[key];
      if (v === undefined) {
        missing.add(key);
        return '';
      }

      const trimmed = typeof v === 'string' ? v.trim() : '';
      if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
        try {
          return JSON.parse(trimmed);
        } catch (error) {
          console.warn(`[render-config] Failed to parse JSON from ${key}: ${error?.message ?? error}. Treating as string.`);
        }
      }

      return v;
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(v => resolveEnv(v, missing));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = resolveEnv(v, missing);
    return out;
  }
  return value;
}

function main() {
  const sample = JSON.parse(fs.readFileSync(samplePath, 'utf8'));
  const existing = fs.existsSync(existingPath) ? JSON.parse(fs.readFileSync(existingPath, 'utf8')) : {};
  const merged = deepMerge(sample, existing);
  const missing = new Set();
  const resolved = resolveEnv(merged, missing);

  if (missing.size) {
    console.error(`[render-config] Missing environment variables: ${[...missing].join(', ')}`);
    process.exit(1);
  }

  const tmp = `${outPath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(resolved, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, outPath);
  fs.renameSync(outPath, existingPath);
  console.log('[render-config] Wrote config.json from server environment.');
}

main();
