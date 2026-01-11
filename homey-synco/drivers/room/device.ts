import Homey from 'homey';
import { OZW772Client } from '../../lib/OZW772Client';
import { DATAPOINT_OFFSETS } from '../../lib/constants';

interface RoomStore {
  host: string;
  username: string;
  password: string;
  roomMenuId: string;
  stateMenuId: string;
  setpointsMenuId: string;
  modeMenuId: string;
}

interface RoomSettings {
  poll_interval: number;
  setpoint_type: 'comfort' | 'precomfort' | 'economy';
}

type ThermostatMode = 'auto' | 'comfort' | 'precomfort' | 'economy' | 'protection';

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

const SETPOINT_OFFSETS: Record<string, number> = {
  comfort: DATAPOINT_OFFSETS.COMFORT_SETPOINT,
  precomfort: DATAPOINT_OFFSETS.PRECOMFORT_SETPOINT,
  economy: DATAPOINT_OFFSETS.ECONOMY_SETPOINT,
};

class RoomDevice extends Homey.Device {
  private client: OZW772Client | null = null;
  private pollInterval: NodeJS.Timeout | null = null;
  private roomBaseId: number = 0;

  private previousTemperature: number | null = null;
  private previousMode: string | null = null;
  private previousValvePosition: number | null = null;

  private temperatureChangedTrigger!: Homey.FlowCardTriggerDevice;
  private modeChangedTrigger!: Homey.FlowCardTriggerDevice;
  private valveOpenedTrigger!: Homey.FlowCardTriggerDevice;

  async onInit(): Promise<void> {
    this.log('Room device initialized:', this.getName());

    const store = this.getStore() as RoomStore;

    if (!store.host || !store.username || !store.password) {
      this.error('Missing credentials in device store');
      this.setUnavailable('Missing gateway credentials').catch(this.error);
      return;
    }

    this.client = new OZW772Client({
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

  private getDatapointId(offset: number): string {
    return (this.roomBaseId + offset).toString();
  }

  private mapEnumToMode(enumValue: string | undefined): ThermostatMode {
    if (!enumValue) return 'auto';
    return ENUM_TO_MODE[enumValue] || 'auto';
  }

  private mapModeToEnum(mode: string): string {
    return MODE_TO_ENUM[mode as ThermostatMode] || '0';
  }

  private getModeDisplayValue(mode: string): string {
    return MODE_DISPLAY_VALUES[mode as ThermostatMode] || 'Automatik';
  }

  async pollData(): Promise<void> {
    if (!this.client) {
      return;
    }

    try {
      await this.client.ensureSession();

      const datapointIds = [
        this.getDatapointId(DATAPOINT_OFFSETS.ACTUAL_TEMP),
        this.getDatapointId(DATAPOINT_OFFSETS.CURRENT_SETPOINT),
        this.getDatapointId(DATAPOINT_OFFSETS.VALVE_POSITION),
        this.getDatapointId(DATAPOINT_OFFSETS.MODE_STATE),
      ];

      const results = await this.client.readDatapoints(datapointIds);

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

      await this.setAvailable();
    } catch (error) {
      this.error('Failed to poll data:', error);
      await this.setUnavailable('Connection error').catch(this.error);
    }
  }

  async onCapabilityTargetTemperature(value: number): Promise<void> {
    if (!this.client) {
      throw new Error('Not connected to gateway');
    }

    this.log(`Setting target temperature to ${value}`);

    const settings = this.getSettings() as RoomSettings;
    const setpointType = settings.setpoint_type || 'comfort';
    const offset = SETPOINT_OFFSETS[setpointType] || DATAPOINT_OFFSETS.COMFORT_SETPOINT;
    const setpointId = this.getDatapointId(offset);

    try {
      const success = await this.client.writeNumeric(setpointId, value);

      if (!success) {
        throw new Error('Failed to write temperature setpoint');
      }

      this.log(`Temperature setpoint (${setpointType}) updated successfully`);
    } catch (error) {
      this.error('Failed to set target temperature:', error);
      throw error;
    }
  }

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
  }

  async onDeleted(): Promise<void> {
    if (this.pollInterval) {
      this.homey.clearInterval(this.pollInterval);
      this.pollInterval = null;
    }

    this.client = null;
    this.log('Room device deleted:', this.getName());
  }
}

module.exports = RoomDevice;
