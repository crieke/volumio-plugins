/* jshint node: true, esversion: 9, unused: false */
'use strict';

var libQ = require('kew');
var fs = require('fs-extra');
var config = new (require('v-conf'))();
var exec = require('child_process').exec;
var execSync = require('child_process').execSync;

var dnsSync = require('dns-sync');
var timers = require('./timers');
var handler = require('./handler');

const { defer, setNextTickFunction } = require('kew');
const { REFUSED, SERVFAIL } = require('dns');
const { get } = require('https');
const { setFlagsFromString } = require('v8');
const { readSync } = require('fs-extra');
const { pseudoRandomBytes } = require('crypto');
const { stat } = require('fs');
const { allowedNodeEnvironmentFlags, setMaxListeners } = require('process');
const { type } = require('os');


module.exports = ControllerPandora;
function ControllerPandora(context) {
    var self = this;

    this.context = context;
    this.commandRouter = this.context.coreCommand;
    this.logger = this.context.logger;
    this.configManager = this.context.configManager;

    self.serviceName = 'pandora';
    self.currStation = {};
    self.lastUri = null;
    self.lastPress = Date.now();
    self.cameFromMenu = false;
    self.state = {};
}


ControllerPandora.prototype.onVolumioStart = function () {
    // var self = this;
    var configFile=this.commandRouter.pluginManager.getConfigurationFile(this.context,'config.json');
    this.config = new (require('v-conf'))();
    this.config.loadFile(configFile);

    return libQ.resolve();
};

ControllerPandora.prototype.onStart = function () {
    var self = this;

    const options = {
        email: self.config.get('email'),
        password: self.config.get('password'),
        isPandoraOne: self.config.get('isPandoraOne'),
        maxStationTracks: self.validateMaxStationTracks(self.config.get('maxStationTracks')),
        bandFilter: self.validateBandFilter(self.config.get('bandFilter'))
    };

    self.useCurl302WorkAround = self.config.get('useCurl302WorkAround');
    self.nextIsThumbsDown = self.config.get('nextIsThumbsDown');
    self.flushThem = self.config.get('flushThem');

    self.mpdPlugin = self.commandRouter.pluginManager.getPlugin('music_service', 'mpd');

    self.addToBrowseSources();

    return self.validateLoginCredentials(options);
};

ControllerPandora.prototype.onStop = function () {
    // Once the Plugin has successfull stopped resolve the promise
    var self = this;

    if (typeof(self.expireHandler) !== 'undefined') self.expireHandler.stop();
    if (typeof(self.streamLifeChecker) !== 'undefined') self.streamLifeChecker.stop();
    if (typeof(self.preventAuthTimeout)  !== 'undefined') self.preventAuthTimeout.stop();

    return self.flushPandora()
        .then(() => self.stop())
        .then(() => {
            self.commandRouter.volumioRemoveToBrowseSources('Pandora Radio');
            return libQ.resolve();
        });
};

ControllerPandora.prototype.onRestart = function () {
    var self = this;
    // Optional, use if you need it
};

// Setup Methods -----------------------------------------------------------------------------

ControllerPandora.prototype.flushPandora = function () {
    var self = this;

    self.announceFn('flushPandora');

    const newQ = self.getQueue().filter(item => item.service !== self.serviceName);

    if (newQ.length > 0) {
        self.commandRouter.stateMachine.playQueue.clearAddPlayQueue(newQ);
    }
    else {
        // self.commandRouter.stateMachine.playQueue.clearPlayQueue();
        self.logInfo('flushPandora: running clearQueue()');
        self.commandRouter.stateMachine.clearQueue();
    }
    return libQ.resolve();
};

ControllerPandora.prototype.initialSetup = function (options) {
    var self = this;

    self.announceFn('initialSetup');

    self.pandoraHandler = new handler(self, options);
    self.pandoraHandler.init()
        .then(() => self.pandoraHandler.setCredentials(options))
        .then(() => {
            self.preventAuthTimeout = new timers.PreventAuthTimeout(self);

            return libQ.resolve();
        })
        .then(() => {
            self.expireHandler = new timers.ExpireOldTracks(self);
            self.streamLifeChecker = new timers.StreamLifeChecker(self);

            return libQ.resolve();
        })
        .then(() => self.flushPandora());
};

