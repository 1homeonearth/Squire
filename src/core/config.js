// src/core/config.js
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.resolve(__dir, '../../config.json');

export function loadConfig() {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    return JSON.parse(raw);
}

export function writeConfig(next) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2));
}
