const {
    knownCapabilities,
    pluginName,
    platformName,
    pluginVersion
} = require("./Constants");
const myUtils = require('./MyUtils'),
    SmartThingsClient = require('./ST_Client'),
    SmartThingsAccessories = require('./Accessories/ST_Accessories'),
    express = require('express'),
    bodyParser = require('body-parser'),
    logger = require('./Logger.js').Logger,
    webApp = express();

module.exports = class ST_Platform {
    constructor(log, config, api) {
        this.config = config;
        this.homebridge = api;
        this.log = log;
        this.logFile = logger.withPrefix(`${this.config['name']} ${pluginVersion}`);
        console.log(`Homebridge Version: ${api.version}`);
        console.log(`${platformName} Plugin Version: ${pluginVersion}`);
        this.Service = api.hap.Service;
        this.Characteristic = api.hap.Characteristic;
        this.PlatformAccessory = api.platformAccessory;
        this.uuid = api.hap.uuid;
        if (config === undefined || config === null || config.app_url === undefined || config.app_url === null || config.app_id === undefined || config.app_id === null) {
            log.debug(platformName + " Plugin not configured. Skipping");
            return;
        }
        this.polling_seconds = config['polling_seconds'] || 3600;
        this.excludedAttributes = this.config["excluded_attributes"] || [];
        this.excludedCapabilities = this.config["excluded_capabilities"] || [];
        this.update_method = this.config['update_method'] || 'direct';
        this.temperature_unit = 'F';
        this.local_commands = false;
        this.local_hub_ip = undefined;
        this.myUtils = new myUtils(this);
        this.configItems = this.getConfigItems();
        this.SmartThingsAccessories = new SmartThingsAccessories(this);

        this.deviceCache = {};
        this.firstpoll = true;
        this.attributeLookup = {};
        this.knownCapabilities = knownCapabilities;
        this.unknownCapabilities = [];
        this.client = new SmartThingsClient(this);
        this.homebridge.on('didFinishLaunching', function() {
            this.didFinishLaunching();
        }.bind(this));
        this.asyncCallWait = 0;
    }

    getConfigItems() {
        return {
            app_url: this.config['app_url'],
            app_id: this.config['app_id'],
            access_token: this.config['access_token'],
            update_seconds: this.config['update_seconds'] || 30,
            direct_port: this.config['direct_port'] || 8000,
            direct_ip: this.config['direct_ip'] || this.myUtils.getIPAddress()
        };
    }
    didFinishLaunching() {
        if (this.asyncCallWait !== 0) {
            this.log.debug("Configuration of cached accessories not done, wait for a bit...", that.asyncCallWait);
            setTimeout(this.didFinishLaunching.bind(that), 1000);
            return;
        }
        this.log('Fetching ' + platformName + ' devices. This can take a while depending on the number of devices are configured!');
        setInterval(this.refreshDevices.bind(this), this.polling_seconds * 1000);
        let that = this;
        console.log(this.webServerInit);
        let starttime = new Date();
        this.refreshDevices()
            .then(() => {
                // Initialize Update Mechanism for realtime-ish updates.
                // let timeElapsedinSeconds = Math.round((new Date() - starttime) / 1000);
                // if (timeElapsedinSeconds >= that.polling_seconds) {
                //     that.log(`It took ${timeElapsedinSeconds} seconds to get all data | polling_seconds is set to ${that.polling_seconds}`);
                //     that.log(' Changing polling_seconds to ' + (timeElapsedinSeconds * 2) + ' seconds');
                //     that.polling_seconds = timeElapsedinSeconds * 2;
                // } else if (that.polling_seconds < 30) {
                //     that.log('polling_seconds really shouldn\'t be smaller than 30 seconds. Setting it to 30 seconds');
                //     that.polling_seconds = 30;
                // }
                // // that.processAccessoryCallback(foundAccessories || []);
                // setInterval(that.refreshDevices.bind(that), that.polling_seconds * 1000);

                that.WebServerInit(that)
                    .catch((err) => that.log('WebServerInit Error: ', err))
                    .then((resp) => {
                        if (resp === 'OK')
                            that.client.startDirect(null);
                    });
            });
    }

    refreshDevices() {
        let that = this;
        return new Promise((resolve) => {
            let foundAccessories = [];
            try {
                that.log.debug('Refreshing All Device Data');
                this.client.getDevices()
                    .then(resp => {
                        console.log(resp);
                        that.log.debug('Received All Device Data');
                        // success
                        if (resp && resp.deviceList && resp.deviceList instanceof Array) {
                            resp.deviceList.forEach(device => {
                                let accessory;
                                device.excludedCapabilities = that.excludedCapabilities[device.deviceid] || ["None"];
                                that.log.debug("Processing device id: " + device.deviceid);

                                if (that.deviceCache[device.deviceid]) {
                                    that.log("Existing device, loading...");
                                    accessory = that.deviceCache[device.deviceid];
                                    accessory.loadData(device);
                                } else {
                                    that.log.debug("New Device, initializing...");
                                    // let deviceId = this.uuid.generate('hbdev:' + platformName.toLowerCase() + ':' + this.deviceid);
                                    // let devAccessory = new that.PlatformAccessory(device.name, deviceId);
                                    // accessory = new that.SmartThingsAccessories.AccessoryDevice(that, devAccessory, device);
                                    accessory = that.addDevice(device);
                                    // that.log(accessory);
                                    if (accessory !== undefined) {
                                        if (accessory.services.length <= 1 || accessory.deviceGroup === 'unknown') {
                                            if (that.firstpoll) {
                                                that.log.debug('Device Skipped - Group ' + accessory.deviceGroup + ', Name ' + accessory.name + ', ID ' + accessory.deviceid + ', JSON: ' + JSON.stringify(device));
                                            }
                                        } else {
                                            // that.log("Device Added - Group " + accessory.deviceGroup + ", Name " + accessory.name + ", ID " + accessory.deviceid); //+", JSON: "+ JSON.stringify(device));
                                            that.deviceCache[device.deviceid] = accessory;
                                            foundAccessories.push(accessory);
                                        }
                                    }
                                }
                                that.firstpoll = false;
                            });
                        };
                        if (resp && resp.location) {
                            that.temperature_unit = resp.location.temperature_scale;
                            if (resp.location.hubIP) {
                                that.local_hub_ip = resp.location.hubIP;
                                that.local_commands = (resp.location.local_commands === true);
                                that.client.updateGlobals(that.local_hub_ip, that.local_commands);
                            }
                        }
                        this.log("Devices refreshed");
                        that.log('Unknown Capabilities: ' + JSON.stringify(that.unknownCapabilities));
                        resolve(true);
                    });


            } catch (e) {
                this.log.error("Failed to refresh devices.", e);
                resolve(false);
            }
        });
    }

    getNewAccessory(device) {
        const deviceId = this.uuid.generate('hbdev:' + platformName.toLowerCase() + ':' + this.deviceid);
        const accessory = new this.PlatformAccessory(device.name, deviceId);
        this.SmartThingsAccessories.PopulateAccessory(accessory, device);
        // this.patchAccessory(accessory, device);
        // this.accessoryHelper.configureAccessory(accessory);
        return accessory;
    }

    addDevice(device) {
        const accessory = this.getNewAccessory(device);
        this.homebridge.registerPlatformAccessories(pluginName, platformName, [accessory]);
        this.accessories.add(accessory);
        this.log(`Added: ${accessory.context.name} (${accessory.context.object_type}/${accessory.context.object_id})`);
    }

    ignoreDevice(data) {
        const [device, reason] = data;
        if (!this.accessories.ignore(device)) {
            return;
        }

        this.log(`${reason}: ${device.name} (${device.object_type}/${device.object_id})`);
    }

    removeAccessory(accessory) {
        if (this.accessories.remove(accessory)) {
            this.api.unregisterPlatformAccessories(pluginName, platformName, [
                accessory
            ]);
            this.log(`Removed: ${accessory.context.name} (${accessory.context.object_type}/${accessory.context.object_id })`);
        }
    }

    addAttributeUsage(attribute, deviceid, mycharacteristic) {
        if (!this.attributeLookup[attribute]) {
            this.attributeLookup[attribute] = {};
        }
        if (!this.attributeLookup[attribute][deviceid]) {
            this.attributeLookup[attribute][deviceid] = [];
        }
        this.attributeLookup[attribute][deviceid].push(mycharacteristic);
    }

    doIncrementalUpdate() {
        let that = this;
        that.client.getUpdates(function(data) {
            that.processIncrementalUpdate(data, that);
        });
    }

    processIncrementalUpdate(data, that) {
        that.log.debug('new data: ' + data);
        if (data && data.attributes && data.attributes instanceof Array) {
            for (let i = 0; i < data.attributes.length; i++) {
                that.processFieldUpdate(data.attributes[i], that);
            }
        }
    }

    processFieldUpdate(attributeSet, that) {
        // this.log(attributeSet);
        if (!(that.attributeLookup[attributeSet.attribute] && that.attributeLookup[attributeSet.attribute][attributeSet.device])) {
            return;
        }
        let myUsage = that.attributeLookup[attributeSet.attribute][attributeSet.device];
        if (myUsage instanceof Array) {
            for (let j = 0; j < myUsage.length; j++) {
                let accessory = that.deviceCache[attributeSet.device];
                if (accessory) {
                    accessory.device.attributes[attributeSet.attribute] = attributeSet.value;
                    myUsage[j].getValue();
                }
            }
        }
    }



    // processAccessoryCallback(foundAccessories) {
    //     // loop through accessories adding them to the list and registering them
    //     console.log(foundAccessories);
    //     let that = this;
    //     for (let i = 0; i < foundAccessories.length; i++) {
    //         let accessoryInstance = foundAccessories[i];
    //         let accessoryName = accessoryInstance.name; // assume this property was set

    //         that.log("Initializing platform accessory '%s'...", accessoryName);
    //         this.homebridge.registerPlatformAccessories(pluginName, platformName, [accessoryInstance]);
    //     }
    // };


    configureAccessory(accessory) {
        // this.log("Configure Cached Accessory: " + accessory.displayName + ", UUID: " + accessory.UUID);

        // this.SmartThingsAccessories.CreateFromCachedAccessory(accessory, this);
        // this.deviceCache[accessory.deviceid] = accessory;
    };

    webServerInit() {
        let that = this;
        // Get the IP address that we will send to the SmartApp. This can be overridden in the config file.
        return new Promise(function(resolve) {
            try {
                let ip = that.configItems.direct_ip || that.myUtils.getIPAddress();
                // Start the HTTP Server
                webApp.listen(that.configItems.direct_port, function() {
                    that.log(`Direct Connect is Listening On ${ip}:${that.configItems.direct_port}`);
                });
                webApp.use(bodyParser.urlencoded({
                    extended: false
                }));
                webApp.use(bodyParser.json());
                webApp.use(function(req, res, next) {
                    res.header("Access-Control-Allow-Origin", "*");
                    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
                    next();
                });

                webApp.get('/', function(req, res) {
                    res.send('WebApp is running...');
                });

                webApp.get('/restart', function(req, res) {
                    console.log('restart...');
                    let delay = (10 * 1000);
                    that.log('Received request from ' + platformName + ' to restart homebridge service in (' + (delay / 1000) + ' seconds) | NOTICE: If you using PM2 or Systemd the Homebridge Service should start back up');
                    setTimeout(function() {
                        process.exit(1);
                    }, parseInt(delay));
                    res.send('OK');
                });

                webApp.post('/updateprefs', function(req, res) {
                    that.log(platformName + ' Hub Sent Preference Updates');
                    let data = JSON.parse(req.body);
                    let sendUpd = false;
                    if (data.local_commands && that.local_commands !== data.local_commands) {
                        sendUpd = true;
                        that.log(platformName + ' Updated Local Commands Preference | Before: ' + that.local_commands + ' | Now: ' + data.local_commands);
                        that.local_commands = data.local_commands;
                    }
                    if (data.local_hub_ip && that.local_hub_ip !== data.local_hub_ip) {
                        sendUpd = true;
                        that.log(platformName + ' Updated Hub IP Preference | Before: ' + that.local_hub_ip + ' | Now: ' + data.local_hub_ip);
                        that.local_hub_ip = data.local_hub_ip;
                    }
                    if (sendUpd) {
                        that.client.updateGlobals(that.local_hub_ip, that.local_commands);
                    }
                    res.send('OK');
                });

                webApp.get('/initial', function(req, res) {
                    that.log(platformName + ' Hub Communication Established');
                    res.send('OK');
                });

                webApp.post('/update', function(req, res) {
                    if (req.body.length < 3)
                        return;
                    let data = JSON.parse(JSON.stringify(req.body));
                    // console.log('update: ', data);
                    if (Object.keys(data).length > 3) {
                        let newChange = {
                            device: data.change_device,
                            attribute: data.change_attribute,
                            value: data.change_value,
                            date: data.change_date
                        };
                        that.log('Change Event:', '(' + data.change_name + ') [' + (data.change_attribute ? data.change_attribute.toUpperCase() : 'unknown') + '] is ' + data.change_value);
                        that.processFieldUpdate(newChange, that);
                    }
                    res.send('OK');
                });
                resolve('OK');
            } catch (ex) {
                resolve('');
            }
        });
    };
};