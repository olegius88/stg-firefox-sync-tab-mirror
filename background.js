"use strict";

const DEFAULT_SETTINGS = {
  mirrorEnabled: true,
  syncCloseTabs: true,
  syncUrlChanges: true,
  syncMoveGroups: true,
  syncPinnedTabs: true,
  pollIntervalSec: 8
};

const SESSION_SYNC_ID_KEY = "mirror_sync_tab_id_v1";
const META_KEY = "mirror_meta_v1";
const CHUNK_PREFIX = "mirror_chunk_v1_";
const MAX_CHUNK_BYTES = 5800; // Safe margin below 8192 bytes per item in storage.sync
const MAX_TOMBSTONES = 120;
const TOMBSTONE_TTL_MS = 24 * 60 * 60 * 1000;

let currentSettings = { ...DEFAULT_SETTINGS };
let deviceId = "";
let deviceName = "";
let syncAccountInfo = { enabled: false, username: "", clientName: "" };

// Local maps: tabId <-> syncTabId
const tabIdToSyncId = new Map();
const syncIdToTabId = new Map();
const localTabTimestamps = new Map(); // syncTabId -> updatedAt (ms)
const knownTabSnapshot = new Map(); // tabId -> { syncTabId, url, stgGroupTitle }
const pendingTombstones = new Map(); // syncTabId -> { ts, by, u, g }

// Guards to prevent echo loops
const suppressedTabIds = new Set();
let isReconciling = false;
let isPushing = false;
let pendingPushTimer = null;
let pendingWeaveSyncTimer = null;
let pollIntervalHandle = null;

// Stats for Popup UI
let syncStats = {
  lastPushTime: 0,
  lastPullTime: 0,
  lastWeaveSyncTime: 0,
  totalSyncedTabs: 0,
  totalStgGroups: 0,
  lastActionText: "Инициализация...",
  lastError: null
};

function generateSyncId() {
  return "t_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
}

function normalizeUrl(url) {
  if (!url || typeof url !== "string") {
    return "";
  }
  return url.trim();
}

function isSyncableUrl(url) {
  if (!url || typeof url !== "string") {
    return false;
  }
  if (
    url === "about:blank" ||
    url.startsWith("about:debugging") ||
    url.startsWith("about:devtools") ||
    url.startsWith("about:addons") ||
    url.startsWith("about:config") ||
    url.startsWith("moz-extension://")
  ) {
    return false;
  }
  return true;
}

async function getOrAssignSyncId(tabId) {
  if (tabIdToSyncId.has(tabId)) {
    return tabIdToSyncId.get(tabId);
  }
  try {
    const saved = await browser.sessions.getTabValue(tabId, SESSION_SYNC_ID_KEY);
    if (saved && typeof saved === "string") {
      tabIdToSyncId.set(tabId, saved);
      syncIdToTabId.set(saved, tabId);
      return saved;
    }
  } catch (_) {}

  const freshId = generateSyncId();
  await setTabSyncId(tabId, freshId);
  return freshId;
}

async function setTabSyncId(tabId, syncId) {
  const oldSyncId = tabIdToSyncId.get(tabId);
  if (oldSyncId && oldSyncId !== syncId) {
    syncIdToTabId.delete(oldSyncId);
  }
  tabIdToSyncId.set(tabId, syncId);
  syncIdToTabId.set(syncId, tabId);
  try {
    await browser.sessions.setTabValue(tabId, SESSION_SYNC_ID_KEY, syncId);
  } catch (_) {}
}

async function updateBadge() {
  if (!currentSettings.mirrorEnabled) {
    await browser.browserAction.setBadgeText({ text: "OFF" });
    await browser.browserAction.setBadgeBackgroundColor({ color: "#64748b" });
  } else if (syncStats.lastError) {
    await browser.browserAction.setBadgeText({ text: "!" });
    await browser.browserAction.setBadgeBackgroundColor({ color: "#ef4444" });
  } else {
    await browser.browserAction.setBadgeText({ text: "ON" });
    await browser.browserAction.setBadgeBackgroundColor({ color: "#10b981" });
  }
}

