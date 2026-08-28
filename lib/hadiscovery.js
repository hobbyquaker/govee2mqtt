/**
 * Home Assistant discovery (ROADMAP §4.7): one bridge device plus one device per Govee light,
 * linked with `via_device`; per-device availability = bridge connected AND `status/<dev>/online`.
 * Pure: devices in, device blocks out; the core publishes them.
 */

import {availability, discoveryId, entity} from 'mqtt-interfaces-core';

const MAX_EFFECTS = 100;

/**
 * @param {object} input
 * @param {string} input.name instance name / topic prefix
 * @param {Array<{name: string, id: string, sku: string, firmware?: {wifi?: string}, scenes?: Array<{name: string}>,
 *          music?: string[], colorTemp?: {min: number, max: number}}>} input.devices
 * @param {boolean} [input.jsonPayloads]
 */
export function discoveryModel({name, devices, jsonPayloads = true}) {
    const bridgeId = discoveryId('govee2mqtt', name);
    const val = (expr) =>
        jsonPayloads ? `{{ ${expr.replace(/VALUE/g, 'value_json.val')} }}` : `{{ ${expr.replace(/VALUE/g, 'value')} }}`;

    const blocks = devices.map((d) => {
        const id = `${bridgeId}_${d.name.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
        const e = (item, platform, label, more = {}) =>
            entity({id, name, item: `${d.name}/${item}`, uid: item, platform, label, jsonPayloads, ...more});
        const effects = (d.scenes || []).map((s) => s.name).slice(0, MAX_EFFECTS);
        const ct = d.colorTemp || {min: 2000, max: 9000};
        const light = e('power', 'light', 'Light', {
            command: true,
            extra: {
                stat_val_tpl: jsonPayloads
                    ? "{{ 'ON' if value_json.val else 'OFF' }}"
                    : "{{ 'ON' if value == 'true' else 'OFF' }}",
                pl_on: 'true',
                pl_off: 'false',
                bri_stat_t: `${name}/status/${d.name}/brightness`,
                bri_val_tpl: val('VALUE'),
                bri_cmd_t: `${name}/set/${d.name}/brightness`,
                bri_scl: 100,
                rgb_stat_t: `${name}/status/${d.name}/color`,
                rgb_val_tpl: jsonPayloads
                    ? '{{ value_json.val.r }},{{ value_json.val.g }},{{ value_json.val.b }}'
                    : '{{ (value | from_json).r }},{{ (value | from_json).g }},{{ (value | from_json).b }}',
                rgb_cmd_t: `${name}/set/${d.name}/color`,
                clr_temp_stat_t: `${name}/status/${d.name}/color_temp`,
                clr_temp_val_tpl: val('VALUE if VALUE else None'),
                clr_temp_cmd_t: `${name}/set/${d.name}/color_temp`,
                clr_temp_kelvin: true,
                min_kelvin: ct.min,
                max_kelvin: ct.max,
                ...(effects.length && {
                    fx_stat_t: `${name}/status/${d.name}/scene`,
                    fx_val_tpl: val('VALUE if VALUE else None'),
                    fx_cmd_t: `${name}/set/${d.name}/scene`,
                    fx_list: effects,
                }),
            },
        });
        delete light.val_tpl; // the light platform uses stat_val_tpl
        const components = {
            light,
            online: e('online', 'binary_sensor', 'Online', {
                category: 'diagnostic',
                extra: {
                    dev_cla: 'connectivity',
                    val_tpl: jsonPayloads
                        ? "{{ 'ON' if value_json.val else 'OFF' }}"
                        : "{{ 'ON' if value == 'true' else 'OFF' }}",
                },
            }),
            ip: e('ip', 'sensor', 'IP address', {category: 'diagnostic', icon: 'mdi:ip-network'}),
            refresh: e('refresh', 'button', 'Refresh', {command: true, category: 'diagnostic', icon: 'mdi:refresh'}),
        };
        if (d.music && d.music.length) {
            components.music = e('music', 'select', 'Music mode', {
                command: true,
                icon: 'mdi:music',
                extra: {options: d.music, val_tpl: val('VALUE if VALUE else None')},
            });
        }
        return {
            id,
            device: {
                name: d.name,
                mf: 'Govee',
                mdl: d.sku,
                via_device: bridgeId,
                ...(d.firmware?.wifi && {sw: d.firmware.wifi}),
            },
            availability: [
                ...availability(name),
                {
                    t: `${name}/status/${d.name}/online`,
                    avty_tpl: jsonPayloads
                        ? "{{ 'online' if value_json.val else 'offline' }}"
                        : "{{ 'online' if value == 'true' else 'offline' }}",
                },
            ],
            components,
        };
    });

    const bridge = {
        id: bridgeId,
        device: {mf: 'Govee', mdl: 'LAN bridge'},
        components: {
            devices: entity({
                id: bridgeId,
                name,
                item: 'bridge/devices',
                uid: 'devices',
                platform: 'sensor',
                label: 'Devices',
                category: 'diagnostic',
                icon: 'mdi:lightbulb-group',
                jsonPayloads,
                extra: {val_tpl: jsonPayloads ? '{{ value_json.val | length }}' : '{{ (value | from_json) | length }}'},
            }),
            scan: entity({
                id: bridgeId,
                name,
                item: 'bridge/scan',
                uid: 'scan',
                platform: 'button',
                label: 'Scan',
                category: 'diagnostic',
                icon: 'mdi:magnify-scan',
                command: true,
            }),
        },
    };
    return [bridge, ...blocks];
}
