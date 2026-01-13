/**
 * OZW772 API Client
 * Handles communication with Siemens OZW772/OZW672 web gateway
 *
 * @description This client provides methods to authenticate, read, and write
 * datapoints on a Siemens OZW772/OZW672 gateway. It includes automatic session
 * management, retry logic for failed requests, and proper error handling.
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

/** Default number of retry attempts for failed requests */
const DEFAULT_MAX_RETRIES = 3;

/** Delay between retry attempts in milliseconds */
const RETRY_DELAY_MS = 1000;

/**
 * Custom error class for OZW772 API errors
 */
export class OZW772Error extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly isRetryable: boolean = false
  ) {
    super(message);
    this.name = 'OZW772Error';
  }
}

/**
 * OZW772 API Client for Siemens web gateway communication
 */
export class OZW772Client {
  private config: OZW772Config;
  private sessionId: string | null = null;
  private baseUrl: string;
  private maxRetries: number;

  /**
   * Creates a new OZW772Client instance
   * @param config - Configuration options for the client
   * @param maxRetries - Maximum number of retry attempts for failed requests (default: 3)
   */
  constructor(config: OZW772Config, maxRetries: number = DEFAULT_MAX_RETRIES) {
    this.config = {
      useHttps: false,
      port: config.useHttps ? DEFAULTS.PORT_HTTPS : DEFAULTS.PORT_HTTP,
      ...config,
    };
    this.maxRetries = maxRetries;

    const protocol = this.config.useHttps ? 'https' : 'http';
    this.baseUrl = `${protocol}://${this.config.host}:${this.config.port}`;
  }

  /**
   * Delay execution for a specified number of milliseconds
   * @param ms - Milliseconds to delay
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Determines if an error is retryable based on its characteristics
   * @param error - The error to check
   */
  private isRetryableError(error: unknown): boolean {
    if (error instanceof OZW772Error) {
      return error.isRetryable;
    }
    if (error instanceof Error) {
      const message = error.message.toLowerCase();
      return (
        message.includes('timeout') ||
        message.includes('econnrefused') ||
        message.includes('econnreset') ||
        message.includes('enotfound') ||
        message.includes('socket hang up') ||
        message.includes('network')
      );
    }
    return false;
  }

