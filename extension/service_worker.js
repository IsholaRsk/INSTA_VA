const PROXY_RECOVERY_KEY = "temporaryProxyRecovery";
const PROXY_AUTH_SESSION_KEY = "temporaryProxyAuth";

/**
 * Le panneau rotat les proxys Webshare : l'entrée d'authentification est réécrite
 * juste avant chaque cycle. On répond donc au challenge en comparant au challenger
 * réel (hôte + port) plutôt qu'en gardant un seul proxy en mémoire.
 */
chrome.webRequest.onAuthRequired.addListener(
  (details, asyncCallback) => {
    const respond = (value = {}) => {
      try { asyncCallback?.(value); } catch { /* la requête n’attend plus de réponse */ }
    };
    if (!asyncCallback) {
      respond();
      return;
    }

    chrome.storage.session.get(PROXY_AUTH_SESSION_KEY).then((result) => {
      const auth = result?.[PROXY_AUTH_SESSION_KEY];
      if (!auth || !auth.username || !auth.password) {
        respond(details.isProxy ? undefined : {});
        return;
      }
      const challengerHost = normalizeProxyHost(details.challenger?.host);
      const challengerPort = Number(details.challenger?.port);
      // Le port du challenger peut être absent; l'hôte est la clé de reconnaissance.
      const matches = challengerHost === normalizeProxyHost(auth.host) &&
        (!challengerPort || challengerPort === Number(auth.port));
      // Un challenge non-proxy (site visité) n'est jamais résolu avec les identifiants Webshare.
      if (!matches || !details.isProxy) {
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
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  void restoreStaleProxy().catch((error) => console.error("Proxy cleanup failed:", error));
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
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
  return String(host || "").trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
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
