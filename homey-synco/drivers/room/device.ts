/**
 * Room Device Driver for Siemens Synco Living
 *
 * @description Handles communication with individual room thermostats connected
 * to a Siemens OZW772/OZW672 gateway. Provides temperature monitoring, setpoint
 * control, and operating mode management.
 */

import Homey from 'homey';
import { OZW772Client, OZW772Error } from '../../lib/OZW772Client';
import { DATAPOINT_OFFSETS } from '../../lib/constants';

/** Room device store structure */
interface RoomStore {
  host: string;
  username: string;
  password: string;
  roomMenuId: string;
  stateMenuId: string;
  setpointsMenuId: string;
  modeMenuId: string;
}

/** Room device settings structure */
interface RoomSettings {
  poll_interval: number;
  setpoint_type: 'comfort' | 'precomfort' | 'economy';
}

/** Supported thermostat operating modes */
type ThermostatMode = 'auto' | 'comfort' | 'precomfort' | 'economy' | 'protection';

/** Number of consecutive failures before marking device unavailable */
const FAILURE_THRESHOLD = 3;

/** Number of consecutive successes before marking device available again */
const RECOVERY_THRESHOLD = 2;

const MODE_TO_ENUM: Record<ThermostatMode, string> = {
  auto: '0',
  comfort: '1',
  precomfort: '2',
  economy: '3',
  protection: '4',
};

const ENUM_TO_MODE: Record<string, ThermostatMode> = {
  '0': 'auto',
  '1': 'comfort',
  '2': 'precomfort',
  '3': 'economy',
  '4': 'protection',
};

const MODE_DISPLAY_VALUES: Record<ThermostatMode, string> = {
  auto: 'Automatik',
  comfort: 'Komfort',
  precomfort: 'Vorkomfort',
  economy: 'Eco',
  protection: 'Schutz',
};

/**
 * Room Device class for Synco Living room thermostats
 */
/** Debounce delay for temperature changes in milliseconds */
const TEMPERATURE_DEBOUNCE_MS = 2000;

class RoomDevice extends Homey.Device {
  private client: OZW772Client | null = null;
  private pollInterval: NodeJS.Timeout | null = null;
  private roomBaseId: number = 0;

  private previousTemperature: number | null = null;
  private previousMode: string | null = null;
  private previousValvePosition: number | null = null;

  /** Pending temperature values waiting to be sent (keyed by setpoint type) */
  private pendingSetpoints: Map<string, number> = new Map();
  /** Debounce timers for temperature changes (keyed by setpoint type) */
  private setpointDebounceTimers: Map<string, NodeJS.Timeout> = new Map();

  /** Counter for consecutive poll failures */
  private consecutiveFailures: number = 0;

  /** Counter for consecutive poll successes (used for recovery) */
  private consecutiveSuccesses: number = 0;

  /** Last error message for debugging (accessible via getLastError) */
  private _lastError: string | null = null;

  private temperatureChangedTrigger!: Homey.FlowCardTriggerDevice;
  private modeChangedTrigger!: Homey.FlowCardTriggerDevice;
  private valveOpenedTrigger!: Homey.FlowCardTriggerDevice;

  /**
   * Initialize the device
   * Sets up client connection, registers capability listeners, and starts polling
   */
  async onInit(): Promise<void> {
    this.log('Room device initialized:', this.getName());

    const store = this.getStore() as RoomStore;

    if (!store.host || !store.username || !store.password) {
      this.error('Missing credentials in device store');
      await this.setUnavailable('Missing gateway credentials').catch(this.error);
      return;
    }

    this.client = new OZW772Client({
      host: store.host,
      username: store.username,
      password: store.password,
    });

    this.roomBaseId = parseInt(store.roomMenuId, 10);

    // Add missing capabilities for existing devices (needed after capability updates)
    await this.ensureCapabilities();

    this.registerCapabilityListener('target_temperature', this.onCapabilityTargetTemperature.bind(this));
    this.registerCapabilityListener('thermostat_mode', this.onCapabilityThermostatMode.bind(this));

    // Register listeners for individual setpoint capabilities
    this.registerCapabilityListener('setpoint_comfort', (value: number) =>
      this.onCapabilitySetpoint('comfort', value));
    this.registerCapabilityListener('setpoint_precomfort', (value: number) =>
      this.onCapabilitySetpoint('precomfort', value));
    this.registerCapabilityListener('setpoint_economy', (value: number) =>
      this.onCapabilitySetpoint('economy', value));
    this.registerCapabilityListener('setpoint_protection', (value: number) =>
      this.onCapabilitySetpoint('protection', value));

    this.registerFlowCards();

    await this.pollData();

    this.startPolling();

    this.log('Room device polling started');
  }

