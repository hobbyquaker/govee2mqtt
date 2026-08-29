# Changelog

## 0.2.0

### Added

- **`--discover`** — list every Govee device on the network and exit (`--discover-json` for JSON),
  and **`-a auto`**, which fills the unicast scan list with all of them. Built on the core's
  discovery module (B-2), so `--discover-address` (a device or a `10.0.1.0/24` range a router
  away), `--discover-timeout` and `--discover-ip` come with it. `--install -a auto` resolves the
  scan once and writes the result into the instance's env file, instead of leaving every service
  start to depend on a scan.
- The `address` option is marked `x-discover` in `--config-schema`, which is how a management UI
  (she) knows to offer the scan when an instance is added — it showed nothing before. It is an
  array, so the scan fills the whole list rather than one address: this is a bridge, one instance
  for the whole LAN.

### Notes

- Needs mqtt-interfaces-core ≥ 0.10.0, whose `bindPort` this required: a Govee device answers to
  port 4002 and ignores the port the scan came from, so the core's probe on an ephemeral port
  heard nothing at all.
- Discovery is for the unicast fallback only. Where multicast works the bridge finds its devices
  by itself and needs no addresses, which is unchanged.

## 0.1.1

### Added

- Docker images on `ghcr.io/hobbyquaker/govee2mqtt`, built for amd64, arm64 and armv7 by the
  release workflow on every tag (`x.y.z`, `x.y`, `latest`); `docker run` example (host networking,
  `/data` volume) in the README.

### Fixed

- The image creates `/data` owned by `node`: on a fresh volume docker created the mount point
  root-owned, so the scene cache could not be written.

## 0.1.0

First working release (replaces the 0.0.1 placeholder).

### Added

- Govee LAN API bridge: multicast / broadcast / unicast discovery, status polling with per-device
  `online`, on/off, brightness, colour, colour temperature.
- Scenes from Govee's public scene library per model, cached in the state directory and sent as
  `ptReal` packets (verified byte-for-byte against app captures for the H606A); music modes for
  the H606A; `set/<dev>/raw` behind `--raw-set`.
- Home Assistant discovery: bridge + one device per light (`light` with effects, `select` music
  mode, diagnostics), per-device availability.
- `--map-file` device names, `--devices` filter, `--config-schema`, systemd `--install`, Dockerfile.
