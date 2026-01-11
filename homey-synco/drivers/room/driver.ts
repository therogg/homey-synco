import Homey from 'homey';
import { OZW772Client } from '../../lib/OZW772Client';
import { DEVICE_IDS, DATAPOINT_OFFSETS } from '../../lib/constants';
import { MenuItem } from '../../lib/types';

interface LoginCredentials {
  host: string;
  username: string;
  password: string;
}

interface RoomDeviceData {
  id: string;
  roomIndex: number;
}

interface RoomDeviceStore {
  host: string;
  username: string;
  password: string;
  roomMenuId: string;
  stateMenuId: string;
  setpointsMenuId: string;
  modeMenuId: string;
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

  async discoverRooms(client: OZW772Client): Promise<MenuItem[]> {
    try {
      const menuTree = await client.getMenuTree(DEVICE_IDS.ROOMS);

      if (menuTree.MenuItems && menuTree.MenuItems.length > 0) {
        return menuTree.MenuItems.filter(item => item.HasSubMenu === 'true');
      }

      return [];
    } catch (error) {
      this.error('Failed to get rooms from menu tree:', error);
      throw error;
    }
  }

  getClient(config: LoginCredentials): OZW772Client {
    return new OZW772Client(config);
  }
}

module.exports = RoomDriver;
