/**
 * Dynamic menu tree discovery for OZW772/OZW672 gateways.
 * Traverses the menu tree to find rooms and gateway datapoints
 * regardless of controller variant or language.
 */

import { OZW772Client } from './OZW772Client';
import {
  MenuItem,
  DatapointItem,
  DiscoveredRoom,
  DiscoveryResult,
  RoomDatapointMap,
  GatewayDatapointMap,
} from './types';

const MAX_DEPTH = 5;
const MIN_ROOM_CELSIUS_RW = 2;

type LogFn = (...args: unknown[]) => void;

interface MenuNode {
  menuItems: MenuItem[];
  datapointItems: DatapointItem[];
}

async function getNode(client: OZW772Client, parentId?: string): Promise<MenuNode> {
  const response = await client.getMenuTree(parentId);
  return {
    menuItems: response.MenuItems || [],
    datapointItems: response.DatapointItems || [],
  };
}

function isCelsius(dp: DatapointItem): boolean {
  return dp.Type === 'Numeric' && (dp.Unit?.includes('°C') || dp.Unit?.includes('°C') || false);
}

function isPercent(dp: DatapointItem): boolean {
  return dp.Type === 'Numeric' && (dp.Unit?.includes('%') || false);
}

function isPressure(dp: DatapointItem): boolean {
  return dp.Type === 'Numeric' && (dp.Unit?.includes('hPa') || dp.Unit?.includes('mbar') || false);
}

function isWritable(dp: DatapointItem): boolean {
  return dp.WriteAccess === 'true';
}

function isEnum(dp: DatapointItem): boolean {
  return dp.Type === 'Enumeration';
}

/**
 * Check if a menu node has the signature of a room:
 * multiple °C RW datapoints, at least one Enumeration, and at least one sub-menu (state).
 */
function isRoomSignature(node: MenuNode): boolean {
  let celsiusRW = 0;
  let enumerations = 0;
  let hasSubMenu = false;

  for (const dp of node.datapointItems) {
    if (isCelsius(dp) && isWritable(dp)) celsiusRW++;
    if (isEnum(dp)) enumerations++;
  }
  for (const mi of node.menuItems) {
    if (mi.HasSubMenu === 'true') hasSubMenu = true;
  }

  return celsiusRW >= MIN_ROOM_CELSIUS_RW && enumerations >= 1 && hasSubMenu;
}

/**
 * Check if a node's children are rooms by sampling the first sub-menu child.
 */
async function checkIfRoomsContainer(
  client: OZW772Client,
  node: MenuNode,
): Promise<boolean> {
  const firstChild = node.menuItems[0];
  if (!firstChild || firstChild.HasSubMenu !== 'true') return false;

  try {
    const childNode = await getNode(client, firstChild.Id);
    return isRoomSignature(childNode);
  } catch {
    return false;
  }
}

/**
 * Classify a room's datapoints by type, unit, and write access.
 */
async function classifyRoom(
  client: OZW772Client,
  menuItem: MenuItem,
  log: LogFn,
): Promise<DiscoveredRoom | null> {
  try {
    const node = await getNode(client, menuItem.Id);
    const datapoints: RoomDatapointMap = {};

    const celsiusRW: DatapointItem[] = [];
    const enumRW: DatapointItem[] = [];
    const enumRO: DatapointItem[] = [];

    for (const dp of node.datapointItems) {
      if (isCelsius(dp) && isWritable(dp)) {
        celsiusRW.push(dp);
      } else if (isEnum(dp) && isWritable(dp)) {
        enumRW.push(dp);
      } else if (isEnum(dp) && !isWritable(dp)) {
        enumRO.push(dp);
      }
    }

    // °C RW setpoints in order: comfort, precomfort, economy, protection
    if (celsiusRW.length >= 1) datapoints.comfortSetpoint = celsiusRW[0].Id;
    if (celsiusRW.length >= 2) datapoints.precomfortSetpoint = celsiusRW[1].Id;
    if (celsiusRW.length >= 3) datapoints.economySetpoint = celsiusRW[2].Id;
    if (celsiusRW.length >= 4) datapoints.protectionSetpoint = celsiusRW[3].Id;

    // Enumeration RW: 1st = modePreselection, 2nd = absenceMode
    if (enumRW.length >= 1) datapoints.modePreselection = enumRW[0].Id;
    if (enumRW.length >= 2) datapoints.absenceMode = enumRW[1].Id;

    // Enumeration RO: 1st = modeState
    if (enumRO.length >= 1) datapoints.modeState = enumRO[0].Id;

    // State sub-menu: first sub-menu child that has RO °C and % datapoints
    for (const mi of node.menuItems) {
      if (mi.HasSubMenu === 'true') {
        const stateNode = await getNode(client, mi.Id);
        datapoints.stateMenuId = mi.Id;

        const celsiusRO: DatapointItem[] = [];
        let percentRO: DatapointItem | null = null;

        for (const dp of stateNode.datapointItems) {
          if (isCelsius(dp) && !isWritable(dp)) {
            celsiusRO.push(dp);
          } else if (isPercent(dp) && !isWritable(dp)) {
            percentRO = dp;
          }
        }

        // 1st °C RO = actualTemp, 2nd °C RO = currentSetpoint
        if (celsiusRO.length >= 1) datapoints.actualTemp = celsiusRO[0].Id;
        if (celsiusRO.length >= 2) datapoints.currentSetpoint = celsiusRO[1].Id;
        if (percentRO) datapoints.valvePosition = percentRO.Id;
        break;
      }
    }

    const name = menuItem.Text.Long || menuItem.Text.Short || `Room ${menuItem.Id}`;
    log(`Discovered room "${name}": ${JSON.stringify(datapoints)}`);

    return { menuId: menuItem.Id, name, datapoints };
  } catch (error) {
    log(`Failed to classify room ${menuItem.Id}:`, error);
    return null;
  }
}

