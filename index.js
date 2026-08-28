#!/usr/bin/env node

/**
 * govee2mqtt — Govee WiFi lights (LAN API) ↔ MQTT, mqtt-smarthome convention, on
 * mqtt-interfaces-core. See ROADMAP.md §4 for the design; lib/ holds the protocol.
 */

import fs from 'node:fs';
import path from 'node:path';
import {createAdapter} from 'mqtt-interfaces-core';
import config from './config.js';
import pkg from './package.json' with {type: 'json'};
import {handle as handleInstall} from './lib/install.js';
import {LanClient} from './lib/lan.js';
import {Device, defaultDeviceName, isValidDeviceName} from './lib/device.js';
import {commandFor} from './lib/items.js';
import {SceneLibrary} from './lib/scenes.js';
import {sceneRule, musicModes, colorTempRange} from './lib/sku.js';
import * as packet from './lib/packet.js';
import {discoveryModel} from './lib/hadiscovery.js';

handleInstall(config);

const VERIFY_MS = 1000;

let map = {};
if (config.mapFile) {
    map = JSON.parse(fs.readFileSync(path.resolve(config.mapFile), 'utf8'));
}
const filter = new Set((config.devices || []).map((d) => String(d).trim()).filter(Boolean));

/** device id → Device */
const devices = new Map();
/** ip → Device */
const byIp = new Map();
/** topic name → Device */
const byName = new Map();
let lastScan = null;
let pollTimer = null;
let scanTimer = null;
let pollCursor = 0;

const adapter = createAdapter({
    pkg,
    config,
    deviceLabel: 'lan',
    info: () => ({
        lan: {port: 4002, multicast: lan.multicastOk, broadcast: config.broadcast, addresses: config.address},
        devices: devices.size,
    }),
    discovery: () =>
        discoveryModel({
            name: config.name,
            jsonPayloads: config.jsonPayloads,
            devices: [...devices.values()].map((d) => ({
                name: d.name,
                id: d.id,
                sku: d.sku,
                firmware: d.firmware,
                scenes: d.scenes,
                music: Object.keys(musicModes(d.sku)),
                colorTemp: colorTempRange(d.sku),
            })),
        }),
    onSet: handleSet,
    onShutdown: async () => {
        clearInterval(pollTimer);
        clearInterval(scanTimer);
        await lan.stop();
    },
});
const {log, pubStatus} = adapter;

const lan = new LanClient({
    addresses: config.address,
    broadcast: config.broadcast,
    interface: config.lanInterface,
    log,
});
const scenes = new SceneLibrary({
    cacheDir: config.stateDir ? path.join(config.stateDir, 'scenes') : undefined,
    refreshDays: config.sceneRefresh,
    log,
});

/*
 * publishing helpers
 */

function publishItems(device, items) {
    for (const [item, value] of Object.entries(items)) {
        pubStatus(`${device.name}/${item}`, value);
    }
}

function publishBridge() {
    pubStatus(
        'bridge/devices',
        [...devices.values()].map((d) => ({
            dev: d.name,
            sku: d.sku,
            device: d.id,
            ip: d.ip,
            transport: ['lan'],
            online: d.online,
        })),
    );
}

function nameFor(info) {
    const mapped = map[info.device];
    if (mapped !== undefined) {
        if (!isValidDeviceName(String(mapped))) {
            log.warn('map file: invalid topic name', mapped, 'for', info.device, '- using the default');
        } else {
            return String(mapped);
        }
    }
    return defaultDeviceName(info.sku, info.device);
}

/*
 * discovery → devices
 */

async function onScan(info) {
    let device = devices.get(info.device);
    if (device) {
        const changedIdentity = device.applyScan(info);
        if (device.ip !== byIp.get(device.ip)?.ip) {
            for (const [ip, d] of byIp) {
                if (d === device) {
                    byIp.delete(ip);
                }
            }
            byIp.set(device.ip, device);
        }
        if (Object.keys(changedIdentity).length) {
            log.info('lan device', device.name, 'changed', JSON.stringify(changedIdentity));
            publishItems(device, changedIdentity);
            publishBridge();
        }
        if (!device.online) {
            device.seen();
            publishItems(device, {online: true});
            publishBridge();
        }
        return;
    }
    const name = nameFor(info);
    if (filter.size && !filter.has(info.device) && !filter.has(name)) {
        log.debug('lan ignoring device', info.device, name, '(--devices)');
        return;
    }
    if (byName.has(name)) {
        log.warn(
            'lan device',
            info.device,
            'has the same topic name as',
            byName.get(name).id,
            '- ignored; use --map-file',
        );
        return;
    }
    device = new Device({...info, name});
    devices.set(device.id, device);
    byIp.set(device.ip, device);
    byName.set(name, device);
    log.info('lan found', device.sku, device.id, 'at', device.ip, '→', name);
    device.seen();
    publishItems(device, {...device.identityItems(), online: true, scene: '', music: ''});
    publishBridge();
    lan.queryStatus(device.ip).catch((err) => log.debug('lan', err.message));
    device.scenes = await scenes.get(device.sku);
    if (device.scenes.length) {
        log.info('lan', device.name, `${device.scenes.length} scenes for ${device.sku}`);
    }
    adapter.markDiscoveryDirty();
    adapter.publishDiscovery();
}

