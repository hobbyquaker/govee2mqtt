# govee2mqtt — research log

The plan and the implementation spec are in [ROADMAP.md](ROADMAP.md) (§2 has the condensed
protocol facts, §9 the sources). This file keeps what does not belong in a spec: the live test log,
the raw data that has no public source, and the capture method for adding SKUs.

Research date: 2026-08-28. Scope decision: network transports only (LAN API, Platform API), no
Bluetooth LE. Test device: Glide Hexa Ultra **H606A** at 172.16.23.120, device id
`1B:FA:FB:75:D9:29:BF:71`, wifi fw hard 1.04.01 / soft 1.03.01, ble fw hard 3.04.01 / soft 1.00.16.

## 1. Live test log (2026-08-28, `scripts/lan-probe.mjs` from this Mac over VPN)

Multicast `scan` from the Mac (192.168.8.0/21, VPN `utun3`) finds nothing — different subnet.
Unicast works:

| step                                                     | reply / status ~1.3 s later                                                                            |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `scan` → `:4001`                                         | 217 ms: `{ip, device, sku: "H606A", bleVersionHard, bleVersionSoft, wifiVersionHard, wifiVersionSoft}` |
| `devStatus` → `:4003`                                    | `{"onOff":0,"brightness":100,"color":{"r":255,"g":127,"b":0},"colorTemInKelvin":0}`                    |
| JSON `turn {value: 1}`                                   | `onOff: 1`                                                                                             |
| JSON `brightness {value: 50}`                            | `brightness: 50`                                                                                       |
| JSON `colorwc {color: {0,0,255}, colorTemInKelvin: 0}`   | `color: {0,0,255}`, `colorTemInKelvin: 0`                                                              |
| JSON `colorwc {color: {0,0,0}, colorTemInKelvin: 4000}`  | `color: {0,0,0}`, `colorTemInKelvin: 4000`                                                             |
| `ptReal` `33 04 64` (brightness 100)                     | `brightness: 100`                                                                                      |
| `ptReal` scene Rainbow (library bytes, `01 n 58`)        | status unchanged (no scene field); 3 s later still unchanged                                           |
| `ptReal` scene Matrix (library bytes)                    | unchanged                                                                                              |
| `ptReal` scene Fire (wez generic `01 n 02` + full param) | unchanged                                                                                              |
| `ptReal` select-only `33 05 04 <Ocean>`                  | unchanged                                                                                              |
| restore colour 255/127/0, brightness 100, off            | back to the initial status                                                                             |
| unsolicited datagrams during the whole run               | **0**                                                                                                  |

From `root@mqtt-ifaces` (172.16.23.226/24, same subnet, Node 24): multicast `scan` → reply in
137 ms; subnet broadcast (172.16.23.255), global broadcast (255.255.255.255) and unicast all
return the same single device — the H606A is the only Govee device on that LAN.

Conclusions: documented JSON commands work on the H606A and are mirrored by `devStatus`; the
device never pushes; `devStatus` cannot tell whether a scene is running, so scene activation must
be confirmed visually (ROADMAP §6 milestone 1 gate). Nothing errored; the device silently ignores
what it does not understand.

## 2. Scene library vs. 2024 capture

`GET https://app2.govee.com/appsku/v1/light-effect-libraries?sku=H606A` (header `AppVersion:
5.6.01`) → 72 scenes in 6 categories, every `scenceParam` starts with `0x22`, every
`speedInfo.supSpeed` is `false`, no `specialEffect`, `sceneType 4`, `cmdVersion 0`.

Comparison with the 78 packet sets captured from the app's BLE writes in 2024
(`prior-art/mqtt-govee-hexa-ultra/scenes.js`, now deleted):

- Stream = `01 <n> 58` + `scenceParam[1:]`, split into `a3 <idx>` + 17 bytes, last index `ff`,
  XOR checksum: **byte-identical for 64 of 72 scenes**.
- 2 copy errors in the capture table (`crawl` had `cubic`'s packets; 7718 is `carnival`, not a
  second `valentinesday`).
- 7 scenes differ in exactly one 4-byte field after a `05` marker: capture `41 06 41 06`, library
  `b7 06 fc 05` (Rainbow 7536, Evolution 7528, Kaleidoscope 7530, Circuit 7531, Ripple 7540, Arcane
  Light 7734, Speeding 7735). Open question OQ-G4.
