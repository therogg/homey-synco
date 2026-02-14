import Homey from 'homey';
import { OZW772Client, OZW772Error } from '../../lib/OZW772Client';
import {
  DATAPOINT_OFFSETS,
  DEFAULTS,
  GATEWAY_DATAPOINTS,
  VENTILATION_MODE_MAP,
  VENTILATION_STAGE_MAP,
} from '../../lib/constants';
import { RoomDatapointMap, GatewayDatapointMap } from '../../lib/types';

interface DeviceStore {
  host: string;
  username: string;
  password: string;
  useHttps?: boolean;
  deviceType?: 'gateway' | 'room';
  roomMenuId?: string;
  stateMenuId?: string;
  setpointsMenuId?: string;
  modeMenuId?: string;
  discoveredDatapoints?: RoomDatapointMap | GatewayDatapointMap;
}

interface DeviceSettings {
  poll_interval: number;
  setpoint_type: 'comfort' | 'precomfort' | 'economy';
}

type ThermostatMode = 'auto' | 'comfort' | 'precomfort' | 'economy' | 'protection';

const FAILURE_THRESHOLD = 3;
const RECOVERY_THRESHOLD = 2;
const TEMPERATURE_DEBOUNCE_MS = 2000;

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

class GatewayDevice extends Homey.Device {
  private client: OZW772Client | null = null;
  private pollInterval: NodeJS.Timeout | null = null;
  private consecutiveFailures: number = 0;
  private consecutiveSuccesses: number = 0;
  private _lastError: string | null = null;

  // Room-specific properties
  private roomBaseId: number = 0;
  private previousValvePosition: number | null = null;
  private pendingSetpoints: Map<string, number> = new Map();
  private setpointDebounceTimers: Map<string, NodeJS.Timeout> = new Map();
  private valveOpenedTrigger!: Homey.FlowCardTriggerDevice;

  // Resolved datapoint IDs (discovered or fallback)
  private gwIds: Record<string, string> = {};
  private roomIds: Record<string, string> = {};

  private get isRoom(): boolean {
    const store = this.getStore() as DeviceStore;
    return store.deviceType === 'room';
  }

  async onInit(): Promise<void> {
    const store = this.getStore() as DeviceStore;
    this.log(`Device initialized: ${this.getName()} (type: ${store.deviceType || 'gateway'})`);

    if (!store.host || !store.username || !store.password) {
      this.error('Missing credentials in device store');
      await this.setUnavailable('Missing gateway credentials').catch(this.error);
      return;
    }

    this.client = new OZW772Client({
      host: store.host,
      username: store.username,
      password: store.password,
      useHttps: store.useHttps,
    });

    if (store.deviceType === 'room') {
      await this.initAsRoom(store);
    } else {
      await this.initAsGateway(store);
    }

    const staggerDelay = Math.random() * DEFAULTS.POLL_STAGGER_MAX_MS;
    this.log(`Staggering initial poll by ${Math.round(staggerDelay / 1000)} seconds`);

    this.homey.setTimeout(async () => {
      await this.pollData();
      this.startPolling();
      this.log('Polling started');
    }, staggerDelay);
  }

  // ---- ID resolution ----

  private resolveGatewayIds(store: DeviceStore): void {
    const dp = (store.discoveredDatapoints || {}) as GatewayDatapointMap;
    this.gwIds = {
      outsideTemperature: dp.outsideTemperature || GATEWAY_DATAPOINTS.OUTSIDE_TEMPERATURE,
      airPressure: dp.airPressure || GATEWAY_DATAPOINTS.AIR_PRESSURE,
      ventilationMode: dp.ventilationMode || GATEWAY_DATAPOINTS.VENTILATION_MODE,
      ventilationStage: dp.ventilationStage || GATEWAY_DATAPOINTS.VENTILATION_STAGE,
    };
    this.log('Resolved gateway IDs:', JSON.stringify(this.gwIds));
  }

  private resolveRoomIds(store: DeviceStore): void {
    const dp = (store.discoveredDatapoints || {}) as RoomDatapointMap;
    const fallback = (offset: number) => (this.roomBaseId + offset).toString();

    this.roomIds = {
      actualTemp: dp.actualTemp || fallback(DATAPOINT_OFFSETS.ACTUAL_TEMP),
      currentSetpoint: dp.currentSetpoint || fallback(DATAPOINT_OFFSETS.CURRENT_SETPOINT),
      valvePosition: dp.valvePosition || fallback(DATAPOINT_OFFSETS.VALVE_POSITION),
      modeState: dp.modeState || fallback(DATAPOINT_OFFSETS.MODE_STATE),
      modePreselection: dp.modePreselection || fallback(DATAPOINT_OFFSETS.MODE_PRESELECTION),
      absenceMode: dp.absenceMode || fallback(DATAPOINT_OFFSETS.ABSENCE_MODE),
      comfortSetpoint: dp.comfortSetpoint || fallback(DATAPOINT_OFFSETS.COMFORT_SETPOINT),
      precomfortSetpoint: dp.precomfortSetpoint || fallback(DATAPOINT_OFFSETS.PRECOMFORT_SETPOINT),
      economySetpoint: dp.economySetpoint || fallback(DATAPOINT_OFFSETS.ECONOMY_SETPOINT),
      protectionSetpoint: dp.protectionSetpoint || fallback(DATAPOINT_OFFSETS.PROTECTION_SETPOINT),
    };
    this.log('Resolved room IDs:', JSON.stringify(this.roomIds));
  }

