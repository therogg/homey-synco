# Homey App Implementation Plan

## Overview

**App Name:** Siemens Synco Living
**App ID:** com.siemens.synco
**Target:** Homey Pro with SDK v3
**Language:** TypeScript

This plan is divided into 6 agent phases, each completing a testable unit of work.

---

## Phase 1: Project Setup & Structure

### Objective
Create the Homey app skeleton with TypeScript configuration and basic file structure.

### Tasks
1. Initialize Homey app with `homey app create`
2. Configure TypeScript (tsconfig.json, dependencies)
3. Set up project structure:
   ```
   homey-synco/
   ├── .homeycompose/
   │   ├── app.json
   │   ├── drivers/
   │   └── flow/
   ├── drivers/
   │   └── room/
   ├── lib/
   │   └── (api client placeholder)
   ├── locales/
   │   ├── en.json
   │   └── de.json
   ├── app.ts
   ├── package.json
   └── tsconfig.json
   ```
4. Configure app.json with basic metadata
5. Add necessary npm dependencies

### Test Criteria
- `npm run build` succeeds
- `homey app validate` passes
- Basic app structure in place

### Deliverables
- Working Homey app skeleton
- TypeScript compilation working
- Git commit: "feat: initial Homey app setup with TypeScript"

---

## Phase 2: OZW772 API Client Module

### Objective
Implement a reusable API client for OZW772 communication.

### Tasks
1. Create `lib/OZW772Client.ts` with:
   - Constructor (host, username, password)
   - `login()` - authenticate and store SessionId
   - `getMenuTree(parentId?)` - navigate menu structure
   - `readDatapoint(id)` - read single datapoint
   - `readDatapoints(ids[])` - read multiple datapoints
   - `writeDatapoint(id, type, value)` - write datapoint
   - Session management (auto-relogin on expiry)
   - Error handling

2. Create `lib/types.ts` with TypeScript interfaces:
   - `OZW772Config`
   - `SessionResponse`
   - `MenuTreeResponse`
   - `DatapointResponse`
   - `DatapointValue`

3. Create `lib/constants.ts` with:
   - API endpoints
   - Data types
   - Error codes

### Test Criteria
- Unit test file `lib/__tests__/OZW772Client.test.ts`
- Can login and get SessionId
- Can read Wohnzimmer temperature (ID 5373)
- Can navigate menu tree

### Deliverables
- Fully functional API client module
- TypeScript types for all API responses
- Test script that reads real data
- Git commit: "feat: implement OZW772 API client module"

---

## Phase 3: Room Device Driver - Basic Structure

### Objective
Create the Room device driver with pairing flow.

### Tasks
1. Create driver structure:
   ```
   drivers/room/
   ├── driver.ts        # Driver class
   ├── device.ts        # Device class
   └── driver.compose.json
   ```

2. Implement `driver.ts`:
   - `onInit()` - initialize driver
   - `onPair()` - pairing flow with:
     - Login credentials input
     - Device discovery (list all rooms)
     - Device selection

3. Implement basic `device.ts`:
   - `onInit()` - initialize device
   - `onDeleted()` - cleanup
   - Store device settings (room ID, parent IDs)

4. Configure `driver.compose.json`:
   - Driver metadata
   - Pairing views configuration

### Test Criteria
- `homey app run` starts without errors
- Pairing flow shows login screen
- After login, all 12 rooms are discovered
- Can add a room device

### Deliverables
- Working driver with pairing flow
- Room discovery from API
- Git commit: "feat: add room device driver with pairing flow"

---

## Phase 4: Capabilities & Data Polling

### Objective
Implement Homey capabilities for room temperature control.

### Tasks
1. Define capabilities in `driver.compose.json`:
   - `measure_temperature` - Current room temperature
   - `target_temperature` - Comfort setpoint (read/write)
   - `valve_position` - Valve position percentage (custom)
   - `thermostat_mode` - Operating mode (custom enum)

2. Create custom capability definitions in `.homeycompose/capabilities/`:
   - `valve_position.json`
   - `thermostat_mode.json`

3. Implement in `device.ts`:
   - `onInit()` - start polling, register listeners
   - `pollData()` - read all datapoints for room
   - `onCapabilityTargetTemperature()` - write comfort setpoint
   - `onCapabilityThermostatMode()` - write operating mode
   - Polling interval (configurable, default 60s)

4. Add device settings:
   - Polling interval
   - Which setpoint to use as target (Comfort/Precomfort/Economy)

