/**
 * Room Driver for Siemens Synco Living
 *
 * @description Handles device pairing and discovery for Synco Living room
 * thermostats connected via OZW772/OZW672 gateway.
 */

import Homey from 'homey';
import { OZW772Client } from '../../lib/OZW772Client';
import { DEVICE_IDS, DATAPOINT_OFFSETS } from '../../lib/constants';
import { MenuItem } from '../../lib/types';

/** Login credentials for gateway connection */
interface LoginCredentials {
  host: string;
  username: string;
  password: string;
  useHttps?: boolean;
}

/** Device data stored in Homey */
interface RoomDeviceData {
  id: string;
  roomIndex: number;
}

/** Device store containing connection details */
interface RoomDeviceStore {
  host: string;
  username: string;
  password: string;
  useHttps?: boolean;
  roomMenuId: string;
  stateMenuId: string;
  setpointsMenuId: string;
  modeMenuId: string;
}

/** Device structure for pairing */
interface PairDevice {
  name: string;
  data: RoomDeviceData;
  store: RoomDeviceStore;
}

/**
 * Driver class for Synco Living room thermostats
 */
class RoomDriver extends Homey.Driver {
  /**
   * Initialize the driver
   */
  async onInit(): Promise<void> {
    this.log('Room driver initialized');
  }

  /**
   * Handle device pairing session
   * @param session - The pairing session
   */
  async onPair(session: Homey.Driver.PairSession): Promise<void> {
    let credentials: LoginCredentials | null = null;
    let client: OZW772Client | null = null;

    session.setHandler('login', async (data: LoginCredentials): Promise<boolean | string> => {
      this.log('Attempting login to:', data.host, 'useHttps:', data.useHttps);

      try {
        let useHttps = data.useHttps || false;

        if (useHttps) {
          // User explicitly requested HTTPS
          client = new OZW772Client({
            host: data.host,
            username: data.username,
            password: data.password,
            useHttps: true,
          });
          await client.login();
        } else {
          // Try HTTP first, auto-detect HTTPS if gateway requires it
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

        // Save credentials to app settings for next time
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
      this.log('Listing devices...');

      if (!credentials || !client) {
        this.error('No credentials available');
        return [];
      }

      try {
        const rooms = await this.discoverRooms(client);
        this.log(`Found ${rooms.length} rooms`);

        return rooms.map((room, index) => {
          const roomId = room.Id;
          const roomIdNum = parseInt(roomId, 10);

          return {
            name: room.Text.Long || room.Text.Short || `Room ${index + 1}`,
            data: {
              id: roomId,
              roomIndex: index,
            },
            store: {
              host: credentials!.host,
              username: credentials!.username,
              password: credentials!.password,
              useHttps: credentials!.useHttps,
              roomMenuId: roomId,
              stateMenuId: (roomIdNum + DATAPOINT_OFFSETS.ROOM_STATE).toString(),
              setpointsMenuId: roomId,
              modeMenuId: roomId,
            },
          };
        });
      } catch (error) {
        this.error('Failed to discover rooms:', error);
        return [];
      }
    });
  }

  /**
   * Discover available rooms from the gateway
   * @param client - OZW772Client instance to use for discovery
   * @returns Array of menu items representing rooms
   */
  async discoverRooms(client: OZW772Client): Promise<MenuItem[]> {
    try {
      this.log('Fetching menu tree for ID:', DEVICE_IDS.ROOMS);
      const menuTree = await client.getMenuTree(DEVICE_IDS.ROOMS);
      this.log('Menu tree response:', JSON.stringify(menuTree, null, 2));

      if (menuTree.MenuItems && menuTree.MenuItems.length > 0) {
        this.log('Found rooms:', menuTree.MenuItems.length);
        return menuTree.MenuItems;
      }

      this.log('No MenuItems found in response');
      return [];
    } catch (error) {
      this.error('Failed to get rooms from menu tree:', error);
      throw error;
    }
  }

  /**
   * Create a new OZW772Client instance
   * @param config - Connection configuration
   * @returns New OZW772Client instance
   */
  getClient(config: LoginCredentials): OZW772Client {
    return new OZW772Client(config);
  }
}

module.exports = RoomDriver;