// Configuration Methods -----------------------------------------------------------------------------

ControllerPandora.prototype.getUIConfig = function () {
    var defer = libQ.defer();
    var self = this;

    var lang_code = this.commandRouter.sharedVars.get('language_code');

    self.commandRouter.i18nJson(__dirname+'/i18n/strings_'+lang_code+'.json',
        __dirname+'/i18n/strings_en.json',
        __dirname + '/UIConfig.json')
        .then(uiconf => {
            uiconf.sections[0].content[0].value = self.config.get('email', '');
            uiconf.sections[0].content[1].value = self.config.get('password', '');
            uiconf.sections[0].content[2].value = self.config.get('isPandoraOne', '');
            uiconf.sections[0].content[3].value = self.config.get('useCurl302WorkAround', '');
            uiconf.sections[0].content[4].value = self.config.get('nextIsThumbsDown', '');
            uiconf.sections[0].content[5].value = self.config.get('superPrevious', '');
            uiconf.sections[0].content[6].value = self.config.get('maxStationTracks', '');
            uiconf.sections[0].content[7].value = self.config.get('flushThem', '');
            uiconf.sections[0].content[8].value = self.config.get('bandFilter', '');
            self.config.get();

            defer.resolve(uiconf);
        })
        .fail(err => {
            defer.reject(new Error('[Pandora] Failed to load UIConfig.json' + err));
        });

    return defer.promise;
};

ControllerPandora.prototype.getConfigurationFiles = function () {
    return ['config.json'];
};

ControllerPandora.prototype.setUIConfig = function (data) {
    var self = this;
    //Perform your installation tasks here
};

ControllerPandora.prototype.getConf = function (varName) {
    var self = this;
    //Perform your installation tasks here
};

ControllerPandora.prototype.setOptionsConf = function (options) {
    var self = this;

    self.config.set('email', options.email);
    self.config.set('password', options.password);
    self.config.set('isPandoraOne', options.isPandoraOne);
    self.isPandoraOne = options.isPandoraOne;
    self.config.set('useCurl302WorkAround', options.useCurl302WorkAround);
    self.useCurl302WorkAround = options.useCurl302WorkAround;
    self.config.set('nextIsThumbsDown', options.nextIsThumbsDown);
    self.nextIsThumbsDown = options.nextIsThumbsDown;
    self.config.set('superPrevious', options.superPrevious);
    self.superPrevious = options.superPrevious;
    self.config.set('flushThem', options.flushThem);
    self.flushThem = options.flushThem;

    // These options are validated
    options.maxStationTracks = self.validateMaxStationTracks(options.maxStationTracks);
    self.config.set('maxStationTracks', options.maxStationTracks);
    options.bandFilter = self.validateBandFilter(options.bandFilter);
    self.config.set('bandFilter', options.bandFilter);

    if (typeof(self.pandoraHandler) !== 'undefined') {
        self.pandoraHandler.setMaxStationTracks(options.maxStationTracks);
        self.pandoraHandler.setBandFilter(options.bandFilter.split('%'));
    }

    return self.validateLoginCredentials(options)
        .then(() => self.timeOutToast('validateLoginCredentials', 'info',
            'Pandora Options', 'Plugin Options Saved', 5000))
        .fail(err => self.generalReject('validateLoginCredentials', err));
};

ControllerPandora.prototype.validateMaxStationTracks = function (mq) {
    var self = this;
    const maxStationTracksDefault = 16;
    const maxStationTracksMin = 8;

    const head = 'Invalid Song Maximum!\n';
    const middle = 'Should be at least ' + maxStationTracksMin + '\n';
    const tail = 'Setting to default (' + maxStationTracksDefault + ').';

    let mqParsed = parseInt(mq);
    let msg = isNaN(mqParsed) ? head + tail : head + middle + tail;

    let result = maxStationTracksDefault;
    if (mqParsed >= maxStationTracksMin) {
        result = mqParsed;
    }
    else {
        self.commandRouter.pushToastMessage('info', 'Pandora Options', msg);
    }

    return result;
};

