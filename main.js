"use strict";

const utils = require("@iobroker/adapter-core");
const auth = require(__dirname + "/lib/auth.js");
const EventEmitter = require("events");
const EventSource = require("eventsource");
const request = require("request");


let getTokenInterval;
let getTokenRefreshInterval;
let reconnectEventStreamInterval;
let retryTimeout;
let rateLimitTimeout;
let restartTimeout;
let eventSource;
const availablePrograms = {};
const availableProgramOptions = {};
const eventSourceList = {};
const reconnectTimeouts = {};
const currentSelected = {};

let rateCalculation = [];

class homeConnect extends utils.Adapter {

    constructor(options) {
        super({
            ...options,
            name: 'homeconnect',
        });

        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('unload', this.onUnload.bind(this));

    }
    async onReady() {
        this.setState('info.connection', false, true);

        await this.create_state();
        await this.initialisation();

    }


        async stateGet(stat) {
            return new Promise((resolve, reject) => {
                this.getState(stat, function (err, state) {
                    if (err) {
                        reject(err);
                    } else {
                        if (typeof state != undefined && state != null) {
                            const value = state.val;
                            resolve(value);
                        } else {
                            const value = false;
                            resolve(value);
                        }
                    }
                });
            });
        }

        async getRefreshToken(disableReconnectStream) {
            const stat = this.namespace + ".dev.refreshToken";
            this.stateGet(stat)
                .then((value) => {
                    auth.tokenRefresh(value)
                        .then(
                            ([token, refreshToken, expires, tokenScope]) => {
                                this.log.info("Accesstoken renewed...");
                                this.setState("dev.token", {
                                    val: token,
                                    ack: true,
                                });
                                this.setState("dev.refreshToken", {
                                    val: refreshToken,
                                    ack: true,
                                });
                                this.setState("dev.expires", {
                                    val: expires,
                                    ack: true,
                                });
                                this.setState("dev.tokenScope", {
                                    val: tokenScope,
                                    ack: true,
                                });
                                if (!disableReconnectStream) {
                                    Object.keys(eventSourceList).forEach(function (key) {
                                        startEventStream(token, key);
                                    });
                                }
                            },
                            ([statusCode, description]) => {
                                retryTimeout = setTimeout(() => {
                                    this.getRefreshToken();
                                }, 5 * 60 * 1000); //5min
                                this.log.error("Error Refresh-Token: " + statusCode + " " + description);
                                this.log.warn("Retry Refresh Token in 5min");
                            }
                        )
                        .catch(() => {
                            this.log.debug("No able to get refesh token ");
                        });
                })
                .catch(() => {
                    this.log.debug("No refreshtoken found");
                });
        }

        async getToken() {
            this.stateGet("dev.devCode")
                .then(
                    (deviceCode) => {
                        const clientID = this.config.clientID;
                        auth.tokenGet(deviceCode, clientID)
                            .then(
                                ([token, refreshToken, expires, tokenScope]) => {
                                    this.log.debug("Accesstoken created: " + token);
                                    this.setState("dev.token", {
                                        val: token,
                                        ack: true,
                                    });
                                    this.setState("dev.refreshToken", {
                                        val: refreshToken,
                                        ack: true,
                                    });
                                    this.setState("dev.expires", {
                                        val: expires,
                                        ack: true,
                                    });
                                    this.setState("dev.tokenScope", {
                                        val: tokenScope,
                                        ack: true,
                                    });
                                    clearInterval(getTokenInterval);

                                    this.setState("dev.access", true);
                                    auth.getAppliances(token)
                                        .then(
                                            (appliances) => {
                                                parseHomeappliances(appliances);
                                            },
                                            ([statusCode, description]) => {
                                                this.log.error("Error getting Aplliances Error: " + statusCode);
                                                this.log.error(description);
                                            }
                                        )
                                        .catch(() => {
                                            this.log.debug("No appliance found");
                                        });

                                    this.log.debug("Start Refreshinterval");
                                    getTokenRefreshInterval = setInterval(this.getRefreshToken, 20 * 60 * 60 * 1000); //every 20h
                                },
                                (statusPost) => {
                                    if (statusPost == "400") {
                                        const stat = "dev.authUriComplete";

                                        this.stateGet(stat)
                                            .then(
                                                (value) => {
                                                    this.log.error("Please visit this url:  " + value);
                                                },
                                                (err) => {
                                                    this.log.error("FEHLER: " + err);
                                                }
                                            )
                                            .catch(() => {
                                                this.log.debug("No state" + stat + " found");
                                            });
                                    } else {
                                        this.log.error("Error GetToken: " + statusPost);
                                        clearInterval(getTokenInterval);
                                    }
                                }
                            )
                            .catch(() => {
                                this.log.debug("No token found");
                            });
                    },
                    (err) => {
                        this.log.error("getToken FEHLER: " + err);
                        clearInterval(getTokenInterval);
                    }
                )
                .catch(() => {
                    this.log.debug("No token found");
                });
        }

