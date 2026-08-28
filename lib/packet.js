/**
 * The raw packet format Govee devices accept over the LAN API's `ptReal` command (the same
 * 20-byte frames the app writes over BLE): bytes 0–18 payload, zero padded, byte 19 = XOR of
 * bytes 0–18. Several frames travel in one `ptReal` message, in order. Pure functions, no I/O.
 *
 * Multi-packet definitions (`0xa3`): a byte stream `01 <count> <type> <definition…>` split into
 * 17-byte chunks, each framed `a3 <index>` with the last chunk indexed `0xff`. Scenes are a
 * definition (the scene library's `scenceParam`, per-SKU prefix rule from lib/sku.js) followed by a
 * select frame `33 05 04 <code LE u16> …`; music modes a definition of type 0x41 followed by
 * `33 05 13`. See ROADMAP.md §2.3.
 */

export const FRAME_LENGTH = 20;
const CHUNK = 17;

/** XOR of bytes 0–18 of a frame (or of all given bytes). */
export function checksum(bytes) {
    let x = 0;
    for (let i = 0; i < Math.min(bytes.length, FRAME_LENGTH - 1); i++) {
        x ^= bytes[i];
    }
    return x;
}

/** Pad a payload (≤ 19 bytes) to a 20-byte frame with its checksum. */
export function frame(payload) {
    const bytes = Buffer.from(payload);
    if (bytes.length > FRAME_LENGTH - 1) {
        throw new Error(`payload too long (${bytes.length} > ${FRAME_LENGTH - 1})`);
    }
    const out = Buffer.alloc(FRAME_LENGTH);
    bytes.copy(out);
    out[FRAME_LENGTH - 1] = checksum(out);
    return out;
}

/** True if `bytes` is a 20-byte frame whose checksum is valid. */
export function isValidFrame(bytes) {
    return bytes.length === FRAME_LENGTH && checksum(bytes) === bytes[FRAME_LENGTH - 1];
}

/**
 * Split a definition into `0xa3` multi-packet frames.
 *
 * @param {number} type the byte after the chunk count (0x58 scenes on H606A, 0x02 generic, 0x41 music)
 * @param {Uint8Array | Buffer} definition
 * @returns {Buffer[]} frames
 */
export function multi(type, definition) {
    const body = Buffer.concat([Buffer.from([0x01, 0x00, type & 0xff]), Buffer.from(definition)]);
    const count = Math.max(1, Math.ceil(body.length / CHUNK));
    if (count > 0xfe) {
        throw new Error(`definition too long (${body.length} bytes)`);
    }
    body[1] = count;
    const frames = [];
    for (let i = 0; i < count; i++) {
        const index = i === count - 1 ? 0xff : i;
        frames.push(frame(Buffer.concat([Buffer.from([0xa3, index]), body.subarray(i * CHUNK, (i + 1) * CHUNK)])));
    }
    return frames;
}

/** Inverse of multi(): the concatenated chunk payloads of `0xa3` frames (padding included). */
export function unmulti(frames) {
    return Buffer.concat(frames.map((f) => Buffer.from(f).subarray(2, 2 + CHUNK)));
}

export const power = (on) => frame([0x33, 0x01, on ? 0x01 : 0x00]);
export const brightness = (percent) => frame([0x33, 0x04, Math.min(100, Math.max(1, Math.round(percent)))]);

/**
 * Scene activation frames for one light effect of the scene library.
 *
 * @param {{sceneCode: number, scenceParam: string}} effect one `lightEffects[]` entry
 * @param {{remove?: string, add?: string, suffix?: string, speedByte?: boolean}} rule per-SKU
 *        prefix rule (lib/sku.js): `remove` hex prefix stripped from the param, `add` hex prefix
 *        put in front (its first byte is the multi-packet type), `suffix` hex appended to the
 *        select frame, `speedByte` → select frame ends with `<flag=0> <speed>`
 * @param {{speed?: number}} [options] speed 0–100; default = the definition's own default
 * @returns {Buffer[]} frames (definition frames, then the select frame)
 */
export function scene(effect, rule = {}, {speed} = {}) {
    const param = Buffer.from(effect.scenceParam || '', 'base64');
    const remove = Buffer.from(rule.remove || '', 'hex');
    const add = Buffer.from(rule.add || '02', 'hex');
    const suffix = Buffer.from(rule.suffix || '', 'hex');
    const code = Number(effect.sceneCode);
    if (!Number.isInteger(code) || code < 0 || code > 0xffff) {
        throw new Error(`invalid scene code ${effect.sceneCode}`);
    }
    const select = [0x33, 0x05, 0x04, code & 0xff, code >> 8, ...suffix];
    if (param.length === 0) {
        return [frame(select)];
    }
    if (remove.length && !param.subarray(0, remove.length).equals(remove)) {
        throw new Error(`scene param does not start with ${rule.remove}`);
    }
    const definition = Buffer.concat([add.subarray(1), param.subarray(remove.length)]);
    if (rule.speedByte) {
        const defaultSpeed = param[remove.length] ?? 0;
        const s = speed === undefined ? defaultSpeed : Math.min(100, Math.max(0, Math.round(speed)));
        select.push(0x00, s);
    }
    return [...multi(add[0], definition), frame(select)];
}

/**
 * Music mode frames: a type 0x41 definition followed by `33 05 13`.
 * @param {string | Uint8Array} definition hex string or bytes (lib/sku.js)
 */
export function music(definition) {
    const bytes = typeof definition === 'string' ? Buffer.from(definition, 'hex') : Buffer.from(definition);
    return [...multi(0x41, bytes), frame([0x33, 0x05, 0x13])];
}

/** Frames → the `command` array of a `ptReal` message. */
export function toBase64(frames) {
    return frames.map((f) => Buffer.from(f).toString('base64'));
}

/**
 * Parse user-supplied raw frames (`set/<dev>/raw`): a JSON array or a whitespace/comma separated
 * list of hex (`33 01 01`, `330101`) or base64 frames; 19-byte payloads get their checksum added,
 * 20-byte frames must carry a valid one.
 * @returns {Buffer[]}
 */
export function parseRaw(input) {
    let parts;
    if (Array.isArray(input)) {
        parts = input.map(String);
    } else if (typeof input === 'string') {
        const s = input.trim();
        if (s.startsWith('[')) {
            parts = JSON.parse(s).map(String);
        } else if (/^[0-9a-fA-F\s]+$/.test(s)) {
            // one or more hex frames, spaces optional; split on 40-hex-char boundaries
            const hex = s.replace(/\s+/g, '');
            if (hex.length % 2) {
                throw new Error('odd hex length');
            }
            parts = hex.match(/.{1,40}/g) || [];
        } else {
            parts = s.split(/[\s,]+/).filter(Boolean);
        }
    } else {
        throw new Error('raw frames must be a string or an array');
    }
    return parts.map((p) => {
        const isHex = /^[0-9a-fA-F]+$/.test(p) && p.length % 2 === 0 && p.length <= 40;
        const bytes = Buffer.from(p, isHex ? 'hex' : 'base64');
        if (bytes.length === 0) {
            throw new Error(`cannot parse frame "${p}"`);
        }
        if (bytes.length === FRAME_LENGTH) {
            if (!isValidFrame(bytes)) {
                throw new Error(`bad checksum in frame ${bytes.toString('hex')}`);
            }
            return bytes;
        }
        return frame(bytes);
    });
}
