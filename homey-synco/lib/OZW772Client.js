"use strict";
/**
 * OZW772 API Client
 * Handles communication with Siemens OZW772/OZW672 web gateway
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
exports.OZW772Client = void 0;
const http = __importStar(require("http"));
const https = __importStar(require("https"));
const url_1 = require("url");
const constants_1 = require("./constants");
class OZW772Client {
    constructor(config) {
        this.sessionId = null;
        this.config = {
            useHttps: false,
            port: config.useHttps ? constants_1.DEFAULTS.PORT_HTTPS : constants_1.DEFAULTS.PORT_HTTP,
            ...config,
        };
        const protocol = this.config.useHttps ? 'https' : 'http';
        this.baseUrl = `${protocol}://${this.config.host}:${this.config.port}`;
    }
    /**
     * Make an HTTP request to the OZW772 API
     */
    request(path, params = {}) {
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
                            reject(new Error(`Failed to parse response: ${data}`));
                        }
                    }
                    else {
                        reject(new Error(`HTTP ${res.statusCode}: ${data}`));
                    }
                });
            });
            req.on('error', (e) => {
                reject(new Error(`${constants_1.ERRORS.CONNECTION_FAILED}: ${e.message}`));
            });
            req.on('timeout', () => {
                req.destroy();
                reject(new Error(constants_1.ERRORS.TIMEOUT));
            });
            req.end();
        });
    }
    /**
     * Login to the OZW772 and get a session ID
     */
    async login() {
        const response = await this.request(constants_1.API_ENDPOINTS.LOGIN, {
            user: this.config.username,
            pwd: this.config.password,
        });
        if (response.Result?.Success !== 'true') {
            throw new Error(constants_1.ERRORS.LOGIN_FAILED);
        }
        this.sessionId = response.SessionId;
        return this.sessionId;
    }
    /**
     * Ensure we have a valid session, login if needed
     */
    async ensureSession() {
        if (!this.sessionId) {
            await this.login();
        }
    }
    /**
     * Check if an error indicates session expiry
     */
    isSessionError(error) {
        if (error instanceof Error) {
            return error.message.toLowerCase().includes(constants_1.ERRORS.SESSION_NOT_VALID);
        }
        return false;
    }
    /**
     * Execute an API call with automatic session refresh
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
     * @param ids Array of datapoint IDs
     */
    async readDatapoints(ids) {
        const results = new Map();
        for (const id of ids) {
            try {
                const value = await this.readDatapoint(id);
                results.set(id, value);
            }
            catch (error) {
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
}
exports.OZW772Client = OZW772Client;
