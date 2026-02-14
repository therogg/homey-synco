/**
 * Dynamic menu tree discovery for OZW772/OZW672 gateways.
 * Traverses the menu tree to find rooms and gateway datapoints
 * regardless of controller variant or language.
 *
 * Classification uses datapoint Type/Unit/WriteAccess from the API.
 * If the menu tree listing doesn't include Type/Unit, the discovery
 * reads individual datapoints to determine their types.
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
const MIN_ROOM_DATAPOINTS = 5;

type LogFn = (...args: unknown[]) => void;

interface MenuNode {
  menuItems: MenuItem[];
  datapointItems: DatapointItem[];
}

interface IndexedRole {
  index: number;
  role: keyof RoomDatapointMap;
}

interface RoomTemplate {
  directMap: IndexedRole[];
  stateMenuIndex: number;
  stateMap: IndexedRole[];
}

async function getNode(client: OZW772Client, parentId?: string): Promise<MenuNode> {
  const response = await client.getMenuTree(parentId);
  return {
    menuItems: response.MenuItems || [],
    datapointItems: response.DatapointItems || [],
  };
}

function hasSub(mi: MenuItem): boolean {
  const v = mi.HasSubMenu;
  return v === 'true' || v === 'True' || v === '1';
}

function isCelsius(dp: DatapointItem): boolean {
  return dp.Type === 'Numeric' && (dp.Unit?.includes('°') ?? false);
}

function isPercent(dp: DatapointItem): boolean {
  return dp.Type === 'Numeric' && (dp.Unit?.includes('%') ?? false);
}

function isPressure(dp: DatapointItem): boolean {
  if (dp.Type !== 'Numeric') return false;
  const u = dp.Unit || '';
  return u.includes('hPa') || u.includes('mbar');
}

function isWritable(dp: DatapointItem): boolean {
  const v = dp.WriteAccess;
  return v === 'true' || v === 'True' || v === '1';
}

function isEnum(dp: DatapointItem): boolean {
  return dp.Type === 'Enumeration';
}

// ---- Enrichment: read datapoints to get Type/Unit when menu tree omits them ----

async function enrichDatapoints(
  client: OZW772Client,
  items: DatapointItem[],
  log: LogFn,
): Promise<DatapointItem[]> {
  if (items.length === 0 || items[0].Type) return items;

  log(`Reading ${items.length} datapoints for type info...`);
  const enriched: DatapointItem[] = [];
  for (const dp of items) {
    try {
      const value = await client.readDatapoint(dp.Id);
      enriched.push({ ...dp, Type: value.Type, Unit: value.Unit });
    } catch {
      enriched.push(dp);
    }
  }
  return enriched;
}

// ---- Room signature check (structural, no Type/Unit needed) ----

function isRoomSignature(node: MenuNode): boolean {
  return node.datapointItems.length >= MIN_ROOM_DATAPOINTS
    && node.menuItems.some(mi => hasSub(mi));
}

async function checkIfRoomsContainer(
  client: OZW772Client,
  node: MenuNode,
  log: LogFn,
): Promise<boolean> {
  const subMenuChildren = node.menuItems.filter(mi => hasSub(mi));
  if (subMenuChildren.length < 2) return false;

  try {
    const childNode = await getNode(client, subMenuChildren[0].Id);
    const match = isRoomSignature(childNode);
    if (match) {
      log(`Candidate rooms container: first child "${subMenuChildren[0].Text?.Long || subMenuChildren[0].Text?.Short}" matches room signature`);
    }
    return match;
  } catch {
    return false;
  }
}

// ---- Room classification ----

function classifyDirectDatapoints(
  items: DatapointItem[],
  datapoints: RoomDatapointMap,
): IndexedRole[] {
  const map: IndexedRole[] = [];

  const celsiusRW: Array<{ dp: DatapointItem; idx: number }> = [];
  const enumRW: Array<{ dp: DatapointItem; idx: number }> = [];
  const enumRO: Array<{ dp: DatapointItem; idx: number }> = [];

  for (let i = 0; i < items.length; i++) {
    const dp = items[i];
    if (isCelsius(dp) && isWritable(dp)) celsiusRW.push({ dp, idx: i });
    else if (isEnum(dp) && isWritable(dp)) enumRW.push({ dp, idx: i });
    else if (isEnum(dp) && !isWritable(dp)) enumRO.push({ dp, idx: i });
  }

  const setpoints: Array<keyof RoomDatapointMap> = [
    'comfortSetpoint', 'precomfortSetpoint', 'economySetpoint', 'protectionSetpoint',
  ];
  for (let i = 0; i < Math.min(celsiusRW.length, setpoints.length); i++) {
    datapoints[setpoints[i]] = celsiusRW[i].dp.Id;
    map.push({ index: celsiusRW[i].idx, role: setpoints[i] });
  }

  if (enumRW.length >= 1) {
    datapoints.modePreselection = enumRW[0].dp.Id;
    map.push({ index: enumRW[0].idx, role: 'modePreselection' });
  }
  if (enumRW.length >= 2) {
    datapoints.absenceMode = enumRW[1].dp.Id;
    map.push({ index: enumRW[1].idx, role: 'absenceMode' });
  }
  if (enumRO.length >= 1) {
    datapoints.modeState = enumRO[0].dp.Id;
    map.push({ index: enumRO[0].idx, role: 'modeState' });
  }

  return map;
}

function classifyStateDatapoints(
  items: DatapointItem[],
  datapoints: RoomDatapointMap,
): IndexedRole[] {
  const map: IndexedRole[] = [];

  const celsiusRO: Array<{ dp: DatapointItem; idx: number }> = [];
  let percentRO: { dp: DatapointItem; idx: number } | null = null;

  for (let i = 0; i < items.length; i++) {
    const dp = items[i];
    if (isCelsius(dp) && !isWritable(dp)) celsiusRO.push({ dp, idx: i });
    else if (isPercent(dp) && !isWritable(dp) && !percentRO) percentRO = { dp, idx: i };
  }

  if (celsiusRO.length >= 1) {
    datapoints.actualTemp = celsiusRO[0].dp.Id;
    map.push({ index: celsiusRO[0].idx, role: 'actualTemp' });
  }
  if (celsiusRO.length >= 2) {
    datapoints.currentSetpoint = celsiusRO[1].dp.Id;
    map.push({ index: celsiusRO[1].idx, role: 'currentSetpoint' });
  }
  if (percentRO) {
    datapoints.valvePosition = percentRO.dp.Id;
    map.push({ index: percentRO.idx, role: 'valvePosition' });
  }

  return map;
}

/**
 * Fully classify a room — enriches datapoints if needed, builds a position template.
 */
