/**
 * OZW772 API Client
 * Handles communication with Siemens OZW772/OZW672 web gateway
 */

import * as http from 'http';
import * as https from 'https';
import { URL } from 'url';

import {
  OZW772Config,
  LoginResponse,
  MenuTreeResponse,
  DatapointResponse,
  DatapointValue,
  WriteDatapointResponse,
} from './types';

import {
  API_ENDPOINTS,
  DATA_TYPES,
  DEFAULTS,
  ERRORS,
} from './constants';

export class OZW772Client {
  private config: OZW772Config;
  private sessionId: string | null = null;
  private baseUrl: string;

  constructor(config: OZW772Config) {
    this.config = {
      useHttps: false,
      port: config.useHttps ? DEFAULTS.PORT_HTTPS : DEFAULTS.PORT_HTTP,
      ...config,
    };

    const protocol = this.config.useHttps ? 'https' : 'http';
    this.baseUrl = `${protocol}://${this.config.host}:${this.config.port}`;
  }

  /**
   * Make an HTTP request to the OZW772 API
   */
  private request<T>(path: string, params: Record<string, string> = {}): Promise<T> {
    return new Promise((resolve, reject) => {
      const url = new URL(path, this.baseUrl);

      for (const [key, value] of Object.entries(params)) {
        url.searchParams.append(key, value);
      }

      const httpModule = this.config.useHttps ? https : http;
      const options: http.RequestOptions = {
        hostname: this.config.host,
        port: this.config.port,
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        timeout: DEFAULTS.REQUEST_TIMEOUT_MS,
      };

      if (this.config.useHttps) {
        (options as https.RequestOptions).rejectUnauthorized = false;
      }

      const req = httpModule.request(options, (res) => {
        let data = '';

        res.on('data', (chunk) => {
          data += chunk;
        });

        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            try {
              const parsed = JSON.parse(data) as T;
              resolve(parsed);
            } catch (e) {
              reject(new Error(`Failed to parse response: ${data}`));
            }
          } else {
            reject(new Error(`HTTP ${res.statusCode}: ${data}`));
          }
        });
      });