  /**
   * Make a single HTTP request to the OZW772 API (without retry)
   * @param path - API endpoint path
   * @param params - Query parameters
   */
  private requestOnce<T>(path: string, params: Record<string, string> = {}): Promise<T> {
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
              reject(new OZW772Error(
                `Failed to parse response from gateway: ${data.substring(0, 100)}`,
                'PARSE_ERROR',
                false
              ));
            }
          } else if (res.statusCode === 401 || res.statusCode === 403) {
            reject(new OZW772Error(
              'Authentication failed - check username and password',
              'AUTH_ERROR',
              false
            ));
          } else if (res.statusCode && res.statusCode >= 500) {
            reject(new OZW772Error(
              `Gateway error (HTTP ${res.statusCode})`,
              'SERVER_ERROR',
              true
            ));
          } else {
            reject(new OZW772Error(
              `HTTP ${res.statusCode}: ${data.substring(0, 100)}`,
              'HTTP_ERROR',
              false
            ));
          }
        });
      });

      req.on('error', (e: NodeJS.ErrnoException) => {
        let message: string;
        let isRetryable = true;

        switch (e.code) {
          case 'ECONNREFUSED':
            message = `Cannot connect to gateway at ${this.config.host}:${this.config.port} - connection refused`;
            break;
          case 'ENOTFOUND':
            message = `Gateway not found - check the hostname: ${this.config.host}`;
            isRetryable = false;
            break;
          case 'ETIMEDOUT':
          case 'ESOCKETTIMEDOUT':
            message = `Connection to gateway timed out after ${DEFAULTS.REQUEST_TIMEOUT_MS}ms`;
            break;
          case 'ECONNRESET':
            message = 'Connection to gateway was reset';
            break;
          case 'EHOSTUNREACH':
            message = `Gateway at ${this.config.host} is unreachable - check network connection`;
            break;
          default:
            message = `${ERRORS.CONNECTION_FAILED}: ${e.message}`;
        }

        reject(new OZW772Error(message, e.code || 'NETWORK_ERROR', isRetryable));
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new OZW772Error(
          `Request timed out after ${DEFAULTS.REQUEST_TIMEOUT_MS}ms - gateway may be slow or unreachable`,
          'TIMEOUT',
          true
        ));
      });

      req.end();
    });
  }

  /**
   * Make an HTTP request to the OZW772 API with automatic retry
   * @param path - API endpoint path
   * @param params - Query parameters
   * @param retryCount - Current retry attempt (internal use)
   */
  private async request<T>(
    path: string,
    params: Record<string, string> = {},
    retryCount: number = 0
  ): Promise<T> {
    try {
      return await this.requestOnce<T>(path, params);
    } catch (error) {
      if (retryCount < this.maxRetries && this.isRetryableError(error)) {
        await this.delay(RETRY_DELAY_MS * (retryCount + 1));
        return this.request<T>(path, params, retryCount + 1);
      }
      throw error;
    }
  }

  /**
   * Login to the OZW772 and get a session ID
   * @returns The session ID for subsequent API calls
   * @throws {OZW772Error} When login fails due to invalid credentials or connection issues
   */
  async login(): Promise<string> {
    try {
      const response = await this.request<LoginResponse>(API_ENDPOINTS.LOGIN, {
        user: this.config.username,
        pwd: this.config.password,
      });

      if (response.Result?.Success !== 'true') {
        throw new OZW772Error(
          'Login failed - invalid username or password',
          'AUTH_ERROR',
          false
        );
      }

      this.sessionId = response.SessionId;
      return this.sessionId;
    } catch (error) {
      if (error instanceof OZW772Error) {
        throw error;
      }
      throw new OZW772Error(
        `Login failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'LOGIN_ERROR',
        false
      );
    }
  }

  /**
   * Ensure we have a valid session, login if needed
   * @throws {OZW772Error} When unable to establish a session
   */
  async ensureSession(): Promise<void> {
    if (!this.sessionId) {
      await this.login();
    }
  }

  /**
   * Check if an error indicates session expiry
   * @param error - The error to check
   */
  private isSessionError(error: unknown): boolean {
    if (error instanceof Error) {
      return error.message.toLowerCase().includes(ERRORS.SESSION_NOT_VALID);
    }
    return false;
  }

  /**
   * Execute an API call with automatic session refresh on session expiry
   * @param fn - Function to execute with the session ID
   * @returns The result of the function
   * @throws {OZW772Error} When the call fails after session refresh attempt
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
   * @param ids - Array of datapoint IDs
   * @param onError - Optional callback for individual datapoint errors
   * @returns Map of successfully read datapoint values
   */
  async readDatapoints(
    ids: string[],
    onError?: (id: string, error: Error) => void
  ): Promise<Map<string, DatapointValue>> {
    const results = new Map<string, DatapointValue>();

    for (const id of ids) {
      try {
        const value = await this.readDatapoint(id);
        results.set(id, value);
      } catch (error) {
        if (onError && error instanceof Error) {
          onError(id, error);
        }
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
      };

      // For enumeration types, try sending only EnumValue (some APIs prefer this)
      if (type === DATA_TYPES.ENUMERATION && enumValue !== undefined) {
        params.EnumValue = enumValue;
        // Also include Value for APIs that require both
        params.Value = value;
      } else {
        params.Value = value;
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
    // OZW772 API expects values with one decimal place (e.g., "22.0" not "22")
    const formattedValue = value.toFixed(1);
    return this.writeDatapoint(id, DATA_TYPES.NUMERIC, formattedValue);
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
   * @returns The current session ID or null if not logged in
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

  /**
   * Test the connection to the gateway
   * @returns True if connection and authentication succeed
   * @throws {OZW772Error} When connection fails
   */
  async testConnection(): Promise<boolean> {
    try {
      await this.login();
      return true;
    } catch (error) {
      if (error instanceof OZW772Error) {
        throw error;
      }
      throw new OZW772Error(
        `Connection test failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'CONNECTION_TEST_FAILED',
        false
      );
    }
  }

  /**
   * Get the current configuration
   * @returns A copy of the client configuration (without password)
   */
  getConfig(): Omit<OZW772Config, 'password'> {
    return {
      host: this.config.host,
      username: this.config.username,
      useHttps: this.config.useHttps,
      port: this.config.port,
    };
  }

  /**
   * Get datapoint description including min/max values and write permissions
   * @param id Datapoint ID
   */
  async getDatapointDesc(id: string): Promise<Record<string, unknown>> {
    return this.withSession(async (sessionId) => {
      const response = await this.request<Record<string, unknown>>(
        API_ENDPOINTS.DATAPOINT_DESC,
        { SessionId: sessionId, Id: id }
      );
      return response;
    });
  }
}
