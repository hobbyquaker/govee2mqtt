import {test, describe} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
    checksum,
    frame,
    isValidFrame,
    multi,
    unmulti,
    power,
    brightness,
    scene,
    music,
    toBase64,
    parseRaw,
} from '../lib/packet.js';
import {sceneRule, musicModes} from '../lib/sku.js';
import {parseLibrary} from '../lib/scenes.js';

const library = parseLibrary(
    JSON.parse(fs.readFileSync(new URL('./fixtures/light-effect-libraries-h606a.json', import.meta.url))),
);
const effect = (name) => library.find((s) => s.name === name);
const hex = (frames) => frames.map((f) => Buffer.from(f).toString('hex'));
const H606A = sceneRule('H606A');

/*
 * Frames captured from the Govee Home app's BLE writes to an H606A (2024, Wireshark), see
 * test/fixtures/capture-h606a.json. Byte 19 is the checksum, so a transcription error shows up as
 * an invalid frame.
 */
const capture = JSON.parse(fs.readFileSync(new URL('./fixtures/capture-h606a.json', import.meta.url))).scenes;
const captured = (name) => capture.find((s) => s.name === name).frames;
const CAPTURE = {matrix: captured('matrix'), breathe: captured('breathe'), leisure100: captured('leisure')};
// crawl carries cubic's packets, 7718 is carnival mislabelled valentinesday (copy errors, ROADMAP §1.1)
const COPY_ERRORS = new Set(['crawl']);
// the app substituted 4 bytes (41 06 41 06 → library b7 06 fc 05) in these seven (ROADMAP OQ-G4)
const PATCHED = new Set(['rainbow', 'evolution', 'kaleidoscope', 'circuit', 'ripple', 'arcanelight', 'speeding']);

// base64 as the app's LAN `ptReal` array (Leisure at speed 59, Desert at speed 79)
const CAPTURE_B64 = {
    leisure59: [
        'owABBFhQAQIBXhsA+A8AMAcAACk=',
        'owEAAAAPAAECAGQAAAH/yGT/BWI=',
        'owIBAGQBMhsABwAAAAcAAAAAAOw=',
        'o/8PAAEAAAAAAAH/yGQKCAEAZGc=',
        'MwUEdR0AOwAAAAAAAAAAAAAAAGE=',
    ],
    desert79: [
        'owABBVhYAQIAYhsA+AEAAAoAAC4=',
        'owEAAAAPAAACKFAAAAH/rlQKANk=',
        'owIBCmQBHiQABwAAAAcAAAAAAPU=',
        'owMYAAEAAAAAAAT/rlT/fwD/pWI=',
        'o/8A9GQACgABAGQAAAAAAAAAAKM=',
        'MwUElh4ATwAAAAAAAAAAAAAAAPU=',
    ],
};
const MUSIC_B64 = {
    rhythm: [
        'owABA0F1Sgf/AAD/fwD//wAA/1g=',
        'owEAAAD/AP//iwD/AfYAAAAAAN4=',
        'o/8BAQEAAAAAAAAAAAAAAAAAAF0=',
        'MwUTAAAAAAAAAAAAAAAAAAAAACU=',
    ],
    pulsating: ['owABAkF2Sgf/AAD/fwD//wAA/1o=', 'o/8AAAD/AP//iwD/AfQAAAAAASM=', 'MwUTAAAAAAAAAAAAAAAAAAAAACU='],
    energy: ['owABAkF3Sgf/AAD/fwD//wAA/1s=', 'o/8AAAD/AP//iwD/AQEAAAAAANc=', 'MwUTAAAAAAAAAAAAAAAAAAAAACU='],
    windmill: [
        'owABA0F4Sgf/AAD/fwD//wAA/1U=',
        'owEAAAD/AP//iwD/AvEAAAAAAds=',
        'o/8BAQEAAAAAAAAAAAAAAAAAAF0=',
        'MwUTAAAAAAAAAAAAAAAAAAAAACU=',
    ],
    divide: ['owABAkF6Sgf/AAD/fwD//wAA/1Y=', 'o/8AAAD/AP//iwD/AQEAAAAAANc=', 'MwUTAAAAAAAAAAAAAAAAAAAAACU='],
    beat: ['owABAkF7Sgf/AAD/fwD//wAA/1c=', 'o/8AAAD/AP//iwD/AfoAAAAAACw=', 'MwUTAAAAAAAAAAAAAAAAAAAAACU='],
};

