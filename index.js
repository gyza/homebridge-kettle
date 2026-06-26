'use strict'

const request = require('./request-shim')
const url = require('url')

let Service, Characteristic
const PATCH_VERSION = "1.2.0"
const PATCH_NAME = `KettlePatched v${PATCH_VERSION}`

module.exports = (homebridge) => {
    Service = homebridge.hap.Service
    Characteristic = homebridge.hap.Characteristic
    homebridge.registerAccessory("homebridge-kettle", "MyKettle", StaggEKGUnifiedAccessory)
    homebridge.registerAccessory("homebridge-kettle", "MyKettleProWifi", StaggEKGProWifiAccessory)
}

// ===================================================================
// PATCHED StaggEKGProWifiAccessory
// Changes:
//   - request timeout (default 8s, configurable)
//   - HTTP status code checks (non-200 = error)
//   - Added CurrentHeatingCoolingState handler
//   - Optional heartbeat keepalive (configurable interval, on-state only)
//   - Error recovery: on transient failure, report last-known value to HomeKit;
//     if unreachable for >30s, accessory goes 'No Response' briefly
//   - v1.1.0: HA HTTP-CLI ports: richer state parsing, firmware info,
//     Pre-Boil switch, no-water / on-base diagnostics, no auto-heat on temp set
//   - v1.1.1: map water status as ContactSensor instead of LeakSensor
//   - v1.2.0: coalesce/cache state reads and avoid heartbeat timer churn
// ===================================================================

class StaggEKGProWifiAccessory {
    constructor (log, config) {
        this.log = log
        this.config = config || {}
        this.service = new Service.Thermostat(this.config.name)
        this.preBoilService = new Service.Switch(`${this.config.name} Pre-Boil`, "pre-boil")
        this.onBaseService = new Service.ContactSensor(`${this.config.name} On Base`, "on-base")
        this.noWaterService = new Service.ContactSensor(`${this.config.name} Water OK`, "water-ok")
        this.url = this.config.url
        this.tempDisplayUnits = 0
        this.patchVersion = PATCH_VERSION

        // Configurable ranges
        this.minTemp = (typeof this.config.minTemp === "number") ? this.config.minTemp : 40
        this.maxTemp = (typeof this.config.maxTemp === "number") ? this.config.maxTemp : 100

        // Configurable request timeout (ms). Default 8000; min 2000.
        this.reqTimeout = Math.max(2000, (typeof this.config.reqTimeout === "number" ? this.config.reqTimeout : 8000))

        // Configurable heartbeat interval (ms). Default 30000; 0 = disabled.
        this.heartbeatMs = (typeof this.config.heartbeatMs === "number") ? this.config.heartbeatMs : 30000

        // The EKG Pro HTTP CLI is small and slow; HomeKit often asks for several
        // characteristics together. Coalesce those reads and keep a tiny cache.
        this.stateCacheMs = Math.max(0, (typeof this.config.stateCacheMs === "number" ? this.config.stateCacheMs : 1500))
        this.settingsCacheMs = Math.max(0, (typeof this.config.settingsCacheMs === "number" ? this.config.settingsCacheMs : 30000))

        // Build /cli URL
        const baseUrl = (this.url || "").replace(/\?.*$/, "")
        if (baseUrl.endsWith("/cli")) {
            this.cliUrl = baseUrl
        } else {
            this.cliUrl = baseUrl.replace(/\/+$/, "") + "/cli"
        }

        // Last-known values for graceful degradation
        this._lastCurrentTemp = null
        this._lastTargetTemp = null
        this._lastState = 0  // 0=Off, 1=Heat
        this._lastBoil = false
        this._lastLifted = false
        this._lastNoWater = false
        this._lastMode = null
        this._lastFirmwareRevision = PATCH_VERSION
        this._unreachable = false
        this._unreachableSince = null
        this._unreachableThresholdMs = 30000

        // Heartbeat timer
        this._heartbeatTimer = null
        this._stateBodyCache = null
        this._settingsBodyCache = null
        this._stateReadQueue = []
        this._settingsReadQueue = []
        this._stateReadInFlight = false
        this._settingsReadInFlight = false

        this.log(`[${PATCH_NAME}] reqTimeout=${this.reqTimeout}ms heartbeatMs=${this.heartbeatMs}ms stateCacheMs=${this.stateCacheMs}ms settingsCacheMs=${this.settingsCacheMs}ms cliUrl=${this.cliUrl}`)
    }