/**
 * Collect gateway-level datapoints from a non-room node.
 */
function collectGatewayDatapoints(
  datapointItems: DatapointItem[],
  gw: GatewayDatapointMap,
  log: LogFn,
): void {
  for (const dp of datapointItems) {
    if (isPressure(dp) && !gw.airPressure) {
      gw.airPressure = dp.Id;
      log(`Found air pressure: ${dp.Id}`);
    } else if (isCelsius(dp) && !isWritable(dp) && !gw.outsideTemperature) {
      gw.outsideTemperature = dp.Id;
      log(`Found outside temperature: ${dp.Id}`);
    } else if (isEnum(dp) && isWritable(dp) && !gw.ventilationMode) {
      gw.ventilationMode = dp.Id;
      log(`Found ventilation mode: ${dp.Id}`);
    } else if (isEnum(dp) && !isWritable(dp) && !gw.ventilationStage) {
      gw.ventilationStage = dp.Id;
      log(`Found ventilation stage: ${dp.Id}`);
    }
  }
}

/**
 * Recursively traverse the menu tree, discovering rooms and gateway datapoints.
 */
async function traverseTree(
  client: OZW772Client,
  parentId: string | undefined,
  depth: number,
  result: DiscoveryResult,
  log: LogFn,
): Promise<void> {
  if (depth >= MAX_DEPTH) return;

  const node = await getNode(client, parentId);

  // Check if this node's children are rooms (only at depth >= 1 to skip root)
  if (node.menuItems.length > 0 && depth >= 1) {
    const isContainer = await checkIfRoomsContainer(client, node);
    if (isContainer) {
      log(`Found rooms container at ID ${parentId} with ${node.menuItems.length} rooms`);
      for (const mi of node.menuItems) {
        const room = await classifyRoom(client, mi, log);
        if (room) result.rooms.push(room);
      }
      return;
    }
  }

  // Collect gateway-level datapoints at this node
  collectGatewayDatapoints(node.datapointItems, result.gatewayDatapoints, log);

  // Recurse into sub-menus
  for (const mi of node.menuItems) {
    if (mi.HasSubMenu === 'true') {
      await traverseTree(client, mi.Id, depth + 1, result, log);
    }
  }
}

/**
 * Discover the full system: rooms and gateway datapoints.
 * Traverses the OZW772 menu tree from root (max depth 5).
 *
 * @param client - Authenticated OZW772Client
 * @param log - Logger function (typically driver's this.log)
 * @returns Discovery result with rooms and gateway datapoints
 */
export async function discoverSystem(
  client: OZW772Client,
  log: LogFn,
): Promise<DiscoveryResult> {
  const result: DiscoveryResult = {
    rooms: [],
    gatewayDatapoints: {},
  };

  log('Starting system discovery...');
  await traverseTree(client, undefined, 0, result, log);
  log(`Discovery complete: ${result.rooms.length} rooms, gateway datapoints: ${JSON.stringify(result.gatewayDatapoints)}`);

  return result;
}