async function collectLocalState() {
  const [tabs, stgState, nativeGroups] = await Promise.all([
    browser.tabs.query({ windowType: "normal" }),
    browser.fxSyncBridge
      ? browser.fxSyncBridge.getStgState().catch(() => ({
          stgAvailable: false,
          groups: [],
          tabGroupsMap: {},
          windowGroupsMap: {}
        }))
      : Promise.resolve({
          stgAvailable: false,
          groups: [],
          tabGroupsMap: {},
          windowGroupsMap: {}
        }),
    browser.tabGroups ? browser.tabGroups.query({}).catch(() => []) : Promise.resolve([])
  ]);

  const stgGroupById = new Map();
  for (const g of stgState.groups || []) {
    stgGroupById.set(Number(g.id), g);
  }

  const nativeGroupById = new Map();
  for (const ng of nativeGroups || []) {
    nativeGroupById.set(ng.id, ng);
  }

  syncStats.totalStgGroups = stgGroupById.size;

  // Sort tabs by windowId and index so relative order inside each STG group ("справа") is preserved
  const sortedTabs = tabs.slice().sort((a, b) => a.windowId - b.windowId || a.index - b.index);
  const groupCounters = new Map(); // stgGroupTitle -> count

  const localRecords = [];
  for (const tab of sortedTabs) {
    if (tab.incognito) {
      continue;
    }
    if (tab.pinned && !currentSettings.syncPinnedTabs) {
      continue;
    }
    const url = normalizeUrl(tab.url);
    if (!isSyncableUrl(url)) {
      continue;
    }

    const syncId = await getOrAssignSyncId(tab.id);
    const stgGroupId =
      stgState.tabGroupsMap[tab.id] ||
      (!tab.hidden ? stgState.windowGroupsMap[tab.windowId] : null) ||
      null;
    const stgGroupObj = stgGroupId ? stgGroupById.get(Number(stgGroupId)) : null;
    const stgGroupTitle = stgGroupObj ? String(stgGroupObj.title || "").trim() : "";

    const idxInGroup = groupCounters.get(stgGroupTitle) || 0;
    groupCounters.set(stgGroupTitle, idxInGroup + 1);

    let nativeGroupTitle = "";
    let nativeGroupColor = "";
    const TAB_GROUP_ID_NONE = browser.tabGroups ? (browser.tabGroups.TAB_GROUP_ID_NONE ?? -1) : -1;
    if (tab.groupId !== undefined && tab.groupId !== TAB_GROUP_ID_NONE) {
      const ng = nativeGroupById.get(tab.groupId);
      if (ng) {
        nativeGroupTitle = String(ng.title || "").trim();
        nativeGroupColor = ng.color || "blue";
      }
    }

    const prevSnap = knownTabSnapshot.get(tab.id);
    let ts = localTabTimestamps.get(syncId) || Date.now();
    if (
      !prevSnap ||
      prevSnap.url !== url ||
      prevSnap.stgGroupTitle !== stgGroupTitle ||
      prevSnap.nativeGroupTitle !== nativeGroupTitle ||
      prevSnap.indexInGroup !== idxInGroup
    ) {
      ts = Date.now();
      localTabTimestamps.set(syncId, ts);
    }

    knownTabSnapshot.set(tab.id, {
      syncTabId: syncId,
      url,
      title: String(tab.title || "").slice(0, 80),
      stgGroupTitle,
      nativeGroupTitle,
      indexInGroup: idxInGroup
    });

    localRecords.push({
      id: syncId,
      u: url.slice(0, 600),
      t: String(tab.title || url || "").slice(0, 80),
      g: stgGroupTitle.slice(0, 80),
      i: idxInGroup,
      p: tab.pinned ? 1 : 0,
      ng: nativeGroupTitle.slice(0, 60),
      nc: nativeGroupColor,
      ts,
      by: deviceId,
      localTabId: tab.id,
      localWindowId: tab.windowId,
      localHidden: Boolean(tab.hidden),
      localActive: Boolean(tab.active)
    });
  }

  return {
    localRecords,
    stgState,
    nativeGroupById,
    allTabs: sortedTabs
  };
}

