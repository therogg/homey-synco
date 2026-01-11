# Siemens OZW772/OZW672 Web API Documentation

## Overview

The Siemens OZW772 (and OZW672) is a web server/gateway for Synco HVAC controllers. It provides a REST-like Web API for reading and writing datapoints from connected heating/cooling systems.

**Key Facts:**
- Protocol: HTTP/HTTPS REST API with JSON responses
- Authentication: Session-based (login returns SessionId)
- Data Access: Hierarchical menu tree with numeric datapoint IDs
- Compatible Controllers: RVS, LPB/BSB bus systems, KNX devices

## API Endpoints

### Authentication

#### Login
```
GET /api/auth/login.json?user={username}&pwd={password}
```

**Response:**
```json
{
  "SessionId": "1cb30bc6-ea9f-43d7-878d-afda7943a5a1",
  "Result": {
    "Success": "true"
  }
}
```

**Notes:**
- SessionId is a UUID that changes with each login
- SessionId must be included in all subsequent requests
- Sessions expire after inactivity (timeout not documented)

---

### Menu Tree / Device Discovery

#### List Menu Tree
```
GET /api/menutree/list.json?SessionId={sessionId}
```

Returns the hierarchical structure of all available devices and datapoints.

---

### Datapoint Operations

#### Read Datapoint
```
GET /api/menutree/read_datapoint.json?SessionId={sessionId}&Id={datapointId}
```

**Response (Numeric):**
```json
{
  "Data": {
    "Type": "Numeric",
    "Value": " 10.4",
    "Unit": "°C"
  },
  "Result": {
    "Success": "true"
  }
}
```

**Response (Enumeration):**
```json
{
  "Data": {
    "Type": "Enumeration",
    "Value": "Automatik",
    "Unit": "",
    "EnumValue": "1"
  },
  "Result": {
    "Success": "true"
  }
}
```

**Notes:**
- Multiple IDs can be queried: `&Id=1253&Id=2536&Id=2535`
- Numeric values may have leading whitespace - trim before parsing
- EnumValue contains the numeric value for enumeration types

#### Read Multiple Datapoints
```
GET /api/menutree/read_datapoint.json?SessionId={sessionId}&Id={id1}&Id={id2}&Id={id3}
```

#### Write Datapoint
```
GET /api/menutree/write_datapoint.json?SessionId={sessionId}&Id={datapointId}&Type={type}&Value={value}
```

**For Enumeration Types:**
```
GET /api/menutree/write_datapoint.json?SessionId={sessionId}&Id={datapointId}&Type=Enumeration&Value={displayValue}&EnumValue={numericValue}
```

**Supported Write Types:**
- `Numeric` - Temperature setpoints, percentages
- `Enumeration` - Operating modes, on/off states

**Notes:**
- Not all datapoints support write access
- The gateway may silently ignore invalid write requests
- Test writes via the web UI first to verify writeability

#### Get Datapoint Description
```
GET /api/menutree/datapoint_desc.json?SessionId={sessionId}&Id={datapointId}
```

Returns metadata about a datapoint including name, type, unit, and access permissions.

---

## Your System: QAX910-DE Room Controller

### Device Hierarchy
```
OZW772.01 (Gateway) - ID: 4232
└── QAX910-DE (Room Controller) - ID: 4719
    └── Rooms - ID: 5350
        ├── Wohnzimmer - ID: 5351
        ├── Gästezimmer - ID: 5392
        ├── WC/Dusche - ID: 5433
        ├── Abstellraum - ID: 5474
        ├── Zimmer Tom - ID: 5515
        ├── Elternzimmer - ID: 5556
        ├── Zimmer Juliette - ID: 5597
        ├── Gang OG - ID: 5638
        ├── Büro - ID: 5679
        ├── Badezimmer - ID: 5720
        ├── Kinderbad - ID: 5761
        └── Eingang - ID: 5802
```

### Wohnzimmer Datapoints (Room 1 - ID: 5351)

#### Room State (read-only)
| ID | Datapoint | Type | Example |
|----|-----------|------|---------|
| 5373 | Actual value room temp | Numeric | 22.2 °C |
| 5374 | Current room temp setpoint | Numeric | 22.0 °C |
| 5375 | Valve position | Numeric | 92 % |
| 5376 | Economy increase | Enumeration | Inactive |
| 5377 | Setpoint limitation | Enumeration | Inactive |

#### Room Setpoints (writable)
| ID | Datapoint | Type | WriteAccess |
|----|-----------|------|-------------|
| 5358 | Comfort heating setpoint | Numeric | **true** |
| 5359 | Precomfort heating setpoint | Numeric | **true** |
| 5360 | Economy heating setpoint | Numeric | **true** |
| 5361 | Protection heating setpoint | Numeric | **true** |
| 5362 | Readjustment room unit | Numeric | **true** |

#### Room Operating Mode
| ID | Datapoint | Type | WriteAccess | Values |
|----|-----------|------|-------------|--------|
| 5353 | Preselection | Enumeration | **true** | 0=Auto, 1=Comfort, 2=Precomfort, 3=Economy, 4=Protection |
| 5354 | State | Enumeration | false | Current state |
| 5355 | Cause | Enumeration | false | Why current state |
| 5356 | Operating mode absence | Enumeration | **true** | Absence mode |

