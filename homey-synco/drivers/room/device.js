"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const homey_1 = __importDefault(require("homey"));
const OZW772Client_1 = require("../../lib/OZW772Client");
const constants_1 = require("../../lib/constants");
const MODE_TO_ENUM = {
    auto: '0',
    comfort: '1',
    precomfort: '2',
    economy: '3',
    protection: '4',
};
const ENUM_TO_MODE = {
    '0': 'auto',
    '1': 'comfort',
    '2': 'precomfort',
    '3': 'economy',
    '4': 'protection',
};
const MODE_DISPLAY_VALUES = {
    auto: 'Automatik',
    comfort: 'Komfort',
    precomfort: 'Vorkomfort',
    economy: 'Eco',
    protection: 'Schutz',
};
const SETPOINT_OFFSETS = {
    comfort: constants_1.DATAPOINT_OFFSETS.COMFORT_SETPOINT,
    precomfort: constants_1.DATAPOINT_OFFSETS.PRECOMFORT_SETPOINT,
    economy: constants_1.DATAPOINT_OFFSETS.ECONOMY_SETPOINT,
};
class RoomDevice extends homey_1.default.Device {
    constructor() {
        super(...arguments);
        this.client = null;
        this.pollInterval = null;
        this.roomBaseId = 0;
    }
    async onInit() {
        this.log('Room device initialized:', this.getName());
        const store = this.getStore();
        if (!store.host || !store.username || !store.password) {
            this.error('Missing credentials in device store');
            this.setUnavailable('Missing gateway credentials').catch(this.error);
            return;
        }
        this.client = new OZW772Client_1.OZW772Client({
            host: store.host,
            username: store.username,
            password: store.password,
        });
        this.roomBaseId = parseInt(store.roomMenuId, 10);
        this.registerCapabilityListener('target_temperature', this.onCapabilityTargetTemperature.bind(this));
        this.registerCapabilityListener('thermostat_mode', this.onCapabilityThermostatMode.bind(this));
        await this.pollData();
        this.startPolling();
        this.log('Room device polling started');
    }
    startPolling() {
        const settings = this.getSettings();
        const intervalMs = (settings.poll_interval || 60) * 1000;
        if (this.pollInterval) {
            this.homey.clearInterval(this.pollInterval);
        }
        this.pollInterval = this.homey.setInterval(() => this.pollData(), intervalMs);
        this.log(`Polling interval set to ${intervalMs / 1000} seconds`);
    }
    getDatapointId(offset) {
        return (this.roomBaseId + offset).toString();
    }
    mapEnumToMode(enumValue) {
        if (!enumValue)
            return 'auto';
        return ENUM_TO_MODE[enumValue] || 'auto';
    }
    mapModeToEnum(mode) {
        return MODE_TO_ENUM[mode] || '0';
    }
    getModeDisplayValue(mode) {
        return MODE_DISPLAY_VALUES[mode] || 'Automatik';
    }
    async pollData() {
        if (!this.client) {
            return;
        }
        try {
            await this.client.ensureSession();
            const datapointIds = [
                this.getDatapointId(constants_1.DATAPOINT_OFFSETS.ACTUAL_TEMP),
                this.getDatapointId(constants_1.DATAPOINT_OFFSETS.CURRENT_SETPOINT),
                this.getDatapointId(constants_1.DATAPOINT_OFFSETS.VALVE_POSITION),
                this.getDatapointId(constants_1.DATAPOINT_OFFSETS.MODE_STATE),
            ];
            const results = await this.client.readDatapoints(datapointIds);
            const actualTemp = results.get(this.getDatapointId(constants_1.DATAPOINT_OFFSETS.ACTUAL_TEMP));
            if (actualTemp) {
                const temp = OZW772Client_1.OZW772Client.parseNumericValue(actualTemp);
                if (temp !== null) {
                    await this.setCapabilityValue('measure_temperature', temp).catch(this.error);
                }
            }
            const setpoint = results.get(this.getDatapointId(constants_1.DATAPOINT_OFFSETS.CURRENT_SETPOINT));
            if (setpoint) {
                const temp = OZW772Client_1.OZW772Client.parseNumericValue(setpoint);
                if (temp !== null) {
                    await this.setCapabilityValue('target_temperature', temp).catch(this.error);
                }
            }
            const valve = results.get(this.getDatapointId(constants_1.DATAPOINT_OFFSETS.VALVE_POSITION));
            if (valve) {
                const position = OZW772Client_1.OZW772Client.parseNumericValue(valve);
                if (position !== null) {
                    await this.setCapabilityValue('valve_position', position).catch(this.error);
                }
            }
            const mode = results.get(this.getDatapointId(constants_1.DATAPOINT_OFFSETS.MODE_STATE));
            if (mode) {
                const modeValue = this.mapEnumToMode(mode.EnumValue);
                await this.setCapabilityValue('thermostat_mode', modeValue).catch(this.error);
            }
            await this.setAvailable();
        }
        catch (error) {
            this.error('Failed to poll data:', error);
            await this.setUnavailable('Connection error').catch(this.error);
        }
    }
    async onCapabilityTargetTemperature(value) {
        if (!this.client) {
            throw new Error('Not connected to gateway');
        }
        this.log(`Setting target temperature to ${value}`);
        const settings = this.getSettings();
        const setpointType = settings.setpoint_type || 'comfort';
        const offset = SETPOINT_OFFSETS[setpointType] || constants_1.DATAPOINT_OFFSETS.COMFORT_SETPOINT;
        const setpointId = this.getDatapointId(offset);
        try {
            const success = await this.client.writeNumeric(setpointId, value);
            if (!success) {
                throw new Error('Failed to write temperature setpoint');
            }
            this.log(`Temperature setpoint (${setpointType}) updated successfully`);
        }
        catch (error) {
            this.error('Failed to set target temperature:', error);
            throw error;
        }
    }
    async onCapabilityThermostatMode(value) {
        if (!this.client) {
            throw new Error('Not connected to gateway');
        }
        this.log(`Setting thermostat mode to ${value}`);
        const modePreselectionId = this.getDatapointId(constants_1.DATAPOINT_OFFSETS.MODE_PRESELECTION);
        const enumValue = this.mapModeToEnum(value);
        const displayValue = this.getModeDisplayValue(value);
        try {
            const success = await this.client.writeEnumeration(modePreselectionId, displayValue, enumValue);
            if (!success) {
                throw new Error('Failed to write thermostat mode');
            }
            this.log('Thermostat mode updated successfully');
        }
        catch (error) {
            this.error('Failed to set thermostat mode:', error);
            throw error;
        }
    }
    async onSettings({ newSettings, changedKeys, }) {
        this.log('Settings changed:', changedKeys);
        if (changedKeys.includes('poll_interval')) {
            this.log(`Polling interval changed to ${newSettings.poll_interval} seconds`);
            this.startPolling();
        }
    }
    async onDeleted() {
        if (this.pollInterval) {
            this.homey.clearInterval(this.pollInterval);
            this.pollInterval = null;
        }
        this.client = null;
        this.log('Room device deleted:', this.getName());
    }
}
module.exports = RoomDevice;