async function readCloudState() {
  const allSync = await browser.storage.sync.get(null);
  const meta = allSync[META_KEY];
  if (!meta || typeof meta !== "object") {
    return {
      meta: null,
      records: [],
      tombstones: {}
    };
  }

  const records = [];
  const chunkCount = Number(meta.chunkCount) || 0;
  for (let i = 0; i < chunkCount; i++) {
    const chunk = allSync[`${CHUNK_PREFIX}${i}`];
    if (Array.isArray(chunk)) {
      for (const item of chunk) {
        if (item && item.id && item.u) {
          records.push(item);
        }
      }
    }
  }

  return {
    meta,
    records,
    tombstones: meta.tombstones && typeof meta.tombstones === "object" ? meta.tombstones : {}
  };
}

async function writeCloudState(records, tombstonesObj) {
  // Prune old tombstones
  const now = Date.now();
  const entries = Object.entries(tombstonesObj || {})
    .filter(([, val]) => val && now - (val.ts || 0) < TOMBSTONE_TTL_MS)
    .sort((a, b) => (b[1].ts || 0) - (a[1].ts || 0))
    .slice(0, MAX_TOMBSTONES);

  const cleanTombstones = Object.fromEntries(entries);

  // Split records into chunks under MAX_CHUNK_BYTES
  const chunks = [];
  let currentChunk = [];
  let currentBytes = 2;

  for (const r of records) {
    const wireRecord = {
      id: r.id,
      u: r.u,
      t: r.t,
      g: r.g,
      i: r.i,
      p: r.p ? 1 : 0,
      ng: r.ng || "",
      nc: r.nc || "",
      ts: r.ts || now,
      by: r.by || deviceId
    };
    const serialized = JSON.stringify(wireRecord);
    const byteLen = new TextEncoder().encode(serialized).length + 2;

    if (currentChunk.length > 0 && currentBytes + byteLen > MAX_CHUNK_BYTES) {
      chunks.push(currentChunk);
      currentChunk = [];
      currentBytes = 2;
    }
    currentChunk.push(wireRecord);
    currentBytes += byteLen;
  }
  if (currentChunk.length > 0) {
    chunks.push(currentChunk);
  }

  const existingSync = await browser.storage.sync.get(META_KEY);
  const oldChunkCount = Number(existingSync[META_KEY]?.chunkCount) || 0;

  const payload = {
    [META_KEY]: {
      version: 1,
      updatedAt: now,
      updatedBy: deviceId,
      updatedByName: deviceName,
      chunkCount: chunks.length,
      totalTabs: records.length,
      tombstones: cleanTombstones
    }
  };

  for (let i = 0; i < chunks.length; i++) {
    payload[`${CHUNK_PREFIX}${i}`] = chunks[i];
  }

  await browser.storage.sync.set(payload);

  // Clean up any leftover old chunks
  if (oldChunkCount > chunks.length) {
    const keysToRemove = [];
    for (let i = chunks.length; i < oldChunkCount; i++) {
      keysToRemove.push(`${CHUNK_PREFIX}${i}`);
    }
    if (keysToRemove.length > 0) {
      await browser.storage.sync.remove(keysToRemove).catch(() => {});
    }
  }

  syncStats.lastPushTime = now;
  syncStats.totalSyncedTabs = records.length;
  scheduleWeaveSync();
}

function scheduleWeaveSync(delayMs = 1200) {
  if (!currentSettings.mirrorEnabled || !browser.fxSyncBridge) {
    return;
  }
  if (pendingWeaveSyncTimer) {
    clearTimeout(pendingWeaveSyncTimer);
  }
  pendingWeaveSyncTimer = setTimeout(async () => {
    pendingWeaveSyncTimer = null;
    try {
      const res = await browser.fxSyncBridge.triggerFirefoxSync();
      if (res && res.ok) {
        syncStats.lastWeaveSyncTime = Date.now();
      }
    } catch (e) {
      console.warn("[STG Mirror Sync] triggerFirefoxSync warning:", e);
    }
  }, delayMs);
}

let lastPushedFingerprint = "";

function computeStateFingerprint(records, tombstonesObj) {
  const recPart = records
    .map(r => `${r.id}|${r.u}|${r.g}|${r.i}|${r.p ? 1 : 0}|${r.ng || ""}|${r.nc || ""}`)
    .join(";;");
  const tombPart = Object.keys(tombstonesObj || {})
    .sort()
    .map(k => `${k}:${tombstonesObj[k]?.ts || 0}`)
    .join(",");
  return `${recPart}###${tombPart}`;
}

