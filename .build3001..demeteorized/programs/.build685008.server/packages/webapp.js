(function () {

/* Imports */
var Meteor = Package.meteor.Meteor;
var Log = Package.logging.Log;
var _ = Package.underscore._;
var RoutePolicy = Package.routepolicy.RoutePolicy;
var Boilerplate = Package['boilerplate-generator'].Boilerplate;
var Spacebars = Package.spacebars.Spacebars;
var HTML = Package.htmljs.HTML;
var Blaze = Package.blaze.Blaze;
var UI = Package.blaze.UI;
var Handlebars = Package.blaze.Handlebars;
var WebAppHashing = Package['webapp-hashing'].WebAppHashing;

/* Package-scope variables */
var WebApp, main, WebAppInternals;

(function () {

///////////////////////////////////////////////////////////////////////////////////////////
//                                                                                       //
// packages/webapp/webapp_server.js                                                      //
//                                                                                       //
///////////////////////////////////////////////////////////////////////////////////////////
                                                                                         //
////////// Requires //////////                                                           // 1
                                                                                         // 2
var fs = Npm.require("fs");                                                              // 3
var http = Npm.require("http");                                                          // 4
var os = Npm.require("os");                                                              // 5
var path = Npm.require("path");                                                          // 6
var url = Npm.require("url");                                                            // 7
var crypto = Npm.require("crypto");                                                      // 8
                                                                                         // 9
var connect = Npm.require('connect');                                                    // 10
var useragent = Npm.require('useragent');                                                // 11
var send = Npm.require('send');                                                          // 12
                                                                                         // 13
var Future = Npm.require('fibers/future');                                               // 14
var Fiber = Npm.require('fibers');                                                       // 15
                                                                                         // 16
var SHORT_SOCKET_TIMEOUT = 5*1000;                                                       // 17
var LONG_SOCKET_TIMEOUT = 120*1000;                                                      // 18
                                                                                         // 19
WebApp = {};                                                                             // 20
WebAppInternals = {};                                                                    // 21
                                                                                         // 22
WebApp.defaultArch = 'web.browser';                                                      // 23
                                                                                         // 24
// XXX maps archs to manifests                                                           // 25
WebApp.clientPrograms = {};                                                              // 26
                                                                                         // 27
// XXX maps archs to program path on filesystem                                          // 28
var archPath = {};                                                                       // 29
                                                                                         // 30
var bundledJsCssPrefix;                                                                  // 31
                                                                                         // 32
// Keepalives so that when the outer server dies unceremoniously and                     // 33
// doesn't kill us, we quit ourselves. A little gross, but better than                   // 34
// pidfiles.                                                                             // 35
// XXX This should really be part of the boot script, not the webapp package.            // 36
//     Or we should just get rid of it, and rely on containerization.                    // 37
                                                                                         // 38
var initKeepalive = function () {                                                        // 39
  var keepaliveCount = 0;                                                                // 40
                                                                                         // 41
  process.stdin.on('data', function (data) {                                             // 42
    keepaliveCount = 0;                                                                  // 43
  });                                                                                    // 44
                                                                                         // 45
  process.stdin.resume();                                                                // 46
                                                                                         // 47
  setInterval(function () {                                                              // 48
    keepaliveCount ++;                                                                   // 49
    if (keepaliveCount >= 3) {                                                           // 50
      console.log("Failed to receive keepalive! Exiting.");                              // 51
      process.exit(1);                                                                   // 52
    }                                                                                    // 53
  }, 3000);                                                                              // 54
};                                                                                       // 55
                                                                                         // 56
                                                                                         // 57
var sha1 = function (contents) {                                                         // 58
  var hash = crypto.createHash('sha1');                                                  // 59
  hash.update(contents);                                                                 // 60
  return hash.digest('hex');                                                             // 61
};                                                                                       // 62
                                                                                         // 63
var readUtf8FileSync = function (filename) {                                             // 64
  return Future.wrap(fs.readFile)(filename, 'utf8').wait();                              // 65
};                                                                                       // 66
                                                                                         // 67
// #BrowserIdentification                                                                // 68
//                                                                                       // 69
// We have multiple places that want to identify the browser: the                        // 70
// unsupported browser page, the appcache package, and, eventually                       // 71
// delivering browser polyfills only as needed.                                          // 72
//                                                                                       // 73
// To avoid detecting the browser in multiple places ad-hoc, we create a                 // 74
// Meteor "browser" object. It uses but does not expose the npm                          // 75
// useragent module (we could choose a different mechanism to identify                   // 76
// the browser in the future if we wanted to).  The browser object                       // 77
// contains                                                                              // 78
//                                                                                       // 79
// * `name`: the name of the browser in camel case                                       // 80
// * `major`, `minor`, `patch`: integers describing the browser version                  // 81
//                                                                                       // 82
// Also here is an early version of a Meteor `request` object, intended                  // 83
// to be a high-level description of the request without exposing                        // 84
// details of connect's low-level `req`.  Currently it contains:                         // 85
//                                                                                       // 86
// * `browser`: browser identification object described above                            // 87
// * `url`: parsed url, including parsed query params                                    // 88
//                                                                                       // 89
// As a temporary hack there is a `categorizeRequest` function on WebApp which           // 90
// converts a connect `req` to a Meteor `request`. This can go away once smart           // 91
// packages such as appcache are being passed a `request` object directly when           // 92
// they serve content.                                                                   // 93
//                                                                                       // 94
// This allows `request` to be used uniformly: it is passed to the html                  // 95
// attributes hook, and the appcache package can use it when deciding                    // 96
// whether to generate a 404 for the manifest.                                           // 97
//                                                                                       // 98
// Real routing / server side rendering will probably refactor this                      // 99
// heavily.                                                                              // 100
                                                                                         // 101
                                                                                         // 102
// e.g. "Mobile Safari" => "mobileSafari"                                                // 103
var camelCase = function (name) {                                                        // 104
  var parts = name.split(' ');                                                           // 105
  parts[0] = parts[0].toLowerCase();                                                     // 106
  for (var i = 1;  i < parts.length;  ++i) {                                             // 107
    parts[i] = parts[i].charAt(0).toUpperCase() + parts[i].substr(1);                    // 108
  }                                                                                      // 109
  return parts.join('');                                                                 // 110
};                                                                                       // 111
                                                                                         // 112
var identifyBrowser = function (userAgentString) {                                       // 113
  var userAgent = useragent.lookup(userAgentString);                                     // 114
  return {                                                                               // 115
    name: camelCase(userAgent.family),                                                   // 116
    major: +userAgent.major,                                                             // 117
    minor: +userAgent.minor,                                                             // 118
    patch: +userAgent.patch                                                              // 119
  };                                                                                     // 120
};                                                                                       // 121
                                                                                         // 122
// XXX Refactor as part of implementing real routing.                                    // 123
WebAppInternals.identifyBrowser = identifyBrowser;                                       // 124
                                                                                         // 125
WebApp.categorizeRequest = function (req) {                                              // 126
  return {                                                                               // 127
    browser: identifyBrowser(req.headers['user-agent']),                                 // 128
    url: url.parse(req.url, true)                                                        // 129
  };                                                                                     // 130
};                                                                                       // 131
                                                                                         // 132
// HTML attribute hooks: functions to be called to determine any attributes to           // 133
// be added to the '<html>' tag. Each function is passed a 'request' object (see         // 134
// #BrowserIdentification) and should return a string,                                   // 135
var htmlAttributeHooks = [];                                                             // 136
var getHtmlAttributes = function (request) {                                             // 137
  var combinedAttributes  = {};                                                          // 138
  _.each(htmlAttributeHooks || [], function (hook) {                                     // 139
    var attributes = hook(request);                                                      // 140
    if (attributes === null)                                                             // 141
      return;                                                                            // 142
    if (typeof attributes !== 'object')                                                  // 143
      throw Error("HTML attribute hook must return null or object");                     // 144
    _.extend(combinedAttributes, attributes);                                            // 145
  });                                                                                    // 146
  return combinedAttributes;                                                             // 147
};                                                                                       // 148
WebApp.addHtmlAttributeHook = function (hook) {                                          // 149
  htmlAttributeHooks.push(hook);                                                         // 150
};                                                                                       // 151
                                                                                         // 152
// Serve app HTML for this URL?                                                          // 153
var appUrl = function (url) {                                                            // 154
  if (url === '/favicon.ico' || url === '/robots.txt')                                   // 155
    return false;                                                                        // 156
                                                                                         // 157
  // NOTE: app.manifest is not a web standard like favicon.ico and                       // 158
  // robots.txt. It is a file name we have chosen to use for HTML5                       // 159
  // appcache URLs. It is included here to prevent using an appcache                     // 160
  // then removing it from poisoning an app permanently. Eventually,                     // 161
  // once we have server side routing, this won't be needed as                           // 162
  // unknown URLs with return a 404 automatically.                                       // 163
  if (url === '/app.manifest')                                                           // 164
    return false;                                                                        // 165
                                                                                         // 166
  // Avoid serving app HTML for declared routes such as /sockjs/.                        // 167
  if (RoutePolicy.classify(url))                                                         // 168
    return false;                                                                        // 169
                                                                                         // 170
  // we currently return app HTML on all URLs by default                                 // 171
  return true;                                                                           // 172
};                                                                                       // 173
                                                                                         // 174
                                                                                         // 175
// We need to calculate the client hash after all packages have loaded                   // 176
// to give them a chance to populate __meteor_runtime_config__.                          // 177
//                                                                                       // 178
// Calculating the hash during startup means that packages can only                      // 179
// populate __meteor_runtime_config__ during load, not during startup.                   // 180
//                                                                                       // 181
// Calculating instead it at the beginning of main after all startup                     // 182
// hooks had run would allow packages to also populate                                   // 183
// __meteor_runtime_config__ during startup, but that's too late for                     // 184
// autoupdate because it needs to have the client hash at startup to                     // 185
// insert the auto update version itself into                                            // 186
// __meteor_runtime_config__ to get it to the client.                                    // 187
//                                                                                       // 188
// An alternative would be to give autoupdate a "post-start,                             // 189
// pre-listen" hook to allow it to insert the auto update version at                     // 190
// the right moment.                                                                     // 191
                                                                                         // 192
Meteor.startup(function () {                                                             // 193
  var calculateClientHash = WebAppHashing.calculateClientHash;                           // 194
  WebApp.clientHash = function (archName) {                                              // 195
    archName = archName || WebApp.defaultArch;                                           // 196
    return calculateClientHash(WebApp.clientPrograms[archName].manifest);                // 197
  };                                                                                     // 198
                                                                                         // 199
  WebApp.calculateClientHashRefreshable = function (archName) {                          // 200
    archName = archName || WebApp.defaultArch;                                           // 201
    return calculateClientHash(WebApp.clientPrograms[archName].manifest,                 // 202
      function (name) {                                                                  // 203
        return name === "css";                                                           // 204
      });                                                                                // 205
  };                                                                                     // 206
  WebApp.calculateClientHashNonRefreshable = function (archName) {                       // 207
    archName = archName || WebApp.defaultArch;                                           // 208
    return calculateClientHash(WebApp.clientPrograms[archName].manifest,                 // 209
      function (name) {                                                                  // 210
        return name !== "css";                                                           // 211
      });                                                                                // 212
  };                                                                                     // 213
  WebApp.calculateClientHashCordova = function () {                                      // 214
    var archName = 'web.cordova';                                                        // 215
    if (! WebApp.clientPrograms[archName])                                               // 216
      return 'none';                                                                     // 217
                                                                                         // 218
    return calculateClientHash(                                                          // 219
      WebApp.clientPrograms[archName].manifest, null, _.pick(                            // 220
        __meteor_runtime_config__, 'PUBLIC_SETTINGS'));                                  // 221
  };                                                                                     // 222
});                                                                                      // 223
                                                                                         // 224
                                                                                         // 225
                                                                                         // 226
// When we have a request pending, we want the socket timeout to be long, to             // 227
// give ourselves a while to serve it, and to allow sockjs long polls to                 // 228
// complete.  On the other hand, we want to close idle sockets relatively                // 229
// quickly, so that we can shut down relatively promptly but cleanly, without            // 230
// cutting off anyone's response.                                                        // 231
WebApp._timeoutAdjustmentRequestCallback = function (req, res) {                         // 232
  // this is really just req.socket.setTimeout(LONG_SOCKET_TIMEOUT);                     // 233
  req.setTimeout(LONG_SOCKET_TIMEOUT);                                                   // 234
  // Insert our new finish listener to run BEFORE the existing one which removes         // 235
  // the response from the socket.                                                       // 236
  var finishListeners = res.listeners('finish');                                         // 237
  // XXX Apparently in Node 0.12 this event is now called 'prefinish'.                   // 238
  // https://github.com/joyent/node/commit/7c9b6070                                      // 239
  res.removeAllListeners('finish');                                                      // 240
  res.on('finish', function () {                                                         // 241
    res.setTimeout(SHORT_SOCKET_TIMEOUT);                                                // 242
  });                                                                                    // 243
  _.each(finishListeners, function (l) { res.on('finish', l); });                        // 244
};                                                                                       // 245
                                                                                         // 246
                                                                                         // 247
// Will be updated by main before we listen.                                             // 248
// Map from client arch to boilerplate object.                                           // 249
// Boilerplate object has:                                                               // 250
//   - func: XXX                                                                         // 251
//   - baseData: XXX                                                                     // 252
var boilerplateByArch = {};                                                              // 253
                                                                                         // 254
// Given a request (as returned from `categorizeRequest`), return the                    // 255
// boilerplate HTML to serve for that request. Memoizes on HTML                          // 256
// attributes (used by, eg, appcache) and whether inline scripts are                     // 257
// currently allowed.                                                                    // 258
// XXX so far this function is always called with arch === 'web.browser'                 // 259
var memoizedBoilerplate = {};                                                            // 260
var getBoilerplate = function (request, arch) {                                          // 261
                                                                                         // 262
  var htmlAttributes = getHtmlAttributes(request);                                       // 263
                                                                                         // 264
  // The only thing that changes from request to request (for now) are                   // 265
  // the HTML attributes (used by, eg, appcache) and whether inline                      // 266
  // scripts are allowed, so we can memoize based on that.                               // 267
  var memHash = JSON.stringify({                                                         // 268
    inlineScriptsAllowed: inlineScriptsAllowed,                                          // 269
    htmlAttributes: htmlAttributes,                                                      // 270
    arch: arch                                                                           // 271
  });                                                                                    // 272
                                                                                         // 273
  if (! memoizedBoilerplate[memHash]) {                                                  // 274
    memoizedBoilerplate[memHash] = boilerplateByArch[arch].toHTML({                      // 275
      htmlAttributes: htmlAttributes                                                     // 276
    });                                                                                  // 277
  }                                                                                      // 278
  return memoizedBoilerplate[memHash];                                                   // 279
};                                                                                       // 280
                                                                                         // 281
var generateBoilerplateInstance = function (arch, manifest, additionalOptions) {         // 282
  additionalOptions = additionalOptions || {};                                           // 283
  var runtimeConfig = _.defaults(__meteor_runtime_config__,                              // 284
    additionalOptions.runtimeConfigDefaults || {}                                        // 285
  );                                                                                     // 286
                                                                                         // 287
  return new Boilerplate(arch, manifest,                                                 // 288
    _.extend({                                                                           // 289
      pathMapper: function (itemPath) {                                                  // 290
        return path.join(archPath[arch], itemPath); },                                   // 291
      baseDataExtension: {                                                               // 292
        additionalStaticJs: _.map(                                                       // 293
          additionalStaticJs || [],                                                      // 294
          function (contents, pathname) {                                                // 295
            return {                                                                     // 296
              pathname: pathname,                                                        // 297
              contents: contents                                                         // 298
            };                                                                           // 299
          }                                                                              // 300
        ),                                                                               // 301
        meteorRuntimeConfig: JSON.stringify(runtimeConfig),                              // 302
        rootUrlPathPrefix: __meteor_runtime_config__.ROOT_URL_PATH_PREFIX || '',         // 303
        bundledJsCssPrefix: bundledJsCssPrefix ||                                        // 304
          __meteor_runtime_config__.ROOT_URL_PATH_PREFIX || '',                          // 305
        inlineScriptsAllowed: WebAppInternals.inlineScriptsAllowed(),                    // 306
        inline: additionalOptions.inline                                                 // 307
      }                                                                                  // 308
    }, additionalOptions)                                                                // 309
  );                                                                                     // 310
};                                                                                       // 311
                                                                                         // 312
// A mapping from url path to "info". Where "info" has the following fields:             // 313
// - type: the type of file to be served                                                 // 314
// - cacheable: optionally, whether the file should be cached or not                     // 315
// - sourceMapUrl: optionally, the url of the source map                                 // 316
//                                                                                       // 317
// Info also contains one of the following:                                              // 318
// - content: the stringified content that should be served at this path                 // 319
// - absolutePath: the absolute path on disk to the file                                 // 320
                                                                                         // 321
var staticFiles;                                                                         // 322
                                                                                         // 323
// Serve static files from the manifest or added with                                    // 324
// `addStaticJs`. Exported for tests.                                                    // 325
WebAppInternals.staticFilesMiddleware = function (staticFiles, req, res, next) {         // 326
  if ('GET' != req.method && 'HEAD' != req.method) {                                     // 327
    next();                                                                              // 328
    return;                                                                              // 329
  }                                                                                      // 330
  var pathname = connect.utils.parseUrl(req).pathname;                                   // 331
  try {                                                                                  // 332
    pathname = decodeURIComponent(pathname);                                             // 333
  } catch (e) {                                                                          // 334
    next();                                                                              // 335
    return;                                                                              // 336
  }                                                                                      // 337
                                                                                         // 338
  var serveStaticJs = function (s) {                                                     // 339
    res.writeHead(200, {                                                                 // 340
      'Content-type': 'application/javascript; charset=UTF-8'                            // 341
    });                                                                                  // 342
    res.write(s);                                                                        // 343
    res.end();                                                                           // 344
  };                                                                                     // 345
                                                                                         // 346
  if (pathname === "/meteor_runtime_config.js" &&                                        // 347
      ! WebAppInternals.inlineScriptsAllowed()) {                                        // 348
    serveStaticJs("__meteor_runtime_config__ = " +                                       // 349
                  JSON.stringify(__meteor_runtime_config__) + ";");                      // 350
    return;                                                                              // 351
  } else if (_.has(additionalStaticJs, pathname) &&                                      // 352
              ! WebAppInternals.inlineScriptsAllowed()) {                                // 353
    serveStaticJs(additionalStaticJs[pathname]);                                         // 354
    return;                                                                              // 355
  }                                                                                      // 356
                                                                                         // 357
  if (!_.has(staticFiles, pathname)) {                                                   // 358
    next();                                                                              // 359
    return;                                                                              // 360
  }                                                                                      // 361
                                                                                         // 362
  // We don't need to call pause because, unlike 'static', once we call into             // 363
  // 'send' and yield to the event loop, we never call another handler with              // 364
  // 'next'.                                                                             // 365
                                                                                         // 366
  var info = staticFiles[pathname];                                                      // 367
                                                                                         // 368
  // Cacheable files are files that should never change. Typically                       // 369
  // named by their hash (eg meteor bundled js and css files).                           // 370
  // We cache them ~forever (1yr).                                                       // 371
  //                                                                                     // 372
  // We cache non-cacheable files anyway. This isn't really correct, as users            // 373
  // can change the files and changes won't propagate immediately. However, if           // 374
  // we don't cache them, browsers will 'flicker' when rerendering                       // 375
  // images. Eventually we will probably want to rewrite URLs of static assets           // 376
  // to include a query parameter to bust caches. That way we can both get               // 377
  // good caching behavior and allow users to change assets without delay.               // 378
  // https://github.com/meteor/meteor/issues/773                                         // 379
  var maxAge = info.cacheable                                                            // 380
        ? 1000 * 60 * 60 * 24 * 365                                                      // 381
        : 1000 * 60 * 60 * 24;                                                           // 382
                                                                                         // 383
  // Set the X-SourceMap header, which current Chrome understands.                       // 384
  // (The files also contain '//#' comments which FF 24 understands and                  // 385
  // Chrome doesn't understand yet.)                                                     // 386
  //                                                                                     // 387
  // Eventually we should set the SourceMap header but the current version of            // 388
  // Chrome and no version of FF supports it.                                            // 389
  //                                                                                     // 390
  // To figure out if your version of Chrome should support the SourceMap                // 391
  // header,                                                                             // 392
  //   - go to chrome://version. Let's say the Chrome version is                         // 393
  //      28.0.1500.71 and the Blink version is 537.36 (@153022)                         // 394
  //   - go to http://src.chromium.org/viewvc/blink/branches/chromium/1500/Source/core/inspector/InspectorPageAgent.cpp?view=log
  //     where the "1500" is the third part of your Chrome version                       // 396
  //   - find the first revision that is no greater than the "153022"                    // 397
  //     number.  That's probably the first one and it probably has                      // 398
  //     a message of the form "Branch 1500 - blink@r149738"                             // 399
  //   - If *that* revision number (149738) is at least 151755,                          // 400
  //     then Chrome should support SourceMap (not just X-SourceMap)                     // 401
  // (The change is https://codereview.chromium.org/15832007)                            // 402
  //                                                                                     // 403
  // You also need to enable source maps in Chrome: open dev tools, click                // 404
  // the gear in the bottom right corner, and select "enable source maps".               // 405
  //                                                                                     // 406
  // Firefox 23+ supports source maps but doesn't support either header yet,             // 407
  // so we include the '//#' comment for it:                                             // 408
  //   https://bugzilla.mozilla.org/show_bug.cgi?id=765993                               // 409
  // In FF 23 you need to turn on `devtools.debugger.source-maps-enabled`                // 410
  // in `about:config` (it is on by default in FF 24).                                   // 411
  if (info.sourceMapUrl)                                                                 // 412
    res.setHeader('X-SourceMap', info.sourceMapUrl);                                     // 413
                                                                                         // 414
  if (info.type === "js") {                                                              // 415
    res.setHeader("Content-Type", "application/javascript; charset=UTF-8");              // 416
  } else if (info.type === "css") {                                                      // 417
    res.setHeader("Content-Type", "text/css; charset=UTF-8");                            // 418
  } else if (info.type === "json") {                                                     // 419
    res.setHeader("Content-Type", "application/json; charset=UTF-8");                    // 420
    // XXX if it is a manifest we are serving, set additional headers                    // 421
    if (/\/manifest.json$/.test(pathname)) {                                             // 422
      res.setHeader("Access-Control-Allow-Origin", "*");                                 // 423
    }                                                                                    // 424
  }                                                                                      // 425
                                                                                         // 426
  if (info.content) {                                                                    // 427
    res.write(info.content);                                                             // 428
    res.end();                                                                           // 429
  } else {                                                                               // 430
    send(req, info.absolutePath)                                                         // 431
      .maxage(maxAge)                                                                    // 432
      .hidden(true)  // if we specified a dotfile in the manifest, serve it              // 433
      .on('error', function (err) {                                                      // 434
        Log.error("Error serving static file " + err);                                   // 435
        res.writeHead(500);                                                              // 436
        res.end();                                                                       // 437
      })                                                                                 // 438
      .on('directory', function () {                                                     // 439
        Log.error("Unexpected directory " + info.absolutePath);                          // 440
        res.writeHead(500);                                                              // 441
        res.end();                                                                       // 442
      })                                                                                 // 443
      .pipe(res);                                                                        // 444
  }                                                                                      // 445
};                                                                                       // 446
                                                                                         // 447
var getUrlPrefixForArch = function (arch) {                                              // 448
  // XXX we rely on the fact that arch names don't contain slashes                       // 449
  // in that case we would need to uri escape it                                         // 450
                                                                                         // 451
  // We add '__' to the beginning of non-standard archs to "scope" the url               // 452
  // to Meteor internals.                                                                // 453
  return arch === WebApp.defaultArch ?                                                   // 454
    '' : '/' + '__' + arch.replace(/^web\./, '');                                        // 455
};                                                                                       // 456
                                                                                         // 457
var runWebAppServer = function () {                                                      // 458
  var shuttingDown = false;                                                              // 459
  var syncQueue = new Meteor._SynchronousQueue();                                        // 460
                                                                                         // 461
  var getItemPathname = function (itemUrl) {                                             // 462
    return decodeURIComponent(url.parse(itemUrl).pathname);                              // 463
  };                                                                                     // 464
                                                                                         // 465
  WebAppInternals.reloadClientPrograms = function () {                                   // 466
    syncQueue.runTask(function() {                                                       // 467
      staticFiles = {};                                                                  // 468
      var generateClientProgram = function (clientPath, arch) {                          // 469
        // read the control for the client we'll be serving up                           // 470
        var clientJsonPath = path.join(__meteor_bootstrap__.serverDir,                   // 471
                                   clientPath);                                          // 472
        var clientDir = path.dirname(clientJsonPath);                                    // 473
        var clientJson = JSON.parse(readUtf8FileSync(clientJsonPath));                   // 474
        if (clientJson.format !== "web-program-pre1")                                    // 475
          throw new Error("Unsupported format for client assets: " +                     // 476
                          JSON.stringify(clientJson.format));                            // 477
                                                                                         // 478
        if (! clientJsonPath || ! clientDir || ! clientJson)                             // 479
          throw new Error("Client config file not parsed.");                             // 480
                                                                                         // 481
        var urlPrefix = getUrlPrefixForArch(arch);                                       // 482
                                                                                         // 483
        var manifest = clientJson.manifest;                                              // 484
        _.each(manifest, function (item) {                                               // 485
          if (item.url && item.where === "client") {                                     // 486
            staticFiles[urlPrefix + getItemPathname(item.url)] = {                       // 487
              absolutePath: path.join(clientDir, item.path),                             // 488
              cacheable: item.cacheable,                                                 // 489
              // Link from source to its map                                             // 490
              sourceMapUrl: item.sourceMapUrl,                                           // 491
              type: item.type                                                            // 492
            };                                                                           // 493
                                                                                         // 494
            if (item.sourceMap) {                                                        // 495
              // Serve the source map too, under the specified URL. We assume all        // 496
              // source maps are cacheable.                                              // 497
              staticFiles[urlPrefix + getItemPathname(item.sourceMapUrl)] = {            // 498
                absolutePath: path.join(clientDir, item.sourceMap),                      // 499
                cacheable: true                                                          // 500
              };                                                                         // 501
            }                                                                            // 502
          }                                                                              // 503
        });                                                                              // 504
                                                                                         // 505
        var program = {                                                                  // 506
          manifest: manifest,                                                            // 507
          version: WebAppHashing.calculateClientHash(manifest, null, _.pick(             // 508
            __meteor_runtime_config__, 'PUBLIC_SETTINGS')),                              // 509
          PUBLIC_SETTINGS: __meteor_runtime_config__.PUBLIC_SETTINGS                     // 510
        };                                                                               // 511
                                                                                         // 512
        WebApp.clientPrograms[arch] = program;                                           // 513
                                                                                         // 514
        // Serve the program as a string at /foo/<arch>/manifest.json                    // 515
        // XXX change manifest.json -> program.json                                      // 516
        staticFiles[path.join(urlPrefix, 'manifest.json')] = {                           // 517
          content: JSON.stringify(program),                                              // 518
          cacheable: true,                                                               // 519
          type: "json"                                                                   // 520
        };                                                                               // 521
      };                                                                                 // 522
                                                                                         // 523
      try {                                                                              // 524
        var clientPaths = __meteor_bootstrap__.configJson.clientPaths;                   // 525
        _.each(clientPaths, function (clientPath, arch) {                                // 526
          archPath[arch] = path.dirname(clientPath);                                     // 527
          generateClientProgram(clientPath, arch);                                       // 528
        });                                                                              // 529
                                                                                         // 530
        // Exported for tests.                                                           // 531
        WebAppInternals.staticFiles = staticFiles;                                       // 532
      } catch (e) {                                                                      // 533
        Log.error("Error reloading the client program: " + e.stack);                     // 534
        process.exit(1);                                                                 // 535
      }                                                                                  // 536
    });                                                                                  // 537
  };                                                                                     // 538
                                                                                         // 539
  WebAppInternals.generateBoilerplate = function () {                                    // 540
    // This boilerplate will be served to the mobile devices when used with              // 541
    // Meteor/Cordova for the Hot-Code Push and since the file will be served by         // 542
    // the device's server, it is important to set the DDP url to the actual             // 543
    // Meteor server accepting DDP connections and not the device's file server.         // 544
    var defaultOptionsForArch = {                                                        // 545
      'web.cordova': {                                                                   // 546
        runtimeConfigDefaults: {                                                         // 547
          DDP_DEFAULT_CONNECTION_URL: __meteor_runtime_config__.ROOT_URL                 // 548
        }                                                                                // 549
      }                                                                                  // 550
    };                                                                                   // 551
                                                                                         // 552
    syncQueue.runTask(function() {                                                       // 553
      _.each(WebApp.clientPrograms, function (program, archName) {                       // 554
        boilerplateByArch[archName] =                                                    // 555
          generateBoilerplateInstance(archName, program.manifest,                        // 556
                                      defaultOptionsForArch[archName]);                  // 557
      });                                                                                // 558
                                                                                         // 559
      // Clear the memoized boilerplate cache.                                           // 560
      memoizedBoilerplate = {};                                                          // 561
                                                                                         // 562
      // Configure CSS injection for the default arch                                    // 563
      // XXX implement the CSS injection for all archs?                                  // 564
      WebAppInternals.refreshableAssets = {                                              // 565
        allCss: boilerplateByArch[WebApp.defaultArch].baseData.css                       // 566
      };                                                                                 // 567
    });                                                                                  // 568
  };                                                                                     // 569
                                                                                         // 570
  WebAppInternals.reloadClientPrograms();                                                // 571
                                                                                         // 572
  // webserver                                                                           // 573
  var app = connect();                                                                   // 574
                                                                                         // 575
  // Auto-compress any json, javascript, or text.                                        // 576
  app.use(connect.compress());                                                           // 577
                                                                                         // 578
  // Packages and apps can add handlers that run before any other Meteor                 // 579
  // handlers via WebApp.rawConnectHandlers.                                             // 580
  var rawConnectHandlers = connect();                                                    // 581
  app.use(rawConnectHandlers);                                                           // 582
                                                                                         // 583
  // Strip off the path prefix, if it exists.                                            // 584
  app.use(function (request, response, next) {                                           // 585
    var pathPrefix = __meteor_runtime_config__.ROOT_URL_PATH_PREFIX;                     // 586
    var url = Npm.require('url').parse(request.url);                                     // 587
    var pathname = url.pathname;                                                         // 588
    // check if the path in the url starts with the path prefix (and the part            // 589
    // after the path prefix must start with a / if it exists.)                          // 590
    if (pathPrefix && pathname.substring(0, pathPrefix.length) === pathPrefix &&         // 591
       (pathname.length == pathPrefix.length                                             // 592
        || pathname.substring(pathPrefix.length, pathPrefix.length + 1) === "/")) {      // 593
      request.url = request.url.substring(pathPrefix.length);                            // 594
      next();                                                                            // 595
    } else if (pathname === "/favicon.ico" || pathname === "/robots.txt") {              // 596
      next();                                                                            // 597
    } else if (pathPrefix) {                                                             // 598
      response.writeHead(404);                                                           // 599
      response.write("Unknown path");                                                    // 600
      response.end();                                                                    // 601
    } else {                                                                             // 602
      next();                                                                            // 603
    }                                                                                    // 604
  });                                                                                    // 605
                                                                                         // 606
  // Parse the query string into res.query. Used by oauth_server, but it's               // 607
  // generally pretty handy..                                                            // 608
  app.use(connect.query());                                                              // 609
                                                                                         // 610
  // Serve static files from the manifest.                                               // 611
  // This is inspired by the 'static' middleware.                                        // 612
  app.use(function (req, res, next) {                                                    // 613
    Fiber(function () {                                                                  // 614
     WebAppInternals.staticFilesMiddleware(staticFiles, req, res, next);                 // 615
    }).run();                                                                            // 616
  });                                                                                    // 617
                                                                                         // 618
  // Packages and apps can add handlers to this via WebApp.connectHandlers.              // 619
  // They are inserted before our default handler.                                       // 620
  var packageAndAppHandlers = connect();                                                 // 621
  app.use(packageAndAppHandlers);                                                        // 622
                                                                                         // 623
  var suppressConnectErrors = false;                                                     // 624
  // connect knows it is an error handler because it has 4 arguments instead of          // 625
  // 3. go figure.  (It is not smart enough to find such a thing if it's hidden          // 626
  // inside packageAndAppHandlers.)                                                      // 627
  app.use(function (err, req, res, next) {                                               // 628
    if (!err || !suppressConnectErrors || !req.headers['x-suppress-error']) {            // 629
      next(err);                                                                         // 630
      return;                                                                            // 631
    }                                                                                    // 632
    res.writeHead(err.status, { 'Content-Type': 'text/plain' });                         // 633
    res.end("An error message");                                                         // 634
  });                                                                                    // 635
                                                                                         // 636
  app.use(function (req, res, next) {                                                    // 637
    if (! appUrl(req.url))                                                               // 638
      return next();                                                                     // 639
                                                                                         // 640
    var headers = {                                                                      // 641
      'Content-Type':  'text/html; charset=utf-8'                                        // 642
    };                                                                                   // 643
    if (shuttingDown)                                                                    // 644
      headers['Connection'] = 'Close';                                                   // 645
                                                                                         // 646
    var request = WebApp.categorizeRequest(req);                                         // 647
                                                                                         // 648
    if (request.url.query && request.url.query['meteor_css_resource']) {                 // 649
      // In this case, we're requesting a CSS resource in the meteor-specific            // 650
      // way, but we don't have it.  Serve a static css file that indicates that         // 651
      // we didn't have it, so we can detect that and refresh.                           // 652
      headers['Content-Type'] = 'text/css; charset=utf-8';                               // 653
      res.writeHead(200, headers);                                                       // 654
      res.write(".meteor-css-not-found-error { width: 0px;}");                           // 655
      res.end();                                                                         // 656
      return undefined;                                                                  // 657
    }                                                                                    // 658
                                                                                         // 659
    // /packages/asdfsad ... /__cordova/dafsdf.js                                        // 660
    var pathname = connect.utils.parseUrl(req).pathname;                                 // 661
    var archKey = pathname.split('/')[1];                                                // 662
    var archKeyCleaned = 'web.' + archKey.replace(/^__/, '');                            // 663
                                                                                         // 664
    if (! /^__/.test(archKey) || ! _.has(archPath, archKeyCleaned)) {                    // 665
      archKey = WebApp.defaultArch;                                                      // 666
    } else {                                                                             // 667
      archKey = archKeyCleaned;                                                          // 668
    }                                                                                    // 669
                                                                                         // 670
    var boilerplate;                                                                     // 671
    try {                                                                                // 672
      boilerplate = getBoilerplate(request, archKey);                                    // 673
    } catch (e) {                                                                        // 674
      Log.error("Error running template: " + e);                                         // 675
      res.writeHead(500, headers);                                                       // 676
      res.end();                                                                         // 677
      return undefined;                                                                  // 678
    }                                                                                    // 679
                                                                                         // 680
    res.writeHead(200, headers);                                                         // 681
    res.write(boilerplate);                                                              // 682
    res.end();                                                                           // 683
    return undefined;                                                                    // 684
  });                                                                                    // 685
                                                                                         // 686
  // Return 404 by default, if no other handlers serve this URL.                         // 687
  app.use(function (req, res) {                                                          // 688
    res.writeHead(404);                                                                  // 689
    res.end();                                                                           // 690
  });                                                                                    // 691
                                                                                         // 692
                                                                                         // 693
  var httpServer = http.createServer(app);                                               // 694
  var onListeningCallbacks = [];                                                         // 695
                                                                                         // 696
  // After 5 seconds w/o data on a socket, kill it.  On the other hand, if               // 697
  // there's an outstanding request, give it a higher timeout instead (to avoid          // 698
  // killing long-polling requests)                                                      // 699
  httpServer.setTimeout(SHORT_SOCKET_TIMEOUT);                                           // 700
                                                                                         // 701
  // Do this here, and then also in livedata/stream_server.js, because                   // 702
  // stream_server.js kills all the current request handlers when installing its         // 703
  // own.                                                                                // 704
  httpServer.on('request', WebApp._timeoutAdjustmentRequestCallback);                    // 705
                                                                                         // 706
                                                                                         // 707
  // For now, handle SIGHUP here.  Later, this should be in some centralized             // 708
  // Meteor shutdown code.                                                               // 709
  process.on('SIGHUP', Meteor.bindEnvironment(function () {                              // 710
    shuttingDown = true;                                                                 // 711
    // tell others with websockets open that we plan to close this.                      // 712
    // XXX: Eventually, this should be done with a standard meteor shut-down             // 713
    // logic path.                                                                       // 714
    httpServer.emit('meteor-closing');                                                   // 715
                                                                                         // 716
    httpServer.close(Meteor.bindEnvironment(function () {                                // 717
      if (proxy) {                                                                       // 718
        try {                                                                            // 719
          proxy.call('removeBindingsForJob', process.env.GALAXY_JOB);                    // 720
        } catch (e) {                                                                    // 721
          Log.error("Error removing bindings: " + e.message);                            // 722
          process.exit(1);                                                               // 723
        }                                                                                // 724
      }                                                                                  // 725
      process.exit(0);                                                                   // 726
                                                                                         // 727
    }, "On http server close failed"));                                                  // 728
                                                                                         // 729
    // Ideally we will close before this hits.                                           // 730
    Meteor.setTimeout(function () {                                                      // 731
      Log.warn("Closed by SIGHUP but one or more HTTP requests may not have finished."); // 732
      process.exit(1);                                                                   // 733
    }, 5000);                                                                            // 734
                                                                                         // 735
  }, function (err) {                                                                    // 736
    console.log(err);                                                                    // 737
    process.exit(1);                                                                     // 738
  }));                                                                                   // 739
                                                                                         // 740
  // start up app                                                                        // 741
  _.extend(WebApp, {                                                                     // 742
    connectHandlers: packageAndAppHandlers,                                              // 743
    rawConnectHandlers: rawConnectHandlers,                                              // 744
    httpServer: httpServer,                                                              // 745
    // For testing.                                                                      // 746
    suppressConnectErrors: function () {                                                 // 747
      suppressConnectErrors = true;                                                      // 748
    },                                                                                   // 749
    onListening: function (f) {                                                          // 750
      if (onListeningCallbacks)                                                          // 751
        onListeningCallbacks.push(f);                                                    // 752
      else                                                                               // 753
        f();                                                                             // 754
    },                                                                                   // 755
    // Hack: allow http tests to call connect.basicAuth without making them              // 756
    // Npm.depends on another copy of connect. (That would be fine if we could           // 757
    // have test-only NPM dependencies but is overkill here.)                            // 758
    __basicAuth__: connect.basicAuth                                                     // 759
  });                                                                                    // 760
                                                                                         // 761
  // Let the rest of the packages (and Meteor.startup hooks) insert connect              // 762
  // middlewares and update __meteor_runtime_config__, then keep going to set up         // 763
  // actually serving HTML.                                                              // 764
  main = function (argv) {                                                               // 765
    // main happens post startup hooks, so we don't need a Meteor.startup() to           // 766
    // ensure this happens after the galaxy package is loaded.                           // 767
    var AppConfig = Package["application-configuration"].AppConfig;                      // 768
    // We used to use the optimist npm package to parse argv here, but it's              // 769
    // overkill (and no longer in the dev bundle). Just assume any instance of           // 770
    // '--keepalive' is a use of the option.                                             // 771
    var expectKeepalives = _.contains(argv, '--keepalive');                              // 772
    WebAppInternals.generateBoilerplate();                                               // 773
                                                                                         // 774
    // only start listening after all the startup code has run.                          // 775
    var localPort = parseInt(process.env.PORT) || 0;                                     // 776
    var host = process.env.BIND_IP;                                                      // 777
    var localIp = host || '0.0.0.0';                                                     // 778
    httpServer.listen(localPort, localIp, Meteor.bindEnvironment(function() {            // 779
      if (expectKeepalives)                                                              // 780
        console.log("LISTENING"); // must match run-app.js                               // 781
      var proxyBinding;                                                                  // 782
                                                                                         // 783
      AppConfig.configurePackage('webapp', function (configuration) {                    // 784
        if (proxyBinding)                                                                // 785
          proxyBinding.stop();                                                           // 786
        if (configuration && configuration.proxy) {                                      // 787
          // TODO: We got rid of the place where this checks the app's                   // 788
          // configuration, because this wants to be configured for some things          // 789
          // on a per-job basis.  Discuss w/ teammates.                                  // 790
          proxyBinding = AppConfig.configureService(                                     // 791
            "proxy",                                                                     // 792
            "pre0",                                                                      // 793
            function (proxyService) {                                                    // 794
              if (proxyService && ! _.isEmpty(proxyService)) {                           // 795
                var proxyConf;                                                           // 796
                // XXX Figure out a per-job way to specify bind location                 // 797
                // (besides hardcoding the location for ADMIN_APP jobs).                 // 798
                if (process.env.ADMIN_APP) {                                             // 799
                  var bindPathPrefix = "";                                               // 800
                  if (process.env.GALAXY_APP !== "panel") {                              // 801
                    bindPathPrefix = "/" + bindPathPrefix +                              // 802
                      encodeURIComponent(                                                // 803
                        process.env.GALAXY_APP                                           // 804
                      ).replace(/\./g, '_');                                             // 805
                  }                                                                      // 806
                  proxyConf = {                                                          // 807
                    bindHost: process.env.GALAXY_NAME,                                   // 808
                    bindPathPrefix: bindPathPrefix,                                      // 809
                    requiresAuth: true                                                   // 810
                  };                                                                     // 811
                } else {                                                                 // 812
                  proxyConf = configuration.proxy;                                       // 813
                }                                                                        // 814
                Log("Attempting to bind to proxy at " +                                  // 815
                    proxyService);                                                       // 816
                WebAppInternals.bindToProxy(_.extend({                                   // 817
                  proxyEndpoint: proxyService                                            // 818
                }, proxyConf));                                                          // 819
              }                                                                          // 820
            }                                                                            // 821
          );                                                                             // 822
        }                                                                                // 823
      });                                                                                // 824
                                                                                         // 825
      var callbacks = onListeningCallbacks;                                              // 826
      onListeningCallbacks = null;                                                       // 827
      _.each(callbacks, function (x) { x(); });                                          // 828
                                                                                         // 829
    }, function (e) {                                                                    // 830
      console.error("Error listening:", e);                                              // 831
      console.error(e && e.stack);                                                       // 832
    }));                                                                                 // 833
                                                                                         // 834
    if (expectKeepalives)                                                                // 835
      initKeepalive();                                                                   // 836
    return 'DAEMON';                                                                     // 837
  };                                                                                     // 838
};                                                                                       // 839
                                                                                         // 840
                                                                                         // 841
var proxy;                                                                               // 842
WebAppInternals.bindToProxy = function (proxyConfig) {                                   // 843
  var securePort = proxyConfig.securePort || 4433;                                       // 844
  var insecurePort = proxyConfig.insecurePort || 8080;                                   // 845
  var bindPathPrefix = proxyConfig.bindPathPrefix || "";                                 // 846
  // XXX also support galaxy-based lookup                                                // 847
  if (!proxyConfig.proxyEndpoint)                                                        // 848
    throw new Error("missing proxyEndpoint");                                            // 849
  if (!proxyConfig.bindHost)                                                             // 850
    throw new Error("missing bindHost");                                                 // 851
  if (!process.env.GALAXY_JOB)                                                           // 852
    throw new Error("missing $GALAXY_JOB");                                              // 853
  if (!process.env.GALAXY_APP)                                                           // 854
    throw new Error("missing $GALAXY_APP");                                              // 855
  if (!process.env.LAST_START)                                                           // 856
    throw new Error("missing $LAST_START");                                              // 857
                                                                                         // 858
  // XXX rename pid argument to bindTo.                                                  // 859
  // XXX factor out into a 'getPid' function in a 'galaxy' package?                      // 860
  var pid = {                                                                            // 861
    job: process.env.GALAXY_JOB,                                                         // 862
    lastStarted: +(process.env.LAST_START),                                              // 863
    app: process.env.GALAXY_APP                                                          // 864
  };                                                                                     // 865
  var myHost = os.hostname();                                                            // 866
                                                                                         // 867
  WebAppInternals.usingDdpProxy = true;                                                  // 868
                                                                                         // 869
  // This is run after packages are loaded (in main) so we can use                       // 870
  // Follower.connect.                                                                   // 871
  if (proxy) {                                                                           // 872
    // XXX the concept here is that our configuration has changed and                    // 873
    // we have connected to an entirely new follower set, which does                     // 874
    // not have the state that we set up on the follower set that we                     // 875
    // were previously connected to, and so we need to recreate all of                   // 876
    // our bindings -- analogous to getting a SIGHUP and rereading                       // 877
    // your configuration file. so probably this should actually tear                    // 878
    // down the connection and make a whole new one, rather than                         // 879
    // hot-reconnecting to a different URL.                                              // 880
    proxy.reconnect({                                                                    // 881
      url: proxyConfig.proxyEndpoint                                                     // 882
    });                                                                                  // 883
  } else {                                                                               // 884
    proxy = Package["follower-livedata"].Follower.connect(                               // 885
      proxyConfig.proxyEndpoint, {                                                       // 886
        group: "proxy"                                                                   // 887
      }                                                                                  // 888
    );                                                                                   // 889
  }                                                                                      // 890
                                                                                         // 891
  var route = process.env.ROUTE;                                                         // 892
  var ourHost = route.split(":")[0];                                                     // 893
  var ourPort = +route.split(":")[1];                                                    // 894
                                                                                         // 895
  var outstanding = 0;                                                                   // 896
  var startedAll = false;                                                                // 897
  var checkComplete = function () {                                                      // 898
    if (startedAll && ! outstanding)                                                     // 899
      Log("Bound to proxy.");                                                            // 900
  };                                                                                     // 901
  var makeCallback = function () {                                                       // 902
    outstanding++;                                                                       // 903
    return function (err) {                                                              // 904
      if (err)                                                                           // 905
        throw err;                                                                       // 906
      outstanding--;                                                                     // 907
      checkComplete();                                                                   // 908
    };                                                                                   // 909
  };                                                                                     // 910
                                                                                         // 911
  // for now, have our (temporary) requiresAuth flag apply to all                        // 912
  // routes created by this process.                                                     // 913
  var requiresDdpAuth = !! proxyConfig.requiresAuth;                                     // 914
  var requiresHttpAuth = (!! proxyConfig.requiresAuth) &&                                // 915
        (pid.app !== "panel" && pid.app !== "auth");                                     // 916
                                                                                         // 917
  // XXX a current limitation is that we treat securePort and                            // 918
  // insecurePort as a global configuration parameter -- we assume                       // 919
  // that if the proxy wants us to ask for 8080 to get port 80 traffic                   // 920
  // on our default hostname, that's the same port that we would use                     // 921
  // to get traffic on some other hostname that our proxy listens                        // 922
  // for. Likewise, we assume that if the proxy can receive secure                       // 923
  // traffic for our domain, it can assume secure traffic for any                        // 924
  // domain! Hopefully this will get cleaned up before too long by                       // 925
  // pushing that logic into the proxy service, so we can just ask for                   // 926
  // port 80.                                                                            // 927
                                                                                         // 928
  // XXX BUG: if our configuration changes, and bindPathPrefix                           // 929
  // changes, it appears that we will not remove the routes derived                      // 930
  // from the old bindPathPrefix from the proxy (until the process                       // 931
  // exits). It is not actually normal for bindPathPrefix to change,                     // 932
  // certainly not without a process restart for other reasons, but                      // 933
  // it'd be nice to fix.                                                                // 934
                                                                                         // 935
  _.each(routes, function (route) {                                                      // 936
    var parsedUrl = url.parse(route.url, /* parseQueryString */ false,                   // 937
                              /* slashesDenoteHost aka workRight */ true);               // 938
    if (parsedUrl.protocol || parsedUrl.port || parsedUrl.search)                        // 939
      throw new Error("Bad url");                                                        // 940
    parsedUrl.host = null;                                                               // 941
    parsedUrl.path = null;                                                               // 942
    if (! parsedUrl.hostname) {                                                          // 943
      parsedUrl.hostname = proxyConfig.bindHost;                                         // 944
      if (! parsedUrl.pathname)                                                          // 945
        parsedUrl.pathname = "";                                                         // 946
      if (! parsedUrl.pathname.indexOf("/") !== 0) {                                     // 947
        // Relative path                                                                 // 948
        parsedUrl.pathname = bindPathPrefix + parsedUrl.pathname;                        // 949
      }                                                                                  // 950
    }                                                                                    // 951
    var version = "";                                                                    // 952
                                                                                         // 953
    var AppConfig = Package["application-configuration"].AppConfig;                      // 954
    version = AppConfig.getStarForThisJob() || "";                                       // 955
                                                                                         // 956
                                                                                         // 957
    var parsedDdpUrl = _.clone(parsedUrl);                                               // 958
    parsedDdpUrl.protocol = "ddp";                                                       // 959
    // Node has a hardcoded list of protocols that get '://' instead                     // 960
    // of ':'. ddp needs to be added to that whitelist. Until then, we                   // 961
    // can set the undocumented attribute 'slashes' to get the right                     // 962
    // behavior. It's not clear whether than is by design or accident.                   // 963
    parsedDdpUrl.slashes = true;                                                         // 964
    parsedDdpUrl.port = '' + securePort;                                                 // 965
    var ddpUrl = url.format(parsedDdpUrl);                                               // 966
                                                                                         // 967
    var proxyToHost, proxyToPort, proxyToPathPrefix;                                     // 968
    if (! _.has(route, 'forwardTo')) {                                                   // 969
      proxyToHost = ourHost;                                                             // 970
      proxyToPort = ourPort;                                                             // 971
      proxyToPathPrefix = parsedUrl.pathname;                                            // 972
    } else {                                                                             // 973
      var parsedFwdUrl = url.parse(route.forwardTo, false, true);                        // 974
      if (! parsedFwdUrl.hostname || parsedFwdUrl.protocol)                              // 975
        throw new Error("Bad forward url");                                              // 976
      proxyToHost = parsedFwdUrl.hostname;                                               // 977
      proxyToPort = parseInt(parsedFwdUrl.port || "80");                                 // 978
      proxyToPathPrefix = parsedFwdUrl.pathname || "";                                   // 979
    }                                                                                    // 980
                                                                                         // 981
    if (route.ddp) {                                                                     // 982
      proxy.call('bindDdp', {                                                            // 983
        pid: pid,                                                                        // 984
        bindTo: {                                                                        // 985
          ddpUrl: ddpUrl,                                                                // 986
          insecurePort: insecurePort                                                     // 987
        },                                                                               // 988
        proxyTo: {                                                                       // 989
          tags: [version],                                                               // 990
          host: proxyToHost,                                                             // 991
          port: proxyToPort,                                                             // 992
          pathPrefix: proxyToPathPrefix + '/websocket'                                   // 993
        },                                                                               // 994
        requiresAuth: requiresDdpAuth                                                    // 995
      }, makeCallback());                                                                // 996
    }                                                                                    // 997
                                                                                         // 998
    if (route.http) {                                                                    // 999
      proxy.call('bindHttp', {                                                           // 1000
        pid: pid,                                                                        // 1001
        bindTo: {                                                                        // 1002
          host: parsedUrl.hostname,                                                      // 1003
          port: insecurePort,                                                            // 1004
          pathPrefix: parsedUrl.pathname                                                 // 1005
        },                                                                               // 1006
        proxyTo: {                                                                       // 1007
          tags: [version],                                                               // 1008
          host: proxyToHost,                                                             // 1009
          port: proxyToPort,                                                             // 1010
          pathPrefix: proxyToPathPrefix                                                  // 1011
        },                                                                               // 1012
        requiresAuth: requiresHttpAuth                                                   // 1013
      }, makeCallback());                                                                // 1014
                                                                                         // 1015
      // Only make the secure binding if we've been told that the                        // 1016
      // proxy knows how terminate secure connections for us (has an                     // 1017
      // appropriate cert, can bind the necessary port..)                                // 1018
      if (proxyConfig.securePort !== null) {                                             // 1019
        proxy.call('bindHttp', {                                                         // 1020
          pid: pid,                                                                      // 1021
          bindTo: {                                                                      // 1022
            host: parsedUrl.hostname,                                                    // 1023
            port: securePort,                                                            // 1024
            pathPrefix: parsedUrl.pathname,                                              // 1025
            ssl: true                                                                    // 1026
          },                                                                             // 1027
          proxyTo: {                                                                     // 1028
            tags: [version],                                                             // 1029
            host: proxyToHost,                                                           // 1030
            port: proxyToPort,                                                           // 1031
            pathPrefix: proxyToPathPrefix                                                // 1032
          },                                                                             // 1033
          requiresAuth: requiresHttpAuth                                                 // 1034
        }, makeCallback());                                                              // 1035
      }                                                                                  // 1036
    }                                                                                    // 1037
  });                                                                                    // 1038
                                                                                         // 1039
  startedAll = true;                                                                     // 1040
  checkComplete();                                                                       // 1041
};                                                                                       // 1042
                                                                                         // 1043
// (Internal, unsupported interface -- subject to change)                                // 1044
//                                                                                       // 1045
// Listen for HTTP and/or DDP traffic and route it somewhere. Only                       // 1046
// takes effect when using a proxy service.                                              // 1047
//                                                                                       // 1048
// 'url' is the traffic that we want to route, interpreted relative to                   // 1049
// the default URL where this app has been told to serve itself. It                      // 1050
// may not have a scheme or port, but it may have a host and a path,                     // 1051
// and if no host is provided the path need not be absolute. The                         // 1052
// following cases are possible:                                                         // 1053
//                                                                                       // 1054
//   //somehost.com                                                                      // 1055
//     All incoming traffic for 'somehost.com'                                           // 1056
//   //somehost.com/foo/bar                                                              // 1057
//     All incoming traffic for 'somehost.com', but only when                            // 1058
//     the first two path components are 'foo' and 'bar'.                                // 1059
//   /foo/bar                                                                            // 1060
//     Incoming traffic on our default host, but only when the                           // 1061
//     first two path components are 'foo' and 'bar'.                                    // 1062
//   foo/bar                                                                             // 1063
//     Incoming traffic on our default host, but only when the path                      // 1064
//     starts with our default path prefix, followed by 'foo' and                        // 1065
//     'bar'.                                                                            // 1066
//                                                                                       // 1067
// (Yes, these scheme-less URLs that start with '//' are legal URLs.)                    // 1068
//                                                                                       // 1069
// You can select either DDP traffic, HTTP traffic, or both. Both                        // 1070
// secure and insecure traffic will be gathered (assuming the proxy                      // 1071
// service is capable, eg, has appropriate certs and port mappings).                     // 1072
//                                                                                       // 1073
// With no 'forwardTo' option, the traffic is received by this process                   // 1074
// for service by the hooks in this 'webapp' package. The original URL                   // 1075
// is preserved (that is, if you bind "/a", and a user visits "/a/b",                    // 1076
// the app receives a request with a path of "/a/b", not a path of                       // 1077
// "/b").                                                                                // 1078
//                                                                                       // 1079
// With 'forwardTo', the process is instead sent to some other remote                    // 1080
// host. The URL is adjusted by stripping the path components in 'url'                   // 1081
// and putting the path components in the 'forwardTo' URL in their                       // 1082
// place. For example, if you forward "//somehost/a" to                                  // 1083
// "//otherhost/x", and the user types "//somehost/a/b" into their                       // 1084
// browser, then otherhost will receive a request with a Host header                     // 1085
// of "somehost" and a path of "/x/b".                                                   // 1086
//                                                                                       // 1087
// The routing continues until this process exits. For now, all of the                   // 1088
// routes must be set up ahead of time, before the initial                               // 1089
// registration with the proxy. Calling addRoute from the top level of                   // 1090
// your JS should do the trick.                                                          // 1091
//                                                                                       // 1092
// When multiple routes are present that match a given request, the                      // 1093
// most specific route wins. When routes with equal specificity are                      // 1094
// present, the proxy service will distribute the traffic between                        // 1095
// them.                                                                                 // 1096
//                                                                                       // 1097
// options may be:                                                                       // 1098
// - ddp: if true, the default, include DDP traffic. This includes                       // 1099
//   both secure and insecure traffic, and both websocket and sockjs                     // 1100
//   transports.                                                                         // 1101
// - http: if true, the default, include HTTP/HTTPS traffic.                             // 1102
// - forwardTo: if provided, should be a URL with a host, optional                       // 1103
//   path and port, and no scheme (the scheme will be derived from the                   // 1104
//   traffic type; for now it will always be a http or ws connection,                    // 1105
//   never https or wss, but we could add a forwardSecure flag to                        // 1106
//   re-encrypt).                                                                        // 1107
var routes = [];                                                                         // 1108
WebAppInternals.addRoute = function (url, options) {                                     // 1109
  options = _.extend({                                                                   // 1110
    ddp: true,                                                                           // 1111
    http: true                                                                           // 1112
  }, options || {});                                                                     // 1113
                                                                                         // 1114
  if (proxy)                                                                             // 1115
    // In the future, lift this restriction                                              // 1116
    throw new Error("Too late to add routes");                                           // 1117
                                                                                         // 1118
  routes.push(_.extend({ url: url }, options));                                          // 1119
};                                                                                       // 1120
                                                                                         // 1121
// Receive traffic on our default URL.                                                   // 1122
WebAppInternals.addRoute("");                                                            // 1123
                                                                                         // 1124
runWebAppServer();                                                                       // 1125
                                                                                         // 1126
                                                                                         // 1127
var inlineScriptsAllowed = true;                                                         // 1128
                                                                                         // 1129
WebAppInternals.inlineScriptsAllowed = function () {                                     // 1130
  return inlineScriptsAllowed;                                                           // 1131
};                                                                                       // 1132
                                                                                         // 1133
WebAppInternals.setInlineScriptsAllowed = function (value) {                             // 1134
  inlineScriptsAllowed = value;                                                          // 1135
  WebAppInternals.generateBoilerplate();                                                 // 1136
};                                                                                       // 1137
                                                                                         // 1138
WebAppInternals.setBundledJsCssPrefix = function (prefix) {                              // 1139
  bundledJsCssPrefix = prefix;                                                           // 1140
  WebAppInternals.generateBoilerplate();                                                 // 1141
};                                                                                       // 1142
                                                                                         // 1143
// Packages can call `WebAppInternals.addStaticJs` to specify static                     // 1144
// JavaScript to be included in the app. This static JS will be inlined,                 // 1145
// unless inline scripts have been disabled, in which case it will be                    // 1146
// served under `/<sha1 of contents>`.                                                   // 1147
var additionalStaticJs = {};                                                             // 1148
WebAppInternals.addStaticJs = function (contents) {                                      // 1149
  additionalStaticJs["/" + sha1(contents) + ".js"] = contents;                           // 1150
};                                                                                       // 1151
                                                                                         // 1152
// Exported for tests                                                                    // 1153
WebAppInternals.getBoilerplate = getBoilerplate;                                         // 1154
WebAppInternals.additionalStaticJs = additionalStaticJs;                                 // 1155
                                                                                         // 1156
///////////////////////////////////////////////////////////////////////////////////////////

}).call(this);


/* Exports */
if (typeof Package === 'undefined') Package = {};
Package.webapp = {
  WebApp: WebApp,
  main: main,
  WebAppInternals: WebAppInternals
};

})();
