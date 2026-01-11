"use strict";
/**
 * Siemens Synco Living App for Homey
 *
 * @description Main application class for the Siemens Synco Living integration.
 * This app provides control of Siemens Synco Living room thermostats through
 * the OZW772/OZW672 web gateway.
 *
 * @version 1.0.0
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const homey_1 = __importDefault(require("homey"));
/**
 * Main application class for Siemens Synco Living
 */
class SyncoApp extends homey_1.default.App {
    /**
     * Application initialization
     * Called when the app is loaded by Homey
     */
    async onInit() {
        this.log('Siemens Synco Living app started');
        this.log(`App version: ${this.homey.manifest.version}`);
    }
}
module.exports = SyncoApp;
