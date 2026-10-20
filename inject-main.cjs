/* ZCode composer predictions - main process loader.
 *
 * Appended to app.asar's out/main/index.js by install.py:
 *
 *   import("file:///.../inject-main.cjs").catch(...)
 *
 * Responsibilities:
 *   - inject overlay.js into every main window (hot reload aware);
 *   - follow the window's active session via ZCode's own IPC channel;
 *   - watch the session database and ask predict_helper.py for a suggestion
 *     when a turn has finished and the composer is empty;
 *   - push the suggestion into the renderer.
 *
 * It never blocks app startup: every failure is logged and ignored.
 */
"use strict";

const path = require("path");
const fs = require("fs");
const os = require("os");
const { spawn } = require("child_process");
const { app, webContents, ipcMain } = require("electron");

const HERE = __dirname;
const CONFIG = path.join(HERE, "config.json");
const OVERLAY = path.join(HERE, "overlay.js");
const HELPER = path.join(HERE, "predict_helper.py");
const LOG_FILE = path.join(HERE, "zcp.log");
const LOG_MAX = 2 * 1024 * 1024;
const IPC_ACTIVE_SID = "zcode:sync-active-task-session";
const VERSION = "0.1.1";

const DEFAULTS = {
  enabled: true,
  pythonPath: "python",
  dbDir: "",
  activityDebounceMs: 500,
  heartbeatMs: 15000,
  predictTimeoutMs: 45000,
  statusTimeoutMs: 6000,
  predictRetryMs: 15000,
  predictMaxAttempts: 3,
  helperRestartMs: 1000,
  hotReload: true,
  debug: false,
};

function readConfig() {
  const cfg = Object.assign({}, DEFAULTS);
  try {
    Object.assign(cfg, JSON.parse(fs.readFileSync(CONFIG, "utf8")));
  } catch (e) {}
  return cfg;
}

let cfgMtime = 0;
let cfgCache = null;
function config() {
  let mtime = 0;
  try {
    mtime = fs.statSync(CONFIG).mtimeMs;
  } catch (e) {}
  if (!cfgCache || mtime !== cfgMtime) {
    cfgMtime = mtime;
    cfgCache = readConfig();
  }
  return cfgCache;
}

function log() {
  const args = Array.prototype.slice.call(arguments);
  const line =
    new Date().toISOString() + " " + args.map(function (value) {
      if (typeof value === "string") return value;
      try {
        return JSON.stringify(value);
      } catch (e) {
        return String(value);
      }
    }).join(" ");
  try {
    console.error("[zcp]", line);
  } catch (e) {}
  try {
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > LOG_MAX) {
      fs.renameSync(LOG_FILE, LOG_FILE + ".1");
    }
    fs.appendFileSync(LOG_FILE, line + "\n");
  } catch (e) {}
}

function debugLog() {
  if (config().debug) log.apply(null, arguments);
}

// ---------------------------------------------------------------------------
// Overlay injection
// ---------------------------------------------------------------------------

let overlaySrc = "";
let overlayMtime = 0;

function loadOverlay() {
  try {
    overlaySrc = fs.readFileSync(OVERLAY, "utf8");
    overlayMtime = fs.statSync(OVERLAY).mtimeMs;
    return true;
  } catch (e) {
    log("overlay read failed:", e.message);
    return false;
  }
}

function isMainWindow(wc) {
  try {
    return wc.getType() === "window";
  } catch (e) {
    return false;
  }
}

function injectOverlay(wc) {
  if (!overlaySrc || !isMainWindow(wc) || wc.isDestroyed()) return;
  wc.executeJavaScript(overlaySrc, true).catch(function (e) {
    debugLog("inject failed:", e.message);
  });
}

function push(wc, code) {
  if (!isMainWindow(wc) || wc.isDestroyed()) return Promise.resolve(null);
  return wc.executeJavaScript(code, true).catch(function () {
    return null;
  });
}

