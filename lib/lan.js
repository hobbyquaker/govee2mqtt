/**
 * Govee LAN API client: one UDP socket bound to port 4002 (the devices always answer to the
 * source address on 4002), multicast membership for discovery, `scan` by multicast / broadcast /
 * unicast, `devStatus` polling and the JSON commands `turn`, `brightness`, `colorwc`, `ptReal`
 * (ROADMAP §2.1). No device state lives here — it emits parsed datagrams; lib/device.js keeps
 * state. Foreign traffic on the port is dropped silently.
 *
 * Events: `scan` ({ip, device, sku, ...}), `status` (ip, {onOff, brightness, color, colorTemInKelvin}),
 * `listening`, `error` (socket level, after which the socket is recreated).
 */

import dgram from 'node:dgram';
import {EventEmitter} from 'node:events';
import os from 'node:os';

export const MULTICAST = '239.255.255.250';
export const SCAN_PORT = 4001;
export const LISTEN_PORT = 4002;
export const CMD_PORT = 4003;
const SEND_GAP_MS = 35;

/** Parse one datagram; null for anything that is not a Govee message. */
export function parseDatagram(buffer) {
    let json;
    try {
        json = JSON.parse(buffer.toString('utf8'));
    } catch {
        return null;
    }
    const msg = json && json.msg;
    if (!msg || typeof msg.cmd !== 'string') {
        return null;
    }
    return {cmd: msg.cmd, data: msg.data && typeof msg.data === 'object' ? msg.data : {}};
}

/** `onOff` arrives as 0/1 or true/false; normalise a status reply. */
export function normalizeStatus(data) {
    const color = data.color && typeof data.color === 'object' ? data.color : {};
    return {
        onOff: data.onOff === true || Number(data.onOff) === 1,
        brightness: Number.isFinite(Number(data.brightness)) ? Number(data.brightness) : undefined,
        color: {r: Number(color.r) || 0, g: Number(color.g) || 0, b: Number(color.b) || 0},
        colorTemInKelvin: Number(data.colorTemInKelvin) || 0,
    };
}

/** IPv4 broadcast addresses of all non-internal interfaces. */
export function broadcastAddresses(interfaces = os.networkInterfaces()) {
    const out = new Set();
    for (const list of Object.values(interfaces)) {
        for (const i of list || []) {
            if (i.family !== 'IPv4' && i.family !== 4) {
                continue;
            }
            if (i.internal || !i.address || !i.netmask) {
                continue;
            }
            const a = i.address.split('.').map(Number);
            const m = i.netmask.split('.').map(Number);
            out.add(a.map((o, k) => (o & m[k]) | (~m[k] & 0xff)).join('.'));
        }
    }
    return [...out];
}

export class LanClient extends EventEmitter {
    /**
     * @param {object} options
     * @param {string[]} [options.addresses] unicast scan targets
     * @param {boolean} [options.broadcast] also scan by subnet broadcast
     * @param {string} [options.interface] IPv4 address of the interface to join the multicast group on
     * @param {number} [options.port] listen port (4002, tests only)
     * @param {object} [options.log]
     * @param {Function} [options.createSocket] dgram.createSocket override (tests)
     */
    constructor({addresses = [], broadcast = false, interface: iface, port = LISTEN_PORT, log, createSocket} = {}) {
        super();
        this.addresses = addresses;
        this.broadcast = broadcast;
        this.iface = iface;
        this.port = port;
        this.log = log || {debug() {}, info() {}, warn() {}, error() {}};
        this.createSocket = createSocket || (() => dgram.createSocket({type: 'udp4', reuseAddr: true}));
        this.socket = null;
        this.queues = new Map(); // ip → Promise chain (send pacing per device)
        this.multicastOk = false;
    }