    getServices () {
        const informationService = new Service.AccessoryInformation()
        this.informationService = informationService
        informationService
            .setCharacteristic(Characteristic.Manufacturer, "Fellow")
            .setCharacteristic(Characteristic.Model, `Stagg EKG Pro (patched ${PATCH_VERSION})`)
            .setCharacteristic(Characteristic.SerialNumber, "123-456-789")
            .setCharacteristic(Characteristic.FirmwareRevision, this._lastFirmwareRevision)

        this.service.getCharacteristic(Characteristic.TargetHeatingCoolingState)
            .on('get', this.getTargetHeatingCoolingStateCharacteristicHandler.bind(this))
            .on('set', this.setTargetHeatingCoolingStateCharacteristicHandler.bind(this))

        this.service.getCharacteristic(Characteristic.TargetTemperature)
            .on('get', this.getTargetTemperatureHandler.bind(this))
            .on('set', this.setTargetTemperatureHandler.bind(this))
            .setProps({
                maxValue: this.maxTemp,
                minValue: this.minTemp,
                unit: 1
            })

        this.service.getCharacteristic(Characteristic.CurrentTemperature)
            .on('get', this.getCurrentTemperatureHandler.bind(this))
            .setProps({
                maxValue: this.maxTemp,
                minValue: 0,
                unit: 1
            })

        this.service.getCharacteristic(Characteristic.TemperatureDisplayUnits)
            .on('get', this.getTemperatureDisplayUnitsHandler.bind(this))
            .on('set', this.setTemperatureDisplayUnitsHandler.bind(this))

        this.service.getCharacteristic(Characteristic.CurrentHeatingCoolingState)
            .on('get', this.getCurrentHeatingCoolingStateHandler.bind(this))
            .setProps({validValues: [0, 1]})

        this.service.getCharacteristic(Characteristic.TargetHeatingCoolingState)
            .setProps({validValues: [0, 1]})

        this.service.getCharacteristic(Characteristic.StatusFault)
            .on('get', this.getStatusFaultHandler.bind(this))

        this.preBoilService.getCharacteristic(Characteristic.On)
            .on('get', this.getPreBoilHandler.bind(this))
            .on('set', this.setPreBoilHandler.bind(this))

        this.onBaseService.getCharacteristic(Characteristic.ContactSensorState)
            .on('get', this.getOnBaseHandler.bind(this))

        this.noWaterService.getCharacteristic(Characteristic.ContactSensorState)
            .on('get', this.getNoWaterHandler.bind(this))

        setTimeout(() => this._refreshFirmwareRevision(), 1000)

        return [informationService, this.service, this.preBoilService, this.onBaseService, this.noWaterService]
    }

    // ---- Handlers ----

    getCurrentHeatingCoolingStateHandler (callback) {
        this.log.debug(`calling getCurrentHeatingCoolingStateHandler`)
        this._readState(false, (error, details) => {
            if (error) return callback(error)
            callback(null, details.state)
        })
    }

    getTargetHeatingCoolingStateCharacteristicHandler (callback) {
        this.log.debug(`calling getTargetHeatingCoolingStateCharacteristicHandler`)
        this._readState(false, (error, details) => {
            if (error) return callback(error)
            callback(null, details.state)
        })
    }

    setTargetHeatingCoolingStateCharacteristicHandler (value, callback) {
        this.log(`calling setTargetHeatingCoolingStateCharacteristicHandler`, value)
        const state = this._stateForHomeKit(value)
        this._cliCommand(`setstate ${state}`, (error) => {
            if (error) return callback(error)
            this._invalidateReadCaches()
            this._lastState = value
            this.service.updateCharacteristic(Characteristic.TargetHeatingCoolingState, value)
            this.service.updateCharacteristic(Characteristic.CurrentHeatingCoolingState, value)
            this._manageHeartbeat()
            callback(null, value)
        })
    }

    getTargetTemperatureHandler (callback) {
        this.log.debug(`calling getTargetTemperatureHandler`)
        this._readState(false, (error, details) => {
            if (error) return callback(error)
            callback(null, details.targetTemp)
        })
    }

