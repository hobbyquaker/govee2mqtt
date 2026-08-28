import {test, describe} from 'node:test';
import assert from 'node:assert/strict';

import {discoveryModel} from '../lib/hadiscovery.js';

const DEVICE = {
    name: 'hexa',
    id: '1B:FA:FB:75:D9:29:BF:71',
    sku: 'H606A',
    firmware: {wifi: '1.03.01'},
    scenes: [{name: 'matrix'}, {name: 'sunset_glow'}],
    music: ['rhythm', 'beat'],
    colorTemp: {min: 2000, max: 9000},
};

describe('discoveryModel', () => {
    test('bridge + one device with light, select, diagnostics and per-device availability', () => {
        const [bridge, dev] = discoveryModel({name: 'govee', devices: [DEVICE]});
        assert.equal(bridge.id, 'govee2mqtt_govee');
        assert.equal(bridge.components.scan.p, 'button');
        assert.equal(bridge.components.scan.cmd_t, 'govee/set/bridge/scan');
        assert.equal(bridge.components.scan.stat_t, undefined);
        assert.equal(bridge.components.devices.stat_t, 'govee/status/bridge/devices');

        assert.equal(dev.id, 'govee2mqtt_govee_hexa');
        assert.deepEqual(dev.device, {
            name: 'hexa',
            mf: 'Govee',
            mdl: 'H606A',
            via_device: 'govee2mqtt_govee',
            sw: '1.03.01',
        });
        assert.equal(dev.availability.length, 2);
        assert.equal(dev.availability[1].t, 'govee/status/hexa/online');

        const light = dev.components.light;
        assert.equal(light.p, 'light');
        assert.equal(light.uniq_id, 'govee2mqtt_govee_hexa_power');
        assert.equal(light.stat_t, 'govee/status/hexa/power');
        assert.equal(light.cmd_t, 'govee/set/hexa/power');
        assert.equal(light.val_tpl, undefined);
        assert.match(light.stat_val_tpl, /value_json\.val/);
        assert.equal(light.pl_on, 'true');
        assert.equal(light.bri_cmd_t, 'govee/set/hexa/brightness');
        assert.equal(light.bri_scl, 100);
        assert.equal(light.rgb_val_tpl, '{{ value_json.val.r }},{{ value_json.val.g }},{{ value_json.val.b }}');
        assert.equal(light.clr_temp_kelvin, true);
        assert.equal(light.min_kelvin, 2000);
        assert.deepEqual(light.fx_list, ['matrix', 'sunset_glow']);
        assert.equal(light.fx_cmd_t, 'govee/set/hexa/scene');

        assert.deepEqual(dev.components.music.options, ['rhythm', 'beat']);
        assert.equal(dev.components.music.cmd_t, 'govee/set/hexa/music');
        assert.equal(dev.components.online.dev_cla, 'connectivity');
        assert.equal(dev.components.online.ent_cat, 'diagnostic');
        assert.equal(dev.components.refresh.p, 'button');
        assert.equal(dev.components.ip.stat_t, 'govee/status/hexa/ip');
    });

    test('no scenes → no effect list, no music → no select, plain payload templates', () => {
        const [, dev] = discoveryModel({name: 'g', devices: [{...DEVICE, scenes: [], music: []}], jsonPayloads: false});
        assert.equal(dev.components.light.fx_list, undefined);
        assert.equal(dev.components.music, undefined);
        assert.equal(dev.components.light.val_tpl, undefined);
        assert.match(dev.components.light.stat_val_tpl, /value == 'true'/);
        assert.match(dev.components.light.rgb_val_tpl, /from_json/);
        assert.match(dev.availability[1].avty_tpl, /value == 'true'/);
    });

    test('no devices → bridge only', () => {
        assert.equal(discoveryModel({name: 'g', devices: []}).length, 1);
    });
});
