// Shared defaults for the options page, the click interceptor, download
// takeover, and the video chip. Values live in storage.local so they
// survive a browser restart.

const GARIA_PREF_DEFAULTS = {
  clickCapture: true,
  downloadTakeover: true,
  videoButton: true,
};

const GARIA_DISMISS_CAP = 100;

function gariaBrowserApi() {
  return globalThis.browser?.runtime ? globalThis.browser : globalThis.chrome;
}

function gariaWhenDone(value) {
  return value && typeof value.then === "function" ? value : Promise.resolve(value);
}

async function gariaLoadPrefs() {
  const api = gariaBrowserApi();
  const fallback = {
    prefs: { ...GARIA_PREF_DEFAULTS },
    dismissedHosts: [],
  };
  if (!api?.storage?.local?.get) return fallback;
  try {
    const data = await gariaWhenDone(
      api.storage.local.get({
        prefs: { ...GARIA_PREF_DEFAULTS },
        dismissedHosts: [],
      }),
    );
    return {
      prefs: { ...GARIA_PREF_DEFAULTS, ...(data?.prefs || {}) },
      dismissedHosts: Array.isArray(data?.dismissedHosts) ? data.dismissedHosts : [],
    };
  } catch {
    return fallback;
  }
}

async function gariaSavePrefs(prefs) {
  const api = gariaBrowserApi();
  if (!api?.storage?.local?.set) return;
  await gariaWhenDone(
    api.storage.local.set({
      prefs: { ...GARIA_PREF_DEFAULTS, ...prefs },
    }),
  );
}

async function gariaSaveDismissedHosts(hosts) {
  const api = gariaBrowserApi();
  if (!api?.storage?.local?.set) return;
  const trimmed = Array.isArray(hosts) ? hosts.slice(-GARIA_DISMISS_CAP) : [];
  await gariaWhenDone(api.storage.local.set({ dismissedHosts: trimmed }));
}

function gariaHostOf(href) {
  try {
    return new URL(href).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return "";
  }
}
