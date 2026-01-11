# Siemens Synco Living for Homey

Control your Siemens Synco Living room heating system with Homey Pro.

## Supported Devices

- **Siemens OZW772 Web Server** - Primary gateway for Synco Living systems
- **Siemens OZW672 Web Server** - Alternative gateway variant
- **Siemens QAX910 Room Controller** - Room temperature controller
- All connected room thermostats

## Features

- **Real-time temperature monitoring** - View current room temperatures
- **Target temperature control** - Set desired temperatures for each room
- **Operating mode switching** - Switch between Auto, Comfort, Economy, and other modes
- **Valve position monitoring** - See the current valve opening percentage
- **Absence mode** - Enable/disable vacation mode via flows
- **Flow cards for automations** - Full integration with Homey's flow system

## Installation

1. Install the app from Homey App Store
2. Add a new device using the "+" button
3. Select "Siemens Synco Living" and then "Room"
4. Enter your OZW772/OZW672 gateway IP address and credentials
5. Select the rooms you want to add to Homey

## Configuration

### Device Settings

Each room device has the following configurable settings:

- **Polling Interval** (default: 60 seconds) - How often to refresh data from the gateway
- **Setpoint Type** - Which temperature setpoint to control:
  - Comfort - Normal comfort temperature
  - Precomfort - Slightly reduced temperature
  - Economy - Energy-saving temperature

### Gateway Requirements

- The OZW772/OZW672 must have HTTP access enabled
- Ensure you have valid login credentials
- The gateway must be on the same network as Homey (or reachable via IP)

## Flow Cards

### Triggers

| Trigger | Description | Tokens |
|---------|-------------|--------|
| Temperature changed | When the room temperature changes | `temperature` (number) |
| Operating mode changed | When the thermostat mode changes | `mode` (string) |
| Valve opened | When the valve position changes (with threshold) | `valve_position` (number) |

### Conditions

| Condition | Description | Arguments |
|-----------|-------------|-----------|
| Temperature above | Check if temperature is above a value | `temperature` (number) |
| Temperature below | Check if temperature is below a value | `temperature` (number) |
| Mode is | Check if the current mode matches | `mode` (dropdown) |
| Valve position above | Check if valve opening is above a value | `position` (number) |

### Actions

| Action | Description | Arguments |
|--------|-------------|-----------|
| Set temperature | Set the target temperature | `temperature` (number) |
| Set mode | Set the operating mode | `mode` (dropdown) |
| Set absence mode | Enable or disable absence mode | `action` (enable/disable) |

## Operating Modes

| Mode | Description |
|------|-------------|
| Auto | Automatic mode following the schedule |
| Comfort | Comfortable room temperature |
| Precomfort | Slightly reduced temperature |
| Economy | Energy-saving mode |
| Protection | Frost protection mode |

## Troubleshooting

### Device shows "Unavailable"

1. **Check network connection** - Ensure the gateway is powered and connected
2. **Verify IP address** - Confirm the gateway IP hasn't changed
3. **Check credentials** - Verify username and password are correct
4. **Gateway access** - Ensure HTTP access is enabled on the OZW772

### Connection timeout errors

- The gateway may be slow to respond - increase the polling interval
- Check if other devices can access the gateway web interface
- Verify there are no firewall rules blocking the connection

### Temperature not updating

- Wait for the next polling interval
- Check the polling interval setting
- Verify the room exists on the gateway

### Cannot change temperature

- Ensure the setpoint type setting matches your system configuration
- Check if the room is in a mode that allows manual temperature changes
- Verify write access is enabled for your user account

## Technical Details

### API Communication

This app communicates with the OZW772/OZW672 gateway using its HTTP REST API:
- Authentication via session-based login
- Datapoint reading for sensor values
- Datapoint writing for setpoint changes
- Automatic session refresh on expiry

### Datapoint Structure

Each room has a set of datapoints identified by offset from a base ID:
- Current temperature
- Target setpoint
- Operating mode
- Valve position
- And more...

### Error Handling

The app implements robust error handling:
- Automatic retry for transient network errors (up to 3 attempts)
- Graceful degradation when connection is lost
- Automatic recovery when connection is restored
- User-friendly error messages

## Development

### Building from Source

```bash
# Install dependencies
npm install

# Compile TypeScript
npm run build

# Run the app locally (requires Homey CLI)
homey app run
```

### Project Structure

```
homey-synco/
├── app.ts                    # Main app entry point
├── lib/
│   ├── OZW772Client.ts      # API client for gateway communication
│   ├── constants.ts          # Configuration constants
│   └── types.ts              # TypeScript type definitions
├── drivers/
│   └── room/
│       ├── device.ts         # Room device implementation
│       └── driver.ts         # Room driver (pairing)
└── .homeycompose/
    ├── app.json              # App manifest
    ├── capabilities/         # Custom capability definitions
    └── flow/                 # Flow card definitions
```

## API Reference

For detailed API documentation, see [docs/api.md](../docs/api.md).

## Known Limitations

- Only rooms (QAX910) are currently supported, not other Synco system components
- The app requires HTTP access; HTTPS with self-signed certificates may not work
- German locale strings are used for some API values (e.g., "Automatik")

## Contributing

Contributions are welcome! Please feel free to submit issues or pull requests.

## License

This project is licensed under the MIT License.

## Acknowledgments

- Siemens for the Synco Living system and API documentation
- Athom for the Homey platform and SDK