ControllerPandora.prototype.validateBandFilter = function (bf) {
    var self = this;
    bf = (!bf) ? '' : bf;
    return bf;
};

// validates Pandora login credentials
ControllerPandora.prototype.validateLoginCredentials = function (options) {
    var self = this;
    const fnName = 'validateLoginCredentials';

    self.announceFn(fnName);

    if ((typeof(options.email) === 'undefined' || typeof(options.password) === 'undefined') ||
        (!options.email || !options.password)) {

        const msg = 'Need email address and password.  See plugin settings.';

        self.timeOutToast(fnName, 'error', 'Pandora Options', msg, 6000);
        self.logError(msg);

        return libQ.resolve();
    }
    else if (typeof(self.pandoraHandler) === 'undefined') { // let's go!
        self.initialSetup(options);

        return libQ.resolve();
    }
    else { // set new credentials, restart auth timer
        self.pandoraHandler.setCredentials(options);
        self.preventAuthTimeout.fn();

        return libQ.resolve();
    }
};

// Playback Controls ---------------------------------------------------------------------------------------
// If your plugin is not a music_sevice don't use this part and delete it

// Use this function to add your music service plugin to music sources
ControllerPandora.prototype.addToBrowseSources = function () {
    var data = {
        name: 'Pandora Radio',
        uri: '/pandora',
        albumart: '/albumart?sourceicon=music_service/pandora/pandora.png',
        icon: 'fa fa-microphone',
        plugin_type: 'music_service',
        plugin_name: 'pandora'
    };

    return this.commandRouter.volumioAddToBrowseSources(data);
};

ControllerPandora.prototype.handleBrowseUri = function (curUri) {
    var self = this;
    const staRe = /\/pandora\/station_id=(\d+)$/;
    const stationData = self.pandoraHandler.getStationData();
    const fnName = 'handleBrowseUri';

    var response = {
        navigation: {
            'prev': { uri: '/pandora' },
            'lists': [
                {
                    'availableListViews': ['list'],
                    'items': []
                }
            ]
        }
    };

    function checkForStationChange(newStationId) {
        let stationChanged = (self.currStation.id !== newStationId);

        self.currStation.id = newStationId;
        self.currStation.name = stationData[newStationId].name;
        if (stationChanged && self.flushThem) {
            return self.flushPandora();
        }

        return libQ.resolve();
    }

    self.announceFn(fnName);

    if (curUri === '/pandora') {
        for (let i = 0; i < stationData.length; i++) {
            response.navigation.lists[0].items.push({
                service: self.serviceName,
                type: 'station',
                artist: '',
                title: stationData[i].name,
                name: stationData[i].name,
                album: '',
                albumart: stationData[i].albumart,
                icon: 'fa fa-folder-open-o',
                uri: '/pandora/station_id=' + i
            });
        }

        return libQ.resolve(response);
    }
    else if (curUri.match(staRe) !== null) {
        return checkForStationChange(curUri.match(staRe)[1])
            .then(() => self.pandoraHandler.fetchTracks())
            .then(() => {
                self.lastUri = null;
                self.cameFromMenu = true;

                let newTracks = self.pandoraHandler.getNewTracks();

                if (newTracks.length > 0) {
                    return self.commandRouter.stateMachine.playQueue.addQueueItems(newTracks)
                        .then(() => self.getQueueIndex(newTracks[0].uri))
                        .then(index => {
                            self.setCurrQueuePos(index);
                            return self.commandRouter.stateMachine.play(index);
                        });
                }
                self.commandRouter.pushToastMessage('error', 'Pandora',
                    'Failed to load tracks from ' + self.currStation.name);

                return self.generalReject(fnName, 'failed to load tracks from ' +
                    self.currStation.name);
            });
    }
    else {
        return self.generalReject('handleBrowseUri', 'failed to match uri: ' + curUri);
    }
};

