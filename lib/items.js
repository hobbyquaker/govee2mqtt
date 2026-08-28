/**
 * Payload parsing for `set/<dev>/<item>` (ROADMAP §4.5). Pure: input → a normalised command
 * object; the caller (index.js) executes it. Read tolerantly, write strictly.
 */

import {toBoolean, clampInt} from 'mqtt-interfaces-core';

export const SET_ITEMS = ['power', 'brightness', 'color', 'color_temp', 'scene', 'music', 'refresh', 'raw'];

/** `{r,g,b}` object, `#rrggbb`, `rrggbb`, `r,g,b` → {r, g, b}. */
export function parseColor(value) {
    if (value && typeof value === 'object') {
        const {r, g, b} = value;
        if ([r, g, b].every((v) => Number.isFinite(Number(v)))) {
            return {r: clampInt(r, 0, 255), g: clampInt(g, 0, 255), b: clampInt(b, 0, 255)};
        }
        throw new Error('color object needs r, g, b');
    }
    const s = String(value ?? '').trim();
    const hex = s.match(/^#?([0-9a-fA-F]{6})$/);
    if (hex) {
        const n = parseInt(hex[1], 16);
        return {r: n >> 16, g: (n >> 8) & 0xff, b: n & 0xff};
    }
    const parts = s.split(/[\s,;]+/).filter(Boolean);
    if (parts.length === 3 && parts.every((p) => /^\d+$/.test(p))) {
        return {r: clampInt(parts[0], 0, 255), g: clampInt(parts[1], 0, 255), b: clampInt(parts[2], 0, 255)};
    }
    if (s.startsWith('{')) {
        return parseColor(JSON.parse(s));
    }
    throw new Error(`cannot parse color "${s}"`);
}

/**
 * @param {string} item set item
 * @param {*} value parsed payload (plain or the `val` of a JSON payload)
 * @param {{rawSet?: boolean, colorTemp?: {min: number, max: number}}} [options]
 * @returns {{type: string, [key: string]: *}}
 */
export function commandFor(item, value, {rawSet = false, colorTemp = {min: 2000, max: 9000}} = {}) {
    switch (item) {
        case 'power':
            return {type: 'power', on: toBoolean(value)};
        case 'brightness': {
            const n = Number(value);
            if (!Number.isFinite(n)) {
                throw new Error(`brightness needs a number, got "${value}"`);
            }
            if (n <= 0) {
                return {type: 'power', on: false};
            }
            return {type: 'brightness', percent: clampInt(n, 1, 100)};
        }
        case 'color':
            return {type: 'color', color: parseColor(value)};
        case 'color_temp': {
            const n = Number(value);
            if (!Number.isFinite(n) || n <= 0) {
                throw new Error(`color_temp needs kelvin, got "${value}"`);
            }
            return {type: 'color_temp', kelvin: clampInt(n, colorTemp.min, colorTemp.max)};
        }
        case 'scene': {
            let key = value;
            let speed;
            if (typeof value === 'string' && value.trim().startsWith('{')) {
                value = JSON.parse(value);
            }
            if (value && typeof value === 'object') {
                key = value.name ?? value.code ?? value.id;
                if (value.speed !== undefined) {
                    speed = clampInt(value.speed, 0, 100);
                }
            }
            if (key === undefined || key === null || String(key).trim() === '') {
                throw new Error('scene needs a name or code');
            }
            return {type: 'scene', key: String(key).trim(), speed};
        }
        case 'music': {
            const key = String(value ?? '')
                .trim()
                .toLowerCase();
            if (!key) {
                throw new Error('music needs a mode name');
            }
            return {type: 'music', key};
        }
        case 'refresh':
            return {type: 'refresh'};
        case 'raw':
            if (!rawSet) {
                throw new Error('set/raw is disabled (start with --raw-set to enable)');
            }
            return {type: 'raw', frames: value};
        default:
            throw new Error(`unknown set item "${item}"`);
    }
}