    setTargetTemperatureHandler (value, callback) {
        this.log(`calling setTargetTemperatureHandler`, value)
        const targetF = Math.round(this._cToF(value))
        this._cliCommand(`setsetting settempr ${targetF}`, (error) => {
            if (error) return callback(error)
            this._invalidateReadCaches()
            this._lastTargetTemp = value
            this.service.updateCharacteristic(Characteristic.TargetTemperature, value)
            callback(null, value)
        })
    }

    getCurrentTemperatureHandler (callback) {
        this.log.debug(`calling getCurrentTemperatureHandler`)
        this._readState(false, (error, details) => {
            if (error) return callback(error)
            callback(null, details.currentTemp)
        })
    }

    getTemperatureDisplayUnitsHandler (callback) {
        this.log.debug(`calling getTemperatureDisplayUnitsHandler`, this.tempDisplayUnits)
        callback(null, this.tempDisplayUnits)
    }

    setTemperatureDisplayUnitsHandler (value, callback) {
        this.log.debug(`calling setTemperatureDisplayUnitsHandler`, value)
        callback(null, this.tempDisplayUnits)
    }

    getStatusFaultHandler (callback) {
        callback(null, this._lastNoWater || this._lastLifted ? 1 : 0)
    }

    getPreBoilHandler (callback) {
        this.log.debug(`calling getPreBoilHandler`)
        this._readState(true, (error, details) => {
            if (error) return callback(error)
            callback(null, Boolean(details.boil))
        })
    }

    setPreBoilHandler (value, callback) {
        this.log(`calling setPreBoilHandler`, value)
        this._cliCommand(`setsetting boil ${value ? 1 : 0}`, (error) => {
            if (error) return callback(error)
            this._invalidateSettingsCache()
            this._lastBoil = Boolean(value)
            this.preBoilService.updateCharacteristic(Characteristic.On, this._lastBoil)
            callback(null, this._lastBoil)
        })
    }

    getOnBaseHandler (callback) {
        // Return last-known value immediately; avoid slow HTTP on HomeKit poll.
        callback(null, this._lastLifted ? 1 : 0)
        // Background refresh if cache is stale
        this._readState(false, (error, details) => {
            if (!error) {
                this.onBaseService.updateCharacteristic(Characteristic.ContactSensorState, details.lifted ? 1 : 0)
            }
        })
    }

    getNoWaterHandler (callback) {
        // Return last-known value immediately; avoid slow HTTP on HomeKit poll.
        callback(null, this._lastNoWater ? 1 : 0)
        // Background refresh if cache is stale
        this._readState(false, (error, details) => {
            if (!error) {
                this.noWaterService.updateCharacteristic(Characteristic.ContactSensorState, details.noWater ? 1 : 0)
            }
        })
    }

    // ---- Heartbeat ----

    _manageHeartbeat () {
        const shouldRun = this.heartbeatMs > 0 && this._lastState === 1
        if (!shouldRun) {
            this._clearHeartbeat()
            return
        }
        if (this._heartbeatTimer) {
            return
        }
        this._heartbeatTimer = setInterval(() => {
            this._readState(false, (error) => {
                if (error) {
                    this.log.debug(`[Heartbeat] keepalive failed: ${error.message}`)
                }
            })
        }, this.heartbeatMs)
        this._heartbeatTimer.unref && this._heartbeatTimer.unref()
    }

    _clearHeartbeat () {
        if (this._heartbeatTimer) {
            clearInterval(this._heartbeatTimer)
            this._heartbeatTimer = null
        }
    }

    // ---- Kettle state ----

    _readState (includeSettings, callback) {
        this._getStateBody((error, body) => {
            if (error) return this._handleReadError(error, callback)

            if (!includeSettings) {
                const details = this._parseStateDetails(body, "")
                this._applyStateDetails(details)
                callback(null, details)
                return
            }

            this._getSettingsBody((settingsError, settingsBody) => {
                if (settingsError) return this._handleReadError(settingsError, callback)
                const details = this._parseStateDetails(body, settingsBody)
                this._applyStateDetails(details)
                callback(null, details)
            })
        })
    }

