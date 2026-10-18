"use strict";

/* global ExtensionAPI, ChromeUtils, Services, Ci, Cc, Cu */

const { ExtensionParent } = ChromeUtils.importESModule(
  "resource://gre/modules/ExtensionParent.sys.mjs"
);
const { SessionStore } = ChromeUtils.importESModule(
  "resource:///modules/sessionstore/SessionStore.sys.mjs"
);

const STG_ID = "simple-tab-groups@drive4ik";
const STG_SESSION_KEY = `extension:${STG_ID}:groupId`;

function ensureSyncPrefs() {
  try {
    Services.prefs.setBoolPref("services.sync.engine.extension-storage.force", true);
  } catch (e) {
    console.error("[STG Mirror Sync] Failed to set extension-storage.force pref:", e);
  }
}

function getStgXulBrowser() {
  try {
    const { proxyContexts } = ExtensionParent.ParentAPIManager;
    for (const ctx of proxyContexts.values()) {
      if (ctx.extension && ctx.extension.id === STG_ID && ctx.viewType === "background") {
        const xulBrowser = ctx.browsingContext?.top?.embedderElement;
        if (xulBrowser && xulBrowser.messageManager) {
          return xulBrowser;
        }
      }
    }
  } catch (e) {
    console.error("[STG Mirror Sync] getStgXulBrowser error:", e);
  }
  return null;
}

const FRAME_SCRIPT_CODE = `
(function() {
  if (globalThis.__stgMirrorBridgeInstalled) {
    return;
  }
  globalThis.__stgMirrorBridgeInstalled = true;

  addMessageListener("STGMirrorBridge:Request", function(msg) {
    const { reqId, action, args } = msg.data;
    try {
      const win = content && content.wrappedJSObject;
      if (!win || !win.inited || typeof win.onBackgroundMessage !== "function") {
        sendAsyncMessage("STGMirrorBridge:Response", {
          reqId,
          ok: false,
          error: "STG background is not initialized yet"
        });
        return;
      }

      const payloadJson = JSON.stringify({ action, args: args || [] });
      const evalPromise = win.eval(\`
        (async function() {
          const req = \${payloadJson};
          const res = await self.onBackgroundMessage(req, self);
          return JSON.stringify(res === undefined ? null : res);
        })()
      \`);

      Promise.resolve(evalPromise).then(
        jsonStr => {
          let parsed = null;
          try {
            parsed = jsonStr ? JSON.parse(jsonStr) : null;
          } catch (_) {}
          sendAsyncMessage("STGMirrorBridge:Response", {
            reqId,
            ok: true,
            result: parsed
          });
        },
        err => {
          sendAsyncMessage("STGMirrorBridge:Response", {
            reqId,
            ok: false,
            error: String(err && err.message ? err.message : err)
          });
        }
      );
    } catch (outerErr) {
      sendAsyncMessage("STGMirrorBridge:Response", {
        reqId,
        ok: false,
        error: String(outerErr && outerErr.message ? outerErr.message : outerErr)
      });
    }
  });
})();
`;

let reqCounter = 1;

function callStgInternal(action, args = [], timeoutMs = 8000) {
  const xulBrowser = getStgXulBrowser();
  if (!xulBrowser) {
    return Promise.resolve({ ok: false, error: "STG background browser not found" });
  }

  const mm = xulBrowser.messageManager;
  if (!xulBrowser.__stgMirrorFrameScriptLoaded) {
    const dataUri =
      "data:application/javascript;charset=utf-8," + encodeURIComponent(FRAME_SCRIPT_CODE);
    mm.loadFrameScript(dataUri, false);
    xulBrowser.__stgMirrorFrameScriptLoaded = true;
  }

  const reqId = `req_${Date.now()}_${reqCounter++}`;

  return new Promise(resolve => {
    let timer = null;
    const listener = {
      receiveMessage(message) {
        if (!message.data || message.data.reqId !== reqId) {
          return;
        }
        mm.removeMessageListener("STGMirrorBridge:Response", listener);
        if (timer) {
          clearTimeout(timer);
        }
        resolve(message.data);
      }
    };

    timer = setTimeout(() => {
      mm.removeMessageListener("STGMirrorBridge:Response", listener);
      resolve({ ok: false, error: "STG bridge call timed out" });
    }, timeoutMs);

    mm.addMessageListener("STGMirrorBridge:Response", listener);
    mm.sendAsyncMessage("STGMirrorBridge:Request", { reqId, action, args });
  });
}