  // ---- Gateway initialization ----

  private async initAsGateway(store: DeviceStore): Promise<void> {
    this.resolveGatewayIds(store);

    const requiredCapabilities = [
      'measure_temperature_outside',
      'measure_pressure',
      'ventilation_stage',
      'ventilation_mode',
    ];

    for (const cap of requiredCapabilities) {
      if (!this.hasCapability(cap)) {
        await this.addCapability(cap).catch((err) => {
          this.error(`Failed to add capability ${cap}:`, err);
        });
      }
    }
  }

  // ---- Room initialization ----

  private async initAsRoom(store: DeviceStore): Promise<void> {
    this.roomBaseId = parseInt(store.roomMenuId || '0', 10);
    this.resolveRoomIds(store);

    await this.setClass('heater').catch((err) => {
      this.error('Failed to set device class:', err);
    });

    const gatewayOnlyCaps = [
      'measure_temperature_outside',
      'measure_pressure',
      'ventilation_stage',
      'ventilation_mode',
    ];
    for (const cap of gatewayOnlyCaps) {
      if (this.hasCapability(cap)) {
        await this.removeCapability(cap).catch((err) => {
          this.error(`Failed to remove capability ${cap}:`, err);
        });
      }
    }

    const roomCapabilities = [
      'measure_temperature',
      'target_temperature',
      'valve_position',
      'thermostat_mode',
      'setpoint_comfort',
      'setpoint_precomfort',
      'setpoint_economy',
      'setpoint_protection',
    ];
    for (const cap of roomCapabilities) {
      if (!this.hasCapability(cap)) {
        await this.addCapability(cap).catch((err) => {
          this.error(`Failed to add capability ${cap}:`, err);
        });
      }
    }

    this.registerCapabilityListener('target_temperature', this.onCapabilityTargetTemperature.bind(this));
    this.registerCapabilityListener('thermostat_mode', this.onCapabilityThermostatMode.bind(this));
    this.registerCapabilityListener('setpoint_comfort', (value: number) =>
      this.onCapabilitySetpoint('comfort', value));
    this.registerCapabilityListener('setpoint_precomfort', (value: number) =>
      this.onCapabilitySetpoint('precomfort', value));
    this.registerCapabilityListener('setpoint_economy', (value: number) =>
      this.onCapabilitySetpoint('economy', value));
    this.registerCapabilityListener('setpoint_protection', (value: number) =>
      this.onCapabilitySetpoint('protection', value));

    this.registerFlowCards();
  }

  // ---- Polling ----

  private startPolling(): void {
    const settings = this.getSettings() as DeviceSettings;
    const intervalMs = (settings.poll_interval || (DEFAULTS.POLLING_INTERVAL_MS / 1000)) * 1000;

    if (this.pollInterval) {
      this.homey.clearInterval(this.pollInterval);
    }

    this.pollInterval = this.homey.setInterval(
      () => this.pollData(),
      intervalMs
    );

    this.log(`Polling interval set to ${intervalMs / 1000} seconds`);
  }

  async pollData(): Promise<void> {
    if (this.isRoom) {
      await this.pollRoomData();
    } else {
      await this.pollGatewayData();
    }
  }

  // ---- Gateway polling ----

