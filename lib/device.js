/**
 * One Govee device as the bridge sees it: identity from `scan`, the normalised state from
 * `devStatus` polls, the items the LAN cannot report (`scene`, `music`, `color_mode` — "last
 * commanded", ROADMAP G-5) and online tracking. Pure state, no I/O: `applyStatus()` returns the
 * items that changed so the caller publishes only those.
 */

export const COLOR_MODES = ['rgb', 'ct', 'scene', 'music', 'unknown'];

/** Topic name from the device id: `<sku lower>_<last two id bytes>` → `h606a_bf71`. */
export function defaultDeviceName(sku, id) {
    const tail = String(id)
        .split(':')
        .slice(-2)
        .join('')
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '');
    return `${String(sku)
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '')}_${tail}`;
}

export function isValidDeviceName(name) {
    return /^[a-z0-9][a-z0-9_-]*$/.test(name);
}

export class Device {
    /**
     * @param {{device: string, sku: string, ip: string, name: string, bleVersionHard?: string,
     *          bleVersionSoft?: string, wifiVersionHard?: string, wifiVersionSoft?: string}} info
     */
    constructor(info) {
        this.id = info.device;
        this.sku = String(info.sku).toUpperCase();
        this.ip = info.ip;
        this.name = info.name;
        this.firmware = {
            wifi: info.wifiVersionSoft,
            ble: info.bleVersionSoft,
            wifiHw: info.wifiVersionHard,
            bleHw: info.bleVersionHard,
        };
        this.state = {}; // published items → value
        this.online = false;
        this.lastSeen = 0;
        this.missedPolls = 0;
        this.scenes = []; // from the scene library
        this.lastCommand = null; // {item, value, at}
        this.lastColorCommandAt = 0; // colour / colour-temperature commands (mode pending until a poll agrees)
    }

    /** Static items published once per device (and again when they change). */
    identityItems() {
        return {
            sku: this.sku,
            device: this.id,
            ip: this.ip,
            firmware: {wifi: this.firmware.wifi, ble: this.firmware.ble},
        };
    }

    /** Update ip/firmware from a later scan reply; returns the changed identity items. */
    applyScan(info) {
        const before = JSON.stringify(this.identityItems());
        this.ip = info.ip || this.ip;
        this.firmware.wifi = info.wifiVersionSoft ?? this.firmware.wifi;
        this.firmware.ble = info.bleVersionSoft ?? this.firmware.ble;
        this.firmware.wifiHw = info.wifiVersionHard ?? this.firmware.wifiHw;
        this.firmware.bleHw = info.bleVersionHard ?? this.firmware.bleHw;
        this.seen();
        const items = this.identityItems();
        return JSON.stringify(items) === before ? {} : items;
    }

    seen(now = Date.now()) {
        this.lastSeen = now;
        this.missedPolls = 0;
        const wasOnline = this.online;
        this.online = true;
        return !wasOnline;
    }

    /** A poll went unanswered; returns true when the device just went offline. */
    missed(threshold = 3) {
        this.missedPolls++;
        if (this.online && this.missedPolls >= threshold) {
            this.online = false;
            return true;
        }
        return false;
    }

    /**
     * Apply a `devStatus` reply. Returns the changed items (`power`, `brightness`, `color`,
     * `color_temp`, `color_mode`, `scene`, `music`).
     * @param {{onOff: boolean, brightness?: number, color: {r,g,b}, colorTemInKelvin: number}} status
     */
    applyStatus(status, now = Date.now()) {
        this.seen(now);
        const next = {
            power: status.onOff,
            brightness: status.brightness ?? this.state.brightness,
            color: status.color,
            color_temp: status.colorTemInKelvin,
        };
        const changed = {};
        for (const [k, v] of Object.entries(next)) {
            if (v !== undefined && JSON.stringify(v) !== JSON.stringify(this.state[k])) {
                changed[k] = v;
            }
        }
        // colour/ct/power changed by something else than our last command → the light left the
        // scene or music mode we set (G-5); our own command's verify poll is exempt
        const lastCommandRecent = this.lastCommand && now - this.lastCommand.at < 5000;
        const inEffect = this.state.color_mode === 'scene' || this.state.color_mode === 'music';
        const lightChanged = 'color' in changed || 'color_temp' in changed;
        let colorMode = this.state.color_mode;
        if (inEffect && lightChanged && !lastCommandRecent) {
            colorMode = next.color_temp > 0 ? 'ct' : 'rgb';
            changed.scene = '';
            changed.music = '';
        } else if (!inEffect) {
            // a routine poll can land before the device applied our colour/ct command: keep the
            // commanded mode until a poll agrees (the verify poll follows 1 s after the command)
            const polled = next.color_temp > 0 ? 'ct' : 'rgb';
            const pending = now - this.lastColorCommandAt < 5000;
            if (!pending || polled === this.state.color_mode) {
                colorMode = polled;
            }
        }
        if (colorMode !== this.state.color_mode) {
            changed.color_mode = colorMode;
        }
        Object.assign(this.state, changed);
        return changed;
    }

    /** Record a command we sent so the next poll can tell our change from foreign ones. */
    commanded(item, value, now = Date.now()) {
        this.lastCommand = {item, value, at: now};
        const changed = {};
        if (item === 'scene') {
            Object.assign(changed, {scene: value, music: '', color_mode: 'scene'});
        } else if (item === 'music') {
            Object.assign(changed, {music: value, scene: '', color_mode: 'music'});
        } else if (item === 'color' || item === 'color_temp') {
            this.lastColorCommandAt = now;
            if (this.state.scene || this.state.music) {
                Object.assign(changed, {scene: '', music: ''});
            }
            changed.color_mode = item === 'color' ? 'rgb' : 'ct';
        }
        for (const k of Object.keys(changed)) {
            if (changed[k] === this.state[k]) {
                delete changed[k];
            }
        }
        Object.assign(this.state, changed);
        return changed;
    }
}
