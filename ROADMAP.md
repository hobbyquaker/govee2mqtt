# Roadmap & implementation spec — govee2mqtt

MQTT interface for **Govee** WiFi lights (LED strips, light panels such as the Glide Hexa Ultra,
lamps, bars) — and, over the cloud API, the rest of Govee's WiFi range — following the
[mqtt-smarthome](https://github.com/mqtt-smarthome/mqtt-smarthome) architecture and the
`xyz2mqtt` fleet conventions. It is built on
[mqtt-interfaces-core](https://github.com/hobbyquaker/mqtt-interfaces-core) (config, MQTT,
`{val, ts, lc}` payloads, `info` / `maintenance` topics, discovery publishing, installer,
logging); this adapter is left with the Govee protocols (LAN API over UDP, the raw `ptReal`
packet format, the Platform API over HTTPS) and the item table. It replaces the author's
single-device script `mqtt-govee-hexa-ultra` (2024, §1.1).

Like alexa-remote-mqtt, cul2mqtt and homeconnect2mqtt it is a **bridge**: one instance = one LAN
(plus optionally one Govee account) = all Govee devices it can see, addressed as
`<name>/status/<dev>/<item>`.

**Scope decision (2026-08-28): network transports only — no Bluetooth LE.** Everything a WiFi Govee
device can do over BLE it can also do over the LAN API's `ptReal` command with the same packet
bytes (§2.3), and BLE would add a native stack, pairing and a one-central-at-a-time limit for no
gain. BLE-only Govee devices are out of scope.

Fleet-wide decisions D-1 … D-13 live in the mqtt-interfaces master roadmap; the core's are C-n,
wiim2mqtt's W-n, homeconnect2mqtt's H-n. This file uses **G-n** for govee2mqtt decisions and
**OQ-Gn** for its open questions. Status 2026-08-29: 0.2.0 published — LAN bridge, scenes from
the library, HA discovery, core device discovery (`--discover`, `-a auto`), 52 unit tests, MQTT
round trip and discovery both verified live on the H606A (RESEARCH.md §1); scene activation still
awaits a visual check (§6).

Contents: 1 prior art · 2 Govee facts · 3 what users struggle with elsewhere · 4 implementation
spec · 5 decisions · 6 milestones · 7 housekeeping · 8 open questions · 9 sources.

---

## 1. Prior art

### 1.1 `mqtt-govee-hexa-ultra` (own, 2024; analysed 2026-08-28 from `prior-art/`, then deleted)

A single-device CommonJS script (yalm + yargs + mqtt 5, ~330 lines) that drove one H606A over the
LAN API. What it did and what it taught:

| concern         | how it did it                                                                                                                                                                                                                                                                                 | lesson for govee2mqtt                                                                                                                                                                                               |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| transport       | one `dgram` socket bound to `0.0.0.0:4002` with multicast membership `239.255.255.250`; `scan` multicast to `:4001` once at start-up; everything else unicast to `<ip>:4003`                                                                                                                  | correct socket layout (the reply port is fixed at 4002 by the devices, §2.1); one socket per adapter, not per device                                                                                                |
| addressing      | `--address <ip>:<name>` tuples, mandatory; the `scan` result was only logged, never used                                                                                                                                                                                                      | discovery drives the device list (G-2): devices appear by their `device` id from `scan`; names come from a map file; static addresses only as unicast scan targets                                                  |
| commands        | **every** command — on/off, brightness, scene — as `ptReal` (base64 20-byte BLE-style packets), never the documented `turn` / `brightness` / `colorwc` JSON commands                                                                                                                          | use the documented JSON commands where they exist (verified on the H606A, they update `devStatus`), `ptReal` only for what the LAN API lacks (scenes, music, segments, DIY)                                         |
| ptReal encoding | 20 bytes, byte 19 = XOR of bytes 0–18, several packets in one UDP message (`command: [base64, …]`), 35 ms pause after each send                                                                                                                                                               | same (§2.3); keep the pacing, add a per-device send queue                                                                                                                                                           |
| scenes          | `scenes.js`: 78 hard-coded entries `{category, name, id, commands[]}` captured from the app's BLE writes with Wireshark (iOS Bluetooth logging profile + `convert-hexdump.js`); `set/<name>/scene` by name or id, optional `{id, speed}` JSON — `speed` overwrote byte 6 of the select packet | **do not hard-code**: the packets are derivable from Govee's public scene library endpoint per SKU (§2.4, verified: 64/72 byte-identical, the rest differ in one 4-byte field); the capture method stays documented |
| music modes     | 6 entries (Rhythm, Pulsating, Energy, Windmill, Divide, Beat): `0xa3` stream with type byte `0x41` + `33 05 13`                                                                                                                                                                               | music mode definitions are not in the scene library response; kept as a per-SKU table in RESEARCH.md until a source is found (OQ-G6)                                                                                |
| status          | `devStatus` requested only on `get/<name>` or `set/<name>/query`; the reply was only `log.debug`ged, nothing published                                                                                                                                                                        | poll every device (the LAN API never pushes, §2.1), diff, publish `status/<dev>/*`; per-device `online` from reply recency                                                                                          |
| topics          | `govee/set/<name>/{state,brightness,scene,query}`, `govee/get/<name>`, `govee/scan`; payloads `ON`/`OFF`, `1..100`                                                                                                                                                                            | fleet conventions: `<name>/status/<dev>/<item>`, `<name>/set/<dev>/<item>`, booleans `true`/`false`, `set/<dev>/refresh` instead of `get/`, `set/bridge/scan`                                                       |
| WLED idea       | `wledmapping.js`: WLED palette id → Govee scene name; README heading "Sync with WLED" left empty                                                                                                                                                                                              | not an adapter concern; a she script on top of the topics                                                                                                                                                           |
| robustness      | no reconnect handling, `JSON.parse` of foreign datagrams crashed the handler, no tests, no HA discovery, no `connected` semantics beyond `1`                                                                                                                                                  | the core covers MQTT/LWT/discovery; the LAN module ignores non-JSON and non-Govee datagrams silently                                                                                                                |

Defects found in the captured table while cross-checking it against the scene library (§2.4):
`scenes.js` id 7718 was labelled `valentinesday` (it is `carnival`), and `crawl` (7518) carried the
packets of `cubic` (7519). Copy errors, not protocol facts. The `govee-sku-h606a.md` notes (1611
lines: every scene as Wireshark hexdump, four Leisure speed variants, six music modes, the `curl`
for the scene library) are condensed into §2.3–2.4 and RESEARCH.md; the raw dumps are not kept.

### 1.2 Other integrations (what they do, what to copy, what to avoid)

| project                                                                                                                                                                                                                                                                                                                                                                             | state (2026-08)                                                        | approach / notable design                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [wez/govee2mqtt](https://github.com/wez/govee2mqtt) (Rust, HA add-on + Docker)                                                                                                                                                                                                                                                                                                      | 1432 ★, pushed 2026-06-15 (last real commits 2026-04), 333 open issues | **the** reference: LAN-first, Platform API for scenes/DIY/segments/appliances, undocumented AWS-IoT channel (account login) for push status; HA discovery only (`gv2mqtt/light/<id>/…`, light JSON schema with `effect_list`, no generic topic convention); polls every 900 s plus a re-poll after each command; scenes via the public scene library + `ptReal` (§2.4); no BLE. Same name as this project — the README must say so (§7). Copy: the three-transport model, the LAN network options (`docs/LAN.md`: unicast scan list, broadcast fallbacks). Avoid: HA-only payloads, account login by default |
| [wez/govee-lan-hass](https://github.com/wez/govee-lan-hass)                                                                                                                                                                                                                                                                                                                         | superseded by the above                                                | LAN API only; first public implementation of `scan`/`devStatus`/`ptReal` in a bridge                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| HA core [`govee_light_local`](https://www.home-assistant.io/integrations/govee_light_local/)                                                                                                                                                                                                                                                                                        | official since 2024.1, on the `govee-local-api` Python lib             | LAN API only, multicast discovery, polling; on/off, brightness, RGB, colour temperature, the scene names the LAN API's `scene` capability list offers for some SKUs. Shows what Govee itself considers "supported": lights only                                                                                                                                                                                                                                                                                                                                                                              |
| [homebridge-govee](https://github.com/homebridge-plugins/homebridge-govee) (bwp91)                                                                                                                                                                                                                                                                                                  | 11.39.0 on 2026-08-28, 587 ★                                           | LAN (JSON commands only, polling) + AWS IoT (commands + push) + Platform API (since 11.20, 2026) + BLE; the source of the IoT reverse engineering wez credits; per-model quirk tables in `lib/utils/`. Copy: the "which transport for which command" matrix idea. BLE part out of scope here                                                                                                                                                                                                                                                                                                                 |
| [AlgoClaw/Govee](https://github.com/AlgoClaw/Govee) `decoded/v1.2`                                                                                                                                                                                                                                                                                                                  | 2025, bash + `model_specific_parameters.json`                          | The scene-packet recipe (§2.3) with per-model `hex_prefix_remove` / `hex_prefix_add` / `normal_command_suffix`; nine model groups, **H606A not listed** — our values (`22` → `58`, suffix `00 <speed>`) come from the 2024 capture and were verified against the library response                                                                                                                                                                                                                                                                                                                            |
| [justabaka/govee-lan-scene-command-generator](https://github.com/justabaka/govee-lan-scene-command-generator)                                                                                                                                                                                                                                                                       | Python port of the recipe                                              | same recipe, useful as a second implementation to diff against in tests                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| [egold555/Govee-Reverse-Engineering](https://github.com/egold555/Govee-Reverse-Engineering)                                                                                                                                                                                                                                                                                         | protocol wiki, issue #11 is the scene thread                           | BLE packet catalogue (`0x33` commands, `0xa3` multi-packets, checksum); everything applies 1:1 to `ptReal`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| [boergegrunicke/ioBroker.govee-local](https://github.com/boergegrunicke/ioBroker.govee-local)                                                                                                                                                                                                                                                                                       | 0.4.7, pushed 2026-08-27                                               | LAN API, poll timer (`deviceStatusRefreshInterval`) + periodic re-scan (`searchInterval`); the structure our LAN module mirrors                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| [krobipd/ioBroker.govee-smart](https://github.com/krobipd/ioBroker.govee-smart)                                                                                                                                                                                                                                                                                                     | 2.27.0, pushed 2026-08-27                                              | The most complete **Node.js** multi-channel reference: LAN incl. `ptReal` scenes/DIY (`0xa1`)/music/gradient/segments, Platform REST, the OpenAPI event feed (`govee-openapi-mqtt-client.ts`), AWS IoT with capped login retries. TypeScript, ioBroker-specific — read, do not depend on                                                                                                                                                                                                                                                                                                                     |
| [Galorhallen/govee-local-api](https://github.com/Galorhallen/govee-local-api) (behind HA core)                                                                                                                                                                                                                                                                                      | 3.0.0 (2026-08-05), 262 SKUs in `SUPPORTED_DEVICES.md`                 | LAN, polls every 5 s, `ptReal` for segments (`33 05 15 …`) and simple scenes; accepts a `devStatus` from any known IP; the SKU list answers OQ-G10 well enough (H606A is on it)                                                                                                                                                                                                                                                                                                                                                                                                                              |
| [weirdtangent/govee2mqtt](https://github.com/weirdtangent/govee2mqtt) (Python, Docker `graystorm/govee2mqtt`)                                                                                                                                                                                                                                                                       | 2026-08                                                                | Platform API polling only, HA discovery. A **second** project with our name — the README disambiguation (G-11) names both                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| npm: [`govee-lan-control`](https://github.com/Joery-M/Govee-LAN-Control) 3.0.2 (2023), `govee-lan-controller` 1.0.5 (2024), [`govee-api-client`](https://github.com/felixgeelhaar/govee-api-client) 3.3.10 (2026-07), [node-red-contrib-govee](https://github.com/Torsten85/node-red-contrib-govee), [matterbridge-govee-lan](https://www.npmjs.com/package/matterbridge-govee-lan) | small / dormant                                                        | LAN basics or a Platform API client; nothing to depend on (the fleet keeps zero deps beyond the core), useful as second opinions on packet bytes                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Govee [Platform API](https://developer.govee.com/reference/get-you-devices) (official)                                                                                                                                                                                                                                                                                              | v1, API key per account                                                | cloud REST + an MQTT event feed; capability model covers lights **and** appliances (§2.2). The only route to device names, DIY scenes, segment colours and non-light devices                                                                                                                                                                                                                                                                                                                                                                                                                                 |

**Conclusion.** LAN API first (G-1): it is local, unauthenticated, ~200 ms round-trip, and with
`ptReal` it reaches everything the app can do to a light. Its two gaps — no push and no scene
vocabulary — are closed by polling (cheap on a LAN) and by the public scene library (no key
needed). The Platform API is the second transport, opt-in with `--api-key`: device names, DIY
scenes, segments, non-LAN devices and appliances, plus its MQTT event feed for sensors. The
undocumented AWS-IoT channel is not planned (OQ-G8): it needs the account password, is the part
of wez's bridge with the most breakage reports, and only buys faster status for lights we poll
anyway.

---

## 2. Govee facts (research summary; live-verified items are marked ✔, sources in §9)

### 2.1 LAN API (UDP, official but thinly documented)

- Must be enabled per device in the Govee Home app (device settings → "LAN Control"). Only WiFi
  lights with the newer controller chips have the switch; appliances never do.
- **Ports**: client multicasts `scan` to `239.255.255.250:4001`; devices answer by unicast to the
  **source IP, port 4002** (not the source port — the client must bind 4002); status queries and
  commands go by unicast to `<device ip>:4003`, replies again to `:4002`. ✔ Unicast `scan` to
  `:4001` works too (the H606A answered from a VPN-routed subnet in 217 ms) — multicast is only
  needed to _find_ devices.
- **Messages** are JSON `{"msg": {"cmd": …, "data": …}}`:

  | cmd          | data (request)                                                                                            | reply                                                                                                                            |
  | ------------ | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
  | `scan`       | `{"account_topic": "reserve"}`                                                                            | `{"ip", "device": "1B:FA:…:71", "sku": "H606A", "bleVersionHard", "bleVersionSoft", "wifiVersionHard", "wifiVersionSoft"}` ✔     |
  | `devStatus`  | `{}`                                                                                                      | `{"onOff": 0\|1, "brightness": 1..100, "color": {"r","g","b"}, "colorTemInKelvin": 0\|K}` ✔ — **no scene/mode/segment fields** ✔ |
  | `turn`       | `{"value": 0\|1}`                                                                                         | none ✔ (status reflects it ≤ 1.3 s later)                                                                                        |
  | `brightness` | `{"value": 1..100}`                                                                                       | none ✔                                                                                                                           |
  | `colorwc`    | `{"color": {"r","g","b"}, "colorTemInKelvin": 0}` or `{"color": {0,0,0}, "colorTemInKelvin": 2000..9000}` | none ✔; a Kelvin set zeroes `color` in status and vice versa ✔                                                                   |
  | `ptReal`     | `{"command": ["<base64 20-byte packet>", …]}`                                                             | none ✔ — raw BLE-style packets, §2.3                                                                                             |

- **No push, ever** ✔: 0 unsolicited datagrams during a 20 s command sequence; state changes made
  in the app or by the device are invisible until the next `devStatus`. Polling is mandatory. (Two
  weak contrary hints exist — an H6061 owner in wez #250, HA's `local_push` label on
  `govee_light_local` whose library polls every 5 s — so the parser accepts a `devStatus` from any
  known IP at any time, as Galorhallen's does; it costs nothing.)
- Quirks seen by other implementations: newer devices may omit `ip` in the `scan` reply (use the
  datagram's source address); `onOff` arrives as `0`/`1` or `true`/`false`; after a command the
  status "does not reliably return the updated state for several seconds" on some SKUs (the
  H606A did within 1.3 s ✔); some firmware (H6061, wez #250) flickers about a minute after
  polling _stops_ — steady polling is the workaround, another reason for G-4.
- Only one process per host can own UDP 4002: homebridge-govee, HA's `govee_light_local`, wez's
  bridge and this adapter are mutually exclusive on a host.
- **No authentication, no encryption** — anyone who can reach UDP 4003 controls the light. The
  adapter must never expose a raw transmitter by default (`--raw-set` off, core rule).
- Multicast is fragile across WLAN/VLAN boundaries (wez `docs/LAN.md`, dozens of issues):
  provide unicast scan targets (`--address`, repeatable) and subnet broadcast as alternatives.
- The official product list is in a JS-rendered page (`app-h5.govee.com/user-manual/wlan-guide`,
  not fetchable headless); the H606A has the switch and answers, which is the test that counts.

### 2.2 Platform API (official cloud REST, v1) — _from docs and wez's client, not yet exercised_

- Base `https://openapi.api.govee.com/router/api/v1/`, header `Govee-API-Key: <key>`; the key is
  requested in the app (profile → settings → "Apply for API key", arrives by e-mail). Since
  2026-05-15 generating a new key **revokes all previous keys** of the account — one key per
  account, share it between instances, never rotate casually. Terms: non-commercial use only.
  (`developer-api.govee.com` with its 10 000/day quota is the _old_ v1 API used by
  `python-govee-api`; dead end.)
- **Rate limits** (current docs): `user/devices` 30/min per account; `device/control` 12/s and
  720/min per account, 2/s and 120/min per device (bursts 80 / 6); `device/state` and
  `device/scenes` 30/min per device; `429` when exceeded. Per-device state polling over the cloud
  therefore stays at ≥ 60 s (`--cloud-poll-interval`) and control goes through a per-device queue.
- Endpoints: `GET user/devices` (sku, device id, `deviceName`, `type`, `capabilities[]`),
  `POST device/control` (`{requestId, payload: {sku, device, capability: {type, instance, value}}}`),
  `POST device/state`, `POST device/scenes` (the SKU's scene list as `dynamic_scene`/`lightScene`
  enum options `{name, value: {id, paramId}}` — `id`/`paramId` are the library's
  `sceneId`/`scenceParamId`, so a cloud scene maps to its LAN packets by `paramId`),
  `POST device/diy-scenes` (the account's DIY scenes, `{name, value: <id>}`).
- Capability kinds: `on_off`, `toggle`, `range` (brightness, humidity, …), `mode`, `color_setting`
  (`colorRgb` as 24-bit int, `colorTemperatureK`), `segment_color_setting`, `music_setting`,
  `dynamic_scene` (`lightScene`, `diyScene`, `snapshot`), `work_mode`, `dynamic_setting`,
  `temperature_setting`, `online`, `property` (sensor values), `event` (alarms). Values are typed
  ENUM / INTEGER / STRUCT with ranges. Device types: `light`, `air_purifier`, `thermometer`,
  `socket`, `sensor`, `heater`, `humidifier`, `dehumidifier`, `ice_maker`, `aroma_diffuser`, `box`
  (kettles/fans appear under heater-like types).
- **Events** (confirmed in the docs, "Subscribe device event"): MQTT over TLS at
  `mqtts://mqtt.openapi.govee.com:8883`, username = password = API key, topic `GA/<api key>`;
  payload `{sku, device, deviceName, capabilities: [{type: "devices.capabilities.event",
instance, state: [{name, value, message?}]}]}`. It is an **event** channel for devices that
  expose `devices.capabilities.event` (ice maker `lackWaterEvent`, presence sensor
  `bodyAppearedEvent`, dehumidifier alarms) — not a state push for lights.
- wez found the scene list from `device/scenes` incomplete for some SKUs and synthesises it from
  the public scene library (§2.4) instead — do the same, the library needs no key.

### 2.3 `ptReal` — the raw packet format (BLE ATT values sent over the LAN)

- Every packet is 20 bytes; byte 19 = XOR of bytes 0–18; payload zero-padded. Several packets go
  in one `ptReal` message as an array, in order. ✔ (brightness `33 04 64` reflected in status)
- **Single commands** (`0x33`): `33 01 01` on, `33 01 00` off, `33 04 <1..100>` brightness
  (scale is per SKU: the H6199 doc says 0–255), `33 05 04 <code lo> <code hi> <flag> <speed>`
  select scene, `33 05 13` select music mode (after its definition), colour variants per model
  family — `33 05 02 r g b` (old strips), `33 05 0b r g b <left> <right>` (H6199 zones),
  `33 05 01 <submode>` (H6199 music); not needed while `colorwc` exists.
- **Segments** over the LAN (Galorhallen's library, wez #105 for H6046/H61E0): colour
  `33 05 15 01 r g b 00 00 00 00 00 <segment bitmask…>`, brightness `33 05 15 02 <pct> <bitmask…>`.
  Whether the H606A's panels answer to it is untested (1.x, OQ-G9).
- **Multi-packet definitions** (`0xa3`, `0xa1` for DIY effects followed by `33 05 0a`, `0xa4` on
  the H70C4): a byte stream split into 17-byte chunks, each prefixed `a3 <index>` with the last
  chunk indexed `ff`. The stream is `01 <chunk count> <type>` followed by the effect definition.
  For scenes the definition is the library's `scenceParam` (§2.4). `0xaa` frames are queries /
  notifications (keep-alives, humidifier state) — decode-only.
- **H606A scene recipe** (derived from the 2024 capture, 64/72 scenes byte-identical to the
  library response, the AlgoClaw recipe with `hex_prefix_remove = 22`, `hex_prefix_add = 58`):

  ```
  stream   = 01 <n> 58 + scenceParam[1:]          (scenceParam[0] is 0x22 for every H606A scene)
  packets  = a3 00 <17 B> … a3 ff <17 B, zero padded>   n = ceil(len(stream) / 17)
  select   = 33 05 04 <sceneCode LE u16> <flag> <speed>  speed default = scenceParam[1]
  ```

  The seven scenes that differ (Rainbow, Evolution, Kaleidoscope, Circuit, Ripple, Arcane Light,
  Speeding) all contain `05 b7 06 fc 05` in the library where the app sent `05 41 06 41 06` — two
  little-endian u16 the app substitutes at send time (OQ-G4). `<flag>` is 0 for 68 scenes, 1 for
  Rainbow/Aurora/Rustling Leaves, `0x0e` for Matrix, with no obvious source field (OQ-G5). Per
  AlgoClaw the select packet only updates the app's notion of the current scene — the `0xa3`
  stream alone changes the light. ✔ Sent both encodings (ours and wez's generic `01 <n> 02` +
  full param) without error, but the LAN status cannot show a scene, so **visual confirmation is
  still open** (§6 milestone 0.1 gate; `scripts/lan-probe.mjs scene <name>`).

- Music modes on the H606A: `01 <n> 41` + a 30-byte definition whose first byte is the mode id
  (`75` Rhythm, `76` Pulsating, `77` Energy, `78` Windmill, `7a` Divide, `7b` Beat), followed by
  `33 05 13`. Definitions are in RESEARCH.md; no public source yet (OQ-G6).
- Generic values for other SKUs: AlgoClaw's `model_specific_parameters.json` (nine groups, e.g.
  `02` prefix with nothing removed for H6072/H61A8/H7039/H805A; `04` with `1200000000` removed
  for H6065/H6066). Ship this table as data (`lib/sku.js`) and fall back to the generic `02` form.

### 2.4 The public scene library (no key, no login) ✔

`GET https://app2.govee.com/appsku/v1/light-effect-libraries?sku=<SKU>` with an `AppVersion`
header (`5.6.01` and `6.5.02` both work) returns `data.categories[].scenes[]` with `sceneId`,
`sceneName`, icon URLs, `lightEffects[]` `{scenceParamId, scenceParam (base64), sceneCode,
sceneType, specialEffect[], speedInfo{supSpeed, config}, rules[]}`. H606A: 6 categories (3D,
Funny, Natural, Life, Festival, Emotion), 72 scenes, one light effect each, `sceneType 4`,
`supSpeed false` everywhere, no `specialEffect`. Names are English. wez caches it one day
(soft) / one week (hard); it must be cached on disk in `STATE_DIRECTORY` and work from cache
when Govee is unreachable (G-6).

### 2.5 Undocumented app / AWS-IoT channel — _not planned_ (OQ-G8)

For the record (from wez's `undoc_api.rs` / `iot.rs` and homebridge-govee's `http.js`/`aws.js`):
login `POST app2.govee.com/account/rest/account/v1/login` (homebridge: `v2/login` +
`v1/verification` for 2FA, status 454) with e-mail, password, a stable `clientId`, `appVersion`
and a GoveeHome user agent; device list `device/rest/devices/v1/list` (each device's IoT
`topic`, opaque); certificate `app/v1/account/iot/key` (`endpoint`, `p12`, `p12_pass`); then
MQTT over TLS to the account's AWS IoT endpoint (`…-ats.iot.us-east-1.amazonaws.com:8883`,
taken from the response, client id `AP/<accountId>/<uuid>`). Commands are the LAN JSON
(`turn`, `brightness`, `colorwc`, `ptReal`, plus `status`) wrapped with
`cmdVersion`/`transaction`/`accountTopic`; state arrives as pushes on the account topic.
`bff-app/v1/exec-plat/home` lists Tap-to-Run shortcuts with ready-made `ptReal` payloads. Risks
on record: 2026-03-25 Govee began rejecting logins with an old `appVersion` (wez #626/#628,
homebridge #1247), some accounts get 454 "service not enabled", repeated failed logins lock the
account (ioBroker.govee-smart caps retries). It is the app's private API: no terms, no stability.

### 2.6 Not doing: Bluetooth LE

Same packets as `ptReal`, needs a native BLE stack (`@abandonware/noble`), one central at a
time, ~10 m. Out of scope by decision (see the intro); BLE-only devices are not supported.

---

## 3. What users struggle with elsewhere (→ requirements)

From wez/govee2mqtt's issue tracker, the HA community threads and the openHAB/ioBroker forums:

1. **Discovery does not work** (multicast across VLANs, WiFi routers dropping multicast, Docker
   bridge networks): every LAN bridge ends up adding a unicast scan list and broadcast options →
   `--address` (repeatable), `--broadcast`, `--scan-interval`, and a `status/bridge/*` view of
   what was found and when (G-2, G-7).
2. **Port 4002 must be free** on the host, and the device must be able to route a reply to it —
   the README needs the three-port diagram and the Docker `--network host` note.
3. **Scenes need the cloud** in most bridges → here they come from the keyless scene library,
   cached on disk, so scenes work offline after the first fetch (G-6).
4. **Status lags** (polling every 30–60 s in cloud-bound bridges) → LAN polling every few seconds
   is fine (a `devStatus` round trip is ~1 ms of device time), plus a verify-poll right after every
   command (G-4).
5. **Account logins break** (app API changes, 2FA, lockouts after failed logins, the 2026-03
   `appVersion` enforcement) → no account login (OQ-G8); the Platform API key is the only
   credential, and it is optional. And since a new key revokes the old ones, the README must say
   "one key per account, reuse it".
6. **HA "effect" lists get huge** and mix scenes, DIY and music → `scene` (library), `diy_scene`
   (account, needs key) and `music` are separate items; HA gets one `effect_list` with prefixes
   only if it turns out to be wanted (OQ-G7).
7. **Port 4002 is taken** by another Govee integration on the same host (homebridge-govee, HA,
   wez) → a clear error naming the usual suspects at start-up, `--no-lan` for a cloud-only
   instance next to them.

---

## 4. Implementation spec

### 4.1 Architecture

```
index.js            createAdapter() + wiring: LanClient/Cloud events → pubStatus, set → actions
config.js           parseConfig(): OPTIONS of §4.8
lib/install.js      createInstaller(); no serviceExtra (UDP needs no privileges)
lib/lan.js          LanClient: one UDP socket on 4002 (+ multicast membership), scan (multicast /
                    broadcast / unicast list), devStatus, JSON commands, ptReal send with pacing,
                    per-device send queue, datagram parsing that ignores foreign traffic
lib/packet.js       pure: 20-byte packet builder + XOR checksum, 0xa3 multi-packet splitter,
                    scene/music/select encoders, base64 helpers — unit-tested against the 2024
                    capture (fixtures)
lib/sku.js          per-SKU data: scene prefix rules (AlgoClaw table + H606A), music mode
                    definitions, colour temperature range, segment count (grows as data, not code)
lib/scenes.js       SceneLibrary: fetch + disk cache (STATE_DIRECTORY/scenes-<sku>.json) of the
                    public library, name ↔ code lookup, normalised names (lower snake_case)
lib/cloud.js        (0.2) Platform API client: devices, state, control, scenes, diy-scenes;
                    request accounting; (0.3) the MQTT event feed
lib/device.js       Device: the one normalised state per device (from LAN polls, cloud state,
                    last commanded scene), diffing, online tracking, verify-after-set
lib/items.js        pure: item table (item → {parse, encode, ha}) and set-topic → action mapping
lib/hadiscovery.js  pure: devices → HA device blocks (bridge + one per device)
scripts/lan-probe.mjs  scan / status / command / scene against one address, no MQTT (already in
                    the repo; grew out of the 2026-08-28 live tests)
test/*.test.js      node:test: packet encoders against capture fixtures, scene library parsing
                    against a recorded H606A response, items, discovery, config schema, installer
```

No runtime dependency besides `mqtt-interfaces-core` (`node:dgram`, `fetch`).

### 4.2 Topics

Default `--name govee`. `<dev>` is the device's topic name (§4.4).

| topic                          | retained | payload / notes                                                                                             |
| ------------------------------ | -------- | ----------------------------------------------------------------------------------------------------------- |
| `<name>/connected`             | yes      | `0` LWT · `1` broker only · `2` LAN socket bound (and, with a key, the cloud reachable) — bridge-level, G-3 |
| `<name>/status/<dev>/<item>`   | yes      | `{val, ts, lc}`; items in §4.3                                                                              |
| `<name>/status/<dev>/online`   | yes      | bool: answered a poll within `3 × poll interval`; HA availability of the device                             |
| `<name>/status/bridge/devices` | yes      | `[{dev, sku, device, ip, transport: ["lan"\|"cloud"], online}]`                                             |
| `<name>/status/bridge/scan`    | yes      | `{last, found, method}` — last scan time, count, `multicast\|broadcast\|unicast`                            |
| `<name>/status/bridge/cloud`   | yes      | (0.2) `{configured, ok, requests_today, last_error}`                                                        |
| `<name>/set/<dev>/<item>`      | —        | commands, §4.5                                                                                              |
| `<name>/set/<dev>/refresh`     | —        | poll this device now                                                                                        |
| `<name>/set/bridge/scan`       | —        | run discovery now                                                                                           |
| `<name>/set/<dev>/raw`         | —        | `ptReal` passthrough (hex or base64 packets, one or many); **`--raw-set` only**                             |
| `<name>/info`, `maintenance/*` | yes      | core; `info` extras: `lan: {port, multicast, addresses}`, `cloud: bool`                                     |

### 4.3 Items (per device)

| item                                                                                           | type / values                                | source                                                                                            | HA                                   |
| ---------------------------------------------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------ |
| `power`                                                                                        | bool                                         | LAN `onOff`                                                                                       | `light` (with the next five)         |
| `brightness`                                                                                   | int 1–100                                    | LAN `brightness`                                                                                  | `light` `bri_scl: 100`               |
| `color`                                                                                        | `{"r", "g", "b"}` (0–255)                    | LAN `color`; `{0,0,0}` while in colour-temperature                                                | `light` rgb                          |
| `color_temp`                                                                                   | int K, `0` = not in ct mode                  | LAN `colorTemInKelvin`                                                                            | `light` `clr_temp_kelvin: true`      |
| `color_mode`                                                                                   | `rgb` · `ct` · `scene` · `music` · `unknown` | derived: ct > 0 → `ct`; color set → `rgb`; last cmd → `scene`/`music` until a poll shows a change | `light` effect state                 |
| `scene`                                                                                        | string (library name, snake_case) or `''`    | **last commanded** (the LAN cannot read it); cleared when a poll shows colour/ct changed          | `light` `fx_list`                    |
| `music`                                                                                        | string (mode name) or `''`                   | last commanded                                                                                    | `select`                             |
| `diy_scene`                                                                                    | (0.2) string, from `device/diy-scenes`       | last commanded / cloud state                                                                      | `select`                             |
| `segments`                                                                                     | (1.x) `[{"r","g","b"}, …]`                   | cloud `segment_color_setting` / raw `0xa3`                                                        | one `light` per segment, opt-in      |
| `sku`, `device`, `ip`, `firmware`                                                              | strings (`firmware` = `{wifi, ble}`)         | `scan` reply                                                                                      | diagnostic sensors                   |
| `online`                                                                                       | bool                                         | poll recency                                                                                      | availability                         |
| cloud devices (0.2): `humidity`, `temperature`, `mode`, `work_mode`, … per capability instance |                                              | Platform API `device/state` + events                                                              | sensor/select/number/switch per kind |

Rules: numbers as numbers, booleans as booleans, `color` as an object (a `#rrggbb` string is
accepted on `set`, never published). `scene` names are the library's `sceneName` lower-cased with
non-alphanumerics → `_` (`sunset_glow`, `mother_s_day` → `mothers_day`: apostrophes dropped
first). Renaming an item is a major release.

### 4.4 Device topic names

Default `<sku lower>_<last two id bytes>` (`h606a_bf71`) — stable, derivable without the cloud.
`--map-file` (JSON, `{"1B:FA:FB:75:D9:29:BF:71": "hexa"}`, shipped `example-map.json` +
`map.schema.json`) overrides; with `--api-key` the app's `deviceName` is offered as a default
_only_ when no map entry exists and `--names app` is set (OQ-G3, the homeconnect2mqtt rename
problem). Names are validated (`[a-z0-9_]`, no `/`).

### 4.5 Commands (`<name>/set/<dev>/…`)

| item         | payload                                           | action                                                                                 |
| ------------ | ------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `power`      | bool-ish (`true`, `on`, `1`, `ON`)                | LAN `turn`                                                                             |
| `brightness` | 1–100 (0 → `power false`)                         | LAN `brightness`                                                                       |
| `color`      | `{"r","g","b"}`, `"#rrggbb"`, `"r,g,b"`           | LAN `colorwc` with `colorTemInKelvin: 0`                                               |
| `color_temp` | K (clamped to the SKU's range, default 2000–9000) | LAN `colorwc` with black colour                                                        |
| `scene`      | name, code, or `{"name"\|"code", "speed": 0–100}` | library lookup → `packet.scene()` → `ptReal`; sets `scene`/`color_mode` optimistically |
| `music`      | mode name or id                                   | `lib/sku.js` definition → `ptReal`                                                     |
| `diy_scene`  | (0.2) name or id                                  | cloud `device/control` `diyScene`; LAN once the DIY payload format is known (OQ-G9)    |
| `refresh`    | any                                               | `devStatus` now                                                                        |
| `raw`        | hex/base64 packet(s), `--raw-set`                 | `ptReal` verbatim, checksum added if the 20th byte is missing                          |

Every `set` is followed by a verify poll after 1 s (G-4); a mismatch logs `warn` ("set had no
effect") and publishes what the device reports. Unknown items and unparsable payloads reject
with a readable reason (core logs `warn`). Commands to a device that is `online: false` are
still sent (UDP is cheap) but logged at `debug`.

### 4.6 Polling, discovery, `connected`

- `LanClient` binds `0.0.0.0:4002` (`--lan-port` only for tests) and joins the multicast group on
  every interface (`--lan-interface` to pin). Discovery = multicast `scan` + (if `--broadcast`)
  `255.255.255.255`/per-interface broadcast + unicast `scan` to each `--address`; at start, every
  `--scan-interval` (default 60 s), and on `set/bridge/scan`. A device is identified by its
  `device` id; a changed IP is just an update.
- Poll every known device's `devStatus` every `--poll-interval` (default 5 s), staggered; a reply
  refreshes `online` and `lc` of changed items only (diffing in `Device`). Missing 3 polls →
  `online false` (one `warn`, recovery at `info` with downtime); keep polling forever.
- `<name>/connected` = 2 as soon as the socket is bound; device health is per device (`online`),
  not the bridge's — a LAN bridge with zero devices is "connected" (G-3).
- Send pacing: one datagram per device per 35 ms (the app's cadence), `ptReal` arrays as one
  datagram; commands never wait for polls.

### 4.7 Home Assistant discovery (`lib/hadiscovery.js`)

Bridge device `govee2mqtt_<name>` with the `bridge/*` diagnostics; one HA device per Govee
device (`via_device` the bridge, `mf: Govee`, `mdl: <sku>`, `sw: wifi fw`, `ids: device id`),
availability = `<name>/connected ≥ 2` **and** `status/<dev>/online` (`avty_mode: all`).
Components per light: one `light` entity (default schema — `stat_t` power with a value template,
`bri_stat_t/bri_cmd_t` with `bri_scl: 100`, `rgb_stat_t/rgb_cmd_t` with templates converting
`{r,g,b}` ↔ `r,g,b`, `clr_temp_*` with `clr_temp_kelvin: true` and the SKU's min/max,
`fx_stat_t/fx_cmd_t` + `fx_list` from the scene library), `select` for `music`, `button` for
`refresh`, diagnostic `sensor`s for `ip`/`firmware`, `binary_sensor` (`connectivity`) for
`online`. Re-published (debounced via `markDiscoveryDirty()`) when a device appears/disappears or
its scene list changes. Payloads validated per platform before publishing (the H-19 lesson);
`fx_list` capped and sorted; entity labels short ("Light", "Music mode").

### 4.8 CLI / env (`GOVEE2MQTT_*`)

Shared options from the core plus: `--address/-a` (repeatable, unicast scan targets), `--broadcast`
(off), `--lan-interface`, `--scan-interval` (60), `--poll-interval` (5), `--no-lan` (cloud only),
`--api-key` (`secret`), `--cloud-poll-interval` (60, cloud-only devices), `--names id|map|app`,
`--map-file` (`file`, json + schema), `--scene-cache` (path, default `STATE_DIRECTORY`),
`--scene-refresh` (days, 7; 0 = never refetch), `--raw-set` (off), `--devices` (filter by id/name,
default all), `--probe <ip>` (action: scan + status, print, exit — the she-friendly form of
`scripts/lan-probe.mjs`). `mqttInterfaces: {spec: "2.0", envPrefix: "GOVEE2MQTT", needs:
["network", "cloud"]}` (cloud optional).

### 4.9 Logging

`lan >` / `lan <` for every datagram at `debug` (JSON compact, `ptReal` as hex), `cloud >`/`cloud <`
likewise; a device going offline/online at `warn`/`info` (transition only); every rejected `set`
at `warn` with topic, payload, reason; scene library fetch/cache use at `info`; foreign datagrams
never logged above `debug`.

### 4.10 Tests

`node --test`: `packet.js` reproduces the 2024 capture for all 64 matching scenes from the recorded
library response (fixture `test/fixtures/light-effect-libraries-h606a.json`, 77 kB) and the six
music modes; checksum/padding edge cases (17-byte multiples, 1 chunk, 8 chunks); `scenes.js`
name normalisation + cache TTL; `items.js` parsing (`#rrggbb`, `r,g,b`, clamps, bool-ish);
`hadiscovery.js` per platform; `config.js` schema; installer via `deps`. `LanClient` against an
in-process fake device (`scripts/mock-govee.mjs`: answers scan/devStatus, records commands) — the
same mock drives an `e2e.sh` with a throwaway mosquitto.

---

## 5. Decisions

| ID   | Decision                                                                                                                                                                                                                                                                                                                                          |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G-1  | **LAN API first, no BLE.** 0.1 is LAN-only and complete for lights; the Platform API is the second transport (0.2, opt-in `--api-key`); the app's AWS-IoT channel is not planned (OQ-G8). Items are transport-neutral.                                                                                                                            |
| G-2  | **Bridge with discovery-driven inventory**: devices are keyed by the LAN `device` id (also the Platform API id), found by multicast/broadcast/unicast scan, named by §4.4. No mandatory address list; `--address` only helps discovery.                                                                                                           |
| G-3  | **`connected` is bridge-level** (2 = socket bound [+ cloud ok]); per-device health is `status/<dev>/online` and feeds HA availability with `avty_mode: all`.                                                                                                                                                                                      |
| G-4  | **Poll + verify.** `devStatus` every 5 s per device (staggered), diffed; every `set` schedules a verify poll after 1 s. No optimistic publishing except `scene`/`music`/`color_mode`, which the LAN cannot report (G-5).                                                                                                                          |
| G-5  | **`scene` is "last commanded"**, never claimed to be read from the device; it is cleared when a poll shows colour/ct/power changed by someone else. Documented as such in the README.                                                                                                                                                             |
| G-6  | **Scenes from the public library, cached on disk**, fetched per SKU on first sight, refreshed every `--scene-refresh` days, served from cache when Govee is down; the packet recipe of §2.3 with per-SKU prefix rules in `lib/sku.js` (data, not code). Nothing scene-related is hard-coded except music modes until OQ-G6 is solved.             |
| G-7  | **Discovery robustness options** like wez's: repeatable `--address`, `--broadcast`, `--lan-interface`, `--scan-interval`; `status/bridge/scan` says what worked. README gets the port/route diagram.                                                                                                                                              |
| G-8  | **Documented JSON commands before `ptReal`**: `turn`/`brightness`/`colorwc` for what they cover (they are what `devStatus` mirrors); `ptReal` for scenes, music, segments, DIY, raw.                                                                                                                                                              |
| G-9  | **Raw passthrough is opt-in** (`--raw-set`) and the LAN API's lack of authentication is stated in the README's security note; the adapter never listens for commands from the LAN.                                                                                                                                                                |
| G-10 | **Fleet conventions are a hard requirement** (core README §1–12): ESM, no TypeScript, node ≥ 20.19, `node --test`, eslint+prettier from the core, CI/release workflows, `--config-schema` with `x-secret` on `--api-key` and `x-file` on the map file, systemd template unit, Dockerfile (`--network host` documented for multicast + port 4002). |
| G-11 | **Name clashes are accepted** (the npm name was free; wez's govee2mqtt is a Rust binary/HA add-on, weirdtangent's a Python Docker image): the README's first paragraph links to both and states the differences (mqtt-smarthome topics, Node.js, no account login, no BLE).                                                                       |
| G-12 | **Cloud is additive, never required**: with `--api-key` the bridge adds device names (`--names app`), DIY scenes, segments, non-LAN devices and appliances polled at `--cloud-poll-interval`, plus the event feed; a LAN device keeps using the LAN for everything the LAN can do.                                                                |
| G-13 | **One process, one LAN**: no attempt to bridge several subnets from one instance beyond unicast `--address` targets; a second subnet is a second instance (`--name`).                                                                                                                                                                             |

---

## 6. Milestones / build order

1. **0.1.0 — LAN bridge for lights** (replaces `mqtt-govee-hexa-ultra`) — _code done
   2026-08-28_: all modules below exist with tests (`npm test`: 42, `npm run lint` clean); the
   MQTT round trip (power, brightness, colour, ct, scene, music, refresh, scan, rejects) ran
   against the H606A from this Mac via a throwaway broker; `lib/packet.js` reproduces the app's
   packets for 64/72 scenes and all 6 music modes. Open before publishing: gate (b) visual, (e) she.
   Plan was: `lib/packet.js` +
   `lib/sku.js` + `lib/scenes.js` with tests against the capture fixtures first (pure, no device);
   then `lib/lan.js`, `lib/device.js`, `lib/items.js`, `index.js`, `config.js`, installer,
   `scripts/mock-govee.mjs`. Topics of §4.2/4.3, commands of §4.5, discovery of §4.6, HA discovery
   of §4.7. **Gate**: on the H606A at 172.16.23.120 — (a) power/brightness/colour/ct round-trip via
   MQTT with verify polls ✔ (protocol part verified 2026-08-28), (b) **scene activation confirmed
   visually** for a matching scene (Matrix) and a patched one (Rainbow, unpatched library bytes;
   if it fails, apply the `41 06 41 06` substitution and retest — OQ-G4), (c) music mode Rhythm,
   (d) discovery from mqtt-ifaces (multicast ✔ 2026-08-28, protocol part) and from this Mac
   (unicast only) through the adapter's own `LanClient`,
   (e) she shows the instance, `--config-schema` renders, secrets masked. Publish 0.1.0 to npm
   (replaces the placeholder).
2. **0.2.0 — Platform API**: `lib/cloud.js` (devices, state, control, scenes, diy-scenes) with
   request accounting on `status/bridge/cloud`, `--names app`, `diy_scene`, cloud-only devices
   (state polling), the capability → item mapping for lights first. Needs an API key (§7).
3. **0.3.0 — cloud events + appliances**: the MQTT event feed (sensors, alarms), appliance
   capability kinds (`work_mode`, `temperature_setting`, `range` instances) as items + HA
   entities; `--devices` filter. Only what can be tested (borrow devices or accept community PRs
   with fixtures).
4. **1.0.0** after two weeks of production use on the H606A; README complete (ports diagram,
   security note, wez comparison, topics table, HA section), CHANGELOG, Docker image.
5. **1.x**: segments (`segment_color_setting` via cloud, raw `0xa3` segment packets where known),
   snapshot scenes, `--ha-entities curated|full`, HA `effect_list` merging (OQ-G7), a
   `scripts/capture-diff.mjs` that diffs a BLE/Wireshark capture against the library recipe for
   new SKUs (the 2024 method, documented in RESEARCH.md).
6. ~~Core discovery (B-2)~~ — done in 0.2.0: `--discover` and `-a auto` on core 0.10.0
   (`lib/discovery.js`), verified against the H606A at 172.16.23.120. It answers OQ-G12 in the
   smaller of the two possible ways: the core scans to _find_ devices before an instance exists,
   `lib/lan.js` keeps the scan the running bridge uses, and the two share only the protocol
   constants. Moving the runtime scan into the core as well would mean teaching it about
   membership, per-device pacing and the reply socket the bridge holds for commands anyway —
   no gain.
7. **Later / maybe**: DIY scenes over the LAN (OQ-G9); AWS-IoT push (OQ-G8) only if polling
   proves insufficient for someone's use case.

---

## 7. Housekeeping

- **Published**: placeholder `0.0.1` reserved the npm name (2026-08-26). Keep `version` < 1.0
  until milestone 4.
- `prior-art/mqtt-govee-hexa-ultra` was analysed into §1.1 and RESEARCH.md and deleted on
  2026-08-28 (its music-mode packets and the capture method are preserved in RESEARCH.md).
- `README.md`/`package.json` no longer mention Bluetooth (scope decision); add the wez
  disambiguation paragraph with milestone 1.
- Request a Platform API key in the Govee app before milestone 2 (Profile → Settings → Apply for
  Govee API key; delivered by e-mail, minutes). Record the daily quota behaviour in §2.2.
- `scripts/lan-probe.mjs` stays as a debug tool (documented in the README); a `--probe` option
  can replace it later.
- The original `mqtt-govee-hexa-ultra` is still installed on `root@mqtt-interfaces` under
  `/usr/local/lib/node_modules/` (read-only reference; its `scenes.js` became
  `test/fixtures/capture-h606a.json`).
- The Mac used for development reaches the H606A only by unicast through the VPN (`utun3`);
  `root@mqtt-ifaces` (172.16.23.226/24, Node 24, UDP 4002 free) is the test host on the light's
  subnet — multicast, subnet broadcast, global broadcast and unicast `scan` all find the H606A
  from there (✔ 2026-08-28, multicast reply in 137 ms); it is the only Govee device on that LAN.
  `scripts/lan-probe.mjs` is copied to `/root/` there.

---

## 8. Open questions

- **OQ-G1** LAN status while a scene runs: `devStatus` keeps reporting the last colour/ct set
  by `colorwc` (✔ observed). Does it change at all while a scene animates (e.g. `brightness`
  following the scene), and does the app's own scene activation alter it? Determines how G-5's
  "cleared when something else changed" heuristic behaves. Test with the app while polling.
- **OQ-G2** Brightness `0` on the LAN: does `brightness 0` turn the light off, error, or clamp?
  (Spec says 1–100; 0 → `power false` locally until tested.)
- **OQ-G3** Names: id-derived default (`h606a_bf71`) vs app name via the cloud key. Proposal
  §4.4 — id default + map file, app names only on `--names app`, frozen in
  `STATE_DIRECTORY/names.json` once seen.
- **OQ-G4** The 4-byte field the app patches in 7 of 72 H606A scenes (`41 06 41 06` sent vs
  `b7 06 fc 05` in the library): what is it (panel count/layout? a version pair?), and does the
  device accept the unpatched bytes? First live test of milestone 1. If patching is needed, find
  the source of the values (the `scan` reply's versions? `rules`? the device's panel topology
  from the app's device settings?).
- **OQ-G5** The `<flag>` byte of `33 05 04` (0 / 1 / 0x0e): harmless to send 0 for all if the
  select packet is only cosmetic for the app (AlgoClaw) — verify that Rainbow (flag 1) and Matrix
  (flag 0x0e) still activate with flag 0.
- **OQ-G6** Music mode definitions: not in the scene library; the Platform API's
  `music_setting` capability lists mode ids per SKU (cloud control only). Is there a keyless
  endpoint for the `0x41` definitions (the app fetches them from somewhere), or do we keep the
  six captured H606A definitions + cloud control for other SKUs?
- **OQ-G7** HA: one `light` with `fx_list` = scenes only, or scenes + `music:<x>` + `diy:<x>`
  merged into one effect list (what wez does)? Start separate (§4.3), revisit on feedback.
- **OQ-G8** AWS-IoT push: skip for good, or offer as `--account-email/--account-password` later?
  Polling at 5 s covers lights; the IoT channel would mainly help appliances/sensors, which the
  official event feed (§2.2) may cover. Decide after 0.3.
- **OQ-G9** DIY scenes and segments over the LAN: the DIY shape is known in outline (`0xa1`
  multi-packet + `33 05 0a`, ioBroker.govee-smart `buildDiyPackets`, H6199 doc) but the DIY
  definition bytes come from the account (`diyEffectStr`?), and the segment packets
  (`33 05 15 01/02 …`, §2.3) are proven on strips, not on hexagon panels. Cloud control first
  (0.2), LAN once a capture from the H606A confirms either.
- **OQ-G10** Official LAN product list: the wlan-guide page is a JS app; HA's
  `govee_light_local` page (~190 SKUs) and Galorhallen's `SUPPORTED_DEVICES.md` (262) are the
  usable mirrors and both list the H606A. Ship no list — "answers `scan`" is the definition.
- **OQ-G11** Colour temperature range per SKU: LAN accepts any K; the H606A's real range
  (2000–9000?) should come from the Platform API's `colorTemperatureK` range when a key is
  present, else a per-SKU default in `lib/sku.js`.
- ~~**OQ-G12**~~ Core: the scan mechanics and the core's device-discovery module (B-2).
  Answered in 0.2.0 (§6.6): the core does the _finding_ — `--discover`, `-a auto`, and the
  `x-discover` marker she needs — and `lib/lan.js` keeps the runtime scan, because that one runs
  on the socket the bridge already holds on 4002 for commands and status. Cost on the core side:
  `bindPort`, since Govee answers to a fixed port and ignores the source port, and
  `autoAddresses`, since a bridge fills a list and not one address.

---

## 9. Sources

Official: [LAN API guide](https://app-h5.govee.com/user-manual/wlan-guide) (JS-rendered),
[Platform API reference](https://developer.govee.com/reference/get-you-devices),
[apply for an API key](https://developer.govee.com/reference/apply-you-govee-api-key),
scene library endpoint `https://app2.govee.com/appsku/v1/light-effect-libraries?sku=<SKU>`
(public, ✔ 2026-08-28).

Reverse engineering: [wez/govee2mqtt](https://github.com/wez/govee2mqtt) — `src/lan_api.rs`,
`src/ble.rs` (`SetSceneCode::encode`), `src/undoc_api.rs`, `src/service/iot.rs`, `docs/LAN.md`,
`docs/SKUS.md`; [AlgoClaw/Govee decoded v1.2](https://github.com/AlgoClaw/Govee/blob/main/decoded/v1.2/explanation_v1.2.md)

- [`model_specific_parameters.json`](https://github.com/AlgoClaw/Govee/blob/main/decoded/v1.2/model_specific_parameters.json);
  [egold555/Govee-Reverse-Engineering issue #11](https://github.com/egold555/Govee-Reverse-Engineering/issues/11)
  (scene thread, comment 2565692233); [justabaka/govee-lan-scene-command-generator](https://github.com/justabaka/govee-lan-scene-command-generator);
  [community LAN protocol gist](https://gist.github.com/mtwilliams5/08ae4782063b57a9b430069044f443f6);
  [loxforum thread on BLE/LAN segment control](https://www.loxforum.com/forum/faqs-tutorials-howto-s/446672-govee-ble-local-api-segmentsteuerung-szenen).

Platform API docs: [index for LLMs](https://developer.govee.com/llms.txt),
[control devices](https://developer.govee.com/reference/control-you-devices),
[device state](https://developer.govee.com/reference/get-devices-status),
[light scenes](https://developer.govee.com/reference/get-light-scene),
[subscribe device event](https://developer.govee.com/reference/subscribe-device-event),
[API key policy 2026-05](https://developer.govee.com/changelog/important-policy-update-important-notice-regarding-api-key-security-management.md);
old API: [govee.readme.io rate limiting](https://govee.readme.io/reference/rate-limiting).

Integrations: [HA `govee_light_local`](https://www.home-assistant.io/integrations/govee_light_local/),
[Galorhallen/govee-local-api](https://github.com/Galorhallen/govee-local-api),
[homebridge-govee](https://github.com/homebridge-plugins/homebridge-govee),
[boergegrunicke/ioBroker.govee-local](https://github.com/boergegrunicke/ioBroker.govee-local),
[krobipd/ioBroker.govee-smart](https://github.com/krobipd/ioBroker.govee-smart),
[weirdtangent/govee2mqtt](https://github.com/weirdtangent/govee2mqtt),
[wez/govee-lan-hass](https://github.com/wez/govee-lan-hass),
[HA community: "Govee news — there's a local API"](https://community.home-assistant.io/t/govee-news-theres-a-local-api/460757),
[openHAB govee binding](https://www.openhab.org/addons/bindings/govee/) (polls every 5 s).
Pain points: wez [#250](https://github.com/wez/govee2mqtt/issues/250) (flicker after polling stops),
[#437](https://github.com/wez/govee2mqtt/issues/437) (scan reply without `ip`),
[#105](https://github.com/wez/govee2mqtt/issues/105) (segment packets),
[#626](https://github.com/wez/govee2mqtt/issues/626) / [#628](https://github.com/wez/govee2mqtt/issues/628)
(app login `appVersion` enforcement), homebridge [#1247](https://github.com/homebridge-plugins/homebridge-govee/issues/1247).

Own: `prior-art/mqtt-govee-hexa-ultra` (deleted, §1.1), RESEARCH.md (live test log of 2026-08-28).