describe('frames', () => {
    test('checksum and padding', () => {
        assert.equal(frame([0x33, 0x01, 0x01]).toString('hex'), '3301010000000000000000000000000000000033');
        assert.equal(frame([0x33, 0x01, 0x00]).toString('hex'), '3301000000000000000000000000000000000032');
        assert.equal(brightness(100).toString('hex'), '3304640000000000000000000000000000000053');
        assert.equal(brightness(37)[2], 0x25);
        assert.equal(brightness(0)[2], 1);
        assert.equal(brightness(250)[2], 100);
        assert.equal(power(true)[2], 1);
        assert.throws(() => frame(Buffer.alloc(20)), /too long/);
    });

    test('captured frames carry valid checksums (transcription check)', () => {
        for (const {frames} of capture) {
            for (const h of frames) {
                const b = Buffer.from(h, 'hex');
                assert.equal(b.length, 20, h);
                assert.ok(isValidFrame(b), `bad checksum ${h}`);
            }
        }
        for (const frames of [...Object.values(CAPTURE_B64), ...Object.values(MUSIC_B64)]) {
            for (const b64 of frames) {
                assert.ok(isValidFrame(Buffer.from(b64, 'base64')), `bad checksum ${b64}`);
            }
        }
        assert.equal(checksum(Buffer.from(CAPTURE.matrix[2], 'hex')), 0x63);
    });

    test('multi-packet framing', () => {
        const frames = multi(0x58, Buffer.alloc(30, 1));
        assert.equal(frames.length, 2);
        assert.equal(frames[0][1], 0x00);
        assert.equal(frames[1][1], 0xff);
        assert.deepEqual([...frames[0].subarray(2, 5)], [0x01, 0x02, 0x58]);
        assert.equal(multi(0x02, Buffer.alloc(14)).length, 1);
        assert.equal(multi(0x02, Buffer.alloc(15)).length, 2);
        assert.equal(multi(0x02, Buffer.alloc(31)).length, 2);
        assert.equal(multi(0x02, Buffer.alloc(32)).length, 3);
        const eight = multi(0x58, Buffer.alloc(8 * 17 - 3));
        assert.equal(eight.length, 8);
        assert.equal(eight[6][1], 6);
        assert.equal(eight[7][1], 0xff);
        assert.equal(unmulti(frames).length, 34);
    });
});

