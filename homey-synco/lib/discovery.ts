/**
 * Dynamic menu tree discovery for OZW772/OZW672 gateways.
 *
 * API facts (discovered by raw tree dump):
 *  - HasSubMenu is always undefined — every MenuItem is a sub-menu
 *  - Type/Unit are never returned in menu tree listings
 *  - Rooms are nested: Controller > "Rooms" section > Room > SubMenus > DPs
 *
 * Room sub-menus are identified by DP count + WriteAccess pattern:
 *  - Operating mode:  4 DPs, 2 RW  → [0]=modePreselection, [1]=modeState, [3]=absenceMode
 *  - Setpoints:       5 DPs, ≥4 RW → [0-3]=comfort/precomfort/economy/protection
 *  - State:           ≥3 DPs, 0 RW → [0]=actualTemp, [1]=currentSetpoint, [2]=valvePosition
 *
 * Heating+cooling rooms have multiple setpoints sub-menus (one for heating, one for cooling).
 * Disambiguation reads the first writable DP from each candidate — heating setpoints are lower.
 *
 * Gateway DPs are found by reading individual datapoints for Type/Unit.
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

type LogFn = (...args: unknown[]) => void;

interface MenuNode {
  menuItems: MenuItem[];
  datapointItems: DatapointItem[];
}

interface RoomTemplate {
  operatingModeIndex: number;
  setpointsIndex: number;
  stateIndex: number;
}

interface SubMenuProfile {
  index: number;
  menuItem: MenuItem;
  datapointItems: DatapointItem[];
  rwCount: number;
}

async function getNode(client: OZW772Client, parentId?: string): Promise<MenuNode> {
  const response = await client.getMenuTree(parentId);
  return {
    menuItems: normalizeArray(response.MenuItems),
    datapointItems: normalizeArray(response.DatapointItems),
  };
}

/** API may return a single object instead of an array for 1-item lists. */
function normalizeArray<T>(items: T[] | T | undefined): T[] {
  if (!items) return [];
  if (Array.isArray(items)) return items;
  return [items];
}

function isWritable(dp: DatapointItem): boolean {
  const v = dp.WriteAccess;
  return v === 'true' || v === 'True' || v === '1';
}

function menuName(mi: MenuItem): string {
  return mi.Text?.Long || mi.Text?.Short || mi.Id;
}

// ---- Room detection ----

/** Room node: multiple sub-menus (≥3), no direct datapoints. */
function isRoomLike(node: MenuNode): boolean {
  return node.menuItems.length >= 3 && node.datapointItems.length === 0;
}

/** Rooms container: ≥2 children that look like rooms. */
async function checkRoomsContainer(
  client: OZW772Client,
  node: MenuNode,
  log: LogFn,
): Promise<boolean> {
  if (node.menuItems.length < 2 || node.datapointItems.length > 0) return false;

  try {
    const child1 = await getNode(client, node.menuItems[0].Id);
    if (!isRoomLike(child1)) return false;
    const child2 = await getNode(client, node.menuItems[1].Id);
    if (!isRoomLike(child2)) return false;

    log(`Rooms container: "${menuName(node.menuItems[0])}" and "${menuName(node.menuItems[1])}" match room structure`);
    return true;
  } catch {
    return false;
  }
}

// ---- Room classification ----

async function profileRoomSubMenus(
  client: OZW772Client,
  roomNode: MenuNode,
): Promise<SubMenuProfile[]> {
  const profiles: SubMenuProfile[] = [];
  for (let i = 0; i < roomNode.menuItems.length; i++) {
    const mi = roomNode.menuItems[i];
    const child = await getNode(client, mi.Id);
    profiles.push({
      index: i,
      menuItem: mi,
      datapointItems: child.datapointItems,
      rwCount: child.datapointItems.filter(dp => isWritable(dp)).length,
    });
  }
  return profiles;
}

