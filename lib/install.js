/**
 * --install / --uninstall: systemd template service govee2mqtt@<name> (mqtt-interfaces-core
 * installer). UDP needs no privileges; the scene cache lives in the state directory.
 */

import {createInstaller} from 'mqtt-interfaces-core';

export const SERVICE = 'govee2mqtt';
export const ENV_PREFIX = 'GOVEE2MQTT';

const installer = createInstaller({
    service: SERVICE,
    envPrefix: ENV_PREFIX,
    description: `${SERVICE} %i - Govee to MQTT bridge`,
    documentation: 'https://github.com/hobbyquaker/govee2mqtt',
});

export const {unitFile, envFile, installService, uninstallService, handle} = installer;