  private async pollGatewayData(): Promise<void> {
    if (!this.client) {
      this.error('Cannot poll: client not initialized');
      return;
    }

    this.log('Polling gateway data');

    try {
      await this.client.ensureSession();

      const datapointIds = [
        this.gwIds.outsideTemperature,
        this.gwIds.airPressure,
        this.gwIds.ventilationMode,
        this.gwIds.ventilationStage,
      ];

      this.log('Reading datapoints:', datapointIds);

      const results = await this.client.readDatapoints(
        datapointIds,
        (id, err) => this.log(`Warning: Failed to read datapoint ${id}: ${err.message}`)
      );

      this.log('Datapoint results:', JSON.stringify(Array.from(results.entries())));

      const outsideTemp = results.get(this.gwIds.outsideTemperature);
      if (outsideTemp) {
        const temp = OZW772Client.parseNumericValue(outsideTemp);
        if (temp !== null) {
          await this.setCapabilityValue('measure_temperature_outside', temp).catch(this.error);
        }
      }

      const airPressure = results.get(this.gwIds.airPressure);
      if (airPressure) {
        const pressure = OZW772Client.parseNumericValue(airPressure);
        if (pressure !== null) {
          await this.setCapabilityValue('measure_pressure', pressure).catch(this.error);
        }
      }

      const ventMode = results.get(this.gwIds.ventilationMode);
      if (ventMode) {
        const modeValue = VENTILATION_MODE_MAP.ENUM_TO_MODE[ventMode.EnumValue || '0'] || 'auto';
        await this.setCapabilityValue('ventilation_mode', modeValue).catch(this.error);
      }

      const ventStage = results.get(this.gwIds.ventilationStage);
      if (ventStage) {
        const stageValue = VENTILATION_STAGE_MAP.ENUM_TO_STAGE[ventStage.EnumValue || '0'] || 'off';
        await this.setCapabilityValue('ventilation_stage', stageValue).catch(this.error);
      }

      await this.handlePollSuccess();
    } catch (error) {
      this.error('Poll error:', error);
      await this.handlePollFailure(error);
    }
  }

  // ---- Room polling ----