describe('scenes (H606A capture vs. scene library)', () => {
    test('rule', () => {
        assert.deepEqual(H606A, {remove: '22', add: '58', suffix: '', speedByte: true});
        assert.deepEqual(sceneRule('h6072'), {remove: '', add: '02', suffix: ''});
        assert.equal(sceneRule('H6065', Buffer.from('12000c000f01', 'hex').toString('base64')).suffix, '0247');
        assert.equal(sceneRule('H6065', Buffer.from('120000000001', 'hex').toString('base64')).suffix, '0047');
    });

    test('Matrix (3 definition frames, default speed)', () => {
        const frames = scene(effect('matrix'), H606A);
        // the capture's select frame carries flag 0x0e where we send 0 (ROADMAP OQ-G5)
        assert.deepEqual(hex(frames).slice(0, 3), CAPTURE.matrix.slice(0, 3));
        assert.equal(frames[3].subarray(0, 5).toString('hex'), '3305045d1d');
        assert.equal(frames[3][6], 0x3c);
    });

    test('Breathe (7 definition frames)', () => {
        assert.deepEqual(hex(scene(effect('breathe'), H606A)), CAPTURE.breathe);
    });

    test('Leisure with explicit speed', () => {
        assert.deepEqual(hex(scene(effect('leisure'), H606A, {speed: 0x3b})), CAPTURE.leisure100);
        assert.deepEqual(toBase64(scene(effect('leisure'), H606A, {speed: 59})), CAPTURE_B64.leisure59);
        assert.deepEqual(toBase64(scene(effect('desert'), H606A, {speed: 79})), CAPTURE_B64.desert79);
    });

    test('every H606A library scene encodes and round-trips its definition', () => {
        for (const s of library) {
            const frames = scene(s, H606A);
            assert.ok(frames.length >= 2, s.name);
            for (const f of frames) {
                assert.ok(isValidFrame(f));
            }
            const stream = unmulti(frames.slice(0, -1));
            assert.deepEqual([...stream.subarray(0, 3)], [0x01, frames.length - 1, 0x58]);
            const param = Buffer.from(s.scenceParam, 'base64');
            assert.ok(stream.subarray(3, 3 + param.length - 1).equals(param.subarray(1)), s.name);
            const select = frames.at(-1);
            assert.equal(select[3] | (select[4] << 8), s.sceneCode);
            assert.equal(select[6], param[1]);
        }
    });

    test('all 78 captured scenes vs. the library recipe', () => {
        let exact = 0;
        for (const cap of capture) {
            if (cap.category === 'music' || COPY_ERRORS.has(cap.name)) {
                continue;
            }
            const libScene = library.find((s) => s.sceneCode === cap.id);
            assert.ok(libScene, `${cap.name} ${cap.id} in library`);
            const select = Buffer.from(cap.frames.at(-1), 'hex');
            const frames = hex(scene(libScene, H606A, {speed: select[6]}));
            assert.equal(frames.length, cap.frames.length, cap.name);
            // select frame: identical except the flag byte 5 (OQ-G5) and therefore the checksum
            const ours = Buffer.from(frames.at(-1), 'hex');
            assert.deepEqual([...ours.subarray(0, 5)], [...select.subarray(0, 5)], cap.name);
            assert.equal(ours[6], select[6], cap.name);
            const definition = frames.slice(0, -1);
            const expected = cap.frames.slice(0, -1);
            if (PATCHED.has(cap.name)) {
                const a = unmulti(definition.map((h) => Buffer.from(h, 'hex')));
                const b = unmulti(expected.map((h) => Buffer.from(h, 'hex')));
                const diff = [...a].map((v, i) => (v === b[i] ? null : i)).filter((i) => i !== null);
                // every difference sits in a 4-byte window 41 06 41 06 (app) vs b7 06 fc 05 (library);
                // the second byte is identical, Kaleidoscope carries the field twice
                assert.ok(diff.length > 0, cap.name);
                for (let i = 0; i < diff.length;) {
                    const start = diff[i];
                    assert.equal(b.subarray(start, start + 4).toString('hex'), '41064106', `${cap.name} @${start}`);
                    assert.equal(a.subarray(start, start + 4).toString('hex'), 'b706fc05', `${cap.name} @${start}`);
                    while (i < diff.length && diff[i] < start + 4) {
                        i++;
                    }
                }
            } else {
                assert.deepEqual(definition, expected, cap.name);
                exact++;
            }
        }
        assert.equal(exact, 64);
    });

    test('generic rule and empty param', () => {
        const frames = scene({sceneCode: 212, scenceParam: Buffer.from([1, 2, 3]).toString('base64')});
        assert.equal(frames.length, 2);
        assert.deepEqual([...frames[0].subarray(0, 8)], [0xa3, 0xff, 0x01, 0x01, 0x02, 1, 2, 3]);
        assert.equal(frames[1].subarray(0, 5).toString('hex'), '330504d400');
        assert.equal(scene({sceneCode: 2899, scenceParam: ''}, {suffix: '0047'}).length, 1);
        assert.equal(
            scene({sceneCode: 2899, scenceParam: ''}, {suffix: '0047'})[0].subarray(0, 7).toString('hex'),
            '330504530b0047',
        );
        assert.throws(() => scene({sceneCode: 1, scenceParam: 'AQID'}, {remove: '22'}), /does not start/);
        assert.throws(() => scene({sceneCode: 70000, scenceParam: ''}), /invalid scene code/);
    });
});

describe('music modes (H606A capture)', () => {
    test('all six', () => {
        const modes = musicModes('H606A');
        assert.deepEqual(Object.keys(modes), Object.keys(MUSIC_B64));
        for (const [name, definition] of Object.entries(modes)) {
            assert.deepEqual(toBase64(music(definition)), MUSIC_B64[name], name);
        }
        assert.deepEqual(musicModes('H9999'), {});
    });
});

describe('parseRaw', () => {
    test('hex, base64, arrays, checksum handling', () => {
        assert.deepEqual(hex(parseRaw('33 01 01')), ['3301010000000000000000000000000000000033']);
        assert.deepEqual(hex(parseRaw('330101')), ['3301010000000000000000000000000000000033']);
        assert.deepEqual(hex(parseRaw(CAPTURE.matrix.join(''))), CAPTURE.matrix);
        assert.deepEqual(
            hex(parseRaw(CAPTURE_B64.leisure59)),
            hex(CAPTURE_B64.leisure59.map((b) => Buffer.from(b, 'base64'))),
        );
        assert.deepEqual(hex(parseRaw(CAPTURE_B64.leisure59.join(' '))).length, 5);
        assert.deepEqual(hex(parseRaw(JSON.stringify(['330101']))), ['3301010000000000000000000000000000000033']);
        assert.throws(() => parseRaw('3301010000000000000000000000000000000034'), /bad checksum/);
        assert.throws(() => parseRaw('abc'), /odd hex/);
        assert.throws(() => parseRaw(42), /string or an array/);
    });
});