      req.on('error', (e) => {
        reject(new Error(`${ERRORS.CONNECTION_FAILED}: ${e.message}`));
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new Error(ERRORS.TIMEOUT));
      });

      req.end();
    });
  }

  /**
   * Login to the OZW772 and get a session ID
   */
  async login(): Promise<string> {
    const response = await this.request<LoginResponse>(API_ENDPOINTS.LOGIN, {
      user: this.config.username,
      pwd: this.config.password,
    });

    if (response.Result?.Success !== 'true') {
      throw new Error(ERRORS.LOGIN_FAILED);
    }

    this.sessionId = response.SessionId;
    return this.sessionId;
  }

  /**
   * Ensure we have a valid session, login if needed
   */
  async ensureSession(): Promise<void> {
    if (!this.sessionId) {
      await this.login();
    }
  }

  /**
   * Check if an error indicates session expiry
   */
  private isSessionError(error: unknown): boolean {
    if (error instanceof Error) {
      return error.message.toLowerCase().includes(ERRORS.SESSION_NOT_VALID);
    }
    return false;
  }

  /**
   * Execute an API call with automatic session refresh
   */
  private async withSession<T>(
    fn: (sessionId: string) => Promise<T>
  ): Promise<T> {
    await this.ensureSession();

    try {
      return await fn(this.sessionId!);
    } catch (error) {
      if (this.isSessionError(error)) {
        this.sessionId = null;
        await this.login();
        return await fn(this.sessionId!);
      }
      throw error;
    }
  }

  /**
   * Get the menu tree structure
   * @param parentId Optional parent ID to get children of
   */
  async getMenuTree(parentId?: string): Promise<MenuTreeResponse> {
    return this.withSession(async (sessionId) => {
      const params: Record<string, string> = { SessionId: sessionId };
      if (parentId) {
        params.Id = parentId;
      }

      const response = await this.request<MenuTreeResponse>(
        API_ENDPOINTS.MENU_TREE,
        params
      );

      if (response.Result?.Success !== 'true') {
        throw new Error(`Failed to get menu tree: ${JSON.stringify(response.Result)}`);
      }

      return response;
    });
  }

  /**
   * Read a single datapoint value
   * @param id Datapoint ID
   */
  async readDatapoint(id: string): Promise<DatapointValue> {
    return this.withSession(async (sessionId) => {
      const response = await this.request<DatapointResponse>(
        API_ENDPOINTS.READ_DATAPOINT,
        { SessionId: sessionId, Id: id }
      );

      if (response.Result?.Success !== 'true') {
        throw new Error(`Failed to read datapoint ${id}: ${JSON.stringify(response.Result)}`);
      }

      // Trim whitespace from numeric values
      if (response.Data.Value) {
        response.Data.Value = response.Data.Value.trim();
      }

      return response.Data;
    });
  }

  /**
   * Read multiple datapoints
   * Note: The API may only return the first value when querying multiple IDs,
   * so we query each ID individually
   * @param ids Array of datapoint IDs
   */
  async readDatapoints(ids: string[]): Promise<Map<string, DatapointValue>> {
    const results = new Map<string, DatapointValue>();

    for (const id of ids) {
      try {
        const value = await this.readDatapoint(id);
        results.set(id, value);
      } catch (error) {
        console.error(`Failed to read datapoint ${id}:`, error);
      }
    }

    return results;
  }

  /**
   * Write a value to a datapoint
   * @param id Datapoint ID
   * @param type Data type (Numeric or Enumeration)
   * @param value Value to write
   * @param enumValue Optional enum value for Enumeration types
   */
  async writeDatapoint(
    id: string,
    type: string,
    value: string,
    enumValue?: string
  ): Promise<boolean> {
    return this.withSession(async (sessionId) => {
      const params: Record<string, string> = {
        SessionId: sessionId,
        Id: id,
        Type: type,
        Value: value,
      };

      if (type === DATA_TYPES.ENUMERATION && enumValue !== undefined) {
        params.EnumValue = enumValue;
      }

      const response = await this.request<WriteDatapointResponse>(
        API_ENDPOINTS.WRITE_DATAPOINT,
        params
      );

      return response.Result?.Success === 'true';
    });
  }

  /**
   * Write a numeric value to a datapoint
   * @param id Datapoint ID
   * @param value Numeric value
   */
  async writeNumeric(id: string, value: number): Promise<boolean> {
    return this.writeDatapoint(id, DATA_TYPES.NUMERIC, value.toString());
  }

  /**
   * Write an enumeration value to a datapoint
   * @param id Datapoint ID
   * @param displayValue Display value (e.g., "Automatik")
   * @param enumValue Numeric enum value (e.g., "1")
   */
  async writeEnumeration(
    id: string,
    displayValue: string,
    enumValue: string
  ): Promise<boolean> {
    return this.writeDatapoint(
      id,
      DATA_TYPES.ENUMERATION,
      displayValue,
      enumValue
    );
  }

  /**
   * Parse a numeric value from datapoint response
   */
  static parseNumericValue(value: DatapointValue): number | null {
    if (value.Type !== DATA_TYPES.NUMERIC) {
      return null;
    }
    const parsed = parseFloat(value.Value.trim());
    return isNaN(parsed) ? null : parsed;
  }

  /**
   * Parse an enumeration value from datapoint response
   */
  static parseEnumValue(value: DatapointValue): number | null {
    if (value.Type !== DATA_TYPES.ENUMERATION || !value.EnumValue) {
      return null;
    }
    const parsed = parseInt(value.EnumValue, 10);
    return isNaN(parsed) ? null : parsed;
  }

  /**
   * Get current session ID (for debugging)
   */
  getSessionId(): string | null {
    return this.sessionId;
  }

  /**
   * Clear the current session (force re-login on next request)
   */
  clearSession(): void {
    this.sessionId = null;
  }
}
