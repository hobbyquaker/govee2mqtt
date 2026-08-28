import {test, describe, beforeEach, afterEach} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {SceneLibrary, parseLibrary, sceneName} from '../lib/scenes.js';

const json = JSON.parse(fs.readFileSync(new URL('./fixtures/light-effect-libraries-h606a.json', import.meta.url)));

describe('parseLibrary / sceneName', () => {
    test('H606A fixture: 72 scenes, 6 categories, names normalised', () => {
        const scenes = parseLibrary(json);
        assert.equal(scenes.length, 72);
        assert.equal(new Set(scenes.map((s) => s.category)).size, 6);
        assert.equal(new Set(scenes.map((s) => s.name)).size, 72);
        const matrix = scenes.find((s) => s.name === 'matrix');
        assert.equal(matrix.sceneCode, 7517);
        assert.equal(matrix.sceneId, 6948);
        assert.equal(matrix.scenceParamId, 9651);
        assert.equal(matrix.label, 'Matrix');
        assert.equal(matrix.supSpeed, false);
        assert.ok(scenes.find((s) => s.name === 'sunset_glow'));
        assert.ok(scenes.find((s) => s.name === 'mothers_day'));
        assert.ok(scenes.find((s) => s.name === 'rubiks_cube'));
        assert.ok(scenes.find((s) => s.name === 'valentines_day'));
        assert.throws(() => parseLibrary({}), /unexpected/);
    });

    test('sceneName', () => {
        assert.equal(sceneName("Mother's Day"), 'mothers_day');
        assert.equal(sceneName('  Sunset  Glow! '), 'sunset_glow');
        assert.equal(sceneName('3D-Cube'), '3d_cube');
    });

    test('find by name, label, code, id, object', () => {
        const scenes = parseLibrary(json);
        assert.equal(SceneLibrary.find(scenes, 'Sunset Glow').sceneCode, 7535);
        assert.equal(SceneLibrary.find(scenes, 'sunset_glow').sceneCode, 7535);
        assert.equal(SceneLibrary.find(scenes, '7535').name, 'sunset_glow');
        assert.equal(SceneLibrary.find(scenes, 7535).name, 'sunset_glow');
        assert.equal(SceneLibrary.find(scenes, {name: 'matrix'}).sceneCode, 7517);
        assert.equal(SceneLibrary.find(scenes, {code: 7517}).name, 'matrix');
        assert.equal(SceneLibrary.find(scenes, 6948).name, 'matrix');
        assert.equal(SceneLibrary.find(scenes, 'nope'), undefined);
        assert.equal(SceneLibrary.find(scenes, ''), undefined);
    });
});

describe('SceneLibrary cache', () => {
    let dir;
    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'govee2mqtt-'));
    });
    afterEach(() => {
        fs.rmSync(dir, {recursive: true, force: true});
    });

    const fetchOk = () => {
        const calls = [];
        const fetch = async (url) => {
            calls.push(url);
            return {ok: true, status: 200, json: async () => json};
        };
        return {fetch, calls};
    };

    test('fetches once, writes the cache, serves from disk afterwards', async () => {
        const {fetch, calls} = fetchOk();
        const lib = new SceneLibrary({cacheDir: dir, fetch});
        const scenes = await lib.get('h606a');
        assert.equal(scenes.length, 72);
        assert.equal(calls.length, 1);
        assert.match(calls[0], /sku=H606A$/);
        assert.ok(fs.existsSync(path.join(dir, 'scenes-h606a.json')));
        await lib.get('H606A');
        assert.equal(calls.length, 1);

        const lib2 = new SceneLibrary({cacheDir: dir, fetch});
        assert.equal((await lib2.get('H606A')).length, 72);
        assert.equal(calls.length, 1, 'served from disk');
    });

    test('stale cache is served and refreshed in the background', async () => {
        const {fetch, calls} = fetchOk();
        const file = path.join(dir, 'scenes-h606a.json');
        fs.writeFileSync(file, JSON.stringify({fetched: Date.now() - 10 * 24 * 3600 * 1000, sku: 'H606A', json}));
        const lib = new SceneLibrary({cacheDir: dir, refreshDays: 7, fetch});
        assert.equal((await lib.get('H606A')).length, 72);
        await lib.pending.get('H606A');
        assert.equal(calls.length, 1);
        assert.ok(JSON.parse(fs.readFileSync(file, 'utf8')).fetched > Date.now() - 5000);

        const never = new SceneLibrary({cacheDir: dir, refreshDays: 0, fetch});
        fs.writeFileSync(file, JSON.stringify({fetched: 0, sku: 'H606A', json}));
        await never.get('H606A');
        assert.equal(calls.length, 1);
    });

    test('fetch failure without cache → empty list, with cache → cache', async () => {
        const warnings = [];
        const log = {warn: (...a) => warnings.push(a.join(' ')), info() {}};
        const failing = async () => ({ok: false, status: 503});
        const lib = new SceneLibrary({cacheDir: dir, fetch: failing, log});
        assert.deepEqual(await lib.get('H606A'), []);
        assert.match(warnings[0], /HTTP 503/);

        fs.writeFileSync(path.join(dir, 'scenes-h606a.json'), JSON.stringify({fetched: 0, sku: 'H606A', json}));
        const lib2 = new SceneLibrary({cacheDir: dir, fetch: failing, log});
        assert.equal((await lib2.get('H606A')).length, 72);
    });

    test('memory only without a cache dir', async () => {
        const {fetch, calls} = fetchOk();
        const lib = new SceneLibrary({fetch});
        await lib.get('H606A');
        await lib.get('H606A');
        assert.equal(calls.length, 1);
    });
});
