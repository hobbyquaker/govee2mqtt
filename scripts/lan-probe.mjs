#!/usr/bin/env node
// Research helper (2026-08-28): talk to one Govee device over the LAN API without MQTT.
// Usage:
//   node scripts/lan-probe.mjs <ip>                       scan + devStatus
//   node scripts/lan-probe.mjs <ip> on|off                 JSON turn
//   node scripts/lan-probe.mjs <ip> brightness <1-100>     JSON brightness
//   node scripts/lan-probe.mjs <ip> color <r> <g> <b>      JSON colorwc
//   node scripts/lan-probe.mjs <ip> ct <kelvin>            JSON colorwc (colour temperature)
//   node scripts/lan-probe.mjs <ip> scene <name> [speed]   scene via the public library + ptReal
//   node scripts/lan-probe.mjs <ip> scenes                 list scene names for the device's SKU
// The device must have "LAN Control" enabled in the Govee Home app; replies arrive on local UDP 4002.
import dgram from 'node:dgram';

const [ip, cmd = 'status', ...args] = process.argv.slice(2);
if (!ip) {
    console.error('usage: lan-probe.mjs <ip> [status|on|off|brightness n|color r g b|ct k|scene name [speed]|scenes]');
    process.exit(1);
}

const sock = dgram.createSocket({type: 'udp4', reuseAddr: true});
const t0 = Date.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const send = (msg, port = 4003) =>
    new Promise((res, rej) => sock.send(JSON.stringify({msg}), port, ip, (e) => (e ? rej(e) : res())));

const finish = (bytes) => {
    const p = Buffer.alloc(20);
    Buffer.from(bytes).copy(p, 0, 0, Math.min(19, bytes.length));
    let x = 0;
    for (let i = 0; i < 19; i++) x ^= p[i];
    p[19] = x;
    return p;
};
const ptReal = (packets) => send({cmd: 'ptReal', data: {command: packets.map((p) => finish(p).toString('base64'))}});

// Scene packets per the AlgoClaw v1.2 recipe; prefix rule verified for H606A (remove 0x22, add 0x58).
function scenePackets(effect, {speed, prefixRemove = 1, prefixAdd = 0x58} = {}) {
    const param = Buffer.from(effect.scenceParam, 'base64');
    const body = Buffer.concat([Buffer.from([0x01, 0x00, prefixAdd]), param.subarray(prefixRemove)]);
    const n = Math.ceil(body.length / 17);
    body[1] = n;
    const packets = [];
    for (let i = 0; i < n; i++)
        packets.push(Buffer.concat([Buffer.from([0xa3, i === n - 1 ? 0xff : i]), body.subarray(i * 17, i * 17 + 17)]));
    packets.push([0x33, 0x05, 0x04, effect.sceneCode & 0xff, effect.sceneCode >> 8, 0x00, speed ?? param[1]]);
    return packets;
}

async function library(sku) {
    const res = await fetch(`https://app2.govee.com/appsku/v1/light-effect-libraries?sku=${sku}`, {
        headers: {AppVersion: '5.6.01'},
    });
    const json = await res.json();
    const scenes = [];
    for (const c of json.data.categories)
        for (const s of c.scenes)
            for (const e of s.lightEffects) scenes.push({category: c.categoryName, name: s.sceneName, ...e});
    return scenes;
}

let sku;
sock.on('message', (m, r) => {
    let j;
    try {
        j = JSON.parse(m.toString());
    } catch {
        return;
    }
    if (j.msg?.cmd === 'scan') sku = j.msg.data.sku;
    console.log(`+${Date.now() - t0}ms < ${r.address} ${JSON.stringify(j.msg)}`);
});

sock.bind(4002, async () => {
    try {
        await send({cmd: 'scan', data: {account_topic: 'reserve'}}, 4001);
        await sleep(800);
        switch (cmd) {
            case 'status':
                break;
            case 'on':
            case 'off':
                await send({cmd: 'turn', data: {value: cmd === 'on' ? 1 : 0}});
                break;
            case 'brightness':
                await send({cmd: 'brightness', data: {value: Number(args[0])}});
                break;
            case 'color':
                await send({
                    cmd: 'colorwc',
                    data: {color: {r: +args[0], g: +args[1], b: +args[2]}, colorTemInKelvin: 0},
                });
                break;
            case 'ct':
                await send({cmd: 'colorwc', data: {color: {r: 0, g: 0, b: 0}, colorTemInKelvin: Number(args[0])}});
                break;
            case 'scenes': {
                for (const s of await library(sku))
                    console.log(`${s.category.padEnd(10)} ${s.name.padEnd(18)} code ${s.sceneCode}`);
                break;
            }
            case 'scene': {
                const scenes = await library(sku);
                const want = args[0].toLowerCase().replace(/[^a-z0-9]/g, '');
                const s = scenes.find(
                    (x) => x.name.toLowerCase().replace(/[^a-z0-9]/g, '') === want || String(x.sceneCode) === args[0],
                );
                if (!s) throw new Error(`scene ${args[0]} not found for ${sku}`);
                const packets = scenePackets(s, {speed: args[1] === undefined ? undefined : Number(args[1])});
                console.log(
                    `> scene ${s.name} code ${s.sceneCode}:`,
                    packets.map((p) => finish(p).toString('hex')).join(' | '),
                );
                await ptReal(packets);
                break;
            }
            default:
                throw new Error(`unknown command ${cmd}`);
        }
        await sleep(1200);
        await send({cmd: 'devStatus', data: {}});
        await sleep(1000);
    } catch (e) {
        console.error(e.message);
    }
    sock.close();
});