async function classifyRoomFull(
  client: OZW772Client,
  menuItem: MenuItem,
  log: LogFn,
): Promise<{ room: DiscoveredRoom; template: RoomTemplate } | null> {
  try {
    const node = await getNode(client, menuItem.Id);
    const datapoints: RoomDatapointMap = {};

    const items = await enrichDatapoints(client, node.datapointItems, log);
    const directMap = classifyDirectDatapoints(items, datapoints);

    let stateMenuIndex = -1;
    let stateMap: IndexedRole[] = [];

    for (let i = 0; i < node.menuItems.length; i++) {
      if (hasSub(node.menuItems[i])) {
        stateMenuIndex = i;
        const stateNode = await getNode(client, node.menuItems[i].Id);
        datapoints.stateMenuId = node.menuItems[i].Id;

        const stateItems = await enrichDatapoints(client, stateNode.datapointItems, log);
        stateMap = classifyStateDatapoints(stateItems, datapoints);
        break;
      }
    }

    const name = menuItem.Text.Long || menuItem.Text.Short || `Room ${menuItem.Id}`;
    log(`Classified room "${name}": ${JSON.stringify(datapoints)}`);

    return {
      room: { menuId: menuItem.Id, name, datapoints },
      template: { directMap, stateMenuIndex, stateMap },
    };
  } catch (error) {
    log(`Failed to classify room ${menuItem.Id}:`, error);
    return null;
  }
}

/**
 * Classify a room using a position template from the first room — no reads needed.
 */
async function classifyRoomByTemplate(
  client: OZW772Client,
  menuItem: MenuItem,
  tmpl: RoomTemplate,
  log: LogFn,
): Promise<DiscoveredRoom | null> {
  try {
    const node = await getNode(client, menuItem.Id);
    const datapoints: RoomDatapointMap = {};

    for (const { index, role } of tmpl.directMap) {
      if (index < node.datapointItems.length) {
        datapoints[role] = node.datapointItems[index].Id;
      }
    }

    if (tmpl.stateMenuIndex >= 0 && tmpl.stateMenuIndex < node.menuItems.length) {
      const stateMi = node.menuItems[tmpl.stateMenuIndex];
      if (hasSub(stateMi)) {
        const stateNode = await getNode(client, stateMi.Id);
        datapoints.stateMenuId = stateMi.Id;

        for (const { index, role } of tmpl.stateMap) {
          if (index < stateNode.datapointItems.length) {
            datapoints[role] = stateNode.datapointItems[index].Id;
          }
        }
      }
    }

    const name = menuItem.Text.Long || menuItem.Text.Short || `Room ${menuItem.Id}`;
    log(`Mapped room "${name}" by template: ${JSON.stringify(datapoints)}`);

    return { menuId: menuItem.Id, name, datapoints };
  } catch (error) {
    log(`Failed to map room ${menuItem.Id}:`, error);
    return null;
  }
}

