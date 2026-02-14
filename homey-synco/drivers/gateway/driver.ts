import Homey from 'homey';
import { OZW772Client } from '../../lib/OZW772Client';
import { discoverSystem } from '../../lib/discovery';
import { RoomDatapointMap, GatewayDatapointMap } from '../../lib/types';

interface LoginCredentials {
  host: string;
  username: string;
  password: string;
  useHttps?: boolean;
}

interface PairDevice {
  name: string;
  data: { id: string };
  store: {
    host: string;
    username: string;
    password: string;
    useHttps?: boolean;
    deviceType: 'gateway' | 'room';
    roomMenuId?: string;
    stateMenuId?: string;
    setpointsMenuId?: string;
    modeMenuId?: string;
    discoveredDatapoints?: RoomDatapointMap | GatewayDatapointMap;
  };
}

class GatewayDriver extends Homey.Driver {
  async onInit(): Promise<void> {
    this.log('Gateway driver initialized');
  }

  async onPair(session: Homey.Driver.PairSession): Promise<void> {
    let credentials: LoginCredentials | null = null;
    let client: OZW772Client | null = null;

    session.setHandler('login', async (data: LoginCredentials): Promise<boolean | string> => {
      this.log('Attempting login to:', data.host, 'useHttps:', data.useHttps);

      try {
        let useHttps = data.useHttps || false;

        if (useHttps) {
          client = new OZW772Client({
            host: data.host,
            username: data.username,
            password: data.password,
            useHttps: true,
          });
          await client.login();
        } else {
          const result = await OZW772Client.createWithAutoHttps({
            host: data.host,
            username: data.username,
            password: data.password,
          });
          client = result.client;
          useHttps = result.useHttps;

          if (result.useHttps) {
            this.log('Auto-detected HTTPS requirement');
          }
        }

        credentials = { ...data, useHttps };
        this.log('Login successful, useHttps:', useHttps);

        await this.homey.settings.set('gateway_host', data.host);
        await this.homey.settings.set('gateway_username', data.username);
        await this.homey.settings.set('gateway_password', data.password);
        await this.homey.settings.set('gateway_use_https', useHttps);
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
      this.log('Listing gateway and room devices...');

      if (!credentials || !client) {
        this.error('No credentials available');
        return [];
      }

      const devices: PairDevice[] = [];
      const gatewayId = `gateway-${credentials.host.replace(/\./g, '-')}`;

      try {
        const discovery = await discoverSystem(client, (...args) => this.log('[discovery]', ...args));

        // Gateway device with discovered datapoints
        devices.push({
          name: `Synco Gateway (${credentials.host})`,
          data: { id: gatewayId },
          store: {
            host: credentials.host,
            username: credentials.username,
            password: credentials.password,
            useHttps: credentials.useHttps,
            deviceType: 'gateway',
            discoveredDatapoints: discovery.gatewayDatapoints,
          },
        });

        // Room devices with discovered datapoints
        for (const room of discovery.rooms) {
          devices.push({
            name: room.name,
            data: { id: `room-${room.menuId}` },
            store: {
              host: credentials.host,
              username: credentials.username,
              password: credentials.password,
              useHttps: credentials.useHttps,
              deviceType: 'room',
              roomMenuId: room.menuId,
              stateMenuId: room.datapoints.stateMenuId,
              setpointsMenuId: room.menuId,
              modeMenuId: room.menuId,
              discoveredDatapoints: room.datapoints,
            },
          });
        }

        this.log(`Discovery found ${discovery.rooms.length} rooms`);
      } catch (error) {
        this.error('Discovery failed:', error);

        // Still provide the gateway device without discovered datapoints
        devices.push({
          name: `Synco Gateway (${credentials.host})`,
          data: { id: gatewayId },
          store: {
            host: credentials.host,
            username: credentials.username,
            password: credentials.password,
            useHttps: credentials.useHttps,
            deviceType: 'gateway',
          },
        });
      }

      return devices;
    });
  }

  getClient(config: LoginCredentials): OZW772Client {
    return new OZW772Client(config);
  }
}

module.exports = GatewayDriver;