function onStatus(ip, status) {
    const device = byIp.get(ip);
    if (!device) {
        log.debug('lan status from unknown device', ip);
        return;
    }
    const wasOnline = device.online;
    const changed = device.applyStatus(status);
    if (!wasOnline) {
        log.info('lan device', device.name, 'online');
        changed.online = true;
        publishBridge();
    }
    if (Object.keys(changed).length) {
        publishItems(device, changed);
    }
}

async function scan() {
    try {
        const used = await lan.scan();
        lastScan = {last: new Date().toISOString(), method: used};
        pubStatus('bridge/scan', {...lastScan, found: devices.size});
    } catch (err) {
        log.warn('lan scan failed -', err.message);
    }
}

/** One device per tick so polls are spread over the interval. */
function pollTick() {
    const list = [...devices.values()];
    if (!list.length) {
        return;
    }
    pollCursor = (pollCursor + 1) % list.length;
    const device = list[pollCursor];
    if (device.missed(config.offlineAfter)) {
        log.warn('lan device', device.name, 'offline (no reply to', device.missedPolls, 'polls)');
        publishItems(device, {online: false});
        publishBridge();
    }
    lan.queryStatus(device.ip).catch((err) => log.debug('lan', err.message));
}

function startTimers() {
    const pollMs = Math.max(1, config.pollInterval) * 1000;
    pollTimer = setInterval(pollTick, Math.max(200, pollMs / Math.max(1, devices.size || 1)));
    if (config.scanInterval > 0) {
        scanTimer = setInterval(scan, config.scanInterval * 1000);
    }
}

/*
 * commands
 */

async function handleSet(parts, value, topic) {
    if (parts[0] === 'bridge') {
        if (parts[1] === 'scan') {
            return scan();
        }
        throw new Error(`unknown bridge item ${parts.slice(1).join('/')}`);
    }
    if (parts.length !== 2) {
        throw new Error(`expected set/<device>/<item>, got ${topic}`);
    }
    const [dev, item] = parts;
    const device = byName.get(dev);
    if (!device) {
        throw new Error(`unknown device "${dev}"`);
    }
    const command = commandFor(item, value, {rawSet: config.rawSet, colorTemp: colorTempRange(device.sku)});
    if (!device.online) {
        log.debug('lan', device.name, 'is offline, sending anyway');
    }
    switch (command.type) {
        case 'power':
            await lan.turn(device.ip, command.on);
            device.commanded('power', command.on);
            break;
        case 'brightness':
            await lan.brightness(device.ip, command.percent);
            device.commanded('brightness', command.percent);
            break;
        case 'color':
            await lan.color(device.ip, command.color);
            publishItems(device, device.commanded('color', command.color));
            break;
        case 'color_temp':
            await lan.colorTemperature(device.ip, command.kelvin);
            publishItems(device, device.commanded('color_temp', command.kelvin));
            break;
        case 'scene': {
            if (!device.scenes.length) {
                device.scenes = await scenes.get(device.sku);
            }
            const scene = SceneLibrary.find(device.scenes, command.key);
            if (!scene) {
                throw new Error(`unknown scene "${command.key}" for ${device.sku}`);
            }
            const frames = packet.scene(scene, sceneRule(device.sku, scene.scenceParam), {speed: command.speed});
            await lan.ptReal(device.ip, packet.toBase64(frames));
            publishItems(device, device.commanded('scene', scene.name));
            break;
        }
        case 'music': {
            const modes = musicModes(device.sku);
            const definition = modes[command.key];
            if (!definition) {
                throw new Error(
                    `unknown music mode "${command.key}" for ${device.sku} (known: ${Object.keys(modes).join(', ') || 'none'})`,
                );
            }
            await lan.ptReal(device.ip, packet.toBase64(packet.music(definition)));
            publishItems(device, device.commanded('music', command.key));
            break;
        }
        case 'raw':
            await lan.ptReal(device.ip, packet.toBase64(packet.parseRaw(command.frames)));
            device.commanded('raw', null);
            break;
        case 'refresh':
            return lan.queryStatus(device.ip);
        default:
            throw new Error(`unhandled command ${command.type}`);
    }
    setTimeout(() => lan.queryStatus(device.ip).catch(() => {}), VERIFY_MS);
}

/*
 * start
 */

lan.on('scan', (info) => onScan(info).catch((err) => log.warn('lan device setup failed -', err.message)));
lan.on('status', onStatus);

adapter.start();
lan.start()
    .then(async () => {
        adapter.setDeviceConnected(true);
        await scan();
        startTimers();
    })
    .catch((err) => {
        if (err.code === 'EADDRINUSE') {
            log.error(
                'udp port 4002 is in use - another Govee integration (homebridge-govee, Home Assistant govee_light_local, wez/govee2mqtt) on this host?',
            );
        } else {
            log.error('lan socket -', err.message);
        }
        adapter.shutdown('lan socket', 1);
    });