function schedulePushLocalChanges(reason = "Изменение вкладок", delayMs = 450, force = false) {
  if (!currentSettings.mirrorEnabled || isReconciling) {
    return;
  }
  if (pendingPushTimer) {
    clearTimeout(pendingPushTimer);
  }
  pendingPushTimer = setTimeout(() => {
    pendingPushTimer = null;
    pushLocalChangesToCloud(reason, force);
  }, delayMs);
}

async function pushLocalChangesToCloud(reason = "Синхронизация", force = false) {
  if (!currentSettings.mirrorEnabled || isReconciling || isPushing) {
    return;
  }
  isPushing = true;
  try {
    const [{ localRecords }, cloud] = await Promise.all([
      collectLocalState(),
      readCloudState()
    ]);

    const mergedTombstones = { ...(cloud.tombstones || {}) };
    let addedNewTombstone = false;
    for (const [syncId, tomb] of pendingTombstones.entries()) {
      mergedTombstones[syncId] = tomb;
      addedNewTombstone = true;
    }
    pendingTombstones.clear();

    // Remove any tombstone if the tab is currently alive locally with a newer timestamp
    for (const rec of localRecords) {
      const tomb = mergedTombstones[rec.id];
      if (tomb && rec.ts > tomb.ts) {
        delete mergedTombstones[rec.id];
      }
    }

    const fingerprint = computeStateFingerprint(localRecords, mergedTombstones);
    if (!force && !addedNewTombstone && fingerprint === lastPushedFingerprint && cloud.meta) {
      return;
    }

    await writeCloudState(localRecords, mergedTombstones);
    lastPushedFingerprint = fingerprint;
    syncStats.lastActionText = `Отправлено (${localRecords.length} вкл.): ${reason}`;
    syncStats.lastError = null;
    await updateBadge();
  } catch (err) {
    console.error("[STG Mirror Sync] pushLocalChangesToCloud error:", err);
    syncStats.lastError = String(err && err.message ? err.message : err);
    await updateBadge();
  } finally {
    isPushing = false;
  }
}

async function ensureNativeTabGroupOnTab(tabId, windowId, nativeGroupTitle, nativeGroupColor) {
  if (!browser.tabGroups) {
    return;
  }
  const cleanTitle = String(nativeGroupTitle || "").trim();
  const TAB_GROUP_ID_NONE = browser.tabGroups.TAB_GROUP_ID_NONE ?? -1;

  try {
    const tab = await browser.tabs.get(tabId);
    const currentGroupId = tab.groupId !== undefined ? tab.groupId : TAB_GROUP_ID_NONE;

    if (!cleanTitle) {
      if (currentGroupId !== TAB_GROUP_ID_NONE) {
        suppressedTabIds.add(tabId);
        try {
          await browser.tabs.ungroup([tabId]);
        } finally {
          setTimeout(() => suppressedTabIds.delete(tabId), 400);
        }
      }
      return;
    }

    // Check if already in a native group with this title
    if (currentGroupId !== TAB_GROUP_ID_NONE) {
      try {
        const curNg = await browser.tabGroups.get(currentGroupId);
        if (curNg && String(curNg.title || "").trim() === cleanTitle) {
          return;
        }
      } catch (_) {}
    }

    // Look for an existing native group in the same window with this title
    const groupsInWin = await browser.tabGroups.query({ windowId: tab.windowId });
    const matchNg = groupsInWin.find(
      g => String(g.title || "").trim().toLowerCase() === cleanTitle.toLowerCase()
    );

    suppressedTabIds.add(tabId);
    try {
      if (matchNg) {
        await browser.tabs.group({ groupId: matchNg.id, tabIds: [tabId] });
      } else {
        const newNgId = await browser.tabs.group({
          createProperties: { windowId: tab.windowId },
          tabIds: [tabId]
        });
        await browser.tabGroups.update(newNgId, {
          title: cleanTitle,
          color: nativeGroupColor || "blue"
        });
      }
    } finally {
      setTimeout(() => suppressedTabIds.delete(tabId), 400);
    }
  } catch (e) {
    console.warn("[STG Mirror Sync] ensureNativeTabGroupOnTab warning:", e);
  }
}