// add tags to newTracks and add to mpd queue
ControllerPandora.prototype.appendTracksToMpd = function (newTracks) {
    var self = this;
    var defer = libQ.defer();

    const fnName = 'appendTracksToMpd';
    self.announceFn(fnName);

    // resolve address to numeric IP by DNS lookup
    function resolveTrackUri (uri) {
        let result = null;
        const subFnName = fnName + '::resolveTrackUri';

        try {
            let start = uri.indexOf('//') + 2;
            let host = uri.substr(start, uri.indexOf('/', start) - start);
            result = uri.replace(host, dnsSync.resolve(host));

            self.logInfo(subFnName + ': ' + uri + ' => ' + result);
        } catch (err) {
            self.logError(subFnName + ': error resolving ' + uri, err);
            self.commandRouter.pushToastMessage('error', 'Pandora',
                subFnName + ' error');
            result = uri;
        }

        return libQ.resolve(result);
    }

    function setTrackTags(input) {
        (() => self.useCurl302WorkAround ?
            resolveTrackUri(input.realUri) :
            libQ.resolve(input.realUri))()
            .then(realUri => self.mpdPlugin.sendMpdCommand('addid', [realUri]))
            .then(result => {
                let tagUpdateCmds = [
                    { command: 'addtagid', parameters: [result.Id, 'artist', input.artist] },
                    { command: 'addtagid', parameters: [result.Id, 'album', input.album] },
                    { command: 'addtagid', parameters: [result.Id, 'title', input.title] }
                ];

                return self.mpdPlugin.sendMpdCommandArray(tagUpdateCmds);
            });
    }

    let promises = [];
    newTracks.forEach(item => promises.push(setTrackTags(item)));
    self.logInfo('appendTracksToMpd added ' +
                  newTracks.length +
                 ' track(s) to mpd');

    libQ.all(promises)
        .fail(err => {
            self.logError('Error in ' + fnName, err);
            defer.reject(self.pandoraPrefix() + fnName + ' error: ' + err);
        })
        .then(defer.resolve());

    return defer.promise;
};

ControllerPandora.prototype.getQueueIndex = function (uri) {
    var self = this;
    return self.getQueue().findIndex(item => item.uri === uri);
};

ControllerPandora.prototype.getQueue = function () {
    var self = this;
    return self.commandRouter.stateMachine.playQueue.getQueue();
};

ControllerPandora.prototype.getCurrQueuePos = function () {
    var self = this;
    return self.commandRouter.stateMachine.currentPosition;
};

ControllerPandora.prototype.setCurrQueuePos = function (newQPos) {
    var self = this;
    self.commandRouter.stateMachine.currentPosition = newQPos;
};

ControllerPandora.prototype.getQueueTrack = function (pos=this.getCurrQueuePos()) {
    var self = this;
    return self.commandRouter.stateMachine.getTrack(pos);
};

ControllerPandora.prototype.getCurrStationTracks = function () {
    var self = this;

    self.announceFn('getCurrStationTracks');

    return libQ.resolve(self.getQueue().filter(item =>
        item.service === self.serviceName &&
        item.stationId == self.currStation.id));
};

ControllerPandora.prototype.removeTrack = function (trackUri, justOldTracks=false) {
    var self = this;
    const fnName = 'removeTrack';
    const qPos = self.getCurrQueuePos();
    const index = self.getQueueIndex(trackUri);

    let test = (index != -1 && index != qPos && trackUri);
    const beforeQPos = (index < qPos);
    if (justOldTracks) {
        test = (test && beforeQPos);
    }

    self.announceFn(fnName + ': ' + trackUri);

    if (test) {
        self.commandRouter.stateMachine.removeQueueItem({value: index});
        return self.mpdPlugin.getState()
            .then(state => self.pushState(state));
    }
    else {
        self.logInfo(fnName + ': '+ 'Not removing ' +
            trackUri + ' at queue index: ' + index);
        return libQ.resolve();
    }
};