    _getStateBody (callback) {
        const cached = this._freshCache(this._stateBodyCache, this.stateCacheMs)
        if (cached !== null) {
            callback(null, cached)
            return
        }

        this._stateReadQueue.push(callback)
        if (this._stateReadInFlight) {
            return
        }

        this._stateReadInFlight = true
        this._cliCommand("state", (error, body) => {
            if (!error) {
                this._stateBodyCache = {
                    body,
                    ts: Date.now()
                }
            }
            this._stateReadInFlight = false
            const queue = this._stateReadQueue.splice(0)
            queue.forEach((queuedCallback) => queuedCallback(error, body))
        })
    }

    _getSettingsBody (callback) {
        const cached = this._freshCache(this._settingsBodyCache, this.settingsCacheMs)
        if (cached !== null) {
            callback(null, cached)
            return
        }

        this._settingsReadQueue.push(callback)
        if (this._settingsReadInFlight) {
            return
        }

        this._settingsReadInFlight = true
        this._cliCommand("prtsettings", (error, body) => {
            if (!error) {
                this._settingsBodyCache = {
                    body,
                    ts: Date.now()
                }
            }
            this._settingsReadInFlight = false
            const queue = this._settingsReadQueue.splice(0)
            queue.forEach((queuedCallback) => queuedCallback(error, body))
        })
    }

    _freshCache (cache, maxAgeMs) {
        if (!cache || maxAgeMs <= 0) {
            return null
        }
        return (Date.now() - cache.ts) <= maxAgeMs ? cache.body : null
    }

    _invalidateReadCaches () {
        this._invalidateStateCache()
        this._invalidateSettingsCache()
    }

    _invalidateStateCache () {
        this._stateBodyCache = null
    }

    _invalidateSettingsCache () {
        this._settingsBodyCache = null
    }

    _handleReadError (error, callback) {
        const hasFallback = this._lastCurrentTemp !== null || this._lastTargetTemp !== null
        const tooOld = this._unreachableSince && (Date.now() - this._unreachableSince > this._unreachableThresholdMs)
        if (!hasFallback || tooOld) {
            callback(error)
            return
        }

        callback(null, {
            state: this._lastState,
            currentTemp: this._lastCurrentTemp,
            targetTemp: this._lastTargetTemp,
            boil: this._lastBoil,
            lifted: this._lastLifted,
            noWater: this._lastNoWater,
            mode: this._lastMode,
        })
    }

    _applyStateDetails (details) {
        if (details.state !== null) {
            this._lastState = details.state
            this.service.updateCharacteristic(Characteristic.CurrentHeatingCoolingState, details.state)
            this.service.updateCharacteristic(Characteristic.TargetHeatingCoolingState, details.state)
        }
        if (details.currentTemp !== null) {
            this._lastCurrentTemp = details.currentTemp
            this.service.updateCharacteristic(Characteristic.CurrentTemperature, details.currentTemp)
        }
        if (details.targetTemp !== null) {
            this._lastTargetTemp = details.targetTemp
            this.service.updateCharacteristic(Characteristic.TargetTemperature, details.targetTemp)
        }
        if (details.tempDisplayUnits !== null) {
            this.tempDisplayUnits = details.tempDisplayUnits
            this.service.updateCharacteristic(Characteristic.TemperatureDisplayUnits, details.tempDisplayUnits)
        }
        if (details.boil !== null) {
            this._lastBoil = details.boil
            this.preBoilService.updateCharacteristic(Characteristic.On, details.boil)
        }
        this._lastLifted = Boolean(details.lifted)
        this._lastNoWater = Boolean(details.noWater)
        this._lastMode = details.mode || this._lastMode
        this.onBaseService.updateCharacteristic(Characteristic.ContactSensorState, this._lastLifted ? 1 : 0)
        this.noWaterService.updateCharacteristic(Characteristic.ContactSensorState, this._lastNoWater ? 1 : 0)
        this.service.updateCharacteristic(Characteristic.StatusFault, this._lastNoWater || this._lastLifted ? 1 : 0)
        this._manageHeartbeat()
    }

