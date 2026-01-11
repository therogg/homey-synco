"use strict";
/**
 * Room Device Driver for Siemens Synco Living
 *
 * @description Handles communication with individual room thermostats connected
 * to a Siemens OZW772/OZW672 gateway. Provides temperature monitoring, setpoint
 * control, and operating mode management.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const homey_1 = __importDefault(require("homey"));
const OZW772Client_1 = require("../../lib/OZW772Client");
const constants_1 = require("../../lib/constants");
/** Number of consecutive failures before marking device unavailable */
const FAILURE_THRESHOLD = 3;
/** Number of consecutive successes before marking device available again */
const RECOVERY_THRESHOLD = 2;
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
/**
 * Room Device class for Synco Living room thermostats
 */
class RoomDevice extends homey_1.default.Device {
    constructor() {
        super(...arguments);
        this.client = null;
        this.pollInterval = null;
        this.roomBaseId = 0;
        this.previousTemperature = null;
        this.previousMode = null;
        this.previousValvePosition = null;
        /** Counter for consecutive poll failures */
        this.consecutiveFailures = 0;
        /** Counter for consecutive poll successes (used for recovery) */
        this.consecutiveSuccesses = 0;
        /** Last error message for debugging (accessible via getLastError) */
        this._lastError = null;
    }
    /**
     * Initialize the device
     * Sets up client connection, registers capability listeners, and starts polling
     */
    async onInit() {
        this.log('Room device initialized:', this.getName());
        const store = this.getStore();
        if (!store.host || !store.username || !store.password) {
            this.error('Missing credentials in device store');
            await this.setUnavailable('Missing gateway credentials').catch(this.error);
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
        this.registerFlowCards();
        await this.pollData();
        this.startPolling();
        this.log('Room device polling started');
    }
    /**
     * Register all flow cards (triggers, conditions, actions)
     */
    registerFlowCards() {
        this.temperatureChangedTrigger = this.homey.flow.getDeviceTriggerCard('temperature_changed');
        this.modeChangedTrigger = this.homey.flow.getDeviceTriggerCard('mode_changed');
        this.valveOpenedTrigger = this.homey.flow.getDeviceTriggerCard('valve_opened');
        this.valveOpenedTrigger.registerRunListener(async (args, state) => {
            return state.valve_position > args.threshold;
        });
        this.homey.flow.getConditionCard('temperature_above')
            .registerRunListener(async (args) => {
            const temp = args.device.getCapabilityValue('measure_temperature');
            return temp !== null && temp > args.temperature;
        });
        this.homey.flow.getConditionCard('temperature_below')
            .registerRunListener(async (args) => {
            const temp = args.device.getCapabilityValue('measure_temperature');
            return temp !== null && temp < args.temperature;
        });
        this.homey.flow.getConditionCard('mode_is')
            .registerRunListener(async (args) => {
            const mode = args.device.getCapabilityValue('thermostat_mode');
            return mode === args.mode;
        });
        this.homey.flow.getConditionCard('valve_above')
            .registerRunListener(async (args) => {
            const position = args.device.getCapabilityValue('valve_position');
            return position !== null && position > args.position;
        });
        this.homey.flow.getActionCard('set_temperature')
            .registerRunListener(async (args) => {
            await args.device.triggerCapabilityListener('target_temperature', args.temperature);
        });
        this.homey.flow.getActionCard('set_mode')
            .registerRunListener(async (args) => {
            await args.device.triggerCapabilityListener('thermostat_mode', args.mode);
        });
        this.homey.flow.getActionCard('set_absence')
            .registerRunListener(async (args) => {
            await args.device.setAbsenceMode(args.action === 'enable');
        });
        this.log('Flow cards registered');
    }
    /**
     * Set the absence/vacation mode for the room
     * @param enable - True to enable absence mode, false to disable
     * @throws {Error} When not connected or write fails
     */
    async setAbsenceMode(enable) {
        if (!this.client) {
            throw new Error('Not connected to gateway');
        }
        this.log(`Setting absence mode to ${enable ? 'enabled' : 'disabled'}`);
        const absenceModeId = this.getDatapointId(constants_1.DATAPOINT_OFFSETS.ABSENCE_MODE);
        const enumValue = enable ? '1' : '0';
        const displayValue = enable ? 'Aktiv' : 'Inaktiv';
        try {
            const success = await this.client.writeEnumeration(absenceModeId, displayValue, enumValue);
            if (!success) {
                throw new Error('Failed to write absence mode');
            }
            this.log('Absence mode updated successfully');
        }
        catch (error) {
            this.error('Failed to set absence mode:', error);
            throw error;
        }
    }
    /**
     * Start the polling interval for data updates
     */
    startPolling() {
        const settings = this.getSettings();
        const intervalMs = (settings.poll_interval || 60) * 1000;
        if (this.pollInterval) {
            this.homey.clearInterval(this.pollInterval);
        }
        this.pollInterval = this.homey.setInterval(() => this.pollData(), intervalMs);
        this.log(`Polling interval set to ${intervalMs / 1000} seconds`);
    }
    /**
     * Calculate the datapoint ID from the room base ID and offset
     * @param offset - Datapoint offset from DATAPOINT_OFFSETS
     */
    getDatapointId(offset) {
        return (this.roomBaseId + offset).toString();
    }
    /**
     * Map API enum value to thermostat mode string
     * @param enumValue - Enum value from API
     */
    mapEnumToMode(enumValue) {
        if (!enumValue)
            return 'auto';
        return ENUM_TO_MODE[enumValue] || 'auto';
    }
    /**
     * Map thermostat mode string to API enum value
     * @param mode - Thermostat mode string
     */
    mapModeToEnum(mode) {
        return MODE_TO_ENUM[mode] || '0';
    }
    /**
     * Get the display value for a thermostat mode
     * @param mode - Thermostat mode string
     */
    getModeDisplayValue(mode) {
        return MODE_DISPLAY_VALUES[mode] || 'Automatik';
    }
    /**
     * Poll data from the gateway and update device capabilities
     * Implements graceful error handling with availability management
     */
    async pollData() {
        if (!this.client) {
            this.error('Cannot poll: client not initialized');
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
            const results = await this.client.readDatapoints(datapointIds, (id, err) => this.log(`Warning: Failed to read datapoint ${id}: ${err.message}`));
            const actualTemp = results.get(this.getDatapointId(constants_1.DATAPOINT_OFFSETS.ACTUAL_TEMP));
            if (actualTemp) {
                const temp = OZW772Client_1.OZW772Client.parseNumericValue(actualTemp);
                if (temp !== null) {
                    await this.setCapabilityValue('measure_temperature', temp).catch(this.error);
                    if (this.previousTemperature !== null && this.previousTemperature !== temp) {
                        await this.temperatureChangedTrigger.trigger(this, { temperature: temp }).catch(this.error);
                    }
                    this.previousTemperature = temp;
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
                    if (this.previousValvePosition !== null &&
                        this.previousValvePosition !== position) {
                        await this.valveOpenedTrigger.trigger(this, { valve_position: position }, { valve_position: position }).catch(this.error);
                    }
                    this.previousValvePosition = position;
                }
            }
            const mode = results.get(this.getDatapointId(constants_1.DATAPOINT_OFFSETS.MODE_STATE));
            if (mode) {
                const modeValue = this.mapEnumToMode(mode.EnumValue);
                await this.setCapabilityValue('thermostat_mode', modeValue).catch(this.error);
                if (this.previousMode !== null && this.previousMode !== modeValue) {
                    const modeDisplayName = this.getModeDisplayValue(modeValue);
                    await this.modeChangedTrigger.trigger(this, { mode: modeDisplayName }).catch(this.error);
                }
                this.previousMode = modeValue;
            }
            await this.handlePollSuccess();
        }
        catch (error) {
            await this.handlePollFailure(error);
        }
    }
    /**
     * Handle successful poll - manage availability recovery
     */
    async handlePollSuccess() {
        this.consecutiveFailures = 0;
        this.consecutiveSuccesses++;
        this._lastError = null;
        if (!this.getAvailable() && this.consecutiveSuccesses >= RECOVERY_THRESHOLD) {
            this.log('Connection recovered, marking device as available');
            await this.setAvailable();
            this.consecutiveSuccesses = 0;
        }
    }
    /**
     * Handle poll failure - manage availability and error logging
     * @param error - The error that occurred
     */
    async handlePollFailure(error) {
        this.consecutiveSuccesses = 0;
        this.consecutiveFailures++;
        const errorMessage = this.getErrorMessage(error);
        this._lastError = errorMessage;
        if (this.consecutiveFailures === 1) {
            this.log(`Poll failed (attempt ${this.consecutiveFailures}/${FAILURE_THRESHOLD}): ${errorMessage}`);
        }
        else if (this.consecutiveFailures <= FAILURE_THRESHOLD) {
            this.log(`Poll failed (attempt ${this.consecutiveFailures}/${FAILURE_THRESHOLD})`);
        }
        if (this.getAvailable() && this.consecutiveFailures >= FAILURE_THRESHOLD) {
            this.error(`Connection lost after ${FAILURE_THRESHOLD} failures: ${errorMessage}`);
            await this.setUnavailable(this.getUserFriendlyError(error)).catch(this.error);
        }
    }
    /**
     * Extract a descriptive error message from an error
     * @param error - The error to extract message from
     */
    getErrorMessage(error) {
        if (error instanceof OZW772Client_1.OZW772Error) {
            return `[${error.code}] ${error.message}`;
        }
        if (error instanceof Error) {
            return error.message;
        }
        return 'Unknown error';
    }
    /**
     * Get a user-friendly error message for the Homey UI
     * @param error - The error to convert
     */
    getUserFriendlyError(error) {
        if (error instanceof OZW772Client_1.OZW772Error) {
            switch (error.code) {
                case 'ECONNREFUSED':
                    return 'Gateway not reachable';
                case 'TIMEOUT':
                    return 'Gateway not responding';
                case 'AUTH_ERROR':
                    return 'Authentication failed';
                case 'ENOTFOUND':
                    return 'Gateway not found';
                default:
                    return 'Connection error';
            }
        }
        return 'Connection error';
    }
    /**
     * Handle target temperature capability changes
     * @param value - New target temperature value
     * @throws {Error} When not connected or write fails
     */
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
    /**
     * Handle thermostat mode capability changes
     * @param value - New thermostat mode value
     * @throws {Error} When not connected or write fails
     */
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
    /**
     * Handle settings changes
     * @param options - Settings change options containing old/new settings and changed keys
     */
    async onSettings({ newSettings, changedKeys, }) {
        this.log('Settings changed:', changedKeys);
        if (changedKeys.includes('poll_interval')) {
            this.log(`Polling interval changed to ${newSettings.poll_interval} seconds`);
            this.startPolling();
        }
    }
    /**
     * Clean up when device is deleted
     */
    async onDeleted() {
        if (this.pollInterval) {
            this.homey.clearInterval(this.pollInterval);
            this.pollInterval = null;
        }
        this.client = null;
        this.log('Room device deleted:', this.getName());
    }
    /**
     * Get the last error message (useful for debugging)
     * @returns The last error message or null if no error occurred
     */
    getLastError() {
        return this._lastError;
    }
}
module.exports = RoomDevice;
