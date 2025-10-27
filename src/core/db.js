// src/core/db.js
import Loki from 'lokijs';

export async function createDb(dbPath) {
    return await new Promise((resolve) => {
        const db = new Loki(dbPath, {
            autosave: true,
            autosaveInterval: 750,
            autoload: true,
            autoloadCallback: () => resolve(db)
        });
    });
}

export function ensureCollection(db, name, opts) {
    return db.getCollection(name) || db.addCollection(name, opts || {});
}