// Remove oldest Pandora tracks from queue to make room for new ones
ControllerPandora.prototype.removeOldTrackBlock = function (pQPos, diff) {
    var self = this;
    const fnName = 'removeOldTrackBlock';
    const limit = Math.min(pQPos, diff);
    let promises = [];

    self.announceFn(fnName);

    return self.getCurrStationTracks()
        .then(pandoraQ => {
            for (let i = 0; i < limit; i++) {
                promises.push(self.siesta(
                    self.removeTrack.bind(self),
                    fnName,
                    [pandoraQ[i].uri, true],
                    10000 * (i + 1)
                ));
            }
            libQ.all(promises)
                .fail(err => self.generalReject(fnName + ': Error', err))
                .then(() => self.logInfo(fnName + ': Removing ' + limit + ' tracks'));
        });
};

ControllerPandora.prototype.fetchAndAddTracks = function (curUri) {
    var self = this;
    const fnName = 'fetchAndAddTracks';

    function getSQInfo() {
        self.announceFn(fnName + '::getSqInfo');

        return self.getCurrStationTracks()
            .then(stationQ => { // stationQ: current station tracks
                const Q = self.getQueue();
                const qLen = Q.length;
                const sQLen = stationQ.length;
                // sQPos: song pos in SQ
                const sQPos = stationQ.findIndex(item => item.uri === curUri);
                // isSQLast: SQ @ end of playQueue
                const isSQLast = (stationQ[sQLen - 1].uri === Q[qLen - 1].uri) &&
                    (stationQ[0].uri === Q[qLen - sQLen].uri);

                return libQ.resolve({ sQPos: sQPos, isSQLast: isSQLast });
            });
    }

    function moveStationTracks(tracks) {
        const subFnName = fnName + '::moveStationTracks';
        const trackLen = tracks.length;
        const qLen = self.getQueue().length;
        let msg = subFnName + ': Moved tracks [';
        let finalPos;

        self.announceFn(subFnName);

        let to = self.oldQLen - 1;
        if (!self.cameFromMenu) {
            self.oldQLen = qLen;
            to = qLen - 1;
        }

        for (let i = 0; i < trackLen; i++) {
            let trackToMove = tracks.shift();
            let from = self.getQueueIndex(trackToMove.uri);
            self.commandRouter.stateMachine.moveQueueItem(from, to);
            msg += (i < tracks.length - 1) ? i + ', ' :
                i + '] from ' + from + ' to ' + to;
        }
        self.logInfo(msg);

        if (!self.cameFromMenu) { // set new Qpos
            getSQInfo()
                .then(sqInfo => libQ.resolve(sqInfo.sQPos))
                .then(sQPos => {
                    finalPos = to - trackLen + sQPos + 1;
                    self.setCurrQueuePos(finalPos);
                    self.logInfo(subFnName +
                        ': Set new Queue Position to ' +
                        finalPos);
                    self.mpdPlugin.getState()
                        .then(state => self.pushState(state));
                });
        }
        return libQ.resolve();
    }

    function checkIfMovingTracks(isSQLast) {
        if (!self.flushThem) { // multiple stations in queue
            if (!isSQLast) {
                const SQ = self.getQueue().filter(
                    item => item.stationId == self.currStation.id);
                return moveStationTracks(SQ);
            }

            self.cameFromMenu = false;
        }

        return libQ.resolve();
    }

    self.announceFn(fnName);

    if (self.state.artist && self.state.title) {
        return self.pandoraHandler.getSongMaxDiff()
            .then(diff1 => {
                return getSQInfo()
                    .then(sQInfo1 => {
                        self.logInfo(fnName + '=> diff1: ' + diff1 +
                            ' sQPos1: ' + sQInfo1.sQPos);
                        if (sQInfo1.sQPos != 0 || diff1 < 0) { // will fetch tracks
                            self.logInfo(fnName + ': Fetching tracks');
                            let deferFetchTracks = self.pandoraHandler.fetchTracks();
                            deferFetchTracks.then(() => {
                                let newTracks = self.pandoraHandler.getNewTracks();
                                if (newTracks) {
                                    // don't add tracks twice (WILL REVISIT)
                                    // let Q = self.getQueue();
                                    // if (!newTracks.map(i => i.uri).some(uri => Q.map(j => j.uri).includes(uri))) {
                                    return checkIfMovingTracks(sQInfo1.isSQLast)
                                        .then(() => self.commandRouter.stateMachine.playQueue.addQueueItems(newTracks))
                                        .then(() => self.pandoraHandler.getSongMaxDiff())
                                        .then(diff2 => {
                                            if (diff2 > 0) {
                                                return getSQInfo()
                                                    .then(sQInfo2 => {
                                                        self.logInfo(fnName + '=> diff2 > 0: ' + diff2 +
                                                            ' sQPos2: ' + sQInfo2.sQPos);
                                                        return self.removeOldTrackBlock(sQInfo2.sQPos, diff2);
                                                    });
                                            }
                                        });
                                }
                            });
                        }
                        else { // no fetch
                            self.logInfo(fnName + ': Not fetching tracks: qPos == 0 && diff1 >= 0');
                            return checkIfMovingTracks(sQInfo1.isSQLast);
                        }
                    });
            });
    }
    return libQ.resolve();
};

