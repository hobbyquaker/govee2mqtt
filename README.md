# govee2mqtt

Interface between **Govee** WiFi lights and MQTT, following the
[mqtt-smarthome](https://github.com/mqtt-smarthome/mqtt-smarthome) convention, with Home Assistant
discovery. Built on [mqtt-interfaces-core](https://github.com/hobbyquaker/mqtt-interfaces-core).

It talks to the lights over Govee's **LAN API** (UDP, no cloud, no account, no API key): on/off,
brightness, colour, colour temperature, the app's scenes (fetched per model from Govee's public
scene library and sent as raw packets) and music modes. Every device on the LAN with _LAN Control_
enabled in the Govee Home app is discovered and bridged; one instance serves them all.

Not to be confused with [wez/govee2mqtt](https://github.com/wez/govee2mqtt) (Rust, Home Assistant
add-on, uses the Govee account's cloud channel) or weirdtangent's Python image of the same name.
This one is Node.js, speaks the mqtt-smarthome topic convention, needs no Govee account and has no
Bluetooth. Status: **0.1 — LAN lights only**, verified on a Glide Hexa Ultra (H606A); the Platform
(cloud) API for names, DIY scenes and non-light devices is planned ([ROADMAP.md](ROADMAP.md)).

## Install

```
npm install -g govee2mqtt
govee2mqtt --mqtt-url mqtt://broker              # foreground, discovers by multicast
sudo govee2mqtt --install -n govee -u mqtt://broker   # systemd service govee2mqtt@govee
```

Requirements: Node ≥ 20.19; the host must be able to **bind UDP port 4002** (Govee devices answer
to that port, whatever port the request came from), reach the devices on UDP **4001** (discovery)
and **4003** (commands), and — for discovery without configuration — receive multicast from them.
Only one Govee LAN integration can run per host (homebridge-govee, Home Assistant's
`govee_light_local` and wez/govee2mqtt all need 4002 too).

Docker: `--network host` (multicast + port 4002), config by `GOVEE2MQTT_*` environment variables,
`/data` volume for the scene cache.

### Discovery on networks without multicast

WiFi routers and VLAN boundaries often drop multicast. Then either give the devices' addresses
(`-a 192.168.1.50 -a 192.168.1.51`, scanned by unicast) or add `--broadcast` (subnet broadcast).
`govee/status/bridge/scan` shows what the last scan used and found. The devices must have a
route back to this host's port 4002.

## Options

| option                      | env                        | default            | description                                                          |
| --------------------------- | -------------------------- | ------------------ | -------------------------------------------------------------------- |
| `-u, --mqtt-url`            | `MQTT_URL`                 | `mqtt://localhost` | broker url (`mqtt://`, `mqtts://`, `ws://`)                          |
| `--mqtt-username/-password` | `MQTT_USERNAME/_PASSWORD`  |                    | broker credentials                                                   |
| `-n, --name`                | `GOVEE2MQTT_NAME`          | `govee`            | instance name = topic prefix                                         |
| `-a, --address`             | `GOVEE2MQTT_ADDRESS`       |                    | device ip to scan by unicast (repeatable)                            |
| `--broadcast`               | `GOVEE2MQTT_BROADCAST`     | `false`            | also scan by subnet broadcast                                        |
| `--lan-interface`           | `GOVEE2MQTT_LAN_INTERFACE` |                    | ipv4 address of the interface for the multicast group                |
| `--scan-interval`           | `GOVEE2MQTT_SCAN_INTERVAL` | `60`               | seconds between discovery scans (0 = only at start)                  |
| `--poll-interval`           | `GOVEE2MQTT_POLL_INTERVAL` | `5`                | seconds between status polls per device                              |
| `--offline-after`           | `GOVEE2MQTT_OFFLINE_AFTER` | `3`                | unanswered polls before `online` goes `false`                        |
| `-m, --map-file`            | `GOVEE2MQTT_MAP_FILE`      |                    | JSON `{"<device id>": "<topic name>"}` ([example](example-map.json)) |
| `--devices`                 | `GOVEE2MQTT_DEVICES`       | all                | only bridge these device ids / names                                 |
| `--state-dir`               | `GOVEE2MQTT_STATE_DIR`     | `$STATE_DIRECTORY` | scene cache directory                                                |
| `--scene-refresh`           | `GOVEE2MQTT_SCENE_REFRESH` | `7`                | days after which a cached scene list is refetched (0 = never)        |
| `--raw-set`                 | `GOVEE2MQTT_RAW_SET`       | `false`            | accept raw packets on `set/<dev>/raw`                                |
| `--no-json-payloads`        | `GOVEE2MQTT_JSON_PAYLOADS` | json on            | plain values instead of `{val, ts, lc}`                              |
| `--no-ha-discovery`         | `GOVEE2MQTT_HA_DISCOVERY`  | on                 | Home Assistant discovery off                                         |
| `-v, --verbosity`           | `GOVEE2MQTT_VERBOSITY`     | `info`             | `error`, `warn`, `info`, `debug`                                     |
| `--config-schema`           |                            |                    | print a JSON Schema of all options (management UIs)                  |

Every option is also an environment variable; CLI > env > defaults. `--help` lists the rest
(`--ha-prefix`, `--mqtt-tls-ca`, `--no-maintenance`, `--stats-interval`, `--install`, …).

## Topics

Default prefix `govee`. `<dev>` is the device's topic name: `<sku>_<last two id bytes>`
(`h606a_bf71`) unless the map file says otherwise.

| topic                                                | retained | payload                                                                                    |
| ---------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------ |
| `govee/connected`                                    | yes      | `0` gone · `1` broker only · `2` LAN socket bound                                          |
| `govee/status/<dev>/power`                           | yes      | `true` / `false`                                                                           |
| `govee/status/<dev>/brightness`                      | yes      | `1`–`100`                                                                                  |
| `govee/status/<dev>/color`                           | yes      | `{"r": 255, "g": 127, "b": 0}` (`{0,0,0}` in colour-temperature mode)                      |
| `govee/status/<dev>/color_temp`                      | yes      | kelvin, `0` when a colour is set                                                           |
| `govee/status/<dev>/color_mode`                      | yes      | `rgb` · `ct` · `scene` · `music`                                                           |
| `govee/status/<dev>/scene`                           | yes      | last scene set through this bridge (`sunset_glow`, …) or `''` — the LAN API cannot read it |
| `govee/status/<dev>/music`                           | yes      | last music mode set through this bridge or `''`                                            |
| `govee/status/<dev>/online`                          | yes      | `true` / `false` (answers polls)                                                           |
| `govee/status/<dev>/sku`, `device`, `ip`, `firmware` | yes      | identity from the scan reply                                                               |
| `govee/status/bridge/devices`                        | yes      | `[{dev, sku, device, ip, transport, online}]`                                              |
| `govee/status/bridge/scan`                           | yes      | `{last, method, found}`                                                                    |
| `govee/info`, `govee/maintenance/…`                  | yes      | instance info, log level / restart / stats (from the core)                                 |

Payloads are `{"val": …, "ts": <ms>, "lc": <ms>}` (`lc` = last change); `--no-json-payloads`
gives plain values.

### Commands `govee/set/<dev>/…`

Plain values or `{"val": …}`.

| topic                   | payload                                                                                  |
| ----------------------- | ---------------------------------------------------------------------------------------- |
| `…/power`               | `true`/`false`, `on`/`off`, `1`/`0`                                                      |
| `…/brightness`          | `1`–`100` (`0` turns off)                                                                |
| `…/color`               | `{"r":0,"g":0,"b":255}`, `#0000ff`, `0,0,255`                                            |
| `…/color_temp`          | kelvin (2000–9000)                                                                       |
| `…/scene`               | scene name (`matrix`, `Sunset Glow`), scene code, or `{"name": "leisure", "speed": 100}` |
| `…/music`               | `rhythm`, `pulsating`, `energy`, `windmill`, `divide`, `beat` (H606A)                    |
| `…/refresh`             | anything — poll now                                                                      |
| `…/raw`                 | hex or base64 20-byte packets (`--raw-set` only)                                         |
| `govee/set/bridge/scan` | anything — discover now                                                                  |

Scene names come from Govee's scene library for the device's model (the names the app shows,
lower-cased, `_` for spaces); the Home Assistant light lists them as effects. After a command the
device is polled again a second later, so `status/…` reflects what the light actually did. The
LAN API has no way to read which scene is running: `scene`/`music` are what this bridge sent last
and are cleared when a poll shows the light changed some other way (app, physical button).

## Home Assistant

Discovery is on by default (device-based, HA ≥ 2024.11): a bridge device plus one device per
light with a `light` entity (on/off, brightness, RGB, colour temperature in Kelvin, effect list =
scenes), a `select` for the music mode, `online` connectivity, IP address and a refresh button.
Entities are unavailable while the bridge is down or the device does not answer polls.

## Security note

The Govee LAN API has no authentication: anyone who can reach UDP 4003 of a light controls it.
This bridge never listens for commands from the LAN and does not expose raw packets over MQTT
unless started with `--raw-set`. Keep the lights on a network you trust.

## Development

`npm test` (node:test; the packet encoder is pinned to app packets captured from an H606A in
`test/fixtures/`), `npm run lint`, `npm run deploy` (tarball deploy to a host, see `deploy.sh`).
`scripts/lan-probe.mjs <ip> [scenes|scene <name>|on|off|…]` talks to one device without MQTT.
[ROADMAP.md](ROADMAP.md) has the design, decisions and open questions; [RESEARCH.md](RESEARCH.md)
the protocol notes and the live test log.

## License

MIT © Sebastian Raff