async function findTemplate(
  client: OZW772Client,
  profiles: SubMenuProfile[],
  log: LogFn,
): Promise<RoomTemplate | null> {
  let opIdx = -1;
  let stIdx = -1;

  const spCandidates: SubMenuProfile[] = [];

  for (const p of profiles) {
    const dpCount = p.datapointItems.length;
    if (dpCount === 4 && p.rwCount === 2 && opIdx === -1) {
      opIdx = p.index;
    } else if (dpCount === 5 && p.rwCount >= 4) {
      spCandidates.push(p);
    } else if (dpCount >= 3 && p.rwCount === 0 && stIdx === -1) {
      stIdx = p.index;
    }
  }

  // Setpoints: single candidate or disambiguate multiple (heating+cooling rooms)
  let spIdx = -1;
  if (spCandidates.length === 1) {
    spIdx = spCandidates[0].index;
  } else if (spCandidates.length > 1) {
    // Heating+cooling room: pick the heating setpoints sub-menu.
    // Heating comfort setpoint (~20-22°C) is lower than any cooling setpoint (~26-35°C).
    log(`Found ${spCandidates.length} setpoints sub-menus, disambiguating by DP values...`);
    let bestProfile = spCandidates[0];
    let bestValue = Infinity;
    for (const candidate of spCandidates) {
      const firstWritable = candidate.datapointItems.find(dp => isWritable(dp));
      if (firstWritable) {
        try {
          const value = await client.readDatapoint(firstWritable.Id);
          const numValue = parseFloat(value.Value);
          log(`  Setpoints [${candidate.index}] "${menuName(candidate.menuItem)}": DP ${firstWritable.Id} = ${numValue}`);
          if (!isNaN(numValue) && numValue < bestValue) {
            bestValue = numValue;
            bestProfile = candidate;
          }
        } catch {
          // Skip on read error
        }
      }
    }
    spIdx = bestProfile.index;
    log(`  Selected heating setpoints at sub-menu index ${spIdx}`);
  }

  if (opIdx === -1 || spIdx === -1 || stIdx === -1) return null;
  return { operatingModeIndex: opIdx, setpointsIndex: spIdx, stateIndex: stIdx };
}

function extractDatapoints(
  profiles: SubMenuProfile[],
  tmpl: RoomTemplate,
): RoomDatapointMap {
  const dp: RoomDatapointMap = {};

  // Operating mode: [0]=modePreselection, [1]=modeState, [3]=absenceMode
  const op = profiles.find(p => p.index === tmpl.operatingModeIndex);
  if (op && op.datapointItems.length >= 4) {
    dp.modePreselection = op.datapointItems[0].Id;
    dp.modeState = op.datapointItems[1].Id;
    dp.absenceMode = op.datapointItems[3].Id;
  }

  // Setpoints: [0-3]=comfort/precomfort/economy/protection
  const sp = profiles.find(p => p.index === tmpl.setpointsIndex);
  if (sp && sp.datapointItems.length >= 4) {
    dp.comfortSetpoint = sp.datapointItems[0].Id;
    dp.precomfortSetpoint = sp.datapointItems[1].Id;
    dp.economySetpoint = sp.datapointItems[2].Id;
    dp.protectionSetpoint = sp.datapointItems[3].Id;
  }

  // State: [0]=actualTemp, [1]=currentSetpoint, [2]=valvePosition
  const st = profiles.find(p => p.index === tmpl.stateIndex);
  if (st) {
    dp.stateMenuId = st.menuItem.Id;
    if (st.datapointItems.length >= 3) {
      dp.actualTemp = st.datapointItems[0].Id;
      dp.currentSetpoint = st.datapointItems[1].Id;
      dp.valvePosition = st.datapointItems[2].Id;
    }
  }

  return dp;
}