async function reconcileFromCloud(allowPushMerged = false) {
  if (!currentSettings.mirrorEnabled || isReconciling) {
    return;
  }
  isReconciling = true;

  try {
    const [cloud, local] = await Promise.all([
      readCloudState(),
      collectLocalState()
    ]);

    if (!cloud.meta) {
      // Nothing in cloud yet — push our initial state if requested
      if (allowPushMerged && local.localRecords.length > 0) {
        isReconciling = false;
        await pushLocalChangesToCloud("Начальная выгрузка вкладок");
        return;
      }
      return;
    }

    const { localRecords, stgState } = local;
    const localBySyncId = new Map();
    const unlinkedLocalByGroupAndUrl = new Map();

    for (const r of localRecords) {
      localBySyncId.set(r.id, r);
      const key = `${r.g.toLowerCase()}|||${r.u}`;
      if (!unlinkedLocalByGroupAndUrl.has(key)) {
        unlinkedLocalByGroupAndUrl.set(key, []);
      }
      unlinkedLocalByGroupAndUrl.get(key).push(r);
    }

    let changesApplied = 0;

    // 1. Handle remote tombstones (closed tabs on another mirrored browser)
    if (currentSettings.syncCloseTabs && cloud.tombstones) {
      for (const [syncId, tomb] of Object.entries(cloud.tombstones)) {
        if (!tomb || tomb.by === deviceId) {
          continue;
        }
        const loc = localBySyncId.get(syncId);
        if (loc && (loc.ts || 0) <= (tomb.ts || 0)) {
          suppressedTabIds.add(loc.localTabId);
          try {
            if (browser.fxSyncBridge) {
              const remRes = await browser.fxSyncBridge.removeMirroredTab(loc.localTabId);
              if (!remRes || !remRes.ok) {
                await browser.tabs.remove(loc.localTabId).catch(() => {});
              }
            } else {
              await browser.tabs.remove(loc.localTabId).catch(() => {});
            }
            localBySyncId.delete(syncId);
            tabIdToSyncId.delete(loc.localTabId);
            syncIdToTabId.delete(syncId);
            knownTabSnapshot.delete(loc.localTabId);
            changesApplied++;
          } finally {
            setTimeout(() => suppressedTabIds.delete(loc.localTabId), 500);
          }
        }
      }
    }

    // 2. Sort remote records by (groupTitle, indexInGroup) so new tabs in a group are added in left-to-right order ("справа")
    const sortedRemote = cloud.records
      .slice()
      .sort((a, b) => String(a.g || "").localeCompare(String(b.g || "")) || (a.i || 0) - (b.i || 0));

    const remoteSyncIds = new Set();

    for (const rem of sortedRemote) {
      if (!rem || !rem.id || !isSyncableUrl(rem.u)) {
        continue;
      }
      const tomb = cloud.tombstones?.[rem.id];
      if (tomb && (tomb.ts || 0) >= (rem.ts || 0)) {
        continue;
      }

      remoteSyncIds.add(rem.id);

      let loc = localBySyncId.get(rem.id);

      // Smart deduplication: if we don't have rem.id yet, check if we already have an identical (group, url) tab locally
      if (!loc) {
        const matchKey = `${String(rem.g || "").trim().toLowerCase()}|||${normalizeUrl(rem.u)}`;
        const candidates = unlinkedLocalByGroupAndUrl.get(matchKey);
        if (candidates && candidates.length > 0) {
          const matchedCandidate = candidates.shift();
          await setTabSyncId(matchedCandidate.localTabId, rem.id);
          localTabTimestamps.set(rem.id, Math.max(matchedCandidate.ts || 0, rem.ts || 0));
          localBySyncId.set(rem.id, matchedCandidate);
          loc = matchedCandidate;
        }
      }

      if (!loc) {
        // NEW TAB FROM ANOTHER BROWSER -> Create strictly in background (inactive, and hidden if in another STG group!)
        let createdTabId = null;
        let targetStgGroupId = null;

        const targetGroupTitle = String(rem.g || "").trim();
        if (targetGroupTitle && !rem.p && browser.fxSyncBridge) {
          const ens = await browser.fxSyncBridge.ensureStgGroup(targetGroupTitle);
          if (ens && ens.ok && ens.group && ens.group.id) {
            targetStgGroupId = Number(ens.group.id);
            const createRes = await browser.fxSyncBridge.createMirroredTabInStg({
              url: rem.u,
              title: rem.t || rem.u,
              stgGroupId: targetStgGroupId,
              cookieStoreId: ens.group.newTabContainer || "firefox-default",
              indexInGroup: rem.i
            });

            if (createRes && createRes.ok && createRes.tabId) {
              createdTabId = createRes.tabId;
              suppressedTabIds.add(createdTabId);
            }
          }
        }

        // Fallback if STG wasn't used or tab is pinned
        if (!createdTabId) {
          const wins = await browser.windows.getAll({ windowTypes: ["normal"] });
          const targetWinId = wins[0]?.id;
          const newTab = await browser.tabs.create({
            url: rem.u,
            active: false,
            pinned: Boolean(rem.p),
            windowId: targetWinId
          });
          createdTabId = newTab.id;
          suppressedTabIds.add(createdTabId);

          if (targetStgGroupId && browser.fxSyncBridge) {
            await browser.fxSyncBridge.moveMirroredTabToStgGroup(createdTabId, targetStgGroupId);
          } else if (targetGroupTitle && !rem.p) {
            // Check if current window is on a different STG group; if so, hide the tab
            const activeWinGroupId = stgState.windowGroupsMap[newTab.windowId];
            if (targetStgGroupId && activeWinGroupId && Number(activeWinGroupId) !== Number(targetStgGroupId)) {
              await browser.tabs.hide([createdTabId]).catch(() => {});
            }
          }
        }

        if (createdTabId) {
          await setTabSyncId(createdTabId, rem.id);
          localTabTimestamps.set(rem.id, rem.ts || Date.now());
          knownTabSnapshot.set(createdTabId, {
            syncTabId: rem.id,
            url: normalizeUrl(rem.u),
            title: rem.t || "",
            stgGroupTitle: targetGroupTitle,
            nativeGroupTitle: rem.ng || "",
            indexInGroup: rem.i || 0
          });

          if (rem.ng) {
            await ensureNativeTabGroupOnTab(createdTabId, null, rem.ng, rem.nc);
          }

          setTimeout(() => suppressedTabIds.delete(createdTabId), 800);
          changesApplied++;
        }
      } else {
        // EXISTING MIRRORED TAB -> Check if remote record is newer
        const remTs = Number(rem.ts) || 0;
        const locTs = Number(loc.ts) || 0;

        if (rem.by !== deviceId && remTs > locTs) {
          const targetGroupTitle = String(rem.g || "").trim();

          // 2a. Check URL update
          if (
            currentSettings.syncUrlChanges &&
            normalizeUrl(rem.u) !== normalizeUrl(loc.u) &&
            !loc.localActive
          ) {
            suppressedTabIds.add(loc.localTabId);
            try {
              await browser.tabs.update(loc.localTabId, { url: rem.u });
              changesApplied++;
            } catch (_) {
            } finally {
              setTimeout(() => suppressedTabIds.delete(loc.localTabId), 600);
            }
          }

          // 2b. Check STG group move
          if (
            currentSettings.syncMoveGroups &&
            targetGroupTitle &&
            targetGroupTitle.toLowerCase() !== String(loc.g || "").trim().toLowerCase() &&
            browser.fxSyncBridge
          ) {
            const ens = await browser.fxSyncBridge.ensureStgGroup(targetGroupTitle);
            if (ens && ens.ok && ens.group && ens.group.id) {
              suppressedTabIds.add(loc.localTabId);
              try {
                await browser.fxSyncBridge.moveMirroredTabToStgGroup(
                  loc.localTabId,
                  Number(ens.group.id)
                );
                changesApplied++;
              } finally {
                setTimeout(() => suppressedTabIds.delete(loc.localTabId), 600);
              }
            }
          }

          // 2c. Check Native Firefox Tab Group move
          if (currentSettings.syncMoveGroups && String(rem.ng || "") !== String(loc.ng || "")) {
            await ensureNativeTabGroupOnTab(loc.localTabId, loc.localWindowId, rem.ng, rem.nc);
            changesApplied++;
          }

          localTabTimestamps.set(rem.id, remTs);
        }
      }
    }

    syncStats.lastPullTime = Date.now();
    syncStats.totalSyncedTabs = Math.max(cloud.records.length, localRecords.length);
    if (changesApplied > 0) {
      syncStats.lastActionText = `Принято изменений из Firefox Sync: ${changesApplied}`;
    } else {
      syncStats.lastActionText = `Зеркало актуально (${syncStats.totalSyncedTabs} вкл.)`;
    }
    syncStats.lastError = null;
    await updateBadge();

    // If allowPushMerged is true (e.g. initial startup or enabling mirror mode) and we have local tabs not in remoteSyncIds, push merged state
    if (allowPushMerged) {
      const hasUnpushedLocal = localRecords.some(r => !remoteSyncIds.has(r.id));
      if (hasUnpushedLocal || changesApplied > 0) {
        setTimeout(() => pushLocalChangesToCloud("Слияние при старте"), 600);
      }
    }
  } catch (err) {
    console.error("[STG Mirror Sync] reconcileFromCloud error:", err);
    syncStats.lastError = String(err && err.message ? err.message : err);
    await updateBadge();
  } finally {
    isReconciling = false;
  }
}

