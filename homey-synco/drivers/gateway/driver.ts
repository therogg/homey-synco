/**
 * Gateway Driver for Siemens Synco Living
 *
 * @description Handles device pairing for the OZW772/OZW672 gateway.
 * The gateway provides global datapoints like outside temperature,
 * air pressure, and ventilation control.
 */

import Homey from 'homey';
import { OZW772Client } from '../../lib/OZW772Client';

/** Login credentials for gateway connection */
interface LoginCredentials {
  host: string;
  username: string;
  password: string;
}

/** Device data stored in Homey */
interface GatewayDeviceData {
  id: string;
}

/** Device store containing connection details */
interface GatewayDeviceStore {
  host: string;
  username: string;
  password: string;
}

/** Device structure for pairing */
interface PairDevice {
  name: string;
  data: GatewayDeviceData;
  store: GatewayDeviceStore;
}

/**
 * Driver class for Synco Living gateway
 */
class GatewayDriver extends Homey.Driver {
  /**
   * Initialize the driver
   */
  async onInit(): Promise<void> {
    this.log('Gateway driver initialized');
  }

  /**
   * Handle device pairing session
   */
  async onPair(session: Homey.Driver.PairSession): Promise<void> {
    let credentials: LoginCredentials | null = null;
    let client: OZW772Client | null = null;

    session.setHandler('login', async (data: LoginCredentials): Promise<boolean | string> => {
      this.log('Attempting login to:', data.host);

      try {
        client = new OZW772Client({
          host: data.host,
          username: data.username,
          password: data.password,
        });

        await client.login();
        credentials = data;
        this.log('Login successful');

        // Save credentials to app settings for next time
        await this.homey.settings.set('gateway_host', data.host);
        await this.homey.settings.set('gateway_username', data.username);
        await this.homey.settings.set('gateway_password', data.password);
        this.log('Credentials saved to app settings');

        return true;
      } catch (error) {
        this.error('Login failed:', error);
        if (error instanceof Error) {
          return error.message;
        }
        return 'Connection failed';
      }
    });

    session.setHandler('list_devices', async (): Promise<PairDevice[]> => {
      this.log('Listing gateway device...');

      if (!credentials || !client) {
        this.error('No credentials available');
        return [];
      }

      // Only one gateway device per installation
      const gatewayId = `gateway-${credentials.host.replace(/\./g, '-')}`;

      return [
        {
          name: `Synco Gateway (${credentials.host})`,
          data: {
            id: gatewayId,
          },
          store: {
            host: credentials.host,
            username: credentials.username,
            password: credentials.password,
          },
        },
      ];
    });
  }

  /**
   * Create a new OZW772Client instance
   */
  getClient(config: LoginCredentials): OZW772Client {
    return new OZW772Client(config);
  }
}

module.exports = GatewayDriver;