async function classifyRoom(
  client: OZW772Client,
  roomMenuItem: MenuItem,
  log: LogFn,
): Promise<DiscoveredRoom | null> {
  try {
    const roomNode = await getNode(client, roomMenuItem.Id);
    if (!isRoomLike(roomNode)) return null;

    const profiles = await profileRoomSubMenus(client, roomNode);
    const tmpl = await findTemplate(client, profiles, log);

    if (!tmpl) {
      const sigs = profiles.map(p => `[${p.datapointItems.length}dp/${p.rwCount}rw]`).join(' ');
      log(`Cannot identify sub-menus for "${menuName(roomMenuItem)}": ${sigs}`);
      return null;
    }

    const datapoints = extractDatapoints(profiles, tmpl);
    const name = menuName(roomMenuItem);
    log(`Classified "${name}": ${JSON.stringify(datapoints)}`);

    return { menuId: roomMenuItem.Id, name, datapoints };
  } catch (error) {
    log(`Failed to classify room ${roomMenuItem.Id}:`, error);
    return null;
  }
}

// ---- Gateway datapoint identification ----

interface EnrichedDP {
  item: DatapointItem;
  type: string;
  unit: string;
}

async function enrichDP(client: OZW772Client, dp: DatapointItem): Promise<EnrichedDP | null> {
  try {
    const value = await client.readDatapoint(dp.Id);
    return { item: dp, type: value.Type, unit: value.Unit || '' };
  } catch {
    return null;
  }
}

/**
 * Find outside temperature and air pressure from a leaf section.
 * Air pressure (hPa/mbar) is unique. Outside temp is the °C RO DP right before it.
 */
async function scanLeafForTempAndPressure(
  client: OZW772Client,
  items: DatapointItem[],
  gw: GatewayDatapointMap,
  log: LogFn,
): Promise<void> {
  if (gw.outsideTemperature && gw.airPressure) return;

  // Read all DPs to find air pressure, then take the °C RO DP before it
  const enriched: (EnrichedDP | null)[] = [];
  for (const dp of items) {
    enriched.push(await enrichDP(client, dp));
  }

  // Find air pressure by unique hPa/mbar unit
  let pressureIdx = -1;
  for (let i = 0; i < enriched.length; i++) {
    const e = enriched[i];
    if (e && e.type === 'Numeric' && (e.unit.includes('hPa') || e.unit.includes('mbar'))) {
      if (!gw.airPressure) {
        gw.airPressure = e.item.Id;
        log(`Gateway: air pressure = ${e.item.Id}`);
        pressureIdx = i;
      }
      break;
    }
  }

  // Outside temp = the °C RO DP immediately before air pressure
  if (pressureIdx > 0 && !gw.outsideTemperature) {
    const prev = enriched[pressureIdx - 1];
    if (prev && prev.type === 'Numeric' && prev.unit.includes('°') && !isWritable(prev.item)) {
      gw.outsideTemperature = prev.item.Id;
      log(`Gateway: outside temperature = ${prev.item.Id}`);
    }
  }
}

/**
 * Find ventilation mode and stage by scanning sub-menus for specific DP signatures.
 * Ventilation operating mode sub-menu: 5 DPs, 3 RW → first Enum RW = ventilationMode
 * Ventilation state sub-menu: 2 DPs, 0 RW → first Enum RO = ventilationStage
 */
