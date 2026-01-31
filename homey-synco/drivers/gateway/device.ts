/**
 * Gateway Device Driver for Siemens Synco Living
 *
 * @description Handles communication with the OZW772/OZW672 gateway for global
 * datapoints like outside temperature, air pressure, and ventilation control.
 */

import Homey from 'homey';
import { OZW772Client, OZW772Error } from '../../lib/OZW772Client';
import {
  DEFAULTS,
  GATEWAY_DATAPOINTS,
  VENTILATION_MODE_MAP,
  VENTILATION_STAGE_MAP,
} from '../../lib/constants';

/** Gateway device store structure */
interface GatewayStore {
  host: string;
  username: string;
  password: string;
  useHttps?: boolean;
}

/** Gateway device settings structure */
interface GatewaySettings {
  poll_interval: number;
}

/** Number of consecutive failures before marking device unavailable */
const FAILURE_THRESHOLD = 3;

/** Number of consecutive successes before marking device available again */
const RECOVERY_THRESHOLD = 2;

/**
 * Gateway Device class for Synco Living global datapoints
 */
class GatewayDevice extends Homey.Device {
  private client: OZW772Client | null = null;
  private pollInterval: NodeJS.Timeout | null = null;

  /** Counter for consecutive poll failures */
  private consecutiveFailures: number = 0;

  /** Counter for consecutive poll successes (used for recovery) */
  private consecutiveSuccesses: number = 0;

  /** Last error message for debugging */
  private _lastError: string | null = null;

  /**
   * Initialize the device
   */
  async onInit(): Promise<void> {
    this.log('Gateway device initialized:', this.getName());

    const store = this.getStore() as GatewayStore;

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

    // Ensure all capabilities exist
    await this.ensureCapabilities();

    // Note: ventilation_mode is read-only - write format not yet determined for OZW772 API

    // Stagger initial poll to prevent gateway overload when multiple devices start
    const staggerDelay = Math.random() * DEFAULTS.POLL_STAGGER_MAX_MS;
    this.log(`Staggering initial poll by ${Math.round(staggerDelay / 1000)} seconds`);

    this.homey.setTimeout(async () => {
      await this.pollData();
      this.startPolling();
      this.log('Gateway device polling started');
    }, staggerDelay);
  }

  /**
   * Ensure all required capabilities exist on the device
   */
  private async ensureCapabilities(): Promise<void> {
    const requiredCapabilities = [
      'measure_temperature_outside',
      'measure_pressure',
      'ventilation_stage',
      'ventilation_mode',
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
   * Start the polling interval for data updates
   */
  private startPolling(): void {
    const settings = this.getSettings() as GatewaySettings;
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

  /**
   * Poll data from the gateway and update device capabilities
   */
  async pollData(): Promise<void> {
    if (!this.client) {
      this.error('Cannot poll: client not initialized');
      return;
    }

    this.log('Polling gateway data');

    try {
      await this.client.ensureSession();

      const datapointIds = [
        GATEWAY_DATAPOINTS.OUTSIDE_TEMPERATURE,
        GATEWAY_DATAPOINTS.AIR_PRESSURE,
        GATEWAY_DATAPOINTS.VENTILATION_MODE,
        GATEWAY_DATAPOINTS.VENTILATION_STAGE,
      ];

      this.log('Reading datapoints:', datapointIds);

      const results = await this.client.readDatapoints(
        datapointIds,
        (id, err) => this.log(`Warning: Failed to read datapoint ${id}: ${err.message}`)
      );

      this.log('Datapoint results:', JSON.stringify(Array.from(results.entries())));

      // Outside temperature
      const outsideTemp = results.get(GATEWAY_DATAPOINTS.OUTSIDE_TEMPERATURE);
      if (outsideTemp) {
        const temp = OZW772Client.parseNumericValue(outsideTemp);
        if (temp !== null) {
          await this.setCapabilityValue('measure_temperature_outside', temp).catch(this.error);
        }
      }

      // Air pressure
      const airPressure = results.get(GATEWAY_DATAPOINTS.AIR_PRESSURE);
      if (airPressure) {
        const pressure = OZW772Client.parseNumericValue(airPressure);
        if (pressure !== null) {
          await this.setCapabilityValue('measure_pressure', pressure).catch(this.error);
        }
      }

      // Ventilation mode (settable)
      const ventMode = results.get(GATEWAY_DATAPOINTS.VENTILATION_MODE);
      if (ventMode) {
        const modeValue = VENTILATION_MODE_MAP.ENUM_TO_MODE[ventMode.EnumValue || '0'] || 'auto';
        await this.setCapabilityValue('ventilation_mode', modeValue).catch(this.error);
      }

      // Ventilation stage (read-only)
      const ventStage = results.get(GATEWAY_DATAPOINTS.VENTILATION_STAGE);
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
        case 'HTTPS_REQUIRED':
          return 'Gateway requires HTTPS - re-pair device';
        default:
          return 'Connection error';
      }
    }
    return 'Connection error';
  }

  /**
   * Handle ventilation mode capability changes
   */
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
        GATEWAY_DATAPOINTS.VENTILATION_MODE,
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

  /**
   * Handle settings changes
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
  }

  /**
   * Clean up when device is deleted
   */
  async onDeleted(): Promise<void> {
    if (this.pollInterval) {
      this.homey.clearInterval(this.pollInterval);
      this.pollInterval = null;
    }

    this.client = null;
    this.log('Gateway device deleted:', this.getName());
  }

  /**
   * Get the last error message (useful for debugging)
   */
  getLastError(): string | null {
    return this._lastError;
  }
}

module.exports = GatewayDevice;
