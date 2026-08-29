import {test, describe} from 'node:test';
import assert from 'node:assert/strict';

import {discoveryHint, parseScan, SCAN_PAYLOAD} from '../lib/discovery.js';
import {MULTICAST, SCAN_PORT, LISTEN_PORT} from '../lib/lan.js';

/** A real `scan` answer from the H606A (RESEARCH.md §1). */
const answer = (data) => Buffer.from(JSON.stringify({msg: {cmd: 'scan', data}}));

const H606A = {
    ip: '192.168.1.50',
    device: 'AB:CD:EF:12:34:56:78:90',
    sku: 'H606A',
    bleVersionHard: '3.01.01',
    bleVersionSoft: '1.03.01',
    wifiVersionHard: '1.00.10',
    wifiVersionSoft: '1.02.11',
};

describe('parseScan', () => {
    test('a scan answer becomes the fields --discover prints', () => {
        assert.deepEqual(parseScan(answer(H606A)), {
            name: 'H606A',
            model: 'H606A',
            device: 'AB:CD:EF:12:34:56:78:90',
            firmware: '1.02.11',
            bleFirmware: '1.03.01',
        });
    });

    test('the device’s own ip field is ignored — the source address is authoritative', () => {
        // newer firmware omits it entirely, and the core fills `address` from the datagram
        assert.equal(Object.hasOwn(parseScan(answer(H606A)), 'ip'), false);
        const {ip, ...withoutIp} = H606A;
        void ip;
        assert.equal(parseScan(answer(withoutIp)).device, H606A.device);
    });

    test('device and sku are what make it a Govee answer', () => {
        assert.equal(parseScan(answer({sku: 'H606A'})), null, 'no device id');
        assert.equal(parseScan(answer({device: 'AB:CD'})), null, 'no sku');
    });

    test('foreign traffic on 4002 is dropped, not guessed at', () => {
        assert.equal(parseScan(Buffer.from('not json at all')), null);
        assert.equal(parseScan(Buffer.from(JSON.stringify({hello: 'world'}))), null);
        assert.equal(parseScan(answer({device: 'x', sku: 'y'}) && Buffer.from('{"msg":{}}')), null);
    });

    test('a devStatus reply on the same socket is not a scan answer', () => {
        const status = Buffer.from(JSON.stringify({msg: {cmd: 'devStatus', data: {onOff: 1, brightness: 50}}}));
        assert.equal(parseScan(status), null);
    });

    test('firmware fields are optional', () => {
        assert.deepEqual(parseScan(answer({device: 'AB:CD', sku: 'H6199'})), {
            name: 'H6199',
            model: 'H6199',
            device: 'AB:CD',
        });
    });
});

describe('discoveryHint', () => {
    const hint = discoveryHint();

    test('scans to 4001 but listens on 4002, which is where the devices answer', () => {
        assert.equal(hint.udp.port, SCAN_PORT, 'probe goes to 4001');
        assert.equal(hint.udp.bindPort, LISTEN_PORT, 'answers arrive on 4002');
        assert.notEqual(hint.udp.port, hint.udp.bindPort);
    });

    test('sends the same scan datagram the running bridge sends', () => {
        assert.equal(hint.udp.address, MULTICAST);
        assert.deepEqual(JSON.parse(SCAN_PAYLOAD), {msg: {cmd: 'scan', data: {account_topic: 'reserve'}}});
        assert.equal(hint.udp.payload, SCAN_PAYLOAD);
    });

    test('declares no ports: the LAN API is udp only, so a tcp sweep would find nothing', () => {
        assert.equal(hint.ports, undefined);
        assert.equal(hint.probe, undefined, 'the scan answer is its own proof');
    });

    test('the hint parses an answer end to end', () => {
        assert.equal(hint.udp.parse(answer(H606A)).model, 'H606A');
    });
});