    _refreshFirmwareRevision () {
        this._cliCommand("fwinfo", (error, body) => {
            if (error) {
                this.log.debug(`[${PATCH_NAME}] firmware read failed: ${error.message}`)
                return
            }
            const version = this._parseFirmwareRevision(body)
            if (!version) return
            this._lastFirmwareRevision = version
            if (this.informationService) {
                this.informationService.updateCharacteristic(Characteristic.FirmwareRevision, version)
            }
        })
    }

    // ---- CLI wrapper with timeout + status check ----

    _cliCommand (cmd, callback) {
        if (!this.cliUrl || this.cliUrl === "/cli") {
            callback(new Error("Missing kettle url; set config.url to the kettle base URL."))
            return
        }
        const encodedCmd = this._encodeCliCommand(cmd)
        const cmdUrl = `${this.cliUrl}?cmd=${encodedCmd}`

        request({
            url: cmdUrl,
            method: "GET",
            timeout: this.reqTimeout,       // <-- PATCH: fail fast
            json: false,
            maxAttempts: 1
        }, (error, response, body) => {
            if (error) {
                this._markUnreachable()
                callback(error)
                return
            }
            // <-- PATCH: check HTTP status
            if (response && response.statusCode !== 200) {
                this._markUnreachable()
                callback(new Error(`Kettle HTTP ${response.statusCode} for cmd "${cmd}"`))
                return
            }
            this._markReachable()
            callback(null, body)
        })
    }

    _markReachable () {
        this._unreachable = false
        this._unreachableSince = null
    }

    _markUnreachable () {
        if (!this._unreachable) {
            this._unreachable = true
            this._unreachableSince = Date.now()
        }
    }

    _encodeCliCommand (cmd) {
        return String(cmd).replace(/ /g, "+")
    }

    // ---- Parsers ----

    _parseFirstNumber (body) {
        const match = (body || "").match(/-?\d+(?:\.\d+)?/)
        return match ? parseFloat(match[0]) : null
    }

    _parseState (body) {
        const mode = this._parseMode(body)
        if (!mode) return null
        if (/^S_(Heat|Hold|StartupToTempr|Boil|Calib_(Started|finish))/i.test(mode)) {
            return 1
        }
        if (/^S_Off/i.test(mode)) {
            return 0
        }
        return null
    }

    _stateForHomeKit (value) {
        return value === 1 ? "S_Heat" : "S_Off"
    }

    _parseSetting (body, name) {
        const re = new RegExp(`${name}\\s*[:=]\\s*(-?\\d+(?:\\.\\d+)?)`, "i")
        const match = (body || "").match(re)
        if (match) {
            return parseFloat(match[1])
        }
        return this._parseFirstNumber(body)
    }

    _parseTemp (body) {
        for (const label of ["tempr", "tempsc", "temps"]) {
            const labeled = this._parseTempLine(body, label)
            if (labeled !== null) return labeled
        }
        return null
    }

    _parseTargetTemp (body) {
        for (const label of ["temprT", "settempr", "tempsc", "temps"]) {
            const labeled = this._parseTempLine(body, label)
            if (labeled !== null) return labeled
        }
        return null
    }

    _parseTempLine (body, label) {
        const re = new RegExp(`\\b${label}\\s*=\\s*(nan|-?\\d+(?:\\.\\d+)?)\\s*([CF])?`, "i")
        const match = (body || "").match(re)
        if (!match) {
            return null
        }
        if (String(match[1]).toLowerCase() === "nan") {
            return null
        }
        const numberMatch = String(match[1]).match(/-?\d+(?:\.\d+)?/)
        if (!numberMatch) {
            return null
        }
        const value = parseFloat(numberMatch[0])
        const unit = (match[2] || "C").toUpperCase()
        if (unit === "F") {
            return this._fToC(value)
        }
        return value
    }

    _parseStateDetails (stateBody, settingsBody) {
        const mode = this._parseMode(stateBody)
        const currentTemp = this._parseTemp(stateBody)
        const targetTemp = this._parseTargetTemp(stateBody) || this._parseTargetTemp(settingsBody)
        const units = this._parseUnitsFlag(stateBody) || this._parseUnitsFlag(settingsBody)
        const state = this._parseState(stateBody)
        const boil = this._parseBoil(settingsBody) ?? this._parseBoil(stateBody)

        return {
            mode,
            state,
            currentTemp: this._validRange(currentTemp, 0, 120) ? currentTemp : this._lastCurrentTemp,
            targetTemp: this._validRange(targetTemp, 30, 100) ? targetTemp : this._lastTargetTemp,
            tempDisplayUnits: units === "F" ? 1 : (units === "C" ? 0 : null),
            boil,
            lifted: this._parseLifted(stateBody),
            noWater: this._parseNoWater(stateBody),
            screenName: this._parseScreenName(stateBody),
        }
    }

