import Homey from 'homey';
import { OZW772Client } from '../../lib/OZW772Client';
import { DATAPOINT_OFFSETS, DEFAULTS } from '../../lib/constants';

interface RoomStore {
  host: string;
  username: string;
  password: string;
  roomMenuId: string;
  stateMenuId: string;
  setpointsMenuId: string;
  modeMenuId: string;
}

class RoomDevice extends Homey.Device {
  private client: OZW772Client | null = null;
  private pollInterval: NodeJS.Timeout | null = null;
  private roomBaseId: number = 0;

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

    await this.pollData();

    this.pollInterval = this.homey.setInterval(
      () => this.pollData(),
      DEFAULTS.POLLING_INTERVAL_MS
    );

    this.log('Room device polling started');
  }

  private getDatapointId(offset: number): string {
    return (this.roomBaseId + offset).toString();
  }

  async pollData(): Promise<void> {
    if (!this.client) {
      return;
    }

    try {
      const datapointIds = [
        this.getDatapointId(DATAPOINT_OFFSETS.ACTUAL_TEMP),
        this.getDatapointId(DATAPOINT_OFFSETS.CURRENT_SETPOINT),
        this.getDatapointId(DATAPOINT_OFFSETS.VALVE_POSITION),
      ];

      const results = await this.client.readDatapoints(datapointIds);

      const actualTemp = results.get(this.getDatapointId(DATAPOINT_OFFSETS.ACTUAL_TEMP));
      if (actualTemp) {
        const temp = OZW772Client.parseNumericValue(actualTemp);
        if (temp !== null) {
          await this.setCapabilityValue('measure_temperature', temp).catch(this.error);
        }
      }

      const setpoint = results.get(this.getDatapointId(DATAPOINT_OFFSETS.CURRENT_SETPOINT));
      if (setpoint) {
        const temp = OZW772Client.parseNumericValue(setpoint);
        if (temp !== null) {
          await this.setCapabilityValue('target_temperature', temp).catch(this.error);
        }
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

    const comfortSetpointId = this.getDatapointId(DATAPOINT_OFFSETS.COMFORT_SETPOINT);

    try {
      const success = await this.client.writeNumeric(comfortSetpointId, value);

      if (!success) {
        throw new Error('Failed to write temperature setpoint');
      }

      this.log('Temperature setpoint updated successfully');
    } catch (error) {
      this.error('Failed to set target temperature:', error);
      throw error;
    }
  }

  async onSettings({
    changedKeys,
  }: {
    oldSettings: { [key: string]: boolean | string | number | undefined | null };
    newSettings: { [key: string]: boolean | string | number | undefined | null };
    changedKeys: string[];
  }): Promise<string | void> {
    this.log('Settings changed:', changedKeys);
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