// This callback runs after mpd player 'player' event
ControllerPandora.prototype.pandoraListener = function () {
    var self = this;
    const fnName = 'pandoraListener';

    self.announceFn(fnName);

    self.mpdPlugin.getState()
        .then(state => {
            let nextTrack = self.getQueueTrack();

            if (nextTrack.service && nextTrack.service === self.serviceName) {
                self.mpdPlugin.clientMpd.once('system-player', self.pandoraListener.bind(self));
                return self.pushState(state);
            }
            else {
                self.logInfo(fnName + ': Removing pandoraListener');
            }
        });
};

// Define a method to clear, add, and play an array of tracks
ControllerPandora.prototype.clearAddPlayTrack = function (track) {
    var self = this;
    const fnName = 'clearAddPlayTrack';

    self.announceFn(fnName);

    // Here we go! (¡Juana's Adicción!)
    return self.mpdPlugin.clear()
        .then(() => self.streamLifeChecker.stop())
        .then(() => {
            if (self.lastUri !== track.uri &&
                    self.currStation.id == track.stationId) {
                self.removeTrack(self.lastUri);
            }
            self.currStation.id = track.stationId;
            self.currStation.name = self.pandoraHandler.getStationData()[track.stationId].name;
            self.lastUri = track.uri;

            return self.appendTracksToMpd([track]);
        })
        .then(() => {
            self.mpdPlugin.clientMpd.removeAllListeners('system-player');
            self.mpdPlugin.clientMpd.once('system-player', self.pandoraListener.bind(self));

            return self.mpdPlugin.sendMpdCommand('play', []);
        })
        .then(() => self.parseState(track))
        .then(state => {
            self.state = state;
            self.state.seek = 0;
            self.state.status = 'play';

            return self.pushState(self.state);
        })
        .then(() => self.fetchAndAddTracks(track.uri))
        .fail(err => {
            self.logError(fnName + ' error: ' + err);
            return self.goPreviousNext('skip');
        });
};

// ControllerPandora.prototype.seek = function (position) {
//     var self = this;

//     // self.announceFn('seek to ' + position);

//     // return self.mpdPlugin.seek(position);
// };

// Stop
ControllerPandora.prototype.stop = function () {
    var self = this;

    self.mpdPlugin.clientMpd.removeAllListeners('system-player');
    self.lastUri = null;

    self.announceFn('stop');

    return self.mpdPlugin.stop()
        .then(() => {
            self.state.status = 'stop';
            return self.pushState(self.state);
        });
};