- Select packet `33 05 04 <code LE> <flag> <speed>`: `speed` equals `scenceParam[1]` for 58 of 71
  scenes; the others were captured after moving the app's speed slider (Leisure at 0x33/0x4d/0x64/
  0x3b) — so byte 6 is the speed and `scenceParam[1]` its default. `flag` is 0 except Rainbow,
  Aurora, Rustling Leaves (1) and Matrix (0x0e); no library field matches it (OQ-G5).

## 3. Music modes — H606A (captured 2024, no public source yet; OQ-G6)

Packets without checksum (the 20th byte is the XOR of the first 19). Each mode = `a3` definition
(type byte `0x41`, mode id as first data byte) + `33 05 13`.

```
Rhythm     a3 00 01 03 41 75 4a 07 ff 00 00 ff 7f 00 ff ff 00 00 ff
           a3 01 00 00 00 ff 00 ff ff 8b 00 ff 01 f6 00 00 00 00 00
           a3 ff 01 01 01 00 00 00 00 00 00 00 00 00 00 00 00 00 00
           33 05 13
Pulsating  a3 00 01 02 41 76 4a 07 ff 00 00 ff 7f 00 ff ff 00 00 ff
           a3 ff 00 00 00 ff 00 ff ff 8b 00 ff 01 f4 00 00 00 00 01
           33 05 13
Energy     a3 00 01 02 41 77 4a 07 ff 00 00 ff 7f 00 ff ff 00 00 ff
           a3 ff 00 00 00 ff 00 ff ff 8b 00 ff 01 01 00 00 00 00 00
           33 05 13
Windmill   a3 00 01 03 41 78 4a 07 ff 00 00 ff 7f 00 ff ff 00 00 ff
           a3 01 00 00 00 ff 00 ff ff 8b 00 ff 02 f1 00 00 00 00 01
           a3 ff 01 01 01 00 00 00 00 00 00 00 00 00 00 00 00 00 00
           33 05 13
Divide     a3 00 01 02 41 7a 4a 07 ff 00 00 ff 7f 00 ff ff 00 00 ff
           a3 ff 00 00 00 ff 00 ff ff 8b 00 ff 01 01 00 00 00 00 00
           33 05 13
Beat       a3 00 01 02 41 7b 4a 07 ff 00 00 ff 7f 00 ff ff 00 00 ff
           a3 ff 00 00 00 ff 00 ff ff 8b 00 ff 01 fa 00 00 00 00 00
           33 05 13
```

The 30-byte definition after `41` is identical across modes except the id (`75`…`7b`, `79`
unused/unknown) and bytes 13–14/18 (`01 f6`, `01 f4`, `01 01`, `02 f1`, `01 01`, `01 fa`; last
byte `01` for Pulsating/Windmill) — the sensitivity/colour settings of the app at capture time.
The colour block `ff 00 00 / ff 7f 00 / ff ff 00 / 00 ff 00 / 00 ff ff / 8b 00 ff` is the app's
default 6-colour palette.

## 4. Capture method for a new SKU (documentation, not a build step)

The app writes the same 20-byte packets over BLE that `ptReal` carries. To obtain packets the
library recipe cannot derive (music modes, DIY, segments, a new prefix rule): install Apple's
Bluetooth logging profile on the phone, drive the effect in the Govee Home app, open the
`.pklg` in Wireshark with filter
`frame.len == 0x20 && btatt.opcode == 0x52 && btatt.value[0:1] != aa`, export the hexdumps.
Then compare against `light-effect-libraries` to find `hex_prefix_remove`/`hex_prefix_add` for
`lib/sku.js` (AlgoClaw's method). BLE is used here only as a sniffing side channel; the adapter
never speaks BLE.

## 5. Not yet exercised

- The Platform API (needs a key — request it before ROADMAP milestone 2): record real rate-limit
  behaviour, the `device/scenes` list for the H606A versus the public library, and whether
  `device/state` reports a running scene (the LAN cannot).
- Scene activation on the H606A (visual): `node scripts/lan-probe.mjs 172.16.23.120 scene matrix`
  and `… scene rainbow` (unpatched library bytes, OQ-G4), then `… off`.
- `python-govee-api` / `govee_api_laggat` (LaggAt, HACS) use the old `developer-api.govee.com`
  API — historical only.
