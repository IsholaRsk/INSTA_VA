const PROXY_RECOVERY_KEY = "temporaryProxyRecovery";
const PROXY_AUTH_SESSION_KEY = "temporaryProxyAuth";

chrome.webRequest.onAuthRequired.addListener(
  (details, asyncCallback) => {
    const respond = (value = {}) => {
      try { asyncCallback?.(value); } catch { /* la requête n’attend plus de réponse */ }
    };
    if (!details.isProxy || !asyncCallback) {
      respond();
      return;
    }

    chrome.storage.session.get(PROXY_AUTH_SESSION_KEY).then((result) => {
      const auth = result?.[PROXY_AUTH_SESSION_KEY];
      const challengerHost = normalizeProxyHost(details.challenger?.host);
      const challengerPort = Number(details.challenger?.port);
      if (!auth || !auth.username || !auth.password ||
          challengerHost !== normalizeProxyHost(auth.host) || challengerPort !== Number(auth.port)) {
        respond();
        return;
      }
      respond({ authCredentials: { username: auth.username, password: auth.password } });
    }).catch(() => respond());
  },
  { urls: ["<all_urls>"] },
  ["asyncBlocking"],
);

chrome.runtime.onInstalled.addListener(() => {
  void restoreStaleProxy().catch((error) => console.error("Proxy cleanup failed:", error));
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

chrome.runtime.onStartup.addListener(() => {
  void restoreStaleProxy().catch((error) => console.error("Proxy cleanup failed:", error));
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || message?.type !== "restore-temporary-proxy") return;
  (async () => {
    try {
      await restoreStaleProxy();
      await chrome.storage.session.remove(PROXY_AUTH_SESSION_KEY);
      sendResponse({ ok: true });
    } catch (error) {
      try { await chrome.storage.session.remove(PROXY_AUTH_SESSION_KEY); } catch { /* Chrome peut être en fermeture */ }
      sendResponse({ ok: false, error: error.message });
    }
  })();
  return true;
});

function normalizeProxyHost(host) {
  return String(host || "").trim().toLowerCase().replace(/\.$/, "");
}

async function restoreStaleProxy() {
  const result = await chrome.storage.local.get(PROXY_RECOVERY_KEY);
  const recovery = result?.[PROXY_RECOVERY_KEY];
  if (!recovery) return;

  if (recovery.restoreWithSet) {
    await chrome.proxy.settings.set({ value: recovery.previousValue, scope: "regular" });
  } else {
    await chrome.proxy.settings.clear({ scope: "regular" });
  }
  await chrome.storage.local.remove(PROXY_RECOVERY_KEY);
}