    _validRange (value, min, max) {
        return typeof value === "number" && !Number.isNaN(value) && value >= min && value <= max
    }

    _parseMode (body) {
        const match = (body || "").match(/\bmode\s*=\s*([A-Za-z0-9_+]+)/i)
        return match ? match[1].toUpperCase() : null
    }

    _parseUnitsFlag (body) {
        const match = (body || "").match(/\bunits\s*=?\s*(\d+)/i)
        if (!match) return null
        return match[1] === "1" ? "C" : "F"
    }

    _parseBoil (body) {
        const match = (body || "").match(/\bboil\s*=?\s*(\d+)/i)
        return match ? parseInt(match[1], 10) === 1 : null
    }

    _parseLifted (body) {
        return /\btempr\s*=\s*nan\b/i.test(body || "")
    }

    _parseNoWater (body) {
        const direct = (body || "").match(/\bnw\s*=?\s*(\d+)/i)
        if (direct) return direct[1] === "1"
        const mode = this._parseMode(body)
        return mode ? mode.includes("NOWATER") : false
    }

    _parseScreenName (body) {
        const match = (body || "").match(/\bscrname\s*=\s*([^\r\n ]+)/i)
        return match ? match[1].replace(".png", "").replace("-", " ").trim() : null
    }

    _parseFirmwareRevision (body) {
        if (!body) return null
        const current = body.match(/Current version:\s*([^\s\r\n]+)/i)
        if (current) return current[1].trim()
        const version = body.match(/fw version\s+([^\s\r\n]+)/i)
        return version ? version[1].trim() : null
    }

    _fToC (f) {
        return (f - 32) / 1.8
    }

    _cToF (c) {
        return (c * 1.8) + 32
    }
}


class StaggEKGUnifiedAccessory {
    constructor (log, config) {
        const mode = String((config && (config.connection || config.mode)) || '').toLowerCase()
        const isWifi = (config && config.accessory === 'MyKettleProWifi') || mode === 'wifi' || mode === 'cli'
        if (isWifi) {
            return new StaggEKGProWifiAccessory(log, config)
        }
        return new StaggEKGPlusAccessory(log, config)
    }
}


class StaggEKGPlusAccessory {
    constructor (log, config) {
        this.log = log
        this.config = config
        this.service = new Service.Thermostat(this.config.name)
        this.url = this.config.url
        this.tempDisplayUnits = 0

        this.minTemp = (typeof this.config.minTemp === "number") ? this.config.minTemp : 40
        this.maxTemp = (typeof this.config.maxMax === "number") ? this.config.maxTemp : 100
    }

    getServices () {
        const informationService = new Service.AccessoryInformation()
        informationService
            .setCharacteristic(Characteristic.Manufacturer, "Fellow")
            .setCharacteristic(Characteristic.Model, "Stagg EKG+")
            .setCharacteristic(Characteristic.SerialNumber, "123-456-789")

        this.service.getCharacteristic(Characteristic.TargetHeatingCoolingState)
            .on('get', this.getTargetHeatingCoolingStateCharacteristicHandler.bind(this))
            .on('set', this.setTargetHeatingCoolingStateCharacteristicHandler.bind(this))

        this.service.getCharacteristic(Characteristic.TargetTemperature)
            .on('get', this.getTargetTemperatureHandler.bind(this))
            .on('set', this.setTargetTemperatureHandler.bind(this))
            .setProps({
                maxValue: this.maxTemp,
                minValue: this.minTemp,
                unit: 1
            })

        this.service.getCharacteristic(Characteristic.CurrentTemperature)
            .setProps({
                maxValue: this.maxTemp,
                minValue: 0,
                unit: 1
            })

        this.service.getCharacteristic(Characteristic.TemperatureDisplayUnits)
            .setProps({value: this.tempDisplayUnits})

        this.service.getCharacteristic(Characteristic.CurrentTemperature)
            .on('get', this.getCurrentTemperatureHandler.bind(this))

        this.service.getCharacteristic(Characteristic.TemperatureDisplayUnits)
            .on('get', this.getTemperatureDisplayUnitsHandler.bind(this))
            .on('set', this.setTemperatureDisplayUnitsHandler.bind(this))

        this.service.getCharacteristic(Characteristic.TargetHeatingCoolingState)
            .setProps({validValues: [0, 1]})

        this.service.getCharacteristic(Characteristic.CurrentHeatingCoolingState)
            .setProps({validValues: [0, 1]})

        return [informationService, this.service]
    }

