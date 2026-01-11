"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const homey_1 = __importDefault(require("homey"));
const OZW772Client_1 = require("../../lib/OZW772Client");
const constants_1 = require("../../lib/constants");
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
        await this.pollData();
        this.pollInterval = this.homey.setInterval(() => this.pollData(), constants_1.DEFAULTS.POLLING_INTERVAL_MS);
        this.log('Room device polling started');
    }
    getDatapointId(offset) {
        return (this.roomBaseId + offset).toString();
    }
    async pollData() {
        if (!this.client) {
            return;
        }
        try {
            const datapointIds = [
                this.getDatapointId(constants_1.DATAPOINT_OFFSETS.ACTUAL_TEMP),
                this.getDatapointId(constants_1.DATAPOINT_OFFSETS.CURRENT_SETPOINT),
                this.getDatapointId(constants_1.DATAPOINT_OFFSETS.VALVE_POSITION),
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
        const comfortSetpointId = this.getDatapointId(constants_1.DATAPOINT_OFFSETS.COMFORT_SETPOINT);
        try {
            const success = await this.client.writeNumeric(comfortSetpointId, value);
            if (!success) {
                throw new Error('Failed to write temperature setpoint');
            }
            this.log('Temperature setpoint updated successfully');
        }
        catch (error) {
            this.error('Failed to set target temperature:', error);
            throw error;
        }
    }
    async onSettings({ changedKeys, }) {
        this.log('Settings changed:', changedKeys);
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
