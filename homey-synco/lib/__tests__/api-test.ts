/**
 * OZW772 API Test Script
 * Tests connection and data reading from the real gateway
 *
 * Run with: npm run test:api
 */

import { OZW772Client } from '../OZW772Client';
import { DEVICE_IDS, DATAPOINT_OFFSETS } from '../constants';

// Test configuration - these should match your actual gateway
const TEST_CONFIG = {
  host: '192.168.1.12',
  username: 'Administrator',
  password: 'Hossaman1976.',
  useHttps: false,
};

// Wohnzimmer room configuration
const WOHNZIMMER = {
  menuId: '5351',
  stateMenuId: '5372',
  actualTempId: '5373',
  comfortSetpointId: '5358',
};

async function runTests(): Promise<void> {
  console.log('='.repeat(60));
  console.log('OZW772 API Client Test');
  console.log('='.repeat(60));
  console.log(`\nTarget: ${TEST_CONFIG.host}`);
  console.log(`User: ${TEST_CONFIG.username}\n`);

  const client = new OZW772Client(TEST_CONFIG);

  try {
    // Step 1: Login
    console.log('Step 1: Logging in...');
    const sessionId = await client.login();
    console.log(`  Session ID: ${sessionId.substring(0, 8)}...`);
    console.log('  Login successful!\n');

    // Step 2: Read root menu tree
    console.log('Step 2: Reading root menu tree...');
    const rootMenu = await client.getMenuTree();
    console.log(`  Found ${rootMenu.MenuItems?.length || 0} menu items`);
    if (rootMenu.MenuItems) {
      rootMenu.MenuItems.forEach((item) => {
        console.log(`    - [${item.Id}] ${item.Text.Long}`);
      });
    }
    console.log();

    // Step 3: Navigate to QAX910-DE (ID 4719)
    console.log('Step 3: Navigating to QAX910-DE (ID 4719)...');
    const qax910Menu = await client.getMenuTree(DEVICE_IDS.QAX910_DE);
    console.log(`  Found ${qax910Menu.MenuItems?.length || 0} menu items`);
    if (qax910Menu.MenuItems) {
      qax910Menu.MenuItems.slice(0, 5).forEach((item) => {
        console.log(`    - [${item.Id}] ${item.Text.Long}`);
      });
      if ((qax910Menu.MenuItems?.length || 0) > 5) {
        console.log(`    ... and ${(qax910Menu.MenuItems?.length || 0) - 5} more`);
      }
    }
    console.log();

    // Step 4: Navigate to Rooms (ID 5350)
    console.log('Step 4: Navigating to Rooms (ID 5350)...');
    const roomsMenu = await client.getMenuTree(DEVICE_IDS.ROOMS);
    console.log(`  Found ${roomsMenu.MenuItems?.length || 0} rooms`);
    if (roomsMenu.MenuItems) {
      roomsMenu.MenuItems.forEach((item) => {
        console.log(`    - [${item.Id}] ${item.Text.Long}`);
      });
    }
    console.log();

    // Step 5: Navigate to Wohnzimmer (ID 5351)
    console.log('Step 5: Navigating to Wohnzimmer (ID 5351)...');
    const wohnzimmerMenu = await client.getMenuTree(WOHNZIMMER.menuId);
    console.log(`  Found ${wohnzimmerMenu.MenuItems?.length || 0} menu items`);
    console.log(`  Found ${wohnzimmerMenu.DatapointItems?.length || 0} datapoints`);
    if (wohnzimmerMenu.MenuItems) {
      wohnzimmerMenu.MenuItems.forEach((item) => {
        console.log(`    Menu: [${item.Id}] ${item.Text.Long}`);
      });
    }
    if (wohnzimmerMenu.DatapointItems) {
      wohnzimmerMenu.DatapointItems.slice(0, 5).forEach((item) => {
        const writeable = item.WriteAccess === 'true' ? ' (writable)' : '';
        console.log(`    DP: [${item.Id}] ${item.Text.Long}${writeable}`);
      });
    }
    console.log();

    // Step 6: Navigate to Room State (ID 5372)
    console.log('Step 6: Getting Room State datapoints (ID 5372)...');
    const roomStateMenu = await client.getMenuTree(WOHNZIMMER.stateMenuId);
    console.log(`  Found ${roomStateMenu.DatapointItems?.length || 0} state datapoints`);
    if (roomStateMenu.DatapointItems) {
      roomStateMenu.DatapointItems.forEach((item) => {
        console.log(`    - [${item.Id}] ${item.Text.Long}`);
      });
    }
    console.log();

    // Step 7: Read actual room temperature (ID 5373)
    console.log('Step 7: Reading actual room temperature (ID 5373)...');
    const actualTemp = await client.readDatapoint(WOHNZIMMER.actualTempId);
    const tempValue = OZW772Client.parseNumericValue(actualTemp);
    console.log(`  Type: ${actualTemp.Type}`);
    console.log(`  Raw Value: "${actualTemp.Value}"`);
    console.log(`  Parsed Value: ${tempValue}`);
    console.log(`  Unit: ${actualTemp.Unit}`);
    console.log(`  => Current temperature: ${tempValue}${actualTemp.Unit}`);
    console.log();

    // Step 8: Read comfort setpoint (ID 5358)
    console.log('Step 8: Reading comfort setpoint (ID 5358)...');
    const comfortSetpoint = await client.readDatapoint(WOHNZIMMER.comfortSetpointId);
    const setpointValue = OZW772Client.parseNumericValue(comfortSetpoint);
    console.log(`  Type: ${comfortSetpoint.Type}`);
    console.log(`  Raw Value: "${comfortSetpoint.Value}"`);
    console.log(`  Parsed Value: ${setpointValue}`);
    console.log(`  Unit: ${comfortSetpoint.Unit}`);
    console.log(`  => Comfort setpoint: ${setpointValue}${comfortSetpoint.Unit}`);
    console.log();

    // Step 9: Read multiple datapoints
    console.log('Step 9: Reading multiple datapoints...');
    const datapointIds = [
      WOHNZIMMER.actualTempId,
      (parseInt(WOHNZIMMER.menuId) + DATAPOINT_OFFSETS.CURRENT_SETPOINT).toString(),
      (parseInt(WOHNZIMMER.menuId) + DATAPOINT_OFFSETS.VALVE_POSITION).toString(),
    ];
    console.log(`  Requesting IDs: ${datapointIds.join(', ')}`);
    const multipleValues = await client.readDatapoints(datapointIds);
    multipleValues.forEach((value, id) => {
      const parsed = OZW772Client.parseNumericValue(value);
      console.log(`    [${id}] ${parsed}${value.Unit}`);
    });
    console.log();

    // Summary
    console.log('='.repeat(60));
    console.log('TEST RESULTS SUMMARY');
    console.log('='.repeat(60));
    console.log(`  Current Room Temperature: ${tempValue}${actualTemp.Unit}`);
    console.log(`  Comfort Setpoint:         ${setpointValue}${comfortSetpoint.Unit}`);
    console.log('='.repeat(60));
    console.log('\nAll tests passed successfully!');

  } catch (error) {
    console.error('\nTest failed with error:');
    console.error(error);
    process.exit(1);
  }
}

// Run the tests
runTests().catch((error) => {
  console.error('Unhandled error:', error);
  process.exit(1);
});