### Test Criteria
- Device shows current temperature
- Device shows target temperature
- Can change target temperature from Homey
- Can change operating mode
- Values update automatically via polling

### Deliverables
- All capabilities working
- Read and write operations functional
- Git commit: "feat: implement room capabilities and polling"

---

## Phase 5: Flow Cards

### Objective
Add Flow cards for Homey automations.

### Tasks
1. Create trigger cards (`.homeycompose/flow/triggers/`):
   - `temperature_changed` - When room temperature changes
   - `mode_changed` - When operating mode changes
   - `valve_opened` - When valve position > threshold

2. Create condition cards (`.homeycompose/flow/conditions/`):
   - `temperature_above` - Temperature above X
   - `temperature_below` - Temperature below X
   - `mode_is` - Operating mode is X
   - `valve_position_above` - Valve > X%

3. Create action cards (`.homeycompose/flow/actions/`):
   - `set_temperature` - Set target temperature
   - `set_mode` - Set operating mode
   - `set_absence` - Enable/disable absence mode

4. Implement flow card handlers in `device.ts`

5. Add localization for all cards (en.json, de.json)

### Test Criteria
- All flow cards appear in Homey Flow editor
- Trigger cards fire correctly
- Condition cards evaluate correctly
- Action cards execute correctly

### Deliverables
- Complete flow card integration
- German and English localization
- Git commit: "feat: add Flow cards for automations"

---

## Phase 6: Polish, Error Handling & Documentation

### Objective
Final polish, robust error handling, and complete documentation.

### Tasks
1. Error handling improvements:
   - Connection loss recovery
   - Session timeout handling
   - Invalid credential handling
   - Offline device status

2. Add app settings page:
   - Gateway IP configuration
   - Credentials management
   - Global polling interval
   - Debug logging toggle

3. Create app store assets:
   - App icon (1024x1024)
   - Screenshots
   - Description (en/de)

4. Write README.md:
   - Installation instructions
   - Configuration guide
   - Troubleshooting
   - API documentation reference

5. Code cleanup:
   - Remove console.logs
   - Add JSDoc comments
   - Ensure consistent code style

### Test Criteria
- App handles network errors gracefully
- App reconnects after gateway restart
- Settings page works correctly
- README is complete

### Deliverables
- Production-ready app
- Complete documentation
- Git commit: "feat: polish, error handling, and documentation"
- Ready for Homey App Store submission

---

## Agent Prompts

Each agent should receive the context from `/docs/api.md` and the previous agent's work.

### Prompt Template
```
Continue developing the Homey app for Siemens OZW772/Synco Living.

## Context
- Project directory: /Users/marogg/Development/Syncoliving Homey/homey-synco
- API Documentation: /Users/marogg/Development/Syncoliving Homey/docs/api.md
- Gateway: 192.168.1.12
- Credentials: Administrator / Hossaman1976.

## Previous Work
[Summary of completed phases]

## Current Phase: [Phase X]
[Phase description and tasks from implementation-plan.md]

## Requirements
1. Complete all tasks for this phase
2. Test that everything works
3. Update documentation if needed
4. Create git commit with message: "[commit message]"
5. Provide prompt for next agent

## Test Commands
- `npm run build` - TypeScript compilation
- `homey app validate` - Homey validation
- `homey app run` - Run on Homey (requires connected Homey)
```

---

## Quick Reference: Datapoint IDs

### Wohnzimmer (Room 1)
| Function | ID | Type | Write |
|----------|-----|------|-------|
| Room temp | 5373 | Numeric | No |
| Current setpoint | 5374 | Numeric | No |
| Valve position | 5375 | Numeric | No |
| Comfort setpoint | 5358 | Numeric | Yes |
| Precomfort setpoint | 5359 | Numeric | Yes |
| Economy setpoint | 5360 | Numeric | Yes |
| Mode preselection | 5353 | Enum | Yes |
| Mode state | 5354 | Enum | No |

### Room ID Mapping
| Room | Menu ID | Offset from Room 1 |
|------|---------|-------------------|
| Wohnzimmer | 5351 | 0 |
| Gästezimmer | 5392 | +41 |
| WC/Dusche | 5433 | +82 |
| Abstellraum | 5474 | +123 |
| Zimmer Tom | 5515 | +164 |
| Elternzimmer | 5556 | +205 |
| Zimmer Juliette | 5597 | +246 |
| Gang OG | 5638 | +287 |
| Büro | 5679 | +328 |
| Badezimmer | 5720 | +369 |
| Kinderbad | 5761 | +410 |
| Eingang | 5802 | +451 |