        /* Eventstream
         */
        async startEventStream(token, haId) {
            this.log.debug("Start EventStream " + haId);
            const baseUrl = "https://api.home-connect.com/api/homeappliances/" + haId + "/events";
            const header = {
                headers: {
                    Authorization: "Bearer " + token,
                    Accept: "text/event-stream",
                },
            };
            if (eventSourceList[haId]) {
                eventSourceList[haId].close();
                eventSourceList[haId].removeEventListener("STATUS", (e) => processEvent(e), false);
                eventSourceList[haId].removeEventListener("NOTIFY", (e) => processEvent(e), false);
                eventSourceList[haId].removeEventListener("EVENT", (e) => processEvent(e), false);
                eventSourceList[haId].removeEventListener("CONNECTED", (e) => processEvent(e), false);
                eventSourceList[haId].removeEventListener("DISCONNECTED", (e) => processEvent(e), false);
                eventSourceList[haId].removeEventListener("KEEP-ALIVE", (e) => resetReconnectTimeout(e.lastEventId), false);
            }
            eventSourceList[haId] = new EventSource(baseUrl, header);
            // Error handling
            eventSourceList[haId].onerror = (err) => {
                this.log.error("EventSource error: " + JSON.stringify(err));
                if (err.status) {
                    this.log.error(err.status + " " + err.message);
                } else {
                    this.log.info("Undefined Error from Homeconnect this happens sometimes.");
                }
                if (err.status !== undefined) {
                    this.log.error("Error (" + haId + ")", err);
                    if (err.status === 401) {
                        this.getRefreshToken();
                        // Most likely the token has expired, try to refresh the token
                        this.log.info("Token abgelaufen");
                    } else if (err.status === 429) {
                        this.log.warn("Too many requests. Adapter sends too many requests per minute. Please wait 1min before restart the instance.");
                    } else {
                        this.log.error("Error: " + err.status);
                        this.log.error("Error: " + JSON.stringify(err));
                        if (err.status >= 500) {
                            this.log.error("Homeconnect API are not available please try again later");
                        }
                    }
                }
            };
            eventSourceList[haId].addEventListener("STATUS", (e) => processEvent(e), false);
            eventSourceList[haId].addEventListener("NOTIFY", (e) => processEvent(e), false);
            eventSourceList[haId].addEventListener("EVENT", (e) => processEvent(e), false);
            eventSourceList[haId].addEventListener("CONNECTED", (e) => processEvent(e), false);
            eventSourceList[haId].addEventListener("DISCONNECTED", (e) => processEvent(e), false);
            eventSourceList[haId].addEventListener(
                "KEEP-ALIVE",
                (e) => {
                    //this.log.debug(JSON.stringify(e));
                    resetReconnectTimeout(e.lastEventId);
                },
                false
            );

            resetReconnectTimeout(haId);
        }

        async resetReconnectTimeout(haId) {
            haId = haId.replace(/\.?\-001*$/, "");
            clearInterval(reconnectTimeouts[haId]);
            reconnectTimeouts[haId] = setInterval(() => {
                this.stateGet(this.namespace + ".dev.token")
                    .then((value) => {
                        this.log.debug("reconnect EventStream " + haId);
                        startEventStream(value, haId);
                    })
                    .catch(() => {
                        this.log.debug("No token found");
                    });
            }, 70000);
        }

        //Eventstream ==>> Datenpunkt

            async processEvent(msg) {
                /*Auswertung des Eventstreams*/
                try {
                    this.log.debug("event: " + JSON.stringify(msg));
                    const stream = msg;
                    const lastEventId = stream.lastEventId.replace(/\.?\-001*$/, "");
                    if (!stream) {
                        this.log.debug("No Return: " + stream);
                        return;
                    }
                    resetReconnectTimeout(lastEventId);
                    if (stream.type == "DISCONNECTED") {
                        this.setState(lastEventId + ".general.connected", false, true);
                        return;
                    }
                    if (stream.type == "CONNECTED") {
                        this.setState(lastEventId + ".general.connected", true, true);
                        const tokenID = this.namespace + ".dev.token";
                        this.stateGet(tokenID)
                            .then(
                                (value) => {
                                    const token = value;
                                    getAPIValues(token, lastEventId, "/status");
                                    getAPIValues(token, lastEventId, "/settings");
                                    getAPIValues(token, lastEventId, "/programs");
                                    getAPIValues(token, lastEventId, "/programs/active");
                                    getAPIValues(token, lastEventId, "/programs/selected");
                                    updateOptions(token, lastEventId, "/programs/active");
                                    updateOptions(token, lastEventId, "/programs/selected");
                                },
                                (err) => {
                                    this.log.error("FEHLER: " + err);
                                }
                            )
                            .catch(() => {
                                this.log.debug("No token found");
                            });
                        return;
                    }

                    const parseMsg = msg.data;

                    const parseMessage = JSON.parse(parseMsg);
                    parseMessage.items.forEach((element) => {
                        let haId = parseMessage.haId;
                        haId = haId.replace(/\.?\-001*$/, "");
                        let folder;
                        let key;
                        if (stream.type === "EVENT") {
                            folder = "events";
                            key = element.key.replace(/\./g, "_");
                        } else {
                            folder = element.uri.split("/").splice(4);
                            if (folder[folder.length - 1].indexOf(".") != -1) {
                                folder.pop();
                            }
                            folder = folder.join(".");
                            key = element.key.replace(/\./g, "_");
                        }
                        this.log.debug(haId + "." + folder + "." + key + ":" + element.value);
                        this.setObjectNotExists(haId + "." + folder + "." + key, {
                            type: "state",
                            common: {
                                name: key,
                                type: "mixed",
                                role: "indicator",
                                write: true,
                                read: true,
                                unit: element.unit || "",
                            },
                            native: {},
                        });

                        this.setState(haId + "." + folder + "." + key, element.value, true);
                    });
                } catch (error) {
                    this.log.error("Parsemessage: " + error);
                    this.log.error("Error Event: " + msg);
                }
            }


