import {test, describe} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';

import {LanClient, parseDatagram, normalizeStatus, broadcastAddresses, MULTICAST} from '../lib/lan.js';

/** A fake dgram socket: records sends, lets tests inject datagrams. */
class FakeSocket extends EventEmitter {
    constructor() {
        super();
        this.sent = [];
        this.memberships = [];
        this.closed = false;
    }
    bind(port, cb) {
        this.port = port;
        setImmediate(cb);
    }
    setBroadcast() {}
    addMembership(group, iface) {
        this.memberships.push([group, iface]);
    }
    send(payload, port, address, cb) {
        this.sent.push({payload: JSON.parse(payload.toString()), port, address});
        setImmediate(() => cb(null));
    }
    close(cb) {
        this.closed = true;
        cb && cb();
    }
    inject(json, address, port = 51292) {
        this.emit('message', Buffer.from(JSON.stringify(json)), {address, port});
    }
}

const client = async (options = {}) => {
    const socket = new FakeSocket();
    const lan = new LanClient({...options, createSocket: () => socket});
    await lan.start();
    return {lan, socket};
};

describe('parsing', () => {
    test('parseDatagram ignores foreign traffic', () => {
        assert.equal(parseDatagram(Buffer.from('M-SEARCH * HTTP/1.1')), null);
        assert.equal(parseDatagram(Buffer.from('{"foo":1}')), null);
        assert.equal(parseDatagram(Buffer.from('{"msg":{}}')), null);
        assert.deepEqual(parseDatagram(Buffer.from('{"msg":{"cmd":"devStatus","data":{"onOff":1}}}')), {
            cmd: 'devStatus',
            data: {onOff: 1},
        });
        assert.deepEqual(parseDatagram(Buffer.from('{"msg":{"cmd":"x"}}')), {cmd: 'x', data: {}});
    });

    test('normalizeStatus', () => {
        assert.deepEqual(normalizeStatus({onOff: 1, brightness: 50, color: {r: 1, g: 2, b: 3}, colorTemInKelvin: 0}), {
            onOff: true,
            brightness: 50,
            color: {r: 1, g: 2, b: 3},
            colorTemInKelvin: 0,
        });
        assert.equal(normalizeStatus({onOff: true}).onOff, true);
        assert.equal(normalizeStatus({onOff: '0'}).onOff, false);
        assert.deepEqual(normalizeStatus({}).color, {r: 0, g: 0, b: 0});
        assert.equal(normalizeStatus({}).brightness, undefined);
    });

    test('broadcastAddresses', () => {
        const ifaces = {
            lo0: [{family: 'IPv4', address: '127.0.0.1', netmask: '255.0.0.0', internal: true}],
            eth0: [
                {family: 'IPv4', address: '172.16.23.226', netmask: '255.255.255.0', internal: false},
                {family: 'IPv6', address: 'fe80::1', netmask: 'ffff::', internal: false},
            ],
            en0: [{family: 4, address: '192.168.8.214', netmask: '255.255.248.0', internal: false}],
        };
        assert.deepEqual(broadcastAddresses(ifaces), ['172.16.23.255', '192.168.15.255']);
    });
});