async function scanSectionForVentilation(
  client: OZW772Client,
  sectionNode: MenuNode,
  gw: GatewayDatapointMap,
  log: LogFn,
): Promise<void> {
  for (const subMi of sectionNode.menuItems) {
    if (gw.ventilationMode && gw.ventilationStage) return;

    let subNode: MenuNode;
    try {
      subNode = await getNode(client, subMi.Id);
    } catch {
      continue;
    }

    const items = subNode.datapointItems;
    const rwCount = items.filter(dp => isWritable(dp)).length;

    // Ventilation operating mode: 5 DPs, 3 RW → first RW Enum = stage selection
    if (items.length === 5 && rwCount === 3 && !gw.ventilationMode) {
      for (const dp of items) {
        if (!isWritable(dp)) continue;
        const e = await enrichDP(client, dp);
        if (e && e.type === 'Enumeration') {
          gw.ventilationMode = dp.Id;
          log(`Gateway: ventilation mode = ${dp.Id}`);
          break;
        }
      }
    }

    // Ventilation state: 2 DPs, 0 RW → first Enum RO = ventilation stage
    if (items.length === 2 && rwCount === 0 && !gw.ventilationStage) {
      const e = await enrichDP(client, items[0]);
      if (e && e.type === 'Enumeration') {
        gw.ventilationStage = items[0].Id;
        log(`Gateway: ventilation stage = ${items[0].Id}`);
      }
    }
  }
}

// ---- Main discovery ----

export async function discoverSystem(
  client: OZW772Client,
  log: LogFn,
): Promise<DiscoveryResult> {
  const result: DiscoveryResult = { rooms: [], gatewayDatapoints: {} };

  log('Starting system discovery...');

  // Phase 1: Walk to depth 2 (root → branches → sections)
  const root = await getNode(client);
  log(`Root: ${root.menuItems.length} branches`);

  for (const rootItem of root.menuItems) {
    const branch = await getNode(client, rootItem.Id);
    log(`Branch "${menuName(rootItem)}": ${branch.menuItems.length} sections`);

    // Only search for rooms and gateway DPs in controller branches (≥5 sections).
    // The OZW772 gateway branch (typically ≤4 sections) contains faults/settings,
    // not room controllers or relevant gateway datapoints.
    const isControllerBranch = branch.menuItems.length >= 5;

    for (const section of branch.menuItems) {
      if (!isControllerBranch) continue;

      const sectionNode = await getNode(client, section.Id);
      const dpCount = sectionNode.datapointItems.length;
      const miCount = sectionNode.menuItems.length;

      // Phase 2: Find rooms container
      if (result.rooms.length === 0 && miCount >= 2 && dpCount === 0) {
        const isContainer = await checkRoomsContainer(client, sectionNode, log);
        if (isContainer) {
          log(`Found ${miCount} rooms in "${menuName(section)}"`);

          const failedRooms: MenuItem[] = [];
          for (const roomMi of sectionNode.menuItems) {
            const room = await classifyRoom(client, roomMi, log);
            if (room) {
              result.rooms.push(room);
            } else {
              failedRooms.push(roomMi);
            }
          }
          // Retry failed rooms after a delay (gives gateway time to recover)
          if (failedRooms.length > 0) {
            log(`Retrying ${failedRooms.length} room(s) that failed initial classification`);
            await new Promise(resolve => setTimeout(resolve, 3000));
            for (const roomMi of failedRooms) {
              const room = await classifyRoom(client, roomMi, log);
              if (room) result.rooms.push(room);
            }
          }
          continue; // Don't scan rooms section for gateway DPs
        }
      }

      // Phase 3: Find outside temp + air pressure from leaf sections (0 menus, has DPs)
      if ((!result.gatewayDatapoints.outsideTemperature || !result.gatewayDatapoints.airPressure)
          && dpCount > 0 && miCount === 0) {
        await scanLeafForTempAndPressure(client, sectionNode.datapointItems, result.gatewayDatapoints, log);
      }

      // Phase 4: Find ventilation mode/stage by sub-menu DP signatures
      if ((!result.gatewayDatapoints.ventilationMode || !result.gatewayDatapoints.ventilationStage)
          && miCount >= 5 && miCount <= 10 && dpCount === 0) {
        await scanSectionForVentilation(client, sectionNode, result.gatewayDatapoints, log);
      }
    }
  }

  log(`Discovery complete: ${result.rooms.length} rooms, gateway: ${JSON.stringify(result.gatewayDatapoints)}`);
  return result;
}
