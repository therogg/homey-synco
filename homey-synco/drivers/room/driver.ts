/**
 * Room Driver for Siemens Synco Living
 *
 * @description Handles device pairing and discovery for Synco Living room
 * thermostats connected via OZW772/OZW672 gateway.
 */

import Homey from 'homey';
import { OZW772Client } from '../../lib/OZW772Client';
import { discoverSystem } from '../../lib/discovery';
import { RoomDatapointMap } from '../../lib/types';

interface LoginCredentials {
  host: string;
  username: string;
  password: string;
  useHttps?: boolean;
}

interface RoomDeviceData {
  id: string;
  roomIndex: number;
}

interface RoomDeviceStore {
  host: string;
  username: string;
  password: string;
  useHttps?: boolean;
  roomMenuId: string;
  stateMenuId?: string;
  setpointsMenuId: string;
  modeMenuId: string;
  discoveredDatapoints?: RoomDatapointMap;
}

interface PairDevice {
  name: string;
  data: RoomDeviceData;
  store: RoomDeviceStore;
}

class RoomDriver extends Homey.Driver {
  async onInit(): Promise<void> {
    this.log('Room driver initialized');
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
      this.log('Listing room devices...');

      if (!credentials || !client) {
        this.error('No credentials available');
        return [];
      }

      try {
        const discovery = await discoverSystem(client, (...args) => this.log('[discovery]', ...args));
        this.log(`Found ${discovery.rooms.length} rooms`);

        return discovery.rooms.map((room, index) => ({
          name: room.name,
          data: {
            id: room.menuId,
            roomIndex: index,
          },
          store: {
            host: credentials!.host,
            username: credentials!.username,
            password: credentials!.password,
            useHttps: credentials!.useHttps,
            roomMenuId: room.menuId,
            stateMenuId: room.datapoints.stateMenuId,
            setpointsMenuId: room.menuId,
            modeMenuId: room.menuId,
            discoveredDatapoints: room.datapoints,
          },
        }));
      } catch (error) {
        this.error('Failed to discover rooms:', error);
        return [];
      }
    });
  }

  getClient(config: LoginCredentials): OZW772Client {
    return new OZW772Client(config);
  }
}

module.exports = RoomDriver;