    onUnload(callback) {
        try {
            this.log.info("cleaned everything up...");
            clearInterval(getTokenRefreshInterval);
            clearInterval(getTokenInterval);
            clearInterval(reconnectEventStreamInterval);
            clearTimeout(retryTimeout);
            clearTimeout(rateLimitTimeout);
            clearTimeout(restartTimeout);
            Object.keys(eventSourceList).forEach((haId) => {
                if (eventSourceList[haId]) {
                    console.log("Clean event " + haId);
                    eventSourceList[haId].close();
                    eventSourceList[haId].removeEventListener("STATUS", (e) => processEvent(e), false);
                    eventSourceList[haId].removeEventListener("NOTIFY", (e) => processEvent(e), false);
                    eventSourceList[haId].removeEventListener("EVENT", (e) => processEvent(e), false);
                    eventSourceList[haId].removeEventListener("CONNECTED", (e) => processEvent(e), false);
                    eventSourceList[haId].removeEventListener("DISCONNECTED", (e) => processEvent(e), false);
                    eventSourceList[haId].removeEventListener("KEEP-ALIVE", (e) => resetReconnectTimeout(e.lastEventId), false);
                }
            });
            callback();
        } catch (e) {
            callback();
        }
    }



    onStateChange(id, state) {
        if (id == this.namespace + ".dev.devCode") {
            getTokenInterval = setInterval(this.getToken, 10000); // Polling bis Authorisation erfolgt ist
        }
        if (state && !state.ack) {
            const idArray = id.split(".");
            const command = idArray.pop().replace(/_/g, ".");
            const haId = idArray[2];
            if (!isNaN(state.val) && !isNaN(parseFloat(state.val))) {
                state.val = parseFloat(state.val);
            }
            if (state.val === "true") {
                state.val = true;
            }
            if (state.val === "false") {
                state.val = false;
            }
            if (id.indexOf(".commands.") !== -1) {
                this.log.debug(id + " " + state.val);
                if (id.indexOf("StopProgram") !== -1 && state.val) {
                    this.stateGet(this.namespace + ".dev.token")
                        .then((token) => {
                            deleteAPIValues(token, haId, "/programs/active");
                        })
                        .catch(() => {
                            this.log.debug("No token found");
                        });
                } else {
                    const data = {
                        data: {
                            key: command,
                            value: state.val,
                        },
                    };
                    this.stateGet(this.namespace + ".dev.token")
                        .then((token) => {
                            putAPIValues(token, haId, "/commands/" + command, data);
                        })
                        .catch(() => {
                            this.log.debug("No token found");
                        });
                }
            }
            if (id.indexOf(".settings.") !== -1) {
                const data = {
                    data: {
                        key: command,
                        value: state.val,
                        type: command,
                    },
                };
                this.stateGet(this.namespace + ".dev.token")
                    .then((token) => {
                        putAPIValues(token, haId, "/settings/" + command, data);
                    })
                    .catch(() => {
                        this.log.debug("No token found");
                    });
            }
            if (id.indexOf(".options.") !== -1) {
                const data = {
                    data: {
                        key: command,
                        value: state.val,
                    },
                };
                if (id.indexOf("selected") !== -1) {
                    idArray.pop();
                }
                const folder = idArray.slice(3, idArray.length).join("/");
                this.stateGet(this.namespace + ".dev.token")
                    .then((token) => {
                        putAPIValues(token, haId, "/" + folder + "/" + command, data);
                    })
                    .catch(() => {
                        this.log.debug("No token found");
                    });
            }
            if (id.indexOf("BSH_Common_Root_") !== -1) {
                const pre = this.name + "." + this.instance;
                if (!state.val) {
                    this.log.warn("No state val: " + JSON.stringify(state));
                    return;
                }
                const key = state.val.split(".").pop();
                this.getStates(pre + "." + haId + ".programs.selected.options." + key + ".*", (err, states) => {
                    const allIds = Object.keys(states);
                    options = [];
                    allIds.forEach(function (keyName) {
                        if (keyName.indexOf("BSH_Common_Option_ProgramProgress") === -1 && keyName.indexOf("BSH_Common_Option_RemainingProgramTime") === -1) {
                            const idArray = keyName.split(".");
                            const commandOption = idArray.pop().replace(/_/g, ".");
                            if (
                                ((availableProgramOptions[state.val] && availableProgramOptions[state.val].includes(commandOption)) || commandOption === "BSH.Common.Option.StartInRelative") &&
                                states[keyName] !== null
                            ) {
                                if (commandOption === "BSH.Common.Option.StartInRelative" && command === "BSH.Common.Root.SelectedProgram") {
                                } else {
                                    options.push({
                                        key: commandOption,
                                        value: states[keyName].val,
                                    });
                                }
                            }
                        }
                    });

                    const data = {
                        data: {
                            key: state.val,
                            options: options,
                        },
                    };

                    if (id.indexOf("Active") !== -1) {
                        this.stateGet(this.namespace + ".dev.token")
                            .then((token) => {
                                putAPIValues(token, haId, "/programs/active", data)
                                    .catch(() => {
                                        this.log.info("Programm doesn't start with options. Try again without selected options.");
                                        putAPIValues(token, haId, "/programs/active", {
                                            data: {
                                                key: state.val,
                                            },
                                        });
                                    })
                                    .then(() => updateOptions(token, haId, "/programs/active"));
                            })
                            .catch(() => {
                                this.log.debug("No token found");
                            });
                    }
                    if (id.indexOf("Selected") !== -1) {
                        if (state.val) {
                            currentSelected[haId] = {key: state.val};
                            this.stateGet(this.namespace + ".dev.token").then((token) => {
                                putAPIValues(token, haId, "/programs/selected", data)
                                    .then(
                                        () => {
                                            updateOptions(token, haId, "/programs/selected");
                                        },
                                        () => {
                                            this.log.warn("Setting selected program was not succesful");
                                        }
                                    )
                                    .catch(() => {
                                        this.log.debug("No program selected found");
                                    });
                            });
                        } else {
                            this.log.warn("No state val: " + JSON.stringify(state));
                        }
                    }
                });
            }
        } else {
            const idArray = id.split(".");
            const command = idArray.pop().replace(/_/g, ".");
            const haId = idArray[2];
            if (id.indexOf("BSH_Common_Root_") !== -1) {
                if (id.indexOf("Active") !== -1) {
                    this.stateGet(this.namespace + ".dev.token")
                        .then((token) => {
                            updateOptions(token, haId, "/programs/active");
                        })
                        .catch(() => {
                            this.log.debug("No token found");
                        });
                }
                if (id.indexOf("Selected") !== -1) {
                    if (state && state.val) {
                        currentSelected[haId] = {key: state.val};
                    } else {
                        this.log.warn("Selected program is empty: " + JSON.stringify(state));
                    }
                    this.stateGet(this.namespace + ".dev.token")
                        .then((token) => {
                            updateOptions(token, haId, "/programs/selected");
                        })
                        .catch(() => {
                            this.log.debug("No token found");
                        });
                }
            }

            if (id.indexOf(".options.") !== -1 || id.indexOf(".events.") !== -1 || id.indexOf(".status.") !== -1) {
                if (id.indexOf("BSH_Common_Option") === -1 && state && state.val && state.val.indexOf && state.val.indexOf(".") !== -1) {
                    this.getObject(id, function (err, obj) {
                        if (obj) {
                            const common = obj.common;
                            const valArray = state.val.split(".");
                            common.states = {};
                            common.states[state.val] = valArray[valArray.length - 1];
                            this.extendObject(id, {
                                common: common,
                            });
                        }
                    });
                }
            }
        }
    }


