/**
 * TypeScript types for OZW772 API
 */

/**
 * Configuration for OZW772 client connection
 */
export interface OZW772Config {
  host: string;
  username: string;
  password: string;
  useHttps?: boolean;
  port?: number;
}

/**
 * Standard API result object
 */
export interface ApiResult {
  Success: string;
}

/**
 * Login response from /api/auth/login.json
 */
export interface LoginResponse {
  SessionId: string;
  Result: ApiResult;
}

/**
 * Text object containing localized strings
 */
export interface TextObject {
  Long: string;
  Short: string;
  [key: string]: string;
}

/**
 * Menu item in the menu tree hierarchy
 */
export interface MenuItem {
  Id: string;
  Text: TextObject;
  HasSubMenu?: string;
}

/**
 * Datapoint item in the menu tree
 */
export interface DatapointItem {
  Id: string;
  Address: string;
  WriteAccess: string;
  Text: TextObject;
  Type?: string;
  Unit?: string;
}

/**
 * Response from /api/menutree/list.json
 */
export interface MenuTreeResponse {
  MenuItems?: MenuItem[];
  DatapointItems?: DatapointItem[];
  Result: ApiResult;
}

/**
 * Value object for a datapoint
 */
export interface DatapointValue {
  Type: string;
  Value: string;
  Unit: string;
  EnumValue?: string;
}

/**
 * Response from /api/menutree/read_datapoint.json
 */
export interface DatapointResponse {
  Data: DatapointValue;
  Result: ApiResult;
}

/**
 * Response from /api/menutree/write_datapoint.json
 */
export interface WriteDatapointResponse {
  Result: ApiResult;
}

/**
 * Data types used in the API
 */
export type DataType = 'Numeric' | 'Enumeration';

/**
 * Room operating modes
 */
export enum OperatingMode {
  Auto = 0,
  Comfort = 1,
  Precomfort = 2,
  Economy = 3,
  Protection = 4,
}

/**
 * Room data structure for convenience
 */
export interface RoomData {
  id: string;
  name: string;
  temperature?: number;
  currentSetpoint?: number;
  comfortSetpoint?: number;
  valvePosition?: number;
  operatingMode?: OperatingMode;
}
