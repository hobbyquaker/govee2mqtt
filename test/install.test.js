import {test, describe} from 'node:test';
import assert from 'node:assert/strict';

process.env.GOVEE2MQTT_MQTT_URL ||= 'mqtt://test';
const {unitFile, envFile} = await import('../lib/install.js');
const {OPTIONS} = await import('../config.js');
const {SHARED_OPTIONS, configSchema} = await import('mqtt-interfaces-core');
const pkg = (await import('../package.json', {with: {type: 'json'}})).default;

describe('install', () => {
    test('unit uses the shared layout, no extra groups', () => {
        const unit = unitFile('/usr/bin/node /usr/local/lib/node_modules/govee2mqtt/index.js');
        assert.doesNotMatch(unit, /SupplementaryGroups/);
        assert.match(unit, /^EnvironmentFile=-\/etc\/mqtt-interfaces\/broker\.env$/m);
        assert.match(unit, /^EnvironmentFile=\/etc\/govee2mqtt\/%i\.env$/m);
        assert.match(unit, /^Environment=GOVEE2MQTT_NAME=%i$/m);
        assert.match(unit, /^SyslogIdentifier=govee2mqtt@%i$/m);
        assert.match(unit, /^Restart=always$/m);
    });

    test('env file carries the adapter options', () => {
        const argv = {
            name: 'govee',
            address: ['1.2.3.4', '5.6.7.8'],
            broadcast: true,
            pollInterval: 2,
            mqttUrl: 'mqtt://b',
        };
        Object.defineProperty(argv, '$options', {value: {...OPTIONS, ...SHARED_OPTIONS}});
        const out = envFile(argv);
        assert.match(out, /^GOVEE2MQTT_ADDRESS=1\.2\.3\.4[ ,]5\.6\.7\.8$/m);
        assert.match(out, /^GOVEE2MQTT_BROADCAST=true$/m);
        assert.match(out, /^GOVEE2MQTT_POLL_INTERVAL=2$/m);
        assert.doesNotMatch(out, /^GOVEE2MQTT_NAME=/m);
    });

    test('config schema marks the map file, the only secret is the broker password', () => {
        const schema = configSchema({pkg, envPrefix: 'GOVEE2MQTT', options: OPTIONS, defaults: {name: 'govee'}});
        const props = schema.properties;
        assert.equal(props['map-file']['x-file'].example, 'example-map.json');
        assert.equal(props['poll-interval'].default, 5);
        assert.equal(props['raw-set'].default, false);
        assert.equal(props.address['x-env'], 'GOVEE2MQTT_ADDRESS');
        const secrets = Object.entries(props)
            .filter(([, p]) => p['x-secret'])
            .map(([k]) => k);
        assert.deepEqual(secrets, ['mqtt-password']);
    });
});