function restartBackgroundPollTimer() {
  if (pollIntervalHandle) {
    clearInterval(pollIntervalHandle);
    pollIntervalHandle = null;
  }
  if (!currentSettings.mirrorEnabled) {
    return;
  }
  const sec = Math.max(4, Number(currentSettings.pollIntervalSec) || 8);
  pollIntervalHandle = setInterval(async () => {
    if (!currentSettings.mirrorEnabled || isReconciling || isPushing) {
      return;
    }
    try {
      if (browser.fxSyncBridge) {
        const res = await browser.fxSyncBridge.triggerFirefoxSync();
        if (res && res.ok) {
          syncStats.lastWeaveSyncTime = Date.now();
        }
      }
      await reconcileFromCloud(false);
    } catch (e) {
      console.warn("[STG Mirror Sync] Background poll warning:", e);
    }
  }, sec * 1000);
}

// === Event Listeners ===

browser.tabs.onCreated.addListener(tab => {
  if (!currentSettings.mirrorEnabled || suppressedTabIds.has(tab.id) || tab.incognito) {
    return;
  }
  // Wait briefly for STG to assign its groupId and initial URL to settle
  setTimeout(() => {
    if (!suppressedTabIds.has(tab.id)) {
      schedulePushLocalChanges("Открыта новая вкладка", 500);
    }
  }, 350);
});