// Spop pause
ControllerPandora.prototype.pause = function () {
    var self = this;

    self.announceFn('pause');

    self.mpdPlugin.clientMpd.removeAllListeners('system-player');

    return self.streamLifeChecker.stop()
        .then(() => self.mpdPlugin.pause())
        .then(() => {
            let vState = self.commandRouter.stateMachine.getState();
            self.state.status = 'pause';
            self.state.seek = vState.seek;
            return self.pushState(self.state);
        });
};

ControllerPandora.prototype.resume = function () {
    var self = this;

    self.announceFn('resume');

    self.mpdPlugin.clientMpd.removeAllListeners('system-player');
    self.mpdPlugin.clientMpd.once('system-player', self.pandoraListener.bind(self));


    return self.mpdPlugin.resume()
        .then(() => self.streamLifeChecker.init());
        // .then(() => self.mpdPlugin.getState())
        // .then(state => self.pushState(state));
};

// enforce slight delay with media controls to avoid traffic jam
ControllerPandora.prototype.handleMediaButton = function (mediaFn) {
    var self = this;
    const fnName = 'handleMediaButton';
    const timeNow = Date.now();
    const spazPressMs = 250;
    const prevPressMs = 1500;
    const timeDiffMs = timeNow - self.lastPress;
    let result = mediaFn;

    if (timeDiffMs < spazPressMs) { // jumpy user
        // self.logInfo(fnName + ': User called ' + mediaFn + ' too rapidly' +
        //     '');
        // self.commandRouter.pushToastMessage('info', 'Pandora',
        //     'Where\'s the fire? Slow down!');
        self.logInfo(fnName + ': Media track skipped in less than ' +
            spazPressMs + 'ms.');
        result = 'spaz';
    }
    else if (timeDiffMs > prevPressMs &&
             mediaFn === 'previous' &&
             self.superPrevious) { // replay track
        result = 'replay';
    }

    self.logInfo(fnName + ': User chose "' + result + '" function');
    self.lastPress = timeNow;

    return libQ.resolve(result);
};

ControllerPandora.prototype.goPreviousNext = function (fnName) {
    var self = this;
    const qLen = self.getQueue().length;
    const isNotRandom = (self.commandRouter.stateMachine.currentRandom !== true);
    let qPos = self.getCurrQueuePos();

    self.mpdPlugin.clientMpd.removeAllListeners('system-player');
    self.lastUri = null;

    return self.handleMediaButton(fnName)
        .then(result => {
            if (result !== 'spaz') {
                if (fnName === 'previous') {
                    if (result === 'replay') {
                        self.commandRouter.stateMachine.currentSeek = 0; // reset Volumio timer
                    }
                    else if (isNotRandom) { // normal previous
                        qPos = (qPos + qLen - 1) % qLen;
                    }
                    else { // random previous
                        return self.stop();
                    }
                    self.setCurrQueuePos(qPos);
                    return self.clearAddPlayTrack(self.getQueue()[qPos]);
                }
                else if (fnName === 'next') {
                    return self.stop()
                        .then(() => {
                            if (self.nextIsThumbsDown) {
                                return self.commandRouter.stateMachine.removeQueueItem({value: qPos});
                            }
                        });
                }
                else { // 'skip' (bad uri lookup / stream ended)
                    return self.stop(); // play next consecutive/random track
                }
            }
            return libQ.resolve();
        });
};

ControllerPandora.prototype.previous = function () {
    var self = this;
    const fnName = 'previous';

    self.announceFn(fnName);

    return self.goPreviousNext(fnName);
};

ControllerPandora.prototype.next = function () {
    var self = this;
    const fnName = 'next';

    self.announceFn(fnName);

    if (self.nextIsThumbsDown) {
        self.pandoraHandler.thumbsDownTrack(self.getQueueTrack());
    }

    return self.goPreviousNext(fnName);
};

