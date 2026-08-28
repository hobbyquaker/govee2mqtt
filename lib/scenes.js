/**
 * Govee's public scene library: `GET app2.govee.com/appsku/v1/light-effect-libraries?sku=<SKU>`
 * (no key, no login; only an `AppVersion` header) returns the scenes the app shows for a SKU with
 * the `scenceParam` blobs the packet encoder needs. Cached on disk per SKU so scenes work while
 * Govee is unreachable (ROADMAP G-6). `parseLibrary()` and the name handling are pure.
 */

import fs from 'node:fs';
import path from 'node:path';

export const LIBRARY_URL = 'https://app2.govee.com/appsku/v1/light-effect-libraries';
const APP_VERSION = '5.6.01';
const DAY = 24 * 3600 * 1000;

/** `Sunset Glow` → `sunset_glow`, `Mother's Day` → `mothers_day`, `Rubik's Cube` → `rubiks_cube`. */
export function sceneName(name) {
    return String(name)
        .toLowerCase()
        .replace(/['’]/g, '')
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');
}

/**
 * Flatten a library response into scenes.
 * @param {object} json the response body
 * @returns {Array<{name: string, label: string, category: string, sceneId: number, sceneCode: number,
 *          scenceParam: string, scenceParamId: number, sceneType: number, supSpeed: boolean}>}
 */
export function parseLibrary(json) {
    const out = [];
    const categories = json?.data?.categories;
    if (!Array.isArray(categories)) {
        throw new Error('unexpected scene library response');
    }
    for (const category of categories) {
        for (const s of category.scenes || []) {
            const effects = (s.lightEffects || []).filter((e) => e.sceneCode);
            effects.forEach((e, i) => {
                const label = effects.length > 1 && e.scenceName ? `${s.sceneName} ${e.scenceName}` : s.sceneName;
                out.push({
                    name: sceneName(effects.length > 1 && !e.scenceName ? `${s.sceneName}_${i + 1}` : label),
                    label,
                    category: category.categoryName,
                    sceneId: s.sceneId,
                    sceneCode: e.sceneCode,
                    scenceParam: e.scenceParam || '',
                    scenceParamId: e.scenceParamId,
                    sceneType: e.sceneType,
                    supSpeed: Boolean(e.speedInfo?.supSpeed),
                });
            });
        }
    }
    return out;
}

/**
 * Per-SKU scene lists with a disk cache.
 *
 * @param {object} options
 * @param {string} [options.cacheDir] directory for `scenes-<sku>.json` (none = memory only)
 * @param {number} [options.refreshDays] refetch after this many days (0 = never refetch a cached list)
 * @param {Function} [options.fetch] fetch override (tests)
 * @param {object} [options.log]
 */
export class SceneLibrary {
    constructor({cacheDir, refreshDays = 7, fetch: fetchFn = globalThis.fetch, log} = {}) {
        this.cacheDir = cacheDir;
        this.refreshDays = refreshDays;
        this.fetchFn = fetchFn;
        this.log = log;
        this.cache = new Map(); // sku → {scenes, fetched}
        this.pending = new Map();
    }

    cacheFile(sku) {
        return this.cacheDir ? path.join(this.cacheDir, `scenes-${sku.toLowerCase()}.json`) : null;
    }

    loadFile(sku) {
        const file = this.cacheFile(sku);
        if (!file || !fs.existsSync(file)) {
            return null;
        }
        try {
            const {fetched, json} = JSON.parse(fs.readFileSync(file, 'utf8'));
            return {scenes: parseLibrary(json), fetched: Number(fetched) || 0};
        } catch (err) {
            this.log?.warn('scene cache unreadable', file, '-', err.message);
            return null;
        }
    }

    saveFile(sku, json) {
        const file = this.cacheFile(sku);
        if (!file) {
            return;
        }
        try {
            fs.mkdirSync(this.cacheDir, {recursive: true});
            fs.writeFileSync(file, JSON.stringify({fetched: Date.now(), sku, json}));
        } catch (err) {
            this.log?.warn('cannot write scene cache', file, '-', err.message);
        }
    }

    async fetch(sku) {
        const res = await this.fetchFn(`${LIBRARY_URL}?sku=${encodeURIComponent(sku)}`, {
            headers: {AppVersion: APP_VERSION, 'User-Agent': `GoveeHome/${APP_VERSION}`},
            signal: AbortSignal.timeout(15000),
        });
        if (!res.ok) {
            throw new Error(`scene library HTTP ${res.status}`);
        }
        const json = await res.json();
        const scenes = parseLibrary(json);
        this.saveFile(sku, json);
        return {scenes, fetched: Date.now()};
    }

    /**
     * Scenes of a SKU: from memory, else the disk cache, else Govee; a stale cache is refreshed
     * in the background and served meanwhile; a failed fetch with a cache logs and serves the cache.
     * @returns {Promise<Array>} scenes (empty when nothing is available)
     */
    async get(sku) {
        sku = String(sku).toUpperCase();
        let entry = this.cache.get(sku) || this.loadFile(sku);
        if (entry) {
            this.cache.set(sku, entry);
            const stale = this.refreshDays > 0 && Date.now() - entry.fetched > this.refreshDays * DAY;
            if (stale) {
                this.refresh(sku).catch(() => {});
            }
            return entry.scenes;
        }
        try {
            entry = await this.refresh(sku);
            return entry.scenes;
        } catch (err) {
            this.log?.warn('scene library', sku, '-', err.message);
            return [];
        }
    }

    refresh(sku) {
        if (!this.pending.has(sku)) {
            const p = this.fetch(sku)
                .then((entry) => {
                    this.cache.set(sku, entry);
                    this.log?.info('scene library', sku, `${entry.scenes.length} scenes`);
                    return entry;
                })
                .finally(() => this.pending.delete(sku));
            this.pending.set(sku, p);
        }
        return this.pending.get(sku);
    }

    /** Find a scene by normalised name, label, sceneCode or sceneId. */
    static find(scenes, key) {
        if (key && typeof key === 'object') {
            key = key.name ?? key.code ?? key.id;
        }
        const s = String(key ?? '').trim();
        if (!s) {
            return undefined;
        }
        if (/^\d+$/.test(s)) {
            const n = Number(s);
            return scenes.find((x) => x.sceneCode === n) || scenes.find((x) => x.sceneId === n);
        }
        const name = sceneName(s);
        return scenes.find((x) => x.name === name);
    }
}
