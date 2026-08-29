/**
 * Finding Govee devices before the adapter runs (core B-2).
 *
 * The same `scan` the running bridge sends (lib/lan.js), but through the core's discovery module
 * so `--discover` and she's add-instance dialog can use it: a JSON datagram to port 4001 —
 * multicast to 239.255.255.250, plus every local broadcast address and whatever
 * `--discover-address` named — and every device that hears it answers.
 *
 * The catch, and the reason core 0.10.0 grew `bindPort`: a Govee device replies to port **4002**
 * on the sender's address, ignoring the source port the probe went out from. A probe on an
 * ephemeral port hears nothing at all. That is also the port a running instance of this adapter
 * holds, which is why the socket is shared rather than exclusive — see the core README §8.
 *
 * The answer is its own proof: only a Govee device sends `{"msg":{"cmd":"scan","data":{…}}}` with
 * a `device` id and an `sku`, so there is no separate `probe` step and no `ports` to check. That
 * matters here — the LAN API listens on UDP only, so a TCP sweep would find nothing and is
 * exactly what we do not want running.
 */

import {MULTICAST, SCAN_PORT, LISTEN_PORT, parseDatagram} from './lan.js';

/** The datagram every Govee device on the LAN answers. */
export const SCAN_PAYLOAD = JSON.stringify({msg: {cmd: 'scan', data: {account_topic: 'reserve'}}});

/**
 * A `scan` answer → the fields `--discover` prints, or null for anything else on the port.
 *
 * `device` (the mac-shaped id) and `sku` (the model, `H606A`) are what make it a Govee answer;
 * without both this is someone else's datagram. The device's own `ip` field is ignored — newer
 * firmware omits it, and the datagram's source address is authoritative anyway (lib/lan.js).
 *
 * @param {Buffer} message
 * @returns {{name: string, model: string, device: string, firmware?: string}|null}
 */
export function parseScan(message) {
    const parsed = parseDatagram(message);
    if (!parsed || parsed.cmd !== 'scan') {
        return null;
    }
    const {device, sku, wifiVersionSoft, bleVersionSoft} = parsed.data;
    if (!device || !sku) {
        return null;
    }
    return {
        // the LAN API has no friendly name — the sku is the most useful label a scan can offer
        name: sku,
        model: sku,
        device,
        ...(wifiVersionSoft && {firmware: String(wifiVersionSoft)}),
        ...(bleVersionSoft && {bleFirmware: String(bleVersionSoft)}),
    };
}

/** The hint `--discover` and `--address auto` scan with. */
export function discoveryHint() {
    return {
        udp: {
            port: SCAN_PORT,
            bindPort: LISTEN_PORT, // the devices answer here, never to the source port
            address: MULTICAST,
            payload: SCAN_PAYLOAD,
            parse: parseScan,
        },
    };
}