ControllerPandora.prototype.parseState = function (state) {
    // var self = this;

    const strip = ({ // remove extra keys
        fetchTime,
        station,
        stationToken,
        trackToken,
        uri,
        ...rest
    }) => rest;
    let pState = strip(state);
    pState.uri = state.realUri;

    return libQ.resolve(pState);
};

ControllerPandora.prototype.pushState = function (state) {
    var self = this;

    self.announceFn('pushState');

    state.trackType = 'mp3';
    state.bitdepth = '16 bit';
    state.samplerate = '44.1 KHz';
    self.commandRouter.servicePushState(state, self.serviceName);

    return self.commandRouter.stateMachine.setConsumeUpdateService('pandora');
};

ControllerPandora.prototype.explodeUri = function (uri) {
    // Mandatory: retrieve all info for a given URI
    var self = this;
    const fnName = 'explodeUri';
    const uriMatch = uri.match(/\/pandora\/station_id=(\d+)\/track_id=\d+/);

    self.announceFn(fnName);

    if (uriMatch !== null) {
        const newStationId = uriMatch[1];

        if (self.currStation.id != newStationId) { // for checkIfMovingTracks()
            self.oldQ = self.getQueue();
            self.oldQLen = self.oldQ.length;
        }

        // return a one elememnt track object array
        const Q = self.getQueue();
        const tracks = Q.concat(self.pandoraHandler.getNewTracks());
        const response = tracks.filter(item => item.uri === uri).slice(0, 1);

        return libQ.resolve(response);
    }

    let errMsg = 'explodeUri could not resolve uri: ' + uri;
    self.commandRouter.pushToastMessage('error', 'Pandora', errMsg);

    return self.generalReject(errMsg);
};

ControllerPandora.prototype.search = function (query) {
    // Mandatory, search. You can divide the search in sections using following functions
    var self = this;

    return libQ.resolve();
};

ControllerPandora.prototype._searchArtists = function (results) {

};

ControllerPandora.prototype._searchAlbums = function (results) {

};

ControllerPandora.prototype._searchPlaylists = function (results) {


};

ControllerPandora.prototype._searchTracks = function (results) {

};

// Logging helper functions --------------------------------------------------------------------------------

ControllerPandora.prototype.pandoraPrefix = function() {
    var self = this;
    return self.datePrefix() +  '[Pandora] ';
};

ControllerPandora.prototype.datePrefix = function() {
    // var self = this;
    return '[' + Date.now() + '] ';
};

ControllerPandora.prototype.logInfo = function (msg) {
    var self = this;
    self.logger.info(self.pandoraPrefix() + msg);
};

ControllerPandora.prototype.logError = function (msg, err) {
    var self = this;

    let errMsg = (typeof(err) !== 'undefined') ?
        msg + ': ' + err : msg;

    self.logger.error(self.pandoraPrefix() + errMsg);
};

ControllerPandora.prototype.generalReject = function (msg, err) {
    var self = this;

    let rejection = (typeof(err) !== 'undefined') ?
        msg + ' error: ' + err : msg;
    rejection = self.pandoraPrefix() + rejection;

    return libQ.reject(new Error(rejection));
};

ControllerPandora.prototype.announceFn = function (fnName) {
    var self = this;
    self.logger.info(self.datePrefix() +
        'ControllerPandora::' + fnName);
};

// Callback function wrappers --------------------------------------------------------------------------------

// Note: *Pass in an anonymous function if there are arguments*
ControllerPandora.prototype.siesta = function (fn, fnName, args, ms) {
    var self = this;

    const timerID = setTimeout(() => {
        fn(...args)
            .fail(err => self.generalReject(fnName, err))
            .then(() => libQ.resolve());
    }, ms);

    return libQ.resolve(timerID);
};

// Delay a toast message and return a promise
ControllerPandora.prototype.timeOutToast = function (fnName, type, title, msg, ms) {
    var self = this;

    return self.siesta( // pushToastMessage() == one level deep -- bind one level down
        self.commandRouter.pushToastMessage.bind(self.commandRouter),
        fnName + '::timeOutToast',
        [type, title, msg],
        ms
    );
};
