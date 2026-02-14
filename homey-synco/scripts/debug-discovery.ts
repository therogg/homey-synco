/**
 * Debug script to explore the OZW772 menu tree and test discovery.
 *
 * Usage:
 *   npx ts-node scripts/debug-discovery.ts <host> <username> <password>
 *
 * This connects to the gateway, dumps the raw menu tree at each level,
 * and then runs the discovery algorithm with verbose logging.
 */

import { OZW772Client } from '../lib/OZW772Client';
import { discoverSystem } from '../lib/discovery';

const [,, host, username, password] = process.argv;

if (!host || !username || !password) {
  console.error('Usage: npx ts-node scripts/debug-discovery.ts <host> <username> <password>');
  process.exit(1);
}

async function dumpTree(client: OZW772Client, parentId?: string, depth = 0, maxDepth = 4): Promise<void> {
  const indent = '  '.repeat(depth);
  const label = parentId || 'ROOT';

  try {
    const response = await client.getMenuTree(parentId);

    const menuItems = response.MenuItems || [];
    const datapointItems = response.DatapointItems || [];

    console.log(`${indent}[${label}] MenuItems: ${Array.isArray(menuItems) ? menuItems.length : `NOT ARRAY: ${typeof menuItems}`}, DatapointItems: ${Array.isArray(datapointItems) ? datapointItems.length : `NOT ARRAY: ${typeof datapointItems}`}`);

    // Show menu items
    if (Array.isArray(menuItems)) {
      for (const mi of menuItems) {
        console.log(`${indent}  MENU: Id=${mi.Id}, Text="${mi.Text?.Long || mi.Text?.Short || '?'}", HasSubMenu=${mi.HasSubMenu}`);
      }
    } else if (menuItems && typeof menuItems === 'object') {
      console.log(`${indent}  MENU (single object): ${JSON.stringify(menuItems)}`);
    }

    // Show datapoint items
    if (Array.isArray(datapointItems)) {
      for (const dp of datapointItems) {
        console.log(`${indent}  DP: Id=${dp.Id}, Text="${dp.Text?.Long || dp.Text?.Short || '?'}", Type=${dp.Type || 'N/A'}, Unit=${dp.Unit || 'N/A'}, WriteAccess=${dp.WriteAccess}`);
      }
    } else if (datapointItems && typeof datapointItems === 'object') {
      console.log(`${indent}  DP (single object): ${JSON.stringify(datapointItems)}`);
    }

    // Recurse (limited depth for raw dump)
    if (depth < maxDepth && Array.isArray(menuItems)) {
      for (const mi of menuItems) {
        await dumpTree(client, mi.Id, depth + 1, maxDepth);
      }
    }
  } catch (error) {
    console.log(`${indent}[${label}] ERROR: ${error instanceof Error ? error.message : error}`);
  }
}

async function main() {
  console.log(`\nConnecting to gateway at ${host}...\n`);

  let client: OZW772Client;
  try {
    const result = await OZW772Client.createWithAutoHttps({ host, username, password });
    client = result.client;
    console.log(`Connected (HTTPS: ${result.useHttps})\n`);
  } catch (error) {
    console.error('Login failed:', error instanceof Error ? error.message : error);
    process.exit(1);
  }

  // Phase 1: Raw tree dump
  console.log('=== RAW MENU TREE DUMP ===\n');
  await dumpTree(client, undefined, 0, 4);

  // Phase 2: Run discovery
  console.log('\n\n=== DISCOVERY ALGORITHM ===\n');
  try {
    const result = await discoverSystem(client, (...args) => console.log('[discovery]', ...args));
    console.log('\n=== DISCOVERY RESULT ===\n');
    console.log(`Rooms found: ${result.rooms.length}`);
    for (const room of result.rooms) {
      console.log(`  Room: "${room.name}" (menuId=${room.menuId})`);
      console.log(`    Datapoints: ${JSON.stringify(room.datapoints, null, 4)}`);
    }
    console.log(`\nGateway datapoints: ${JSON.stringify(result.gatewayDatapoints, null, 2)}`);
  } catch (error) {
    console.error('Discovery failed:', error instanceof Error ? error.message : error);
  }
}

main().catch(console.error);