### Datapoint ID Pattern
Each room follows a similar structure with incrementing IDs:
- Room 1 (Wohnzimmer): Base ID ~5351, State IDs 5373-5377, Setpoints 5358-5362
- Room 2 (Gästezimmer): Base ID ~5392 (+41 offset)
- etc.

---

## Generic Datapoint IDs (Other Systems)

**Important:** Datapoint IDs vary by controller model and firmware. These are examples from various installations:

### Typical Temperature Datapoints
| ID | Description | Type | Unit |
|----|-------------|------|------|
| 1237 | Outside Temperature | Numeric | °C |
| 1253 | Room Temperature | Numeric | °C |
| 1200 | Return Flow Temperature | Numeric | °C |
| 2535 | Boiler Temperature | Numeric | °C |
| 2536 | Outside Temperature (alt) | Numeric | °C |

### Typical Setpoint/Control Datapoints
| ID | Description | Type | Values |
|----|-------------|------|--------|
| 2010 | Operating Mode | Enumeration | 1=Auto, 2=Reduced, 3=Comfort |
| 2011 | Comfort Temperature Setpoint | Numeric | °C |
| 2012 | Reduced Temperature Setpoint | Numeric | °C |
| 1087 | DHW (Hot Water) Mode | Enumeration | 0=Off, 1=On |

---

## Configuration Requirements

### Enable HTTP Access (recommended for local use)
Navigate in web UI: `Home > 0.x OZW772.01 > Settings > Communication > Services`
- Set "Web access via http" = ON

**Why HTTP?**
- HTTP is more reliable and faster than HTTPS on the OZW
- HTTPS requires ignoring SSL certificate validation
- For local network use, HTTP is acceptable

### Network Configuration
- Use static IP for the OZW772
- Configure Gateway & DNS if needed
- Default USB commissioning IP: 192.168.250.1

---

## Performance Considerations

- The OZW772 has limited processing power
- Limit polling to max 10 datapoints per request
- Recommended polling interval: 60 seconds minimum
- HTTP performs better than HTTPS

---

## OZW772 vs OZW672 Compatibility

Both devices share:
- Same firmware codebase
- Same Web API structure
- Same authentication mechanism

**Differences:**
- OZW772: KNX/Synco devices (up to 16 or 250 devices)
- OZW672: LPB/BSB bus systems

**API Compatibility:** The OZW772 API is expected to be compatible with OZW672 implementations, but testing is recommended.

---

## Existing Integrations (Reference)

### Home Assistant Custom Component
- Repository: [johnaherninfotrack/homeassistant_custom_siemensozw672](https://github.com/johnaherninfotrack/homeassistant_custom_siemensozw672)
- Tested with OZW672.01 firmware v11.0
- Supports: binary_sensor, sensor, switch, select, number

### OpenHAB SiemensHVAC Binding
- Repository: [openhab/openhab-addons](https://github.com/openhab/openhab-addons/tree/main/bundles/org.openhab.binding.siemenshvac)
- Uses UPnP for discovery
- OZW772 support not yet implemented

### Community Resources
- [Home Assistant Community Thread](https://community.home-assistant.io/t/siemens-webserver-ozw672/27467)
- [KNX User Forum (German)](https://knx-user-forum.de/forum/öffentlicher-bereich/knx-eib-forum/13104-siemens-webserver-ozw772-knx-ozs164-lpb/)
- [ioBroker Forum (German)](https://forum.iobroker.net/topic/3365/heizungssteuerung-mit-siemens-webserver-ozw-672)
- [Loxone Forum (German)](https://www.loxforum.com/forum/german/software-konfiguration-programm-und-visualisierung/79878-siemens-ozw672)

---

## Security Notes

- CVE advisories exist for older firmware versions
- Update to firmware V5.2 or higher (V7.0+ recommended)
- [CISA Advisory](https://www.cisa.gov/news-events/ics-advisories/icsa-24-319-03)
- Use HTTPS for remote access outside local network

---

## Example Workflow

```javascript
// 1. Login
const loginUrl = `http://${host}/api/auth/login.json?user=${user}&pwd=${password}`;
const loginResponse = await fetch(loginUrl);
const { SessionId } = await loginResponse.json();

// 2. Read outside temperature (ID may vary)
const readUrl = `http://${host}/api/menutree/read_datapoint.json?SessionId=${SessionId}&Id=1237`;
const dataResponse = await fetch(readUrl);
const data = await dataResponse.json();
// data.Data.Value = " 10.4", data.Data.Unit = "°C"

// 3. Set comfort temperature
const writeUrl = `http://${host}/api/menutree/write_datapoint.json?SessionId=${SessionId}&Id=2011&Type=Numeric&Value=21.5`;
const writeResponse = await fetch(writeUrl);

// 4. Change operating mode to Automatic
const modeUrl = `http://${host}/api/menutree/write_datapoint.json?SessionId=${SessionId}&Id=2010&Type=Enumeration&Value=Automatik&EnumValue=1`;
const modeResponse = await fetch(modeUrl);
```

---

## Next Steps for Homey Integration

1. **Test connectivity** to your OZW772 (ping, HTTP port 80)
2. **Explore your specific datapoints** via web UI or API
3. **Document your datapoint IDs** (they're installation-specific)
4. **Implement Homey app** using this API reference
