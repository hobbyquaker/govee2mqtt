import {parseConfig} from 'mqtt-interfaces-core';
import pkg from './package.json' with {type: 'json'};

export const OPTIONS = {
    address: {
        alias: 'a',
        type: 'array',
        describe: 'ip of a device to scan by unicast (repeatable; multicast discovery needs no addresses)',
        default: [],
    },
    broadcast: {
        type: 'boolean',
        describe: 'also scan by subnet broadcast (for networks without multicast)',
        default: false,
    },
    'lan-interface': {type: 'string', describe: 'ipv4 address of the interface to join the multicast group on'},
    'scan-interval': {type: 'number', describe: 'seconds between discovery scans (0 = only at start)', default: 60},
    'poll-interval': {type: 'number', describe: 'seconds between status polls per device', default: 5},
    'offline-after': {type: 'number', describe: 'unanswered polls before a device is reported offline', default: 3},
    'map-file': {
        alias: 'm',
        type: 'string',
        describe: 'JSON file mapping device ids to topic names (see example-map.json)',
        file: {format: 'json', example: 'example-map.json', schema: 'map.schema.json', describe: 'device topic names'},
    },
    devices: {
        type: 'array',
        describe: 'only bridge these devices (ids or topic names; default all)',
        default: [],
    },
    'state-dir': {
        type: 'string',
        describe: 'directory for the scene cache (default: $STATE_DIRECTORY)',
        default: process.env.STATE_DIRECTORY,
    },
    'scene-refresh': {
        type: 'number',
        describe: 'days after which a cached scene list is refetched (0 = never)',
        default: 7,
    },
    'raw-set': {
        type: 'boolean',
        describe: 'accept raw ptReal frames on <name>/set/<dev>/raw (unrestricted device access!)',
        default: false,
    },
};

export default parseConfig({
    pkg,
    options: OPTIONS,
    defaults: {name: 'govee'},
    examples: [
        ['$0 -u mqtt://broker', 'run in the foreground, discover by multicast'],
        ['$0 -u mqtt://broker -a 192.168.1.50 --broadcast', 'help discovery on networks without multicast'],
        ['sudo $0 --install -n govee -u mqtt://broker', 'install as service govee2mqtt@govee'],
    ],
});