function readSessionInt(rawVal) {
  if (!rawVal) {
    return null;
  }
  try {
    const parsed = JSON.parse(rawVal);
    const num = Number(parsed);
    return Number.isFinite(num) && num > 0 ? num : null;
  } catch (_) {
    const num = Number(rawVal);
    return Number.isFinite(num) && num > 0 ? num : null;
  }
}

this.fxSyncBridge = class extends ExtensionAPI {
  getAPI(context) {
    ensureSyncPrefs();

    return {
      fxSyncBridge: {
        async getSyncAccountInfo() {
          ensureSyncPrefs();
          let username = "";
          let clientName = "";
          let clientGuid = "";
          let lastSync = "";
          let engineForce = true;

          try {
            username = Services.prefs.getStringPref("services.sync.username", "");
          } catch (_) {}
          try {
            clientName = Services.prefs.getStringPref("services.sync.client.name", "");
          } catch (_) {}
          try {
            clientGuid = Services.prefs.getStringPref("services.sync.client.GUID", "");
          } catch (_) {}
          try {
            lastSync = Services.prefs.getStringPref("services.sync.lastSync", "");
          } catch (_) {}
          try {
            engineForce = Services.prefs.getBoolPref(
              "services.sync.engine.extension-storage.force",
              false
            );
          } catch (_) {}

          return {
            enabled: Boolean(username),
            username,
            clientName,
            clientGuid,
            lastSync,
            engineEnabled: engineForce
          };
        },

        async triggerFirefoxSync() {
          ensureSyncPrefs();
          try {
            const { Weave } = ChromeUtils.importESModule(
              "resource://services-sync/main.sys.mjs"
            );
            if (!Weave || !Weave.Service) {
              return { ok: false, error: "Weave.Service unavailable" };
            }
            if (Weave.Service._locked) {
              Weave.Service.queueSync("user");
              return { ok: true, queued: true };
            }
            await Weave.Service.sync({
              engines: ["extension-storage"],
              why: "user"
            });
            return { ok: true, queued: false, timestamp: Date.now() };
          } catch (err) {
            return {
              ok: false,
              error: String(err && err.message ? err.message : err)
            };
          }
        },

        async getStgState() {
          // 1. Query STG groups (with tabs) via STG internal bridge
          let groups = [];
          let stgAvailable = false;
          const tabGroupsMap = {};
          const windowGroupsMap = {};

          const loadRes = await callStgInternal("Groups.load", [null, true]);
          if (loadRes && loadRes.ok && loadRes.result && Array.isArray(loadRes.result.groups)) {
            stgAvailable = true;
            for (const g of loadRes.result.groups) {
              if (!g || g.isArchive) {
                continue;
              }
              groups.push({
                id: g.id,
                title: g.title || `Group ${g.id}`,
                newTabContainer: g.newTabContainer || "firefox-default",
                iconColor: g.iconColor || null
              });
              if (Array.isArray(g.tabs)) {
                for (const t of g.tabs) {
                  if (t && t.id !== undefined) {
                    tabGroupsMap[t.id] = g.id;
                  }
                }
              }
            }
          }

          // 2. Supplement tabId -> stgGroupId and windowId -> stgGroupId from SessionStore
          const winEnum = Services.wm.getEnumerator("navigator:browser");
          while (winEnum.hasMoreElements()) {
            const win = winEnum.getNext();
            if (!win || win.closed || !win.gBrowser) {
              continue;
            }
            const extWin = context.extension.windowManager.getWrapper(win);
            const winId = extWin ? extWin.id : null;
            if (winId !== null) {
              const rawWinGroup = SessionStore.getWindowValue(win, STG_SESSION_KEY);
              const parsedWinGroup = readSessionInt(rawWinGroup);
              if (parsedWinGroup) {
                windowGroupsMap[winId] = parsedWinGroup;
              }
            }

            for (const nativeTab of win.gBrowser.tabs) {
              const tabId = context.extension.tabManager.getWrapper(nativeTab)?.id;
              if (tabId !== undefined && !tabGroupsMap[tabId]) {
                const rawTabGroup = SessionStore.getTabValue(nativeTab, STG_SESSION_KEY);
                const parsedTabGroup = readSessionInt(rawTabGroup);
                if (parsedTabGroup) {
                  tabGroupsMap[tabId] = parsedTabGroup;
                }
              }
            }
          }

          return {
            stgAvailable,
            groups,
            tabGroupsMap,
            windowGroupsMap
          };
        },

        async ensureStgGroup(title) {
          const cleanTitle = String(title || "").trim();
          if (!cleanTitle) {
            return { ok: false, error: "Empty group title" };
          }

          const loadRes = await callStgInternal("Groups.load", [null, false]);
          if (loadRes && loadRes.ok && loadRes.result && Array.isArray(loadRes.result.groups)) {
            const existing =
              loadRes.result.groups.find(g => !g.isArchive && g.title === cleanTitle) ||
              loadRes.result.groups.find(
                g => !g.isArchive && String(g.title || "").trim().toLowerCase() === cleanTitle.toLowerCase()
              );
            if (existing) {
              return {
                ok: true,
                created: false,
                group: {
                  id: existing.id,
                  title: existing.title,
                  newTabContainer: existing.newTabContainer || "firefox-default"
                }
              };
            }
          }

          // Create group in background (windowId = null so current window does NOT switch groups!)
          const addRes = await callStgInternal("Groups.add", [null, [], cleanTitle]);
          if (addRes && addRes.ok && addRes.result) {
            return {
              ok: true,
              created: true,
              group: {
                id: addRes.result.id,
                title: addRes.result.title || cleanTitle,
                newTabContainer: addRes.result.newTabContainer || "firefox-default"
              }
            };
          }

          return {
            ok: false,
            error: addRes?.error || "Failed to ensure STG group"
          };
        },

        async createMirroredTabInStg(spec) {
          const { url, title, stgGroupId, cookieStoreId } = spec || {};
          if (stgGroupId && Number.isFinite(Number(stgGroupId))) {
            const res = await callStgInternal("Tabs.add", [
              Number(stgGroupId),
              cookieStoreId || "firefox-default",
              url || "about:blank",
              title || url || ""
            ]);
            if (res && res.ok && res.result && res.result.id) {
              return {
                ok: true,
                tabId: res.result.id,
                groupId: Number(stgGroupId),
                hidden: Boolean(res.result.hidden)
              };
            }
          }
          return {
            ok: false,
            error: "STG Tabs.add failed or no stgGroupId provided"
          };
        },

        async moveMirroredTabToStgGroup(tabId, groupId) {
          if (!tabId || !groupId) {
            return { ok: false, error: "tabId and groupId are required" };
          }
          const loadRes = await callStgInternal("Groups.load", [Number(groupId), false]);
          const groupObj = loadRes?.result?.group || { id: Number(groupId) };
          const quietGroupProps = {
            ...groupObj,
            id: Number(groupId),
            showNotificationAfterMovingTabIntoThisGroup: false,
            showTabAfterMovingItIntoThisGroup: false,
            showOnlyActiveTabAfterMovingItIntoThisGroup: false
          };

          const moveRes = await callStgInternal("Tabs.move", [
            [Number(tabId)],
            Number(groupId),
            quietGroupProps,
            false
          ]);
          return {
            ok: Boolean(moveRes && moveRes.ok),
            error: moveRes?.error || null
          };
        },

        async removeMirroredTab(tabId) {
          if (!tabId) {
            return { ok: false };
          }
          const res = await callStgInternal("Tabs.remove", [[Number(tabId)]]);
          return {
            ok: Boolean(res && res.ok)
          };
        }
      }
    };
  }
};