describe('LanClient', () => {
    test('start joins the multicast group and scan sends to multicast + unicast targets', async () => {
        const {lan, socket} = await client({addresses: ['10.0.0.5']});
        assert.equal(socket.port, 4002);
        assert.deepEqual(socket.memberships, [[MULTICAST, undefined]]);
        const used = await lan.scan();
        assert.deepEqual(used, [MULTICAST, '10.0.0.5']);
        assert.deepEqual(socket.sent[0], {
            payload: {msg: {cmd: 'scan', data: {account_topic: 'reserve'}}},
            port: 4001,
            address: MULTICAST,
        });
        assert.equal(socket.sent[1].address, '10.0.0.5');
        await lan.stop();
        assert.ok(socket.closed);
    });

    test('scan and status events; the source address wins over the reply ip', async () => {
        const {lan, socket} = await client();
        const scans = [];
        const statuses = [];
        lan.on('scan', (i) => scans.push(i));
        lan.on('status', (ip, s) => statuses.push([ip, s]));
        socket.inject(
            {msg: {cmd: 'scan', data: {ip: '1.2.3.4', device: 'AA:BB', sku: 'H606A', wifiVersionSoft: '1.03.01'}}},
            '172.16.23.120',
        );
        socket.inject({msg: {cmd: 'scan', data: {device: 'CC:DD', sku: 'H6072'}}}, '172.16.23.121');
        socket.inject({msg: {cmd: 'scan', data: {sku: 'H6072'}}}, '172.16.23.122');
        socket.inject(
            {
                msg: {
                    cmd: 'devStatus',
                    data: {onOff: 0, brightness: 100, color: {r: 255, g: 127, b: 0}, colorTemInKelvin: 0},
                },
            },
            '172.16.23.120',
        );
        socket.emit('message', Buffer.from('NOTIFY * HTTP/1.1'), {address: '9.9.9.9', port: 1900});
        assert.equal(scans.length, 2);
        assert.equal(scans[0].ip, '172.16.23.120');
        assert.equal(scans[0].wifiVersionSoft, '1.03.01');
        assert.equal(scans[1].ip, '172.16.23.121');
        assert.deepEqual(statuses, [
            ['172.16.23.120', {onOff: false, brightness: 100, color: {r: 255, g: 127, b: 0}, colorTemInKelvin: 0}],
        ]);
        await lan.stop();
    });

    test('commands are JSON to port 4003 and paced per device', async () => {
        const {lan, socket} = await client();
        const t0 = Date.now();
        await Promise.all([lan.turn('1.1.1.1', true), lan.brightness('1.1.1.1', 50), lan.turn('2.2.2.2', false)]);
        const elapsed = Date.now() - t0;
        assert.ok(elapsed >= 60, `two paced sends to one device take ≥ 70 ms (took ${elapsed})`);
        assert.deepEqual(
            socket.sent.map((s) => [s.address, s.port, s.payload.msg.cmd]),
            [
                ['1.1.1.1', 4003, 'turn'],
                ['2.2.2.2', 4003, 'turn'],
                ['1.1.1.1', 4003, 'brightness'],
            ],
        );
        assert.deepEqual(socket.sent[0].payload, {msg: {cmd: 'turn', data: {value: 1}}});
        await lan.color('1.1.1.1', {r: 0, g: 0, b: 255});
        await lan.colorTemperature('1.1.1.1', 4000);
        await lan.ptReal('1.1.1.1', ['MwEB']);
        await lan.queryStatus('1.1.1.1');
        assert.deepEqual(
            socket.sent.slice(3).map((s) => s.payload.msg),
            [
                {cmd: 'colorwc', data: {color: {r: 0, g: 0, b: 255}, colorTemInKelvin: 0}},
                {cmd: 'colorwc', data: {color: {r: 0, g: 0, b: 0}, colorTemInKelvin: 4000}},
                {cmd: 'ptReal', data: {command: ['MwEB']}},
                {cmd: 'devStatus', data: {}},
            ],
        );
        await lan.stop();
    });

    test('bind failure rejects start', async () => {
        const socket = new FakeSocket();
        socket.bind = () =>
            setImmediate(() => socket.emit('error', Object.assign(new Error('EADDRINUSE'), {code: 'EADDRINUSE'})));
        const lan = new LanClient({createSocket: () => socket});
        await assert.rejects(lan.start(), /EADDRINUSE/);
    });

    test('multicast join failure is not fatal; scan falls back to broadcast/unicast', async () => {
        const socket = new FakeSocket();
        socket.addMembership = () => {
            throw new Error('ENODEV');
        };
        const warnings = [];
        const lan = new LanClient({
            createSocket: () => socket,
            broadcast: true,
            log: {debug() {}, info() {}, warn: (...a) => warnings.push(a.join(' ')), error() {}},
        });
        await lan.start();
        assert.equal(lan.multicastOk, false);
        assert.match(warnings[0], /multicast/);
        const used = await lan.scan();
        assert.ok(!used.includes(MULTICAST));
        assert.ok(used.includes('255.255.255.255'));
        await lan.stop();
    });
});
