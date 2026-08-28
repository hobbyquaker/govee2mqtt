/**
 * Per-SKU data: how a scene library `scenceParam` is wrapped into `0xa3` frames (the AlgoClaw
 * v1.2 recipe, https://github.com/AlgoClaw/Govee/blob/main/decoded/v1.2/explanation_v1.2.md),
 * captured music-mode definitions, colour temperature ranges. Data, not code — extend here.
 *
 * Scene rule fields: `remove` hex prefix that every param of the SKU starts with and that is
 * stripped; `add` hex prefix put in front of the stripped param — its first byte becomes the
 * multi-packet type byte; `suffix` hex appended to the select frame; `speedByte` → select frame
 * ends with `00 <speed>` (H606A capture: speed default = first param byte after `remove`).
 */

const GENERIC = {remove: '', add: '02', suffix: ''};

/** AlgoClaw model_specific_parameters.json (2025) + own captures. */
const SCENE_RULES = {
    // Glide Hexa Ultra: verified against the 2024 capture, 64/72 scenes byte-identical
    H606A: {remove: '22', add: '58', suffix: '', speedByte: true},
    // AlgoClaw: first rule whose `remove` matches wins, else the generic rule
    H6065: [
        {remove: '12000c000f', add: '04', suffix: '0247'},
        {remove: '1200000000', add: '04', suffix: '0047'},
    ],
    H6066: [
        {remove: '1200000000', add: '04', suffix: ''},
        {remove: '1d', add: '', suffix: ''},
    ],
};

/** Captured H606A music mode definitions (type 0x41), hex; ROADMAP §2.3, RESEARCH.md §3. */
const MUSIC = {
    H606A: {
        rhythm: '754a07ff0000ff7f00ffff0000ff000000ff00ffff8b00ff01f60000000000010101',
        pulsating: '764a07ff0000ff7f00ffff0000ff000000ff00ffff8b00ff01f40000000001',
        energy: '774a07ff0000ff7f00ffff0000ff000000ff00ffff8b00ff01010000000000',
        windmill: '784a07ff0000ff7f00ffff0000ff000000ff00ffff8b00ff02f10000000001010101',
        divide: '7a4a07ff0000ff7f00ffff0000ff000000ff00ffff8b00ff01010000000000',
        beat: '7b4a07ff0000ff7f00ffff0000ff000000ff00ffff8b00ff01fa0000000000',
    },
};

const COLOR_TEMP = {default: {min: 2000, max: 9000}};

export function normalizeSku(sku) {
    return String(sku || '')
        .trim()
        .toUpperCase();
}

/**
 * The scene rule for a SKU and (when the SKU has several) the given param.
 * @param {string} sku
 * @param {string} [scenceParam] base64
 */
export function sceneRule(sku, scenceParam = '') {
    const rules = SCENE_RULES[normalizeSku(sku)];
    if (!rules) {
        return GENERIC;
    }
    if (!Array.isArray(rules)) {
        return rules;
    }
    const param = Buffer.from(scenceParam, 'base64').toString('hex');
    return rules.find((r) => param.startsWith(r.remove)) || GENERIC;
}

/** Music mode names → definition hex for a SKU (empty object when unknown). */
export function musicModes(sku) {
    return MUSIC[normalizeSku(sku)] || {};
}

export function colorTempRange(sku) {
    return COLOR_TEMP[normalizeSku(sku)] || COLOR_TEMP.default;
}

/** SKUs with own data, for `info` / diagnostics. */
export const KNOWN_SKUS = [...new Set([...Object.keys(SCENE_RULES), ...Object.keys(MUSIC)])].sort();