function jsString(value) {
  return JSON.stringify(value)
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function pushSession(wc, sid) {
  push(wc, "window.__zcpSetSession && window.__zcpSetSession(" + jsString(sid || "") + ")");
}

function pushSuggestion(wc, payload) {
  push(wc, "window.__zcpShowSuggestion && window.__zcpShowSuggestion(" + jsString(payload) + ")");
}

function pushClear(wc) {
  push(wc, "window.__zcpClear && window.__zcpClear()");
}

function askShouldPredict(wc) {
  return push(
    wc,
    "window.__zcpShouldPredict ? JSON.stringify(window.__zcpShouldPredict()) : 'null'"
  ).then(function (raw) {
    if (!raw || raw === "null") return null;
    try {
      return JSON.parse(raw);
    } catch (e) {
      return null;
    }
  });
}

function hookWindow(wc) {
  if (!isMainWindow(wc)) return;
  wc.on("did-finish-load", function () {
    injectOverlay(wc);
    const sid = activeSid.get(wc.id) || "";
    if (sid) pushSession(wc, sid);
    scheduleCheck(1200, true);
  });
  wc.on("destroyed", function () {
    activeSid.delete(wc.id);
  });
  if (!wc.isLoading()) {
    injectOverlay(wc);
    const sid = activeSid.get(wc.id) || "";
    if (sid) pushSession(wc, sid);
    scheduleCheck(1500, true);
  }
}

function hotReloadIfChanged() {
  if (config().hotReload === false) return;
  let mtime = 0;
  try {
    mtime = fs.statSync(OVERLAY).mtimeMs;
  } catch (e) {
    return;
  }
  if (mtime === overlayMtime) return;

  let src = "";
  try {
    src = fs.readFileSync(OVERLAY, "utf8");
    new Function(src); // syntax check before swapping a half-written file
  } catch (e) {
    log("overlay hot reload skipped:", e.message);
    return;
  }
  overlayMtime = mtime;
  overlaySrc = src;
  log("overlay changed, hot reloading");
  for (const wc of webContents.getAllWebContents()) {
    if (!isMainWindow(wc) || wc.isDestroyed()) continue;
    push(wc, "window.__zcpOverlay && window.__zcpOverlay.dispose && window.__zcpOverlay.dispose()");
    injectOverlay(wc);
  }
}

// ---------------------------------------------------------------------------
// Active session tracking
// ---------------------------------------------------------------------------

const activeSid = new Map(); // webContents.id -> session id or ""

try {
  ipcMain.on(IPC_ACTIVE_SID, function (event, sid) {
    if (!event || !event.sender || event.sender.isDestroyed()) return;
    const value = typeof sid === "string" ? sid.trim() : "";
    const clean = value && value.length <= 255 && /^[A-Za-z0-9_-]+$/.test(value) ? value : "";
    const wc = event.sender;
    if (!isMainWindow(wc)) return;
    const previous = activeSid.get(wc.id);
    activeSid.set(wc.id, clean);
    if (previous !== clean) {
      debugLog("active session", wc.id, previous || "-", "->", clean || "-");
      pushSession(wc, clean);
      pushClear(wc);
      scheduleCheck(900, true);
    }
  });
} catch (e) {
  log("ipc hook failed:", e.message);
}

// ---------------------------------------------------------------------------
// Resident helper
// ---------------------------------------------------------------------------

const helper = {
  proc: null,
  buf: "",
  pending: new Map(),
  nextId: 1,
  fails: 0,
  born: 0,
  disabledUntil: 0,
  starting: false,
};

function helperEnv() {
  return Object.assign({}, process.env, {
    ZCP_RUNTIME_DIR: HERE,
    PYTHONIOENCODING: "utf-8",
    PYTHONUNBUFFERED: "1",
  });
}

function resolvePending(id, response) {
  const entry = helper.pending.get(id);
  if (!entry) return;
  helper.pending.delete(id);
  clearTimeout(entry.timer);
  entry.resolve(response);
}

function rejectAllPending(reason) {
  for (const [id, entry] of helper.pending) {
    helper.pending.delete(id);
    clearTimeout(entry.timer);
    entry.reject(new Error(reason));
  }
}

function startHelper() {
  if (helper.proc || helper.starting) return;
  if (Date.now() < helper.disabledUntil) return;
  helper.starting = true;

  let proc;
  try {
    proc = spawn(config().pythonPath || "python", [HELPER, "serve"], {
      cwd: HERE,
      env: helperEnv(),
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (e) {
    helper.starting = false;
    helper.disabledUntil = Date.now() + 60000;
    log("helper spawn failed:", e.message);
    return;
  }

  helper.proc = proc;
  helper.buf = "";
  helper.born = Date.now();
  helper.starting = false;
  log("helper started pid=" + (proc.pid || "?"));

  proc.stdout.on("data", function (chunk) {
    helper.buf += chunk.toString("utf8");
    let index;
    while ((index = helper.buf.indexOf("\n")) >= 0) {
      const line = helper.buf.slice(0, index).trim();
      helper.buf = helper.buf.slice(index + 1);
      if (!line) continue;
      let payload = null;
      try {
        payload = JSON.parse(line);
      } catch (e) {
        debugLog("helper non-json:", line.slice(0, 200));
        continue;
      }
      if (payload && payload.ready) {
        debugLog("helper ready", payload.version || "");
        continue;
      }
      if (payload && payload.id !== undefined) {
        resolvePending(payload.id, payload);
      } else {
        debugLog("helper response without id", payload);
      }
    }
  });

  proc.stderr.on("data", function (chunk) {
    const text = chunk.toString("utf8").trim();
    if (text) debugLog("helper stderr:", text.slice(0, 500));
  });

  proc.on("error", function (e) {
    log("helper process error:", e.message);
  });

  proc.on("close", function (code) {
    if (helper.proc === proc) helper.proc = null;
    rejectAllPending("helper exited");
    if (Date.now() - helper.born < 30000) {
      helper.fails += 1;
      if (helper.fails >= 3) {
        helper.disabledUntil = Date.now() + 60000;
        log("helper unstable, one-shot mode for 60s");
        return;
      }
    } else {
      helper.fails = 0;
    }
    const delay = Math.min(30000, (config().helperRestartMs || 1000) * Math.max(1, helper.fails));
    setTimeout(startHelper, delay);
    debugLog("helper exited", code);
  });
}

function requestHelper(payload, timeoutMs) {
  return new Promise(function (resolve, reject) {
    if (Date.now() < helper.disabledUntil) {
      oneShot(payload, timeoutMs).then(resolve, reject);
      return;
    }
    startHelper();
    if (!helper.proc || !helper.proc.stdin || !helper.proc.stdin.writable) {
      oneShot(payload, timeoutMs).then(resolve, reject);
      return;
    }

    const id = helper.nextId++;
    const timer = setTimeout(function () {
      helper.pending.delete(id);
      reject(new Error("helper timeout"));
    }, timeoutMs);
    helper.pending.set(id, { resolve: resolve, reject: reject, timer: timer });

    try {
      helper.proc.stdin.write(JSON.stringify(Object.assign({ id: id }, payload)) + "\n");
    } catch (e) {
      helper.pending.delete(id);
      clearTimeout(timer);
      oneShot(payload, timeoutMs).then(resolve, reject);
    }
  });
}

function oneShot(payload, timeoutMs) {
  return new Promise(function (resolve, reject) {
    const args = [HELPER, payload.cmd, "--session", payload.sessionId];
    if (payload.cmd === "predict" && payload.maxChars) {
      args.push("--max-chars", String(payload.maxChars));
    }
    let proc;
    try {
      proc = spawn(config().pythonPath || "python", args, {
        cwd: HERE,
        env: helperEnv(),
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      reject(e);
      return;
    }
    let out = "";
    let err = "";
    const timer = setTimeout(function () {
      try {
        proc.kill();
      } catch (e) {}
      reject(new Error("one-shot timeout"));
    }, timeoutMs);
    proc.stdout.on("data", function (d) {
      out += d.toString("utf8");
    });
    proc.stderr.on("data", function (d) {
      err += d.toString("utf8");
    });
    proc.on("error", function (e) {
      clearTimeout(timer);
      reject(e);
    });
    proc.on("close", function () {
      clearTimeout(timer);
      try {
        const start = out.indexOf("{");
        const end = out.lastIndexOf("}");
        if (start < 0 || end < start) throw new Error("no json: " + err.slice(0, 300));
        resolve(JSON.parse(out.slice(start, end + 1)));
      } catch (e) {
        reject(new Error(e.message + (err ? " / " + err.slice(0, 300) : "")));
      }
    });
  });
}

// ---------------------------------------------------------------------------
// DB watcher and prediction flow
// ---------------------------------------------------------------------------

const lastPredicted = new Map(); // sessionId -> assistant message id
const busySessions = new Set();
const attempts = new Map(); // "sessionId|messageId" -> failed attempt count

/* Definitive outcomes (turn settled but no usable prediction) stop retrying;
   transient failures (timeout, model HTTP error, spawn failure) retry a few
   times before giving up on this assistant message. */
const NO_RETRY_REASONS = ["turn-not-complete", "empty-transcript", "missing-model"];

function registerAttempt(sid, messageId) {
  const key = sid + "|" + messageId;
  const next = (attempts.get(key) || 0) + 1;
  const max = Math.max(1, config().predictMaxAttempts | 0 || 3);
  if (next >= max) {
    attempts.delete(key);
    lastPredicted.set(sid, messageId);
    log("predict gave up after", next, "attempts", sid.slice(0, 18));
    return false;
  }
  attempts.set(key, next);
  if (attempts.size > 200) attempts.delete(attempts.keys().next().value);
  return true;
}

function clearAttempts(sid, messageId) {
  attempts.delete(sid + "|" + messageId);
}
let checkInFlight = false;
let checkAgain = false;
let retryTimer = 0;
let lastStamp = 0;

function dbDir() {
  const configured = config().dbDir;
  if (configured) return configured;
  return path.join(os.homedir(), ".zcode", "cli", "db");
}

function dbStamp() {
  let stamp = 0;
  for (const name of ["db.sqlite", "db.sqlite-wal", "db.sqlite-shm"]) {
    try {
      stamp = Math.max(stamp, fs.statSync(path.join(dbDir(), name)).mtimeMs);
    } catch (e) {}
  }
  return stamp;
}

function scheduleCheck(delay, force) {
  // A session switch or a freshly loaded overlay must re-check even when the
  // database stamp has not changed since the last pass.
  if (force) lastStamp = 0;
  clearTimeout(retryTimer);
  retryTimer = setTimeout(maybeCheck, typeof delay === "number" ? delay : 600);
}

async function maybeCheck() {
  if (checkInFlight) {
    checkAgain = true;
    return;
  }
  if (!config().enabled) return;
  checkInFlight = true;
  checkAgain = false;
  try {
    const stamp = dbStamp();
    if (stamp && stamp === lastStamp && !checkAgain) {
      // No database change since the last pass.  Heartbeats still get here;
      // status checks are cheap, but skip an identical idle pass.
      debugLog("db unchanged, skip");
      return;
    }
    lastStamp = stamp;

    for (const wc of webContents.getAllWebContents()) {
      if (!isMainWindow(wc) || wc.isDestroyed()) continue;
      const sid = activeSid.get(wc.id) || "";
      if (!sid || busySessions.has(sid)) continue;

      const canPredict = await askShouldPredict(wc);
      if (!canPredict || !canPredict.ok) {
        debugLog("skip", sid.slice(0, 16), canPredict);
        continue;
      }

      let status = null;
      try {
        status = await requestHelper(
          { cmd: "status", sessionId: sid },
          config().statusTimeoutMs
        );
      } catch (e) {
        debugLog("status failed", e.message);
        continue;
      }
      if (!status || !status.complete || !status.messageId) continue;
      if (lastPredicted.get(sid) === status.messageId) continue;
      if (activeSid.get(wc.id) !== sid) continue;

      const stillOk = await askShouldPredict(wc);
      if (!stillOk || !stillOk.ok) {
        debugLog("composer changed before predict", sid.slice(0, 16));
        continue;
      }

      busySessions.add(sid);
      const started = Date.now();
      try {
        log(
          "predicting",
          sid.slice(0, 18),
          status.providerId || "?",
          status.modelId || "?",
          status.messageId.slice(0, 18)
        );
        const result = await requestHelper(
          { cmd: "predict", sessionId: sid },
          config().predictTimeoutMs
        );

        if (!result || !result.ok) {
          const reason = (result && (result.reason || result.error)) || "unknown";
          log("predict failed", reason);
          if (!NO_RETRY_REASONS.includes(reason)) {
            if (registerAttempt(sid, status.messageId)) {
              scheduleCheck(Math.max(1000, config().predictRetryMs | 0 || 15000));
            }
          } else {
            lastPredicted.set(sid, status.messageId);
          }
          continue;
        }
        if (!result.suggestion) {
          lastPredicted.set(sid, status.messageId);
          clearAttempts(sid, status.messageId);
          debugLog("model returned SKIP/SKIP-like", sid.slice(0, 16));
          continue;
        }
        if (activeSid.get(wc.id) !== sid || wc.isDestroyed()) {
          if (registerAttempt(sid, status.messageId)) {
            scheduleCheck(Math.max(1000, config().predictRetryMs | 0 || 15000));
          }
          continue;
        }

        const finalOk = await askShouldPredict(wc);
        if (!finalOk || !finalOk.ok) {
          debugLog("composer no longer empty, retry prediction later");
          if (registerAttempt(sid, status.messageId)) {
            scheduleCheck(Math.max(1000, config().predictRetryMs | 0 || 15000));
          }
          continue;
        }

        lastPredicted.set(sid, status.messageId);
        clearAttempts(sid, status.messageId);
        pushSuggestion(wc, {
          text: result.suggestion,
          sessionId: sid,
          messageId: status.messageId,
          model: result.model || status.modelId || "",
          latencyMs: result.elapsedMs || Date.now() - started,
        });
        log(
          "suggestion shown",
          sid.slice(0, 18),
          result.suggestion.length + " chars",
          (result.elapsedMs || Date.now() - started) + "ms"
        );
      } catch (e) {
        log("predict error", e.message);
        if (registerAttempt(sid, status.messageId)) {
          scheduleCheck(Math.max(1000, config().predictRetryMs | 0 || 15000));
        }
      } finally {
        busySessions.delete(sid);
      }
    }
  } finally {
    checkInFlight = false;
    if (checkAgain) {
      checkAgain = false;
      scheduleCheck(300);
    }
  }
}

let watcher = null;
let debounceTimer = 0;

function watchDb() {
  if (watcher) return;
  try {
    watcher = fs.watch(dbDir(), function (event, filename) {
      if (filename && !/db\.sqlite/.test(filename)) return;
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(maybeCheck, Math.max(100, config().activityDebounceMs || 500));
    });
    watcher.on("error", function () {
      log("db watcher error, re-arm in 5s");
      try {
        watcher.close();
      } catch (e) {}
      watcher = null;
      setTimeout(watchDb, 5000);
    });
    log("watching", dbDir());
  } catch (e) {
    log("db watch failed, retry in 5s:", e.message);
    setTimeout(watchDb, 5000);
  }
}

let heartbeat = 0;
let hotTimer = 0;

function start() {
  loadOverlay();
  app.on("web-contents-created", function (event, wc) {
    hookWindow(wc);
  });
  for (const wc of webContents.getAllWebContents()) hookWindow(wc);

  watchDb();
  scheduleCheck(2500, true);

  heartbeat = setInterval(maybeCheck, Math.max(5000, config().heartbeatMs || 15000));
  hotTimer = setInterval(hotReloadIfChanged, 2000);
  log("loaded v" + VERSION, "helper=" + HELPER);
}

function shutdown() {
  clearInterval(heartbeat);
  clearInterval(hotTimer);
  clearTimeout(debounceTimer);
  clearTimeout(retryTimer);
  if (watcher) {
    try {
      watcher.close();
    } catch (e) {}
  }
  if (helper.proc) {
    try {
      helper.proc.kill();
    } catch (e) {}
  }
}

app.whenReady().then(start).catch(function (e) {
  log("start failed:", e.message);
});
app.on("will-quit", shutdown);
