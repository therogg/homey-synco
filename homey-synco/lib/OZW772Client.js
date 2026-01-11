"use strict";
/**
 * OZW772 API Client
 * Handles communication with Siemens OZW772/OZW672 web gateway
 *
 * @description This client provides methods to authenticate, read, and write
 * datapoints on a Siemens OZW772/OZW672 gateway. It includes automatic session
 * management, retry logic for failed requests, and proper error handling.
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.OZW772Client = exports.OZW772Error = void 0;
const http = __importStar(require("http"));
const https = __importStar(require("https"));
const url_1 = require("url");
const constants_1 = require("./constants");
/** Default number of retry attempts for failed requests */
const DEFAULT_MAX_RETRIES = 3;
/** Delay between retry attempts in milliseconds */
const RETRY_DELAY_MS = 1000;
/**
 * Custom error class for OZW772 API errors
 */
class OZW772Error extends Error {
    constructor(message, code, isRetryable = false) {
        super(message);
        this.code = code;
        this.isRetryable = isRetryable;
        this.name = 'OZW772Error';
    }
}
exports.OZW772Error = OZW772Error;
/**
 * OZW772 API Client for Siemens web gateway communication
 */
class OZW772Client {
    /**
     * Creates a new OZW772Client instance
     * @param config - Configuration options for the client
     * @param maxRetries - Maximum number of retry attempts for failed requests (default: 3)
     */
    constructor(config, maxRetries = DEFAULT_MAX_RETRIES) {
        this.sessionId = null;
        this.config = {
            useHttps: false,
            port: config.useHttps ? constants_1.DEFAULTS.PORT_HTTPS : constants_1.DEFAULTS.PORT_HTTP,
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
    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
    /**
     * Determines if an error is retryable based on its characteristics
     * @param error - The error to check
     */
    isRetryableError(error) {
        if (error instanceof OZW772Error) {
            return error.isRetryable;
        }
        if (error instanceof Error) {
            const message = error.message.toLowerCase();
            return (message.includes('timeout') ||
                message.includes('econnrefused') ||
                message.includes('econnreset') ||
                message.includes('enotfound') ||
                message.includes('socket hang up') ||
                message.includes('network'));
        }
        return false;
    }
    /**
     * Make a single HTTP request to the OZW772 API (without retry)
     * @param path - API endpoint path
     * @param params - Query parameters
     */
    requestOnce(path, params = {}) {
        return new Promise((resolve, reject) => {
            const url = new url_1.URL(path, this.baseUrl);
            for (const [key, value] of Object.entries(params)) {
                url.searchParams.append(key, value);
            }
            const httpModule = this.config.useHttps ? https : http;
            const options = {
                hostname: this.config.host,
                port: this.config.port,
                path: `${url.pathname}${url.search}`,
                method: 'GET',
                timeout: constants_1.DEFAULTS.REQUEST_TIMEOUT_MS,
            };
            if (this.config.useHttps) {
                options.rejectUnauthorized = false;
            }
            const req = httpModule.request(options, (res) => {
                let data = '';
                res.on('data', (chunk) => {
                    data += chunk;
                });
                res.on('end', () => {
                    if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                        try {
                            const parsed = JSON.parse(data);
                            resolve(parsed);
                        }
                        catch (e) {
                            reject(new OZW772Error(`Failed to parse response from gateway: ${data.substring(0, 100)}`, 'PARSE_ERROR', false));
                        }
                    }
                    else if (res.statusCode === 401 || res.statusCode === 403) {
                        reject(new OZW772Error('Authentication failed - check username and password', 'AUTH_ERROR', false));
                    }
                    else if (res.statusCode && res.statusCode >= 500) {
                        reject(new OZW772Error(`Gateway error (HTTP ${res.statusCode})`, 'SERVER_ERROR', true));
                    }
                    else {
                        reject(new OZW772Error(`HTTP ${res.statusCode}: ${data.substring(0, 100)}`, 'HTTP_ERROR', false));
                    }
                });
            });
            req.on('error', (e) => {
                let message;
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
                        message = `Connection to gateway timed out after ${constants_1.DEFAULTS.REQUEST_TIMEOUT_MS}ms`;
                        break;
                    case 'ECONNRESET':
                        message = 'Connection to gateway was reset';
                        break;
                    case 'EHOSTUNREACH':
                        message = `Gateway at ${this.config.host} is unreachable - check network connection`;
                        break;
                    default:
                        message = `${constants_1.ERRORS.CONNECTION_FAILED}: ${e.message}`;
                }
                reject(new OZW772Error(message, e.code || 'NETWORK_ERROR', isRetryable));
            });
            req.on('timeout', () => {
                req.destroy();
                reject(new OZW772Error(`Request timed out after ${constants_1.DEFAULTS.REQUEST_TIMEOUT_MS}ms - gateway may be slow or unreachable`, 'TIMEOUT', true));
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
    async request(path, params = {}, retryCount = 0) {
        try {
            return await this.requestOnce(path, params);
        }
        catch (error) {
            if (retryCount < this.maxRetries && this.isRetryableError(error)) {
                await this.delay(RETRY_DELAY_MS * (retryCount + 1));
                return this.request(path, params, retryCount + 1);
            }
            throw error;
        }
    }
    /**
     * Login to the OZW772 and get a session ID
     * @returns The session ID for subsequent API calls
     * @throws {OZW772Error} When login fails due to invalid credentials or connection issues
     */
    async login() {
        try {
            const response = await this.request(constants_1.API_ENDPOINTS.LOGIN, {
                user: this.config.username,
                pwd: this.config.password,
            });
            if (response.Result?.Success !== 'true') {
                throw new OZW772Error('Login failed - invalid username or password', 'AUTH_ERROR', false);
            }
            this.sessionId = response.SessionId;
            return this.sessionId;
        }
        catch (error) {
            if (error instanceof OZW772Error) {
                throw error;
            }
            throw new OZW772Error(`Login failed: ${error instanceof Error ? error.message : 'Unknown error'}`, 'LOGIN_ERROR', false);
        }
    }
    /**
     * Ensure we have a valid session, login if needed
     * @throws {OZW772Error} When unable to establish a session
     */
    async ensureSession() {
        if (!this.sessionId) {
            await this.login();
        }
    }
    /**
     * Check if an error indicates session expiry
     * @param error - The error to check
     */
    isSessionError(error) {
        if (error instanceof Error) {
            return error.message.toLowerCase().includes(constants_1.ERRORS.SESSION_NOT_VALID);
        }
        return false;
    }
    /**
     * Execute an API call with automatic session refresh on session expiry
     * @param fn - Function to execute with the session ID
     * @returns The result of the function
     * @throws {OZW772Error} When the call fails after session refresh attempt
     */
    async withSession(fn) {
        await this.ensureSession();
        try {
            return await fn(this.sessionId);
        }
        catch (error) {
            if (this.isSessionError(error)) {
                this.sessionId = null;
                await this.login();
                return await fn(this.sessionId);
            }
            throw error;
        }
    }
    /**
     * Get the menu tree structure
     * @param parentId Optional parent ID to get children of
     */
    async getMenuTree(parentId) {
        return this.withSession(async (sessionId) => {
            const params = { SessionId: sessionId };
            if (parentId) {
                params.Id = parentId;
            }
            const response = await this.request(constants_1.API_ENDPOINTS.MENU_TREE, params);
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
    async readDatapoint(id) {
        return this.withSession(async (sessionId) => {
            const response = await this.request(constants_1.API_ENDPOINTS.READ_DATAPOINT, { SessionId: sessionId, Id: id });
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
    async readDatapoints(ids, onError) {
        const results = new Map();
        for (const id of ids) {
            try {
                const value = await this.readDatapoint(id);
                results.set(id, value);
            }
            catch (error) {
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
    async writeDatapoint(id, type, value, enumValue) {
        return this.withSession(async (sessionId) => {
            const params = {
                SessionId: sessionId,
                Id: id,
                Type: type,
                Value: value,
            };
            if (type === constants_1.DATA_TYPES.ENUMERATION && enumValue !== undefined) {
                params.EnumValue = enumValue;
            }
            const response = await this.request(constants_1.API_ENDPOINTS.WRITE_DATAPOINT, params);
            return response.Result?.Success === 'true';
        });
    }
    /**
     * Write a numeric value to a datapoint
     * @param id Datapoint ID
     * @param value Numeric value
     */
    async writeNumeric(id, value) {
        return this.writeDatapoint(id, constants_1.DATA_TYPES.NUMERIC, value.toString());
    }
    /**
     * Write an enumeration value to a datapoint
     * @param id Datapoint ID
     * @param displayValue Display value (e.g., "Automatik")
     * @param enumValue Numeric enum value (e.g., "1")
     */
    async writeEnumeration(id, displayValue, enumValue) {
        return this.writeDatapoint(id, constants_1.DATA_TYPES.ENUMERATION, displayValue, enumValue);
    }
    /**
     * Parse a numeric value from datapoint response
     */
    static parseNumericValue(value) {
        if (value.Type !== constants_1.DATA_TYPES.NUMERIC) {
            return null;
        }
        const parsed = parseFloat(value.Value.trim());
        return isNaN(parsed) ? null : parsed;
    }
    /**
     * Parse an enumeration value from datapoint response
     */
    static parseEnumValue(value) {
        if (value.Type !== constants_1.DATA_TYPES.ENUMERATION || !value.EnumValue) {
            return null;
        }
        const parsed = parseInt(value.EnumValue, 10);
        return isNaN(parsed) ? null : parsed;
    }
    /**
     * Get current session ID (for debugging)
     * @returns The current session ID or null if not logged in
     */
    getSessionId() {
        return this.sessionId;
    }
    /**
     * Clear the current session (force re-login on next request)
     */
    clearSession() {
        this.sessionId = null;
    }
    /**
     * Test the connection to the gateway
     * @returns True if connection and authentication succeed
     * @throws {OZW772Error} When connection fails
     */
    async testConnection() {
        try {
            await this.login();
            return true;
        }
        catch (error) {
            if (error instanceof OZW772Error) {
                throw error;
            }
            throw new OZW772Error(`Connection test failed: ${error instanceof Error ? error.message : 'Unknown error'}`, 'CONNECTION_TEST_FAILED', false);
        }
    }
    /**
     * Get the current configuration
     * @returns A copy of the client configuration (without password)
     */
    getConfig() {
        return {
            host: this.config.host,
            username: this.config.username,
            useHttps: this.config.useHttps,
            port: this.config.port,
        };
    }
}
exports.OZW772Client = OZW772Client;
