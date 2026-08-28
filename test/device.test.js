import {test, describe} from 'node:test';
import assert from 'node:assert/strict';

import {Device, defaultDeviceName, isValidDeviceName} from '../lib/device.js';

const INFO = {
    device: '1B:FA:FB:75:D9:29:BF:71',
    sku: 'H606A',
    ip: '172.16.23.120',
    name: 'hexa',
    wifiVersionSoft: '1.03.01',
    bleVersionSoft: '1.00.16',
};
const OFF = {onOff: false, brightness: 100, color: {r: 255, g: 127, b: 0}, colorTemInKelvin: 0};

describe('names', () => {
    test('defaultDeviceName / isValidDeviceName', () => {
        assert.equal(defaultDeviceName('H606A', '1B:FA:FB:75:D9:29:BF:71'), 'h606a_bf71');
        assert.equal(defaultDeviceName('h6072', 'AA:BB'), 'h6072_aabb');
        assert.ok(isValidDeviceName('hexa'));
        assert.ok(isValidDeviceName('living-room_2'));
        assert.ok(!isValidDeviceName('Hexa'));
        assert.ok(!isValidDeviceName('a/b'));
        assert.ok(!isValidDeviceName(''));
    });
});

describe('Device', () => {
    test('identity, scan updates, online tracking', () => {
        const d = new Device(INFO);
        assert.deepEqual(d.identityItems(), {
            sku: 'H606A',
            device: INFO.device,
            ip: INFO.ip,
            firmware: {wifi: '1.03.01', ble: '1.00.16'},
        });
        assert.equal(d.online, false);
        assert.deepEqual(d.applyScan({...INFO}), {});
        assert.equal(d.online, true);
        assert.deepEqual(d.applyScan({...INFO, ip: '172.16.23.121', wifiVersionSoft: '1.04.00'}).ip, '172.16.23.121');
        assert.equal(d.firmware.wifi, '1.04.00');
        assert.equal(d.missed(3), false);
        assert.equal(d.missed(3), false);
        assert.equal(d.missed(3), true);
        assert.equal(d.online, false);
        assert.equal(d.missed(3), false);
        assert.equal(d.seen(), true);
        assert.equal(d.seen(), false);
        assert.equal(d.missedPolls, 0);
    });

    test('applyStatus publishes only changes and derives color_mode', () => {
        const d = new Device(INFO);
        assert.deepEqual(d.applyStatus(OFF), {
            power: false,
            brightness: 100,
            color: {r: 255, g: 127, b: 0},
            color_temp: 0,
            color_mode: 'rgb',
        });
        assert.deepEqual(d.applyStatus(OFF), {});
        assert.deepEqual(d.applyStatus({...OFF, onOff: true}), {power: true});
        assert.deepEqual(d.applyStatus({...OFF, onOff: true, color: {r: 0, g: 0, b: 0}, colorTemInKelvin: 4000}), {
            color: {r: 0, g: 0, b: 0},
            color_temp: 4000,
            color_mode: 'ct',
        });
        assert.deepEqual(
            d.applyStatus({onOff: true, color: {r: 0, g: 0, b: 0}, colorTemInKelvin: 4000}),
            {},
            'missing brightness keeps the old one',
        );
    });

    test('scene is last-commanded and cleared when someone else changes the light (G-5)', () => {
        const d = new Device(INFO);
        d.applyStatus({...OFF, onOff: true}, 1000);
        assert.deepEqual(d.commanded('scene', 'matrix', 2000), {scene: 'matrix', music: '', color_mode: 'scene'});
        // the verify poll right after our command reports whatever the device says — scene stays
        assert.deepEqual(d.applyStatus({...OFF, onOff: true, color: {r: 1, g: 2, b: 3}}, 3000), {
            color: {r: 1, g: 2, b: 3},
        });
        assert.equal(d.state.scene, 'matrix');
        // a later foreign change clears it
        assert.deepEqual(d.applyStatus({...OFF, onOff: true, color: {r: 9, g: 9, b: 9}}, 20000), {
            color: {r: 9, g: 9, b: 9},
            scene: '',
            music: '',
            color_mode: 'rgb',
        });
        // brightness/power changes alone do not end a scene
        assert.deepEqual(d.commanded('music', 'rhythm', 30000), {music: 'rhythm', color_mode: 'music'});
        assert.deepEqual(d.applyStatus({...OFF, onOff: true, brightness: 20, color: {r: 9, g: 9, b: 9}}, 40000), {
            brightness: 20,
        });
        assert.equal(d.state.music, 'rhythm');
        // our own colour command ends the effect
        assert.deepEqual(d.commanded('color', {r: 1, g: 1, b: 1}, 50000), {music: '', color_mode: 'rgb'});
        assert.deepEqual(d.commanded('color_temp', 3000, 50001), {color_mode: 'ct'});
        assert.deepEqual(d.commanded('power', true, 50002), {});
        // a routine poll right after the ct command still shows rgb: the mode does not flap back
        assert.deepEqual(d.applyStatus({...OFF, onOff: true, brightness: 20, color: {r: 9, g: 9, b: 9}}, 50500), {});
        assert.equal(d.state.color_mode, 'ct');
        assert.deepEqual(
            d.applyStatus({onOff: true, brightness: 20, color: {r: 0, g: 0, b: 0}, colorTemInKelvin: 3000}, 51000),
            {
                color: {r: 0, g: 0, b: 0},
                color_temp: 3000,
            },
        );
        // long after the command the poll is authoritative again
        assert.deepEqual(d.applyStatus({...OFF, onOff: true, brightness: 20, color: {r: 9, g: 9, b: 9}}, 90000), {
            color: {r: 9, g: 9, b: 9},
            color_temp: 0,
            color_mode: 'rgb',
        });
    });
});
