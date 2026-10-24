// A small in-memory stand-in for the chrome.* APIs background.js uses.
// `store` and `sessionStore` are passed in so a test can "restart" the service worker
// (new chrome object + fresh module evaluation) while keeping storage, exactly like Chrome.

export const EXT_ID = "testextensionid";

export function makeStore(initial = {}) {
  return { data: structuredClone(initial) };
}

function storageArea(store) {
  return {
    async get(keys) {
      if (keys == null) return structuredClone(store.data);
      const list = Array.isArray(keys)
        ? keys
        : typeof keys === "string"
          ? [keys]
          : Object.keys(keys);
      const out = {};
      for (const k of list)
        if (k in store.data) out[k] = structuredClone(store.data[k]);
      return out;
    },
    async set(obj) {
      for (const [k, v] of Object.entries(obj)) {
        if (v === undefined) delete store.data[k];
        else store.data[k] = structuredClone(v);
      }
    },
  };
}

function eventSlot() {
  const listeners = [];
  return { addListener: (fn) => listeners.push(fn), listeners };
}

/** Chrome match-pattern check, enough for the patterns background.js produces. */
function matchesPattern(pattern, url) {
  if (pattern === "<all_urls>") return /^(https?|file|ftp):/.test(url);
  const m = /^(\*|https?|file|ftp):\/\/([^/]*)(\/.*)$/.exec(pattern);
  if (!m) return false;
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  const [, scheme, host, path] = m;
  const proto = u.protocol.slice(0, -1);
  if (scheme === "*" ? proto !== "http" && proto !== "https" : scheme !== proto) return false;
  if (host !== "*") {
    if (host.startsWith("*.")) {
      const base = host.slice(2);
      if (u.hostname !== base && !u.hostname.endsWith("." + base)) return false;
    } else if (u.hostname !== host) return false;
  }
  const re = new RegExp("^" + path.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");
  return re.test(u.pathname + u.search);
}

export function makeChrome({ local, session, now }) {
  const alarms = new Map();
  const registeredScripts = new Map();
  const executedScripts = [];
  const openedTabs = [];
  const env = {
    activeTab: null, // { id, url, audible }
    grantedOrigins: [], // host permissions the user has granted; tests reassign or mutate this
    openTabs: [], // every open tab ({ id, url? }); returned by tabs.query({ url })
    registered: registeredScripts, // dynamically registered content scripts, by id
    injected: [], // tab IDs that scripting.executeScript has been called for
    createdTabs: [], // URLs passed to tabs.create
    windowFocused: true,
    idleState: "active",
  };

  const chrome = {
    runtime: {
      id: EXT_ID,
      getURL: (p = "") => `chrome-extension://${EXT_ID}/${p}`,
      getManifest: () => ({ version: "test" }),
      onMessage: eventSlot(),
      onInstalled: eventSlot(),
      onStartup: eventSlot(),
    },
    permissions: {
      async getAll() {
        return { origins: [...env.grantedOrigins], permissions: [] };
      },
      onAdded: eventSlot(),
      onRemoved: eventSlot(),
    },
    scripting: {
      async getRegisteredContentScripts({ ids } = {}) {
        const scripts = [...registeredScripts.values()];
        return ids ? scripts.filter((s) => ids.includes(s.id)) : scripts;
      },

      async registerContentScripts(scripts) {
        for (const script of scripts) {
          if (registeredScripts.has(script.id)) {
            throw new Error(`Duplicate script ID: ${script.id}`);
          }
          registeredScripts.set(script.id, structuredClone(script));
        }
      },

      async updateContentScripts(scripts) {
        for (const script of scripts) {
          if (!registeredScripts.has(script.id)) {
            throw new Error(`Unknown script ID: ${script.id}`);
          }
          registeredScripts.set(script.id, structuredClone(script));
        }
      },

      async unregisterContentScripts({ ids } = {}) {
        if (ids) {
          for (const id of ids) registeredScripts.delete(id);
        } else {
          registeredScripts.clear();
        }
      },

      async executeScript(details) {
        executedScripts.push(structuredClone(details));
        env.injected.push(details.target.tabId);
        return [];
      },
    },
    storage: {
      local: storageArea(local),
      session: storageArea(session),
      onChanged: eventSlot(),
    },
    alarms: {
      create(name, info) {
        const scheduledTime =
          info.when != null
            ? info.when
            : now() +
              (info.delayInMinutes ?? info.periodInMinutes ?? 0) * 60000;
        alarms.set(name, {
          name,
          scheduledTime,
          periodInMinutes: info.periodInMinutes,
        });
      },
      async get(name) {
        return alarms.get(name);
      },
      async getAll() {
        return [...alarms.values()];
      },
      async clear(name) {
        return alarms.delete(name);
      },
      onAlarm: eventSlot(),
    },
    tabs: {
      async query(info = {}) {
        if (info.url !== undefined) {
          // A tab's url is only visible/matchable when a granted pattern covers it. Tabs the test
          // declares without a url are treated as already matching the requested patterns.
          const patterns = [].concat(info.url);
          return env.openTabs
            .filter((t) => t.url === undefined || patterns.some((p) => matchesPattern(p, t.url)))
            .map((t) => ({ ...t }));
        }
        return env.activeTab ? [{ ...env.activeTab }] : [];
      },
      async create(properties) {
        const tab = { id: openedTabs.length + 1, ...properties };
        openedTabs.push(tab);
        env.createdTabs.push(properties.url);
        return tab;
      },
      onActivated: eventSlot(),
      onUpdated: eventSlot(),
      onRemoved: eventSlot(),
    },
    windows: {
      async getLastFocused() {
        return { focused: env.windowFocused };
      },
      onFocusChanged: eventSlot(),
    },
    idle: {
      queryState(_seconds, cb) {
        cb(env.idleState);
      },
      setDetectionInterval() {},
      onStateChanged: eventSlot(),
    },
  };
  return {
    chrome,
    env,
    alarms,
    registeredScripts,
    executedScripts,
    openedTabs,
  };
}

/** Delivers a message to the background's onMessage listener and resolves with its response. */
export function sendMessage(chrome, message, sender) {
  return new Promise((resolve) => {
    let answered = false;
    const reply = (r) => {
      answered = true;
      resolve(r);
    };
    for (const fn of chrome.runtime.onMessage.listeners)
      fn(message, sender, reply);
    // A listener that returns false without answering would leave the promise hanging.
    const timer = setTimeout(() => {
      if (!answered) resolve(undefined);
    }, 2000);
    if (timer.unref) timer.unref();
  });
}

export const senders = {
  popup: { id: EXT_ID, url: `chrome-extension://${EXT_ID}/popup.html` },
  content: (tabId = 7) => ({
    id: EXT_ID,
    url: "https://www.reddit.com/r/all",
    tab: { id: tabId },
    frameId: 0,
  }),
  contentSubframe: (tabId = 7) => ({
    id: EXT_ID,
    url: "https://ads.example.com/",
    tab: { id: tabId },
    frameId: 3,
  }),
  otherExtension: {
    id: "someotherextension",
    url: "chrome-extension://someotherextension/x.html",
  },
};