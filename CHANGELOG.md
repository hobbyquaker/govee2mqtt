# Changelog

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
