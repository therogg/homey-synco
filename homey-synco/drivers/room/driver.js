"use strict";
/**
 * Room Driver for Siemens Synco Living
 *
 * @description Handles device pairing and discovery for Synco Living room
 * thermostats connected via OZW772/OZW672 gateway.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const homey_1 = __importDefault(require("homey"));
const OZW772Client_1 = require("../../lib/OZW772Client");
const constants_1 = require("../../lib/constants");
/**
 * Driver class for Synco Living room thermostats
 */
class RoomDriver extends homey_1.default.Driver {
    /**
     * Initialize the driver
     */
    async onInit() {
        this.log('Room driver initialized');
    }
    /**
     * Handle device pairing session
     * @param session - The pairing session
     */
    async onPair(session) {
        let credentials = null;
        let client = null;
        session.setHandler('login', async (data) => {
            this.log('Attempting login to:', data.host);
            try {
                client = new OZW772Client_1.OZW772Client({
                    host: data.host,
                    username: data.username,
                    password: data.password,
                });
                await client.login();
                credentials = data;
                this.log('Login successful');
                return true;
            }
            catch (error) {
                this.error('Login failed:', error);
                if (error instanceof Error) {
                    return error.message;
                }
                return 'Connection failed';
            }
        });
        session.setHandler('list_devices', async () => {
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
                            host: credentials.host,
                            username: credentials.username,
                            password: credentials.password,
                            roomMenuId: roomId,
                            stateMenuId: (roomIdNum + constants_1.DATAPOINT_OFFSETS.ROOM_STATE).toString(),
                            setpointsMenuId: roomId,
                            modeMenuId: roomId,
                        },
                    };
                });
            }
            catch (error) {
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
    async discoverRooms(client) {
        try {
            const menuTree = await client.getMenuTree(constants_1.DEVICE_IDS.ROOMS);
            if (menuTree.MenuItems && menuTree.MenuItems.length > 0) {
                return menuTree.MenuItems.filter(item => item.HasSubMenu === 'true');
            }
            return [];
        }
        catch (error) {
            this.error('Failed to get rooms from menu tree:', error);
            throw error;
        }
    }
    /**
     * Create a new OZW772Client instance
     * @param config - Connection configuration
     * @returns New OZW772Client instance
     */
    getClient(config) {
        return new OZW772Client_1.OZW772Client(config);
    }
}
module.exports = RoomDriver;