    getTargetHeatingCoolingStateCharacteristicHandler (callback) {
        this.log(`calling getTargetHeatingCoolingStateCharacteristicHandler`)
        const self = this
        request({
            url: self.url + "/state",
            method: "GET"
        }, function (error, response, body) {
            if (error) {
                callback(error)
                return
            }
            self.log(`getTargetHeatingCoolingState result:`, body)
            self.service.updateCharacteristic(Characteristic.TargetHeatingCoolingState, body)
            callback(null, self.service.getCharacteristic(Characteristic.TargetHeatingCoolingState).value)
        })
    }

    setTargetHeatingCoolingStateCharacteristicHandler (value, callback) {
        this.service.updateCharacteristic(Characteristic.TargetHeatingCoolingState, value)
        this.log(`calling setTargetHeatingCoolingStateCharacteristicHandler`, value)
        const self = this
        request({
            url: self.url + "/state",
            method: "POST",
            json: false,
            body: "value=" + value,
            headers: {"Content-Length": 7}
        }, function (error, response, body){
            if (error) {
                callback(error)
                return
            }
            callback(null, value)
        })
    }

    getTargetTemperatureHandler (callback) {
        this.log(`calling getTargetTemperatureHandler`)
        const self = this
        request({
            url: self.url + "/target_temp",
            method: "GET"
        }, function (error, response, body) {
            if (error) {
                callback(error)
                return
            }
            self.log(`getTargetTemperatureHandler result:`, body)
            self.service.updateCharacteristic(Characteristic.TargetTemperature, (body - 32) / 1.8000)
            callback(null, self.service.getCharacteristic(Characteristic.TargetTemperature).value)
        })
    }

    setTargetTemperatureHandler (value, callback) {
        this.service.updateCharacteristic(Characteristic.TargetTemperature, value)
        this.log(`calling setTargetTemperatureHandler`, value)
        const self = this
        request({
            url: self.url + "/target_temp",
            method: "POST",
            json: false,
            body: "value=" + value.toString(),
            headers: {"Content-Length": 6 + value.toString().length}
        }, function (error, response, body){
            if (error) {
                callback(error)
                return
            }
            callback(null, value)
        })
    }

    getCurrentTemperatureHandler (callback) {
        this.log(`calling getCurrentTemperatureHandler`)
        const self = this
        request({
            url: self.url + "/current_temp",
            method: "GET"
        }, function (error, response, body) {
            if (error) {
                callback(error)
                return
            }
            self.log(`getCurrentTemperatureHandler result:`, body)
            self.service.updateCharacteristic(Characteristic.CurrentTemperature, (body - 32) / 1.8000)
            callback(null, self.service.getCharacteristic(Characteristic.CurrentTemperature).value)
        })
    }

    getTemperatureDisplayUnitsHandler (callback) {
        this.log(`calling getTemperatureDisplayUnitsHandler`, this.tempDisplayUnits)
        callback(null, this.tempDisplayUnits)
    }

    setTemperatureDisplayUnitsHandler (value, callback) {
        this.log(`calling setTemperatureDisplayUnitsHandler`, value)
        callback(null, this.tempDisplayUnits)
    }
}

module.exports.StaggEKGUnifiedAccessory = StaggEKGUnifiedAccessory
module.exports.StaggEKGPlusAccessory = StaggEKGPlusAccessory
module.exports.StaggEKGProWifiAccessory = StaggEKGProWifiAccessory
module.exports.StaggEKGAccessory = StaggEKGProWifiAccessory