    /** Bind the socket; rejects when the port is taken (EADDRINUSE). */
    start() {
        return new Promise((resolve, reject) => {
            const socket = this.createSocket();
            this.socket = socket;
            socket.on('message', (buffer, rinfo) => this.onMessage(buffer, rinfo));
            socket.once('error', reject);
            socket.bind(this.port, () => {
                socket.removeListener('error', reject);
                socket.on('error', (err) => {
                    this.log.warn('lan socket', err.message);
                    if (this.listenerCount('error')) {
                        this.emit('error', err);
                    }
                });
                try {
                    socket.setBroadcast(true);
                } catch (err) {
                    this.log.debug('lan setBroadcast', err.message);
                }
                try {
                    socket.addMembership(MULTICAST, this.iface);
                    this.multicastOk = true;
                } catch (err) {
                    this.log.warn('lan cannot join multicast group', MULTICAST, '-', err.message);
                }
                this.log.info(
                    'lan listening on udp',
                    this.port,
                    this.multicastOk ? `(multicast ${MULTICAST})` : '(no multicast)',
                );
                this.emit('listening');
                resolve();
            });
        });
    }

    stop() {
        return new Promise((resolve) => {
            if (!this.socket) {
                return resolve();
            }
            const s = this.socket;
            this.socket = null;
            try {
                s.close(() => resolve());
            } catch {
                resolve();
            }
        });
    }

    onMessage(buffer, rinfo) {
        const parsed = parseDatagram(buffer);
        if (!parsed) {
            this.log.debug('lan < ignoring', buffer.length, 'bytes from', rinfo.address);
            return;
        }
        this.log.debug('lan <', rinfo.address, JSON.stringify(parsed));
        switch (parsed.cmd) {
            case 'scan': {
                // newer firmware may omit ip — the datagram's source is authoritative anyway
                const info = {...parsed.data, ip: rinfo.address};
                if (!info.device || !info.sku) {
                    return;
                }
                this.emit('scan', info);
                break;
            }
            case 'devStatus':
                this.emit('status', rinfo.address, normalizeStatus(parsed.data));
                break;
            default:
                this.emit('message', rinfo.address, parsed);
        }
    }

    sendRaw(payload, port, address) {
        return new Promise((resolve, reject) => {
            if (!this.socket) {
                return reject(new Error('lan socket not started'));
            }
            this.socket.send(payload, port, address, (err) => (err ? reject(err) : resolve()));
        });
    }

    /** Send a command to one device, paced per device (35 ms between datagrams). */
    send(ip, cmd, data = {}) {
        const payload = JSON.stringify({msg: {cmd, data}});
        const prev = this.queues.get(ip) || Promise.resolve();
        const next = prev
            .catch(() => {})
            .then(async () => {
                this.log.debug('lan >', ip, payload.length > 300 ? payload.slice(0, 300) + '…' : payload);
                await this.sendRaw(payload, CMD_PORT, ip);
                await new Promise((r) => setTimeout(r, SEND_GAP_MS));
            });
        this.queues.set(ip, next);
        next.finally(() => {
            if (this.queues.get(ip) === next) {
                this.queues.delete(ip);
            }
        });
        return next;
    }

    /** Discovery: multicast + (optional) broadcasts + unicast targets. Replies arrive as `scan` events. */
    async scan() {
        const payload = JSON.stringify({msg: {cmd: 'scan', data: {account_topic: 'reserve'}}});
        const targets = [];
        if (this.multicastOk) {
            targets.push(MULTICAST);
        }
        if (this.broadcast) {
            targets.push(...broadcastAddresses(), '255.255.255.255');
        }
        targets.push(...this.addresses);
        const used = [];
        for (const t of new Set(targets)) {
            try {
                await this.sendRaw(payload, SCAN_PORT, t);
                used.push(t);
            } catch (err) {
                this.log.debug('lan scan', t, err.message);
            }
        }
        this.log.debug('lan > scan', used.join(' '));
        return used;
    }

    queryStatus(ip) {
        return this.send(ip, 'devStatus', {});
    }

    turn(ip, on) {
        return this.send(ip, 'turn', {value: on ? 1 : 0});
    }

    brightness(ip, percent) {
        return this.send(ip, 'brightness', {value: percent});
    }

    color(ip, {r, g, b}) {
        return this.send(ip, 'colorwc', {color: {r, g, b}, colorTemInKelvin: 0});
    }

    colorTemperature(ip, kelvin) {
        return this.send(ip, 'colorwc', {color: {r: 0, g: 0, b: 0}, colorTemInKelvin: kelvin});
    }

    /** @param {string[]} frames base64 20-byte frames (lib/packet.js toBase64) */
    ptReal(ip, frames) {
        return this.send(ip, 'ptReal', {command: frames});
    }
}