// ---- Gateway datapoint collection ----

async function collectGatewayDatapoints(
  client: OZW772Client,
  datapointItems: DatapointItem[],
  gw: GatewayDatapointMap,
  log: LogFn,
): Promise<void> {
  if (datapointItems.length === 0) return;
  if (gw.outsideTemperature && gw.airPressure && gw.ventilationMode && gw.ventilationStage) return;

  for (const dp of datapointItems) {
    let enriched = dp;
    if (!dp.Type) {
      try {
        const value = await client.readDatapoint(dp.Id);
        enriched = { ...dp, Type: value.Type, Unit: value.Unit };
      } catch {
        continue;
      }
    }

    if (isPressure(enriched) && !gw.airPressure) {
      gw.airPressure = enriched.Id;
      log(`Found air pressure: ${enriched.Id}`);
    } else if (isCelsius(enriched) && !isWritable(enriched) && !gw.outsideTemperature) {
      gw.outsideTemperature = enriched.Id;
      log(`Found outside temperature: ${enriched.Id}`);
    } else if (isEnum(enriched) && isWritable(enriched) && !gw.ventilationMode) {
      gw.ventilationMode = enriched.Id;
      log(`Found ventilation mode: ${enriched.Id}`);
    } else if (isEnum(enriched) && !isWritable(enriched) && !gw.ventilationStage) {
      gw.ventilationStage = enriched.Id;
      log(`Found ventilation stage: ${enriched.Id}`);
    }

    if (gw.outsideTemperature && gw.airPressure && gw.ventilationMode && gw.ventilationStage) break;
  }
}

// ---- Tree traversal ----

async function traverseTree(
  client: OZW772Client,
  parentId: string | undefined,
  depth: number,
  result: DiscoveryResult,
  template: { value: RoomTemplate | null },
  log: LogFn,
): Promise<void> {
  if (depth >= MAX_DEPTH) return;

  const node = await getNode(client, parentId);

  if (node.menuItems.length === 0 && node.datapointItems.length === 0) {
    log(`Empty response for ID ${parentId || 'root'}`);
    return;
  }

  log(`Depth ${depth}, ID ${parentId || 'root'}: ${node.menuItems.length} menus, ${node.datapointItems.length} datapoints`);

  // Check if this node's children are rooms
  if (node.menuItems.length >= 2 && depth >= 1) {
    const isContainer = await checkIfRoomsContainer(client, node, log);
    if (isContainer) {
      log(`Found rooms container at ID ${parentId} with ${node.menuItems.length} rooms`);

      const subMenuChildren = node.menuItems.filter(mi => hasSub(mi));
      for (let i = 0; i < subMenuChildren.length; i++) {
        if (!template.value) {
          const classified = await classifyRoomFull(client, subMenuChildren[i], log);
          if (classified) {
            result.rooms.push(classified.room);
            template.value = classified.template;
          }
        } else {
          const room = await classifyRoomByTemplate(client, subMenuChildren[i], template.value, log);
          if (room) result.rooms.push(room);
        }
      }
      return;
    }
  }

  // Collect gateway-level datapoints
  await collectGatewayDatapoints(client, node.datapointItems, result.gatewayDatapoints, log);

  // Recurse into sub-menus
  for (const mi of node.menuItems) {
    if (hasSub(mi)) {
      await traverseTree(client, mi.Id, depth + 1, result, template, log);
    }
  }
}

/**
 * Discover the full system: rooms and gateway datapoints.
 * Traverses the OZW772 menu tree from root (max depth 5).
 */
export async function discoverSystem(
  client: OZW772Client,
  log: LogFn,
): Promise<DiscoveryResult> {
  const result: DiscoveryResult = {
    rooms: [],
    gatewayDatapoints: {},
  };
  const template = { value: null as RoomTemplate | null };

  log('Starting system discovery...');
  await traverseTree(client, undefined, 0, result, template, log);
  log(`Discovery complete: ${result.rooms.length} rooms, gateway: ${JSON.stringify(result.gatewayDatapoints)}`);

  return result;
}