browser.tabs.onUpdated.addListener(
  (tabId, changeInfo, tab) => {
    if (!currentSettings.mirrorEnabled || suppressedTabIds.has(tabId) || tab.incognito) {
      return;
    }
    if (changeInfo.status === "complete" || changeInfo.url || "pinned" in changeInfo || "groupId" in changeInfo || "hidden" in changeInfo) {
      schedulePushLocalChanges("Обновлена вкладка", 500);
    }
  },
  { properties: ["status", "url", "pinned", "groupId", "hidden"] }
);

browser.tabs.onMoved.addListener((tabId, moveInfo) => {
  if (!currentSettings.mirrorEnabled || suppressedTabIds.has(tabId)) {
    return;
  }
  schedulePushLocalChanges("Перемещена вкладка", 600);
});

browser.tabs.onRemoved.addListener((tabId, removeInfo) => {
  // IMPORTANT: Ignore tab removals when an entire browser window is closing (e.g. exiting Firefox)
  // so shutting down PC 1 never wipes out tabs on PC 2!
  if (removeInfo && removeInfo.isWindowClosing) {
    return;
  }
  if (!currentSettings.mirrorEnabled || suppressedTabIds.has(tabId)) {
    return;
  }

  const syncId = tabIdToSyncId.get(tabId);
  const snap = knownTabSnapshot.get(tabId);
  tabIdToSyncId.delete(tabId);
  knownTabSnapshot.delete(tabId);

  if (syncId) {
    syncIdToTabId.delete(syncId);
    if (currentSettings.syncCloseTabs) {
      pendingTombstones.set(syncId, {
        ts: Date.now(),
        by: deviceId,
        u: snap?.url || "",
        g: snap?.stgGroupTitle || ""
      });
    }
  }

  schedulePushLocalChanges("Закрыта вкладка", 450);
});