        async updateOptions(token, haId, url) {
            const pre = this.name + "." + this.instance;
            this.getStates(pre + "." + haId + ".programs.*", (err, states) => {
                const allIds = Object.keys(states);
                let searchString = "selected.options.";
                if (url.indexOf("/active") !== -1) {
                    searchString = "active.options.";
                    this.log.debug(searchString);
                    //delete only for active options
                    this.log.debug("Delete: " + haId + url.replace(/\//g, ".") + ".options");
                    allIds.forEach(function (keyName) {
                        if (keyName.indexOf(searchString) !== -1 && keyName.indexOf("BSH_Common_Option") === -1) {
                            this.delObject(keyName.split(".").slice(2).join("."));
                        }
                    });
                }
                setTimeout(() => getAPIValues(token, haId, url + "/options"), 0);
            });
        }


        async parseHomeappliances(appliancesArray) {
            appliancesArray.data.homeappliances.forEach((element) => {
                // if (element.haId.indexOf("BOSCH-WTX87K80") === -1) {
                //     return;
                // }
                const haId = element.haId;
                this.extendObject(haId, {
                    type: "device",
                    common: {
                        name: element.name,
                        type: "object",
                        role: "indicator",
                        write: false,
                        read: true,
                    },
                    native: {},
                });
                for (const key in element) {
                     this.setObjectNotExists(haId + ".general." + key, {
                        type: "state",
                        common: {
                            name: key,
                            type: "object",
                            role: "indicator",
                            write: false,
                            read: true,
                        },
                        native: {},
                    });
                    this.setState(haId + ".general." + key, element[key]);
                }
                this.extendObject(haId + ".commands.BSH_Common_Command_StopProgram", {
                    type: "state",
                    common: {
                        name: "Stop Program",
                        type: "boolean",
                        role: "button",
                        write: true,
                        read: true,
                    },
                    native: {},
                });
                this.extendObject(haId + ".commands.BSH_Common_Command_PauseProgram", {
                    type: "state",
                    common: {
                        name: "Pause Program",
                        type: "boolean",
                        role: "button",
                        write: true,
                        read: true,
                    },
                    native: {},
                });
                this.extendObject(haId + ".commands.BSH_Common_Command_ResumeProgram", {
                    type: "state",
                    common: {
                        name: "Resume Program",
                        type: "boolean",
                        role: "button",
                        write: true,
                        read: true,
                    },
                    native: {},
                });
                const tokenID = this.namespace + ".dev.token";
                this.stateGet(tokenID)
                    .then(
                        (value) => {
                            const token = value;
                            if (element.connected) {
                                getAPIValues(token, haId, "/status");
                                getAPIValues(token, haId, "/settings");
                                getAPIValues(token, haId, "/programs");
                                getAPIValues(token, haId, "/programs/active");
                                getAPIValues(token, haId, "/programs/selected");
                                updateOptions(token, haId, "/programs/active");
                                updateOptions(token, haId, "/programs/selected");
                            }
                            startEventStream(token, haId);
                        },
                        (err) => {
                            this.log.error("FEHLER: " + err);
                        }
                    )
                    .catch(() => {
                        this.log.debug("No token found");
                    });
            });
            //Delete old states
            this.getStates("*", (err, states) => {
                const allIds = Object.keys(states);
                allIds.forEach(function (keyName) {
                    if (
                        keyName.indexOf(".Event.") !== -1 ||
                        keyName.indexOf(".General.") !== -1 ||
                        keyName.indexOf(".Option.") !== -1 ||
                        keyName.indexOf(".Root.") !== -1 ||
                        keyName.indexOf(".Setting.") !== -1 ||
                        keyName.indexOf(".Status.") !== -1
                    ) {
                        this.delObject(keyName.split(".").slice(2).join("."));
                    }
                });
            });
        }

        async putAPIValues(token, haId, url, data) {
            return new Promise((resolve, reject) => {
                this.log.debug(haId + url);
                this.log.debug(JSON.stringify(data));
                sendRequest(token, haId, url, "PUT", JSON.stringify(data))
                    .then(
                        ([statusCode, returnValue]) => {
                            this.log.debug(statusCode + " " + returnValue);
                            this.log.debug(JSON.stringify(returnValue));
                            resolve();
                        },
                        ([statusCode, description]) => {
                            if (statusCode === 403) {
                                this.log.info("Homeconnect API has not the rights for this command and device");
                            }
                            this.log.info(statusCode + ": " + description);
                            reject();
                        }
                    )
                    .catch(() => {
                        this.log.debug("request not successful found");
                    });
            });
        }

        async deleteAPIValues(token, haId, url) {
            sendRequest(token, haId, url, "DELETE")
                .then(
                    ([statusCode, returnValue]) => {
                        this.log.debug(url);
                        this.log.debug(JSON.stringify(returnValue));
                    },
                    ([statusCode, description]) => {
                        if (statusCode === 403) {
                            this.log.info("Homeconnect API has not the rights for this command and device");
                        }
                        this.log.info(statusCode + ": " + description);
                    }
                )
                .catch(() => {
                    this.log.debug("delete not successful");
                });
        }

        async getAPIValues(token, haId, url) {
            sendRequest(token, haId, url)
                .then(
                    ([statusCode, returnValue]) => {
                        try {
                            this.log.debug(url);
                            this.log.debug(JSON.stringify(returnValue));
                            if (url.indexOf("/settings/") !== -1) {
                                let type = "string";
                                if (returnValue.data.type === "Int" || returnValue.data.type === "Double") {
                                    type = "number";
                                }
                                if (returnValue.data.type === "Boolean") {
                                    type = "boolean";
                                }
                                const common = {
                                    name: returnValue.data.name,
                                    type: type,
                                    role: "indicator",
                                    write: true,
                                    read: true,
                                };
                                if (returnValue.data.constraints && returnValue.data.constraints.allowedvalues) {
                                    const states = {};
                                    returnValue.data.constraints.allowedvalues.forEach((element, index) => {
                                        states[element] = returnValue.data.constraints.displayvalues[index];
                                    });
                                    common.states = states;
                                }
                                const folder = ".settings." + returnValue.data.key.replace(/\./g, "_");
                                this.extendObject(haId + folder, {
                                    type: "state",
                                    common: common,
                                    native: {},
                                });
                                return;
                            }

                            if (url.indexOf("/programs/available/") !== -1) {
                                if (returnValue.data.options) {
                                    availableProgramOptions[returnValue.data.key] = availableProgramOptions[returnValue.data.key] || [];
                                    returnValue.data.options.forEach((option) => {
                                        availableProgramOptions[returnValue.data.key].push(option.key);
                                        let type = "string";
                                        if (option.type === "Int" || option.type === "Double") {
                                            type = "number";
                                        }
                                        if (option.type === "Boolean") {
                                            type = "boolean";
                                        }
                                        const common = {
                                            name: option.name,
                                            type: type,
                                            role: "indicator",
                                            unit: option.unit || "",
                                            write: true,
                                            read: true,
                                            min: option.constraints.min || null,
                                            max: option.constraints.max || null,
                                        };

                                        if (option.constraints.allowedvalues) {
                                            common.states = {};
                                            option.constraints.allowedvalues.forEach((element, index) => {
                                                common.states[element] = option.constraints.displayvalues[index];
                                            });
                                        }
                                        let folder = ".programs.available.options." + option.key.replace(/\./g, "_");

                                        this.extendObject(haId + folder, {
                                            type: "state",
                                            common: common,
                                            native: {},
                                        });
                                        this.setState(haId + folder, option.constraints.default, true);
                                        const key = returnValue.data.key.split(".").pop();
                                        this.setObjectNotExists(haId + ".programs.selected.options." + key, {
                                            type: "state",
                                            common: {
                                                name: returnValue.data.name,
                                                type: "mixed",
                                                role: "indicator",
                                                write: true,
                                                read: true
                                            },
                                            native: {},
                                        });
                                        folder = ".programs.selected.options." + key + "." + option.key.replace(/\./g, "_");
                                        this.extendObject(haId + folder, {
                                            type: "state",
                                            common: common,
                                            native: {},
                                        });
                                    });
                                }
                                return;
                            }

                            if ("key" in returnValue.data) {
                                returnValue.data = {
                                    items: [returnValue.data],
                                };
                            }
                            for (const item in returnValue.data) {
                                returnValue.data[item].forEach((subElement) => {
                                    let folder = url.replace(/\//g, ".");
                                    if (url === "/programs/active") {
                                        subElement.value = subElement.key;
                                        subElement.key = "BSH_Common_Root_ActiveProgram";
                                        subElement.name = "BSH_Common_Root_ActiveProgram";
                                    }
                                    if (url === "/programs/selected") {
                                        if (subElement.key) {
                                            subElement.value = subElement.key;
                                            currentSelected[haId] = {key: subElement.value, name: subElement.name};
                                            subElement.key = "BSH_Common_Root_SelectedProgram";
                                            subElement.name = "BSH_Common_Root_SelectedProgram";
                                        } else {
                                            this.log.warn("Empty sublement: " + JSON.stringify(subElement));
                                        }
                                    }
                                    if (url === "/programs") {
                                        this.log.debug(haId + " available: " + JSON.stringify(subElement));
                                        if (availablePrograms[haId]) {
                                            availablePrograms[haId].push({
                                                key: subElement.key,
                                                name: subElement.name,
                                            });
                                        } else {
                                            availablePrograms[haId] = [
                                                {
                                                    key: subElement.key,
                                                    name: subElement.name,
                                                },
                                            ];
                                        }
                                        getAPIValues(token, haId, "/programs/available/" + subElement.key);
                                        folder += ".available";
                                    }
                                    if (url === "/settings") {
                                        getAPIValues(token, haId, "/settings/" + subElement.key);
                                    }

                                    if (url.indexOf("/programs/selected/") !== -1) {
                                        if (!currentSelected[haId]) {
                                            return;
                                        }
                                        if (!currentSelected[haId].key) {
                                            this.log.warn(JSON.stringify(currentSelected[haId]) + " is selected but has no key selected ");
                                            return;
                                        }
                                        const key = currentSelected[haId].key.split(".").pop();
                                        folder += "." + key;

                                        this.setObjectNotExists(haId + folder, {
                                            type: "state",
                                            common: {
                                                name: currentSelected[haId].name,
                                                type: "mixed",
                                                role: "indicator",
                                                write: true,
                                                read: true
                                            },
                                            native: {},
                                        });
                                    }
                                    this.log.debug("Create State: " + haId + folder + "." + subElement.key.replace(/\./g, "_"));
                                    let type = "mixed";
                                    if (typeof subElement.value === "boolean") {
                                        type = "boolean";
                                    }
                                    if (typeof subElement.value === "number") {
                                        type = "number";
                                    }
                                    const common = {
                                        name: subElement.name,
                                        type: type,
                                        role: "indicator",
                                        write: true,
                                        read: true,
                                        unit: subElement.unit || "",
                                        min: (subElement.constraints && subElement.constraints.min) || null,
                                        max: (subElement.constraints && subElement.constraints.max) || null,
                                    };
                                    this.setObjectNotExists(haId + folder + "." + subElement.key.replace(/\./g, "_"), {
                                        type: "state",
                                        common: common,
                                        native: {},
                                    });
                                    this.setState(haId + folder + "." + subElement.key.replace(/\./g, "_"), subElement.value, true);
                                });
                            }
                            if (url === "/programs") {
                                const rootItems = [
                                    {
                                        key: "BSH_Common_Root_ActiveProgram",
                                        folder: ".programs.active",
                                    },
                                    {
                                        key: "BSH_Common_Root_SelectedProgram",
                                        folder: ".programs.selected",
                                    },
                                ];
                                rootItems.forEach((rootItem) => {
                                    const common = {
                                        name: rootItem.key,
                                        type: "string",
                                        role: "indicator",
                                        write: true,
                                        read: true,
                                        states: {},
                                    };
                                    availablePrograms[haId].forEach((program) => {
                                        common.states[program.key] = program.name;
                                    });
                                    this.setObjectNotExists(haId + rootItem.folder + "." + rootItem.key.replace(/\./g, "_"), {
                                        type: "state",
                                        common: common,
                                        native: {},
                                    });
                                    this.extendObject(haId + rootItem.folder + "." + rootItem.key.replace(/\./g, "_"), {
                                        type: "state",
                                        common: common,
                                        native: {},
                                    });
                                });
                            }
                        } catch (error) {
                            this.log.error(error);
                            this.log.error(error.stack);
                            this.log.error(url);
                            this.log.error(JSON.stringify(returnValue));
                        }
                    },
                    ([statusCode, description]) => {
                        // this.log.info("Error getting API Values Error: " + statusGet);
                        this.log.info(haId + ": " + description);
                    }
                )
                .catch(() => {
                    this.log.debug("request not succesfull");
                });
        }

        async sendRequest(token, haId, url, method, data) {
            method = method || "GET";

            const param = {
                Authorization: "Bearer " + token,
                Accept: "application/vnd.bsh.sdk.v1+json, application/vnd.bsh.sdk.v2+json, application/json, application/vnd.bsh.hca.v2+json, application/vnd.bsh.sdk.v1+json, application/vnd",
                "Accept-Language": "de-DE",
            };
            if (method === "PUT" || method === "DELETE") {
                param["Content-Type"] = "application/vnd.bsh.sdk.v1+json";
            }
            return new Promise((resolve, reject) => {
                const now = Date.now();
                let timeout = 0;

                let i = 0;
                while (i < rateCalculation.length) {
                    if (now - rateCalculation[i] < 60000) {
                        break;
                    }
                    i++;
                }
                if (i) {
                    if (i < rateCalculation.length) {
                        rateCalculation.splice(0, i);
                    } else {
                        rateCalculation = [];
                    }
                }

                if (rateCalculation.length > 2) {
                    timeout = rateCalculation.length * 1500;
                }

                this.log.debug("Rate per min: " + rateCalculation.length);
                rateCalculation.push(now);
                rateLimitTimeout = setTimeout(() => {
                    request(
                        {
                            method: method,
                            url: "https://api.home-connect.com/api/homeappliances/" + haId + url,
                            headers: param,
                            body: data,
                        },

                        function (error, response, body) {
                            const responseCode = response ? response.statusCode : null;
                            if (error) {
                                reject([responseCode, error]);
                                return;
                            }
                            if (!error && responseCode >= 300) {
                                try {
                                    const errorString = JSON.parse(body);
                                    const description = errorString.error.description;
                                    reject([responseCode, description]);
                                } catch (error) {
                                    const description = body;
                                    reject([responseCode, description]);
                                }
                            } else {
                                try {
                                    const parsedResponse = JSON.parse(body);
                                    resolve([responseCode, parsedResponse]);
                                } catch (error) {
                                    resolve([responseCode, body]);
                                }
                            }
                        }
                    );
                }, timeout);
            });
        }

        async initialisation() {
            if (!this.config.clientID) {
                this.log.error("Client ID not specified!");
            }

            if (this.config.resetAccess) {
                this.log.info("Reset access");
                this.setState("dev.authUriComplete", "");
                this.setState("dev.devCode", "");
                this.setState("dev.access", false);
                this.setState("dev.token", "");
                this.setState("dev.refreshToken", "");
                this.setState("dev.expires", "");
                this.setState("dev.tokenScope", "");
                const adapterConfig = "system.this." + this.name + "." + this.instance;
                this.getForeignObject(adapterConfig, (error, obj) => {
                    obj.native.authUri = "";
                    obj.native.clientID = "";
                    obj.native.resetAccess = false;
                    this.setForeignObject(adapterConfig, obj);
                });
                return;
            }

            if (!this.config.updateCleanup) {
                const pre = this.name + "." + this.instance;
                this.getStates(pre + ".*", (err, states) => {
                    const allIds = Object.keys(states);
                    const searchString = "selected.options.";
                    allIds.forEach(function (keyName) {
                        if (keyName.indexOf(searchString) !== -1) {
                            this.delObject(keyName.split(".").slice(2).join("."));
                        }
                    });
                    const adapterConfig = "system.this." + this.name + "." + this.instance;
                    this.getForeignObject(adapterConfig, (error, obj) => {
                        if (obj) {
                            obj.native.updateCleanup = true;
                        }
                        //  this.setForeignObject(adapterConfig, obj);
                    });
                });
            }
            //OAuth2 Deviceflow
            //Get Authorization-URI to grant access ===> User interaction

            const scope = this.config.scope;
            const clientID = this.config.clientID;

            this.stateGet(this.namespace + ".dev.devCode")
                .then((value) => {
                    if (value == false) {
                        auth.authUriGet(scope, clientID)
                            .then(
                                ([authUri, devCode, pollInterval]) => {
                                    this.setState("dev.authUriComplete", authUri);
                                    this.setState("dev.devCode", devCode);
                                    this.setState("dev.pollInterval", pollInterval);
                                    const adapterConfig = "system.adapter." + this.name + "." + this.instance;
                                    this.getForeignObject(adapterConfig, (error, obj) => {
                                        if (!obj.native.authUri) {
                                            obj.native.authUri = authUri;
                                            this.setForeignObject(adapterConfig, obj, true);
                                        }
                                    });
                                },
                                (statusPost) => {
                                    this.log.error("Error AuthUriGet: " + statusPost);
                                }
                            )
                            .catch(() => {
                                this.log.debug("auth uri not successfull");
                            });
                    } else {
                        this.stateGet(this.namespace + ".dev.token")
                            .then(
                                (value) => {
                                    if (!value) {
                                        getTokenInterval = setInterval(this.getToken, 10000);
                                    } else {
                                        const token = value;
                                        auth.getAppliances(token)
                                            .then(
                                                (appliances) => {
                                                    parseHomeappliances(appliances);
                                                },

                                                ([statusCode, description]) => {
                                                    this.log.error("Error getting Aplliances with existing Token: " + statusCode + " " + description);
                                                    this.log.warn("Restart the Adapter to get all devices correctly.");
                                                    if (statusCode === 401) {
                                                        if (description && description.indexOf("malformed") !== -1) {
                                                            this.log.warn(
                                                                "The Homeconnect API is not reachable, the adapter will restart until the API is reachable. Please do not reset the Token while the Homeconnect API is not reachable."
                                                            );
                                                        } else {
                                                            this.log.warn("If Restart is not working please reset the Token in the settings.");
                                                        }
                                                    }
                                                    if (statusCode === 503) {
                                                        this.log.warn("Homeconnect is not reachable please wait until the service is up again.");
                                                    }
                                                    restartTimeout = setTimeout(() => this.restart(), 2000);
                                                }
                                            )
                                            .catch(() => {
                                                this.log.debug("No appliance found");
                                            });
                                        this.stateGet(this.namespace + ".dev.refreshToken")
                                            .then((refreshToken) => {
                                                this.getRefreshToken(true);
                                                getTokenRefreshInterval = setInterval(this.getRefreshToken, 20 * 60 * 60 * 1000); //every 20h
                                            })
                                            .catch(() => {
                                                this.log.debug("Not able to get refresh token");
                                            });
                                    }
                                },
                                (err) => {
                                    this.log.error("FEHLER: " + err);
                                }
                            )
                            .catch(() => {
                                this.log.debug("No token found");
                            });
                    }
                })
                .catch(() => {
                    this.log.debug("No token found");
                });
        }
        async create_state() {

            this.setObjectNotExists("dev.authUriComplete", {
                type: "state",
                common: {
                    name: "AuthorizationURI",
                    type: "mixed",
                    role: "indicator",
                    write: false,
                    read: true,
                },
                native: {},
            });

            this.setObjectNotExists("dev.devCode", {
                type: "state",
                common: {
                    name: "DeviceCode",
                    type: "mixed",
                    role: "indicator",
                    write: false,
                    read: true,
                },
                native: {},
            });

            this.setObjectNotExists("dev.pollInterval", {
                type: "state",
                common: {
                    name: "Poll-Interval in sec.",
                    type: "mixed",
                    role: "indicator",
                    write: false,
                    read: true,
                },
                native: {},
            });

            this.setObjectNotExists("dev.token", {
                type: "state",
                common: {
                    name: "Access-Token",
                    type: "mixed",
                    role: "indicator",
                    write: false,
                    read: true,
                },
                native: {},
            });

            this.setObjectNotExists("dev.refreshToken", {
                type: "state",
                common: {
                    name: "Refresh-Token",
                    type: "mixed",
                    role: "indicator",
                    write: false,
                    read: true,
                },
                native: {},
            });

            this.setObjectNotExists("dev.access", {
                type: "state",
                common: {
                    name: "access",
                    type: "boolean",
                    role: "indicator",
                    write: true,
                    read: true,
                },
                native: {},
            });

            this.setObjectNotExists("dev.expires", {
                type: "state",
                common: {
                    name: "Token expires in sec",
                    type: "number",
                    role: "indicator",
                    write: false,
                    read: true,
                },
                native: {},
            });

            this.setObjectNotExists("dev.tokenScope", {
                type: "state",
                common: {
                    name: "Scope",
                    type: "mixed",
                    role: "indicator",
                    write: false,
                    read: true,
                },
                native: {},
            });

            this.setObjectNotExists("dev.eventStreamJSON", {
                type: "state",
                common: {
                    name: "Eventstream_JSON",
                    type: "object",
                    role: "indicator",
                    write: false,
                    read: true,
                },
                native: {},
            });

            this.subscribeStates("*");
        }

}

// @ts-ignore parent is a valid property on module
if (module.parent) {
    // Export the constructor in compact mode
    /**
     * @param {Partial<utils.AdapterOptions>} [options={}]
     */
    module.exports = (options) => new homeConnect(options);
} else {
    // otherwise start the instance directly
    new homeConnect();
}
