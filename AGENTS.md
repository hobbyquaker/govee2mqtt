# Agent instructions — govee2mqtt

## What this is

govee2mqtt is an MQTT bridge for Govee WiFi lights over the **Govee LAN API** (UDP 4001/4002/4003,
JSON commands plus raw `ptReal` packets), one of the `xyz2mqtt` adapters by the same author. All
follow the [mqtt-smarthome](https://github.com/mqtt-smarthome/mqtt-smarthome) architecture and
are built on [mqtt-interfaces-core](https://github.com/hobbyquaker/mqtt-interfaces-core)
(`../mqtt-interfaces-core` when checked out next to this repo — generic fixes go there; its README
is the complete guide to building an adapter). Consistency with the core's conventions and with
cul2mqtt / lgtv2mqtt 3 / wiim2mqtt is a hard requirement. ROADMAP.md holds the analysis, the
implementation spec (§4), decisions (G-n) and open questions (OQ-Gn); RESEARCH.md the protocol
notes and live test log. **No Bluetooth** — network transports only (decision in ROADMAP).

## MQTT conventions

`<name>/connected` (0/1/2, bridge level), `<name>/status/<dev>/<item>` retained `{val, ts, lc}`,
`<name>/set/<dev>/<item>` commands, `<name>/status/bridge/*`, `<name>/info`, `maintenance/*` from
the core. Items: `power`, `brightness`, `color` `{r,g,b}`, `color_temp`, `color_mode`, `scene`,
`music`, `online`, `sku`, `device`, `ip`, `firmware`. `scene`/`music` are "last commanded" (the LAN
cannot read them). Do not rename topics outside a major release.

## Code layout (ES modules, node >= 20.19)

- `index.js` — `createAdapter()` + wiring: `LanClient` events → devices → `pubStatus()`,
  `handleSet()` → `commandFor()` → LAN commands / packets, verify poll 1 s after every command,
  staggered polling, periodic scans, HA discovery re-publish when devices appear.
- `lib/lan.js` — `LanClient`: one UDP socket on 4002, multicast membership, scan targets, paced
  per-device sends, datagram parsing (foreign traffic ignored). Socket injectable for tests.
- `lib/packet.js` — pure: 20-byte frames + XOR checksum, `0xa3` multi-packet splitter, scene /
  music / raw encoders. Tests pin it to `test/fixtures/capture-h606a.json` (app packets).
- `lib/sku.js` — per-SKU data: scene prefix rules (AlgoClaw recipe + H606A capture), music mode
  definitions, colour temperature ranges. Extend with data, not code.
- `lib/scenes.js` — `SceneLibrary`: Govee's public `light-effect-libraries` endpoint per SKU with a
  disk cache; `parseLibrary()`, `sceneName()`, `find()` are pure.
- `lib/device.js` — `Device`: identity, state diffing, online tracking, the G-5 scene/colour-mode
  heuristics. Pure.
- `lib/items.js` — `commandFor(item, value)`: payload parsing. `lib/hadiscovery.js` —
  `discoveryModel()`: pure device blocks. `lib/install.js`, `config.js` — core wiring.
- `scripts/lan-probe.mjs` — talk to one device without MQTT (research/debug tool).
- `test/` — node:test for every lib module; `test/fixtures/` has the captured packets and a
  recorded library response for the H606A.

## Style & practices

Plain JavaScript ESM, 4 spaces, single quotes, eslint + prettier (`npm run lint`, `npm run format`),
`npm test`. Only dependency: `mqtt-interfaces-core` (`mqtt`, `yargs` come with it). Log `lan >` /
`lan <` at debug; device offline/online at warn/info (transitions only); rejected `set`s are
warned by the core with topic, payload and reason. Raw transmit stays opt-in. Never make defaults
point at personal infrastructure.

## Running / testing live

```
node index.js -u mqtt://broker -a <device ip> -v debug
node scripts/lan-probe.mjs <device ip> scenes
```

The author's test device is an H606A; `RESEARCH.md` §1 has the live test log. Scene activation
cannot be verified from the LAN status (no scene field) — only visually.