  /**
   * Ensure all required capabilities exist on the device
   * This is needed when new capabilities are added after devices have been paired
   */
  private async ensureCapabilities(): Promise<void> {
    const requiredCapabilities = [
      'measure_temperature',
      'target_temperature',
      'valve_position',
      'thermostat_mode',
      'setpoint_comfort',
      'setpoint_precomfort',
      'setpoint_economy',
      'setpoint_protection',
    ];

    for (const capability of requiredCapabilities) {
      if (!this.hasCapability(capability)) {
        this.log(`Adding missing capability: ${capability}`);
        await this.addCapability(capability).catch((err) => {
          this.error(`Failed to add capability ${capability}:`, err);
        });
      }
    }
  }

  /**
   * Register all flow cards (triggers, conditions, actions)
   */
  private registerFlowCards(): void {
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
  async setAbsenceMode(enable: boolean): Promise<void> {
    if (!this.client) {
      throw new Error('Not connected to gateway');
    }

    this.log(`Setting absence mode to ${enable ? 'enabled' : 'disabled'}`);

    const absenceModeId = this.getDatapointId(DATAPOINT_OFFSETS.ABSENCE_MODE);
    const enumValue = enable ? '1' : '0';
    const displayValue = enable ? 'Aktiv' : 'Inaktiv';

    try {
      const success = await this.client.writeEnumeration(
        absenceModeId,
        displayValue,
        enumValue
      );

      if (!success) {
        throw new Error('Failed to write absence mode');
      }

      this.log('Absence mode updated successfully');
    } catch (error) {
      this.error('Failed to set absence mode:', error);
      throw error;
    }
  }

  /**
   * Start the polling interval for data updates
   */
  private startPolling(): void {
    const settings = this.getSettings() as RoomSettings;
    const intervalMs = (settings.poll_interval || 60) * 1000;

    if (this.pollInterval) {
      this.homey.clearInterval(this.pollInterval);
    }

    this.pollInterval = this.homey.setInterval(
      () => this.pollData(),
      intervalMs
    );

    this.log(`Polling interval set to ${intervalMs / 1000} seconds`);
  }

  /**
   * Calculate the datapoint ID from the room base ID and offset
   * @param offset - Datapoint offset from DATAPOINT_OFFSETS
   */
  private getDatapointId(offset: number): string {
    return (this.roomBaseId + offset).toString();
  }

  /**
   * Map API enum value to thermostat mode string
   * @param enumValue - Enum value from API
   */
  private mapEnumToMode(enumValue: string | undefined): ThermostatMode {
    if (!enumValue) return 'auto';
    return ENUM_TO_MODE[enumValue] || 'auto';
  }

  /**
   * Map thermostat mode string to API enum value
   * @param mode - Thermostat mode string
   */
  private mapModeToEnum(mode: string): string {
    return MODE_TO_ENUM[mode as ThermostatMode] || '0';
  }

  /**
   * Get the display value for a thermostat mode
   * @param mode - Thermostat mode string
   */
  private getModeDisplayValue(mode: string): string {
    return MODE_DISPLAY_VALUES[mode as ThermostatMode] || 'Automatik';
  }

  /**
   * Poll data from the gateway and update device capabilities
   * Implements graceful error handling with availability management
   */
  async pollData(): Promise<void> {
    if (!this.client) {
      this.error('Cannot poll: client not initialized');
      return;
    }

    this.log('Polling data for room:', this.getName(), 'baseId:', this.roomBaseId);

    try {
      await this.client.ensureSession();

      const datapointIds = [
        this.getDatapointId(DATAPOINT_OFFSETS.ACTUAL_TEMP),
        this.getDatapointId(DATAPOINT_OFFSETS.CURRENT_SETPOINT),
        this.getDatapointId(DATAPOINT_OFFSETS.VALVE_POSITION),
        this.getDatapointId(DATAPOINT_OFFSETS.MODE_STATE),
        this.getDatapointId(DATAPOINT_OFFSETS.COMFORT_SETPOINT),
        this.getDatapointId(DATAPOINT_OFFSETS.PRECOMFORT_SETPOINT),
        this.getDatapointId(DATAPOINT_OFFSETS.ECONOMY_SETPOINT),
        this.getDatapointId(DATAPOINT_OFFSETS.PROTECTION_SETPOINT),
      ];

      this.log('Reading datapoints:', datapointIds);

      const results = await this.client.readDatapoints(
        datapointIds,
        (id, err) => this.log(`Warning: Failed to read datapoint ${id}: ${err.message}`)
      );

      this.log('Datapoint results:', JSON.stringify(Array.from(results.entries())));

      const actualTemp = results.get(this.getDatapointId(DATAPOINT_OFFSETS.ACTUAL_TEMP));
      if (actualTemp) {
        const temp = OZW772Client.parseNumericValue(actualTemp);
        if (temp !== null) {
          await this.setCapabilityValue('measure_temperature', temp).catch(this.error);

          if (this.previousTemperature !== null && this.previousTemperature !== temp) {
            await this.temperatureChangedTrigger.trigger(this, { temperature: temp }).catch(this.error);
          }
          this.previousTemperature = temp;
        }
      }

      const setpoint = results.get(this.getDatapointId(DATAPOINT_OFFSETS.CURRENT_SETPOINT));
      if (setpoint) {
        const temp = OZW772Client.parseNumericValue(setpoint);
        if (temp !== null) {
          await this.setCapabilityValue('target_temperature', temp).catch(this.error);
        }
      }

      const valve = results.get(this.getDatapointId(DATAPOINT_OFFSETS.VALVE_POSITION));
      if (valve) {
        const position = OZW772Client.parseNumericValue(valve);
        if (position !== null) {
          await this.setCapabilityValue('valve_position', position).catch(this.error);

          if (
            this.previousValvePosition !== null &&
            this.previousValvePosition !== position
          ) {
            await this.valveOpenedTrigger.trigger(this, { valve_position: position }, { valve_position: position }).catch(this.error);
          }
          this.previousValvePosition = position;
        }
      }

      const mode = results.get(this.getDatapointId(DATAPOINT_OFFSETS.MODE_STATE));
      if (mode) {
        const modeValue = this.mapEnumToMode(mode.EnumValue);
        await this.setCapabilityValue('thermostat_mode', modeValue).catch(this.error);

        if (this.previousMode !== null && this.previousMode !== modeValue) {
          const modeDisplayName = this.getModeDisplayValue(modeValue);
          await this.modeChangedTrigger.trigger(this, { mode: modeDisplayName }).catch(this.error);
        }
        this.previousMode = modeValue;
      }

      // Update individual setpoint capabilities
      const comfortSetpoint = results.get(this.getDatapointId(DATAPOINT_OFFSETS.COMFORT_SETPOINT));
      if (comfortSetpoint) {
        const temp = OZW772Client.parseNumericValue(comfortSetpoint);
        if (temp !== null) {
          await this.setCapabilityValue('setpoint_comfort', temp).catch(this.error);
        }
      }

      const precomfortSetpoint = results.get(this.getDatapointId(DATAPOINT_OFFSETS.PRECOMFORT_SETPOINT));
      if (precomfortSetpoint) {
        const temp = OZW772Client.parseNumericValue(precomfortSetpoint);
        if (temp !== null) {
          await this.setCapabilityValue('setpoint_precomfort', temp).catch(this.error);
        }
      }

      const economySetpoint = results.get(this.getDatapointId(DATAPOINT_OFFSETS.ECONOMY_SETPOINT));
      if (economySetpoint) {
        const temp = OZW772Client.parseNumericValue(economySetpoint);
        if (temp !== null) {
          await this.setCapabilityValue('setpoint_economy', temp).catch(this.error);
        }
      }

      const protectionSetpoint = results.get(this.getDatapointId(DATAPOINT_OFFSETS.PROTECTION_SETPOINT));
      if (protectionSetpoint) {
        const temp = OZW772Client.parseNumericValue(protectionSetpoint);
        if (temp !== null) {
          await this.setCapabilityValue('setpoint_protection', temp).catch(this.error);
        }
      }

      await this.handlePollSuccess();
    } catch (error) {
      this.error('Poll error:', error);
      await this.handlePollFailure(error);
    }
  }

  /**
   * Handle successful poll - manage availability recovery
   */
  private async handlePollSuccess(): Promise<void> {
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
  private async handlePollFailure(error: unknown): Promise<void> {
    this.consecutiveSuccesses = 0;
    this.consecutiveFailures++;

    const errorMessage = this.getErrorMessage(error);
    this._lastError = errorMessage;

    if (this.consecutiveFailures === 1) {
      this.log(`Poll failed (attempt ${this.consecutiveFailures}/${FAILURE_THRESHOLD}): ${errorMessage}`);
    } else if (this.consecutiveFailures <= FAILURE_THRESHOLD) {
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
  private getErrorMessage(error: unknown): string {
    if (error instanceof OZW772Error) {
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
  private getUserFriendlyError(error: unknown): string {
    if (error instanceof OZW772Error) {
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
   * Handle target temperature capability changes with debouncing
   * Uses setpoint_type setting to determine which setpoint to control
   * @param value - New target temperature value
   */
  async onCapabilityTargetTemperature(value: number): Promise<void> {
    const settings = this.getSettings() as RoomSettings;
    const setpointType = settings.setpoint_type || 'comfort';
    await this.onCapabilitySetpoint(setpointType, value);
  }

  /**
   * Handle individual setpoint capability changes with debouncing
   * @param setpointType - Type of setpoint (comfort, precomfort, economy)
   * @param value - New temperature value
   */
  async onCapabilitySetpoint(setpointType: string, value: number): Promise<void> {
    const roundedValue = Math.round(value * 10) / 10;

    this.log(`Setpoint ${setpointType} change requested: ${roundedValue}°C (debouncing...)`);

    // Store the pending value
    this.pendingSetpoints.set(setpointType, roundedValue);

    // Clear existing timer for this setpoint type
    const existingTimer = this.setpointDebounceTimers.get(setpointType);
    if (existingTimer) {
      this.homey.clearTimeout(existingTimer);
    }

    // Set new timer - will fire after user stops changing
    const timer = this.homey.setTimeout(async () => {
      await this.sendPendingSetpoint(setpointType);
    }, TEMPERATURE_DEBOUNCE_MS);

    this.setpointDebounceTimers.set(setpointType, timer);
  }

  /**
   * Send the pending setpoint to the gateway
   * @param setpointType - Type of setpoint to send
   */
  private async sendPendingSetpoint(setpointType: string): Promise<void> {
    const value = this.pendingSetpoints.get(setpointType);
    if (value === undefined) return;

    this.pendingSetpoints.delete(setpointType);
    this.setpointDebounceTimers.delete(setpointType);

    if (!this.client) {
      this.error('Cannot send temperature: not connected to gateway');
      return;
    }

    const setpointTypeToOffset: Record<string, number> = {
      comfort: DATAPOINT_OFFSETS.COMFORT_SETPOINT,
      precomfort: DATAPOINT_OFFSETS.PRECOMFORT_SETPOINT,
      economy: DATAPOINT_OFFSETS.ECONOMY_SETPOINT,
      protection: DATAPOINT_OFFSETS.PROTECTION_SETPOINT,
    };

    const offset = setpointTypeToOffset[setpointType] || DATAPOINT_OFFSETS.COMFORT_SETPOINT;
    const setpointId = this.getDatapointId(offset);

    this.log(`Sending ${setpointType} setpoint ${value}°C to gateway (datapoint: ${setpointId})`);

    try {
      const success = await this.client.writeNumeric(setpointId, value);

      if (!success) {
        this.error(`Gateway rejected ${setpointType} setpoint write`);
        return;
      }

      this.log(`${setpointType} setpoint updated successfully to ${value}°C`);
    } catch (error) {
      this.error(`Failed to send ${setpointType} setpoint to gateway:`, error);
    }
  }

  /**
   * Handle thermostat mode capability changes
   * @param value - New thermostat mode value
   * @throws {Error} When not connected or write fails
   */
  async onCapabilityThermostatMode(value: string): Promise<void> {
    if (!this.client) {
      throw new Error('Not connected to gateway');
    }

    this.log(`Setting thermostat mode to ${value}`);

    const modePreselectionId = this.getDatapointId(DATAPOINT_OFFSETS.MODE_PRESELECTION);
    const enumValue = this.mapModeToEnum(value);
    const displayValue = this.getModeDisplayValue(value);

    try {
      const success = await this.client.writeEnumeration(
        modePreselectionId,
        displayValue,
        enumValue
      );

      if (!success) {
        throw new Error('Failed to write thermostat mode');
      }

      this.log('Thermostat mode updated successfully');
    } catch (error) {
      this.error('Failed to set thermostat mode:', error);
      throw error;
    }
  }

  /**
   * Update the target_temperature capability options based on setpoint type
   * @param setpointType - The setpoint type (comfort, precomfort, economy)
   */
  private async updateTemperatureRange(setpointType: string): Promise<void> {
    if (!this.client) return;

    const setpointTypeToOffset: Record<string, number> = {
      comfort: DATAPOINT_OFFSETS.COMFORT_SETPOINT,
      precomfort: DATAPOINT_OFFSETS.PRECOMFORT_SETPOINT,
      economy: DATAPOINT_OFFSETS.ECONOMY_SETPOINT,
      protection: DATAPOINT_OFFSETS.PROTECTION_SETPOINT,
    };

    const offset = setpointTypeToOffset[setpointType] || DATAPOINT_OFFSETS.COMFORT_SETPOINT;
    const setpointId = this.getDatapointId(offset);

    try {
      const desc = await this.client.getDatapointDesc(setpointId) as {
        Description?: { Min?: string; Max?: string };
      };

      if (desc.Description?.Min && desc.Description?.Max) {
        const min = parseFloat(desc.Description.Min);
        const max = parseFloat(desc.Description.Max);

        this.log(`Updating target_temperature range for ${setpointType}: min=${min}, max=${max}`);

        await this.setCapabilityOptions('target_temperature', {
          min,
          max,
          step: 0.5,
        });
      }
    } catch (error) {
      this.error('Failed to update temperature range:', error);
    }
  }

  /**
   * Handle settings changes
   * @param options - Settings change options containing old/new settings and changed keys
   */
  async onSettings({
    newSettings,
    changedKeys,
  }: {
    oldSettings: { [key: string]: boolean | string | number | undefined | null };
    newSettings: { [key: string]: boolean | string | number | undefined | null };
    changedKeys: string[];
  }): Promise<string | void> {
    this.log('Settings changed:', changedKeys);

    if (changedKeys.includes('poll_interval')) {
      this.log(`Polling interval changed to ${newSettings.poll_interval} seconds`);
      this.startPolling();
    }

    if (changedKeys.includes('setpoint_type')) {
      const setpointType = newSettings.setpoint_type as string;
      this.log(`Setpoint type changed to ${setpointType}`);
      await this.updateTemperatureRange(setpointType);
    }
  }

  /**
   * Clean up when device is deleted
   */
  async onDeleted(): Promise<void> {
    if (this.pollInterval) {
      this.homey.clearInterval(this.pollInterval);
      this.pollInterval = null;
    }

    // Clear all pending setpoint timers
    for (const timer of this.setpointDebounceTimers.values()) {
      this.homey.clearTimeout(timer);
    }
    this.setpointDebounceTimers.clear();
    this.pendingSetpoints.clear();

    this.client = null;
    this.log('Room device deleted:', this.getName());
  }

  /**
   * Get the last error message (useful for debugging)
   * @returns The last error message or null if no error occurred
   */
  getLastError(): string | null {
    return this._lastError;
  }
}

module.exports = RoomDevice;