  private async pollRoomData(): Promise<void> {
    if (!this.client) {
      this.error('Cannot poll: client not initialized');
      return;
    }

    this.log('Polling data for room:', this.getName(), 'baseId:', this.roomBaseId);

    try {
      await this.client.ensureSession();

      const datapointIds = [
        this.roomIds.actualTemp,
        this.roomIds.currentSetpoint,
        this.roomIds.valvePosition,
        this.roomIds.modeState,
        this.roomIds.comfortSetpoint,
        this.roomIds.precomfortSetpoint,
        this.roomIds.economySetpoint,
        this.roomIds.protectionSetpoint,
      ];

      this.log('Reading datapoints:', datapointIds);

      const results = await this.client.readDatapoints(
        datapointIds,
        (id, err) => this.log(`Warning: Failed to read datapoint ${id}: ${err.message}`)
      );

      this.log('Datapoint results:', JSON.stringify(Array.from(results.entries())));

      const actualTemp = results.get(this.roomIds.actualTemp);
      if (actualTemp) {
        const temp = OZW772Client.parseNumericValue(actualTemp);
        if (temp !== null) {
          await this.setCapabilityValue('measure_temperature', temp).catch(this.error);
        }
      }

      const setpoint = results.get(this.roomIds.currentSetpoint);
      if (setpoint) {
        const temp = OZW772Client.parseNumericValue(setpoint);
        if (temp !== null) {
          await this.setCapabilityValue('target_temperature', temp).catch(this.error);
        }
      }

      const valve = results.get(this.roomIds.valvePosition);
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

      const mode = results.get(this.roomIds.modeState);
      if (mode) {
        const modeValue = ENUM_TO_MODE[mode.EnumValue || '0'] || 'auto';
        await this.setCapabilityValue('thermostat_mode', modeValue).catch(this.error);
      }

      const comfortSetpoint = results.get(this.roomIds.comfortSetpoint);
      if (comfortSetpoint) {
        const temp = OZW772Client.parseNumericValue(comfortSetpoint);
        if (temp !== null) {
          await this.setCapabilityValue('setpoint_comfort', temp).catch(this.error);
        }
      }

      const precomfortSetpoint = results.get(this.roomIds.precomfortSetpoint);
      if (precomfortSetpoint) {
        const temp = OZW772Client.parseNumericValue(precomfortSetpoint);
        if (temp !== null) {
          await this.setCapabilityValue('setpoint_precomfort', temp).catch(this.error);
        }
      }

      const economySetpoint = results.get(this.roomIds.economySetpoint);
      if (economySetpoint) {
        const temp = OZW772Client.parseNumericValue(economySetpoint);
        if (temp !== null) {
          await this.setCapabilityValue('setpoint_economy', temp).catch(this.error);
        }
      }

      const protectionSetpoint = results.get(this.roomIds.protectionSetpoint);
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

  // ---- Poll success/failure handling ----

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

  private getErrorMessage(error: unknown): string {
    if (error instanceof OZW772Error) {
      return `[${error.code}] ${error.message}`;
    }
    if (error instanceof Error) {
      return error.message;
    }
    return 'Unknown error';
  }

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
        case 'HTTPS_REQUIRED':
          return 'Gateway requires HTTPS - re-pair device';
        default:
          return 'Connection error';
      }
    }
    return 'Connection error';
  }

  // ---- Gateway capability handlers ----

  async onCapabilityVentilationMode(value: string): Promise<void> {
    if (!this.client) {
      throw new Error('Not connected to gateway');
    }

    this.log(`Setting ventilation mode to ${value}`);

    const enumValue = VENTILATION_MODE_MAP.MODE_TO_ENUM[value];
    const displayValue = VENTILATION_MODE_MAP.MODE_TO_DISPLAY[value];

    if (!enumValue || !displayValue) {
      this.error(`Invalid ventilation mode: ${value}`);
      throw new Error(`Invalid ventilation mode: ${value}`);
    }

    try {
      const success = await this.client.writeEnumeration(
        this.gwIds.ventilationMode,
        displayValue,
        enumValue
      );

      if (!success) {
        throw new Error('Failed to write ventilation mode');
      }

      this.log('Ventilation mode updated successfully');
    } catch (error) {
      this.error('Failed to set ventilation mode:', error);
      throw error;
    }
  }

  // ---- Room capability handlers ----

  async onCapabilityTargetTemperature(value: number): Promise<void> {
    const settings = this.getSettings() as DeviceSettings;
    const setpointType = settings.setpoint_type || 'comfort';
    await this.onCapabilitySetpoint(setpointType, value);
  }

  async onCapabilitySetpoint(setpointType: string, value: number): Promise<void> {
    const roundedValue = Math.round(value * 10) / 10;

    this.log(`Setpoint ${setpointType} change requested: ${roundedValue}°C (debouncing...)`);

    this.pendingSetpoints.set(setpointType, roundedValue);

    const existingTimer = this.setpointDebounceTimers.get(setpointType);
    if (existingTimer) {
      this.homey.clearTimeout(existingTimer);
    }

    const timer = this.homey.setTimeout(async () => {
      await this.sendPendingSetpoint(setpointType);
    }, TEMPERATURE_DEBOUNCE_MS);

    this.setpointDebounceTimers.set(setpointType, timer);
  }

  private async sendPendingSetpoint(setpointType: string): Promise<void> {
    const value = this.pendingSetpoints.get(setpointType);
    if (value === undefined) return;

    this.pendingSetpoints.delete(setpointType);
    this.setpointDebounceTimers.delete(setpointType);

    if (!this.client) {
      this.error('Cannot send temperature: not connected to gateway');
      return;
    }

    const setpointTypeToKey: Record<string, string> = {
      comfort: 'comfortSetpoint',
      precomfort: 'precomfortSetpoint',
      economy: 'economySetpoint',
      protection: 'protectionSetpoint',
    };

    const key = setpointTypeToKey[setpointType] || 'comfortSetpoint';
    const setpointId = this.roomIds[key];

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

  async onCapabilityThermostatMode(value: string): Promise<void> {
    if (!this.client) {
      throw new Error('Not connected to gateway');
    }

    this.log(`Setting thermostat mode to ${value}`);

    const enumValue = MODE_TO_ENUM[value as ThermostatMode] || '0';
    const displayValue = MODE_DISPLAY_VALUES[value as ThermostatMode] || 'Automatik';

    try {
      const success = await this.client.writeEnumeration(
        this.roomIds.modePreselection,
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

  async setAbsenceMode(enable: boolean): Promise<void> {
    if (!this.client) {
      throw new Error('Not connected to gateway');
    }

    this.log(`Setting absence mode to ${enable ? 'enabled' : 'disabled'}`);

    const enumValue = enable ? '1' : '0';
    const displayValue = enable ? 'Aktiv' : 'Inaktiv';

    try {
      const success = await this.client.writeEnumeration(
        this.roomIds.absenceMode,
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

  // ---- Room flow cards ----

  private registerFlowCards(): void {
    this.valveOpenedTrigger = this.homey.flow.getDeviceTriggerCard('valve_opened');

    this.valveOpenedTrigger.registerRunListener(async (args, state) => {
      return state.valve_position > args.threshold;
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

    this.homey.flow.getActionCard('set_absence')
      .registerRunListener(async (args) => {
        await args.device.setAbsenceMode(args.action === 'enable');
      });

    this.log('Flow cards registered');
  }

  // ---- Settings ----

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

    if (changedKeys.includes('setpoint_type') && this.isRoom) {
      this.log(`Setpoint type changed to ${newSettings.setpoint_type}`);
    }
  }

  // ---- Cleanup ----

  async onDeleted(): Promise<void> {
    if (this.pollInterval) {
      this.homey.clearInterval(this.pollInterval);
      this.pollInterval = null;
    }

    for (const timer of this.setpointDebounceTimers.values()) {
      this.homey.clearTimeout(timer);
    }
    this.setpointDebounceTimers.clear();
    this.pendingSetpoints.clear();

    this.client = null;
    this.log('Device deleted:', this.getName());
  }

  getLastError(): string | null {
    return this._lastError;
  }
}

module.exports = GatewayDevice;
