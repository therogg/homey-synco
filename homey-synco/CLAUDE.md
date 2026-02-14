# Homey Synco Living App

## Project Overview
Homey smart home app for Siemens Synco Living (OZW772/OZW672 gateway). Controls room temperature regulators and ventilation via the gateway's web API.

## Architecture
- **Homey SDK 3** with TypeScript
- **Two drivers:** `gateway` (sensor) and `room` (heater)
- **API client:** `lib/OZW772Client.ts` — HTTP/HTTPS communication with gateway
- **Compose-based:** Edit `.homeycompose/` files, then `npx homey app compose` regenerates `app.json`

## Key Patterns
- Gateway API uses menu tree structure (IDs like `5350` for rooms list)
- Room datapoints are calculated: `roomBaseId + DATAPOINT_OFFSETS.X`
- Device polling with staggered startup (0-30s random delay) and failure/recovery thresholds
- Temperature setpoint changes are debounced (2s)
- HTTPS auto-detection for newer firmware (v12+)

## Device Types
- **Gateway:** Outside temp, air pressure, ventilation mode/stage. Class: `sensor`
- **Room:** Temperature, setpoints (comfort/precomfort/economy/protection), valve position, thermostat mode. Class: `heater`
- Gateway driver can also create room-type devices (store.deviceType = 'room') with dynamic capabilities

## Build & Test
```bash
npm run build          # TypeScript compile
npx homey app compose  # Regenerate app.json from .homeycompose
npx homey app run      # Run on Homey (development)
npx homey app install  # Install on Homey
```

## Important Constants
- `DEVICE_IDS.ROOMS = '5350'` — Menu tree ID for room discovery
- `GATEWAY_DATAPOINTS` — Fixed IDs for gateway-level data (4725, 4726, 5862, 5884)
- `DATAPOINT_OFFSETS` — Offsets added to room base ID for specific data points

## Constraints
- Homey SDK 3 `list_devices` only creates devices of the current driver type
- No API for cross-driver device creation — room devices in gateway flow use dynamic capabilities
- Flow cards filter by capability (not driver_id) to support both driver types