if (browser.tabGroups) {
  browser.tabGroups.onUpdated.addListener(() => {
    if (currentSettings.mirrorEnabled && !isReconciling) {
      schedulePushLocalChanges("Обновлена нативная группа", 600);
    }
  });
}

browser.storage.onChanged.addListener((changes, area) => {
  if (area === "sync") {
    if (changes[META_KEY]) {
      const newMeta = changes[META_KEY].newValue;
      // If the change came from another device, reconcile immediately!
      if (newMeta && newMeta.updatedBy && newMeta.updatedBy !== deviceId) {
        reconcileFromCloud(false);
      }
    }
  }
});

browser.runtime.onMessage.addListener(msg => {
  if (!msg || !msg.action) {
    return undefined;
  }

  if (msg.action === "getStatus") {
    return (async () => {
      if (browser.fxSyncBridge) {
        syncAccountInfo = await browser.fxSyncBridge.getSyncAccountInfo().catch(() => syncAccountInfo);
      }
      await collectLocalState();
      return {
        settings: currentSettings,
        deviceId,
        deviceName,
        syncAccountInfo,
        stats: syncStats
      };
    })();
  }

  if (msg.action === "saveSettings") {
    return (async () => {
      const wasEnabled = currentSettings.mirrorEnabled;
      currentSettings = { ...DEFAULT_SETTINGS, ...(msg.settings || {}) };
      await browser.storage.local.set({ settings: currentSettings });
      await updateBadge();
      restartBackgroundPollTimer();

      if (currentSettings.mirrorEnabled && !wasEnabled) {
        if (browser.fxSyncBridge) {
          await browser.fxSyncBridge.triggerFirefoxSync().catch(() => {});
        }
        await reconcileFromCloud(true);
      }
      return {
        settings: currentSettings,
        stats: syncStats
      };
    })();
  }

  if (msg.action === "syncNow") {
    return (async () => {
      if (browser.fxSyncBridge) {
        const wRes = await browser.fxSyncBridge.triggerFirefoxSync();
        if (wRes && wRes.ok) {
          syncStats.lastWeaveSyncTime = Date.now();
        }
      }
      await reconcileFromCloud(true);
      return {
        settings: currentSettings,
        stats: syncStats
      };
    })();
  }

  if (msg.action === "forcePushAll") {
    return (async () => {
      await pushLocalChangesToCloud("Принудительная отправка всех вкладок", true);
      if (browser.fxSyncBridge) {
        await browser.fxSyncBridge.triggerFirefoxSync().catch(() => {});
      }
      return {
        settings: currentSettings,
        stats: syncStats
      };
    })();
  }

  if (msg.action === "forcePullAll") {
    return (async () => {
      if (browser.fxSyncBridge) {
        await browser.fxSyncBridge.triggerFirefoxSync().catch(() => {});
      }
      await reconcileFromCloud(false);
      return {
        settings: currentSettings,
        stats: syncStats
      };
    })();
  }

  return undefined;
});

(async function init() {
  try {
    const stored = await browser.storage.local.get(["settings", "deviceId", "deviceName"]);
    currentSettings = { ...DEFAULT_SETTINGS, ...(stored.settings || {}) };

    if (browser.fxSyncBridge) {
      syncAccountInfo = await browser.fxSyncBridge.getSyncAccountInfo().catch(() => syncAccountInfo);
    }

    deviceId =
      syncAccountInfo.clientGuid ||
      stored.deviceId ||
      "dev_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 7);
    deviceName = syncAccountInfo.clientName || stored.deviceName || "Firefox PC";

    await browser.storage.local.set({
      settings: currentSettings,
      deviceId,
      deviceName
    });

    await updateBadge();
    restartBackgroundPollTimer();

    // Give STG 1.5 seconds on browser startup to finish initializing its background cache, then run initial sync
    setTimeout(async () => {
      if (currentSettings.mirrorEnabled) {
        if (browser.fxSyncBridge) {
          await browser.fxSyncBridge.triggerFirefoxSync().catch(() => {});
        }
        await reconcileFromCloud(true);
      }
    }, 1500);
  } catch (err) {
    console.error("[STG Mirror Sync] init error:", err);
  }
})();
