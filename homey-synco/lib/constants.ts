/**
 * Constants for OZW772 API
 */

/**
 * API Endpoints
 */
export const API_ENDPOINTS = {
  LOGIN: '/api/auth/login.json',
  MENU_TREE: '/api/menutree/list.json',
  READ_DATAPOINT: '/api/menutree/read_datapoint.json',
  WRITE_DATAPOINT: '/api/menutree/write_datapoint.json',
  DATAPOINT_DESC: '/api/menutree/datapoint_desc.json',
} as const;

/**
 * Data Types
 */
export const DATA_TYPES = {
  NUMERIC: 'Numeric',
  ENUMERATION: 'Enumeration',
} as const;

/**
 * Default configuration values
 */
export const DEFAULTS = {
  PORT_HTTP: 80,
  PORT_HTTPS: 443,
  POLLING_INTERVAL_MS: 60000,
  REQUEST_TIMEOUT_MS: 10000,
} as const;

/**
 * Known device hierarchy IDs for QAX910-DE
 */
export const DEVICE_IDS = {
  GATEWAY: '4232',
  QAX910_DE: '4719',
  ROOMS: '5350',
} as const;

/**
 * Room base IDs and offset for calculating other room datapoint IDs
 */
export const ROOM_CONFIG = {
  FIRST_ROOM_ID: 5351,
  ROOM_OFFSET: 41,
  ROOMS: [
    { name: 'Wohnzimmer', baseId: 5351 },
    { name: 'Gästezimmer', baseId: 5392 },
    { name: 'WC/Dusche', baseId: 5433 },
    { name: 'Abstellraum', baseId: 5474 },
    { name: 'Zimmer Tom', baseId: 5515 },
    { name: 'Elternzimmer', baseId: 5556 },
    { name: 'Zimmer Juliette', baseId: 5597 },
    { name: 'Gang OG', baseId: 5638 },
    { name: 'Büro', baseId: 5679 },
    { name: 'Badezimmer', baseId: 5720 },
    { name: 'Kinderbad', baseId: 5761 },
    { name: 'Eingang', baseId: 5802 },
  ],
} as const;

/**
 * Datapoint offsets relative to room base ID
 * These offsets are added to the room base ID to get specific datapoint IDs
 */
export const DATAPOINT_OFFSETS = {
  MODE_PRESELECTION: 2,    // 5353 for Wohnzimmer (5351 + 2)
  MODE_STATE: 3,           // 5354
  MODE_CAUSE: 4,           // 5355
  ABSENCE_MODE: 5,         // 5356
  COMFORT_SETPOINT: 7,     // 5358
  PRECOMFORT_SETPOINT: 8,  // 5359
  ECONOMY_SETPOINT: 9,     // 5360
  PROTECTION_SETPOINT: 10, // 5361
  READJUSTMENT: 11,        // 5362
  ROOM_STATE: 21,          // 5372 - Menu containing room state datapoints
  ACTUAL_TEMP: 22,         // 5373
  CURRENT_SETPOINT: 23,    // 5374
  VALVE_POSITION: 24,      // 5375
  ECONOMY_INCREASE: 25,    // 5376
  SETPOINT_LIMITATION: 26, // 5377
} as const;

/**
 * Error messages
 */
export const ERRORS = {
  SESSION_NOT_VALID: 'session not valid',
  LOGIN_FAILED: 'Login failed',
  CONNECTION_FAILED: 'Connection failed',
  TIMEOUT: 'Request timeout',
} as const;
