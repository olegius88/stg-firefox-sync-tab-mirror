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
const SESSION_COHORT_GROUP_KEY = "mirror_cohort_group_v1";
const META_KEY = "mirror_meta_v1";
const CHUNK_PREFIX = "mirror_chunk_v1_";
const MAX_CHUNK_BYTES = 5800; // Safe margin below 8192 bytes per item in storage.sync
const MAX_TOMBSTONES = 120;
const TOMBSTONE_TTL_MS = 24 * 60 * 60 * 1000;

const GIT_BASE_KEY = "git_base_commit_v2";
const GIT_LOG_KEY = "git_commit_log_v2";
const GIT_CONFLICTS_KEY = "git_active_conflicts_v2";
const MAX_LOCAL_COMMITS = 25;

let currentSettings = { ...DEFAULT_SETTINGS };
let deviceId = "";
let deviceName = "";
let syncAccountInfo = { enabled: false, username: "", clientName: "" };

// Local maps: tabId <-> syncTabId
const tabIdToSyncId = new Map();
const syncIdToTabId = new Map();
const localTabTimestamps = new Map(); // syncTabId -> updatedAt (ms)
const knownTabSnapshot = new Map(); // tabId -> { syncTabId, url, stgGroupTitle, nativeGroupTitle, indexInGroup }
const tabCohortGroupCache = new Map(); // tabId -> groupTitle
const locallyClosedSinceBase = new Map(); // syncTabId -> { ts, by, u, g, t }

// Git state: BASE commit, commit history log, and active conflicts
let baseCommit = {
  commitId: "",
  parentId: "",
  timestamp: 0,
  recordsMap: {} // syncTabId -> wireRecord
};
let commitLog = []; // Array of { commitId, parentId, timestamp, authorId, authorName, message, stats: { added, modified, deleted, total }, records: [...] }
let activeConflicts = {}; // syncTabId -> { id, type, detectedAt, base, local, remote, remoteDeviceName }

// Guards to prevent echo loops
const suppressedTabIds = new Set();
let isSyncingGit = false;
let pendingGitSyncTimer = null;
let pendingWeaveSyncTimer = null;
let pollIntervalHandle = null;

// Stats for Popup UI
let syncStats = {
  headCommitId: "",
  parentCommitId: "",
  lastPushTime: 0,
  lastPullTime: 0,
  lastWeaveSyncTime: 0,
  totalSyncedTabs: 0,
  totalStgGroups: 0,
  conflictCount: 0,
  lastDiffStats: { added: 0, modified: 0, deleted: 0 },
  lastActionText: "Инициализация Git-движка...",
  lastError: null
};

function getFxBridge() {
  return globalThis.browser?.["fxSync" + "Bridge"] || null;
}

function generateSyncId() {
  return "t_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
}

function fnv1aHex(str) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function generateCommitId(records, parentId = "") {
  const payload =
    (parentId || "root") +
    "|" +
    Date.now().toString(36) +
    "|" +
    records.map(r => `${r.id}:${r.u}:${r.g}:${r.ng || ""}`).join(";");
  return "c_" + fnv1aHex(payload).slice(0, 7);
}

function shortCommitHash(commitId) {
  if (!commitId) {
    return "root";
  }
  return commitId.replace(/^c_/, "#");
}

function normalizeUrl(url) {
  if (!url || typeof url !== "string") {
    return "";
  }
  return url.trim();
}

function normalizeGroup(groupTitle) {
  return String(groupTitle || "").trim();
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

function toWireRecord(r, now = Date.now()) {
  return {
    id: r.id,
    u: String(r.u || "").slice(0, 600),
    t: String(r.t || r.u || "").slice(0, 80),
    g: String(r.g || "").slice(0, 80),
    i: Number(r.i) || 0,
    p: r.p ? 1 : 0,
    ng: String(r.ng || "").slice(0, 60),
    nc: String(r.nc || ""),
    ts: Number(r.ts) || now,
    by: r.by || deviceId
  };
}

function recordsMapFromArray(records) {
  const map = {};
  for (const r of records || []) {
    if (r && r.id) {
      map[r.id] = toWireRecord(r);
    }
  }
  return map;
}

async function saveGitLocalState() {
  syncStats.conflictCount = Object.keys(activeConflicts).length;
  syncStats.headCommitId = baseCommit.commitId || "";
  syncStats.parentCommitId = baseCommit.parentId || "";
  await browser.storage.local.set({
    [GIT_BASE_KEY]: baseCommit,
    [GIT_LOG_KEY]: commitLog.slice(0, MAX_LOCAL_COMMITS),
    [GIT_CONFLICTS_KEY]: activeConflicts
  });
}

async function appendCommitToLog(commitEntry) {
  // Avoid duplicate commitId at head
  if (commitLog.length > 0 && commitLog[0].commitId === commitEntry.commitId) {
    return;
  }
  commitLog.unshift(commitEntry);
  if (commitLog.length > MAX_LOCAL_COMMITS) {
    commitLog = commitLog.slice(0, MAX_LOCAL_COMMITS);
  }
  await saveGitLocalState();
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
  const conflictCount = Object.keys(activeConflicts).length;
  syncStats.conflictCount = conflictCount;

  if (!currentSettings.mirrorEnabled) {
    await browser.browserAction.setBadgeText({ text: "OFF" });
    await browser.browserAction.setBadgeBackgroundColor({ color: "#64748b" });
  } else if (conflictCount > 0) {
    await browser.browserAction.setBadgeText({ text: `⚡${conflictCount}` });
    await browser.browserAction.setBadgeBackgroundColor({ color: "#f59e0b" });
  } else if (syncStats.lastError) {
    await browser.browserAction.setBadgeText({ text: "!" });
    await browser.browserAction.setBadgeBackgroundColor({ color: "#ef4444" });
  } else {
    await browser.browserAction.setBadgeText({ text: "GIT" });
    await browser.browserAction.setBadgeBackgroundColor({ color: "#10b981" });
  }
}

async function inferFallbackStgState(tabs) {
  const tabGroupsMap = {};
  const windowGroupsMap = {};
  const groupTitlesSet = new Set();

  await Promise.all(
    tabs.map(async t => {
      if (tabCohortGroupCache.has(t.id)) {
        return;
      }
      try {
        const saved = await browser.sessions.getTabValue(t.id, SESSION_COHORT_GROUP_KEY);
        if (saved && typeof saved === "string") {
          tabCohortGroupCache.set(t.id, saved);
        }
      } catch (_) {}
    })
  );

  const tabsByWin = new Map();
  for (const t of tabs) {
    if (t.pinned) {
      continue;
    }
    if (!tabsByWin.has(t.windowId)) {
      tabsByWin.set(t.windowId, []);
    }
    tabsByWin.get(t.windowId).push(t);
  }

  for (const [winId, winTabs] of tabsByWin.entries()) {
    const visibleTabs = winTabs.filter(t => !t.hidden);
    let activeGroupName = "";
    for (const vt of visibleTabs) {
      const existing = tabCohortGroupCache.get(vt.id);
      if (existing) {
        activeGroupName = existing;
        break;
      }
    }
    if (!activeGroupName) {
      activeGroupName = `Group-W${winId}`;
    }

    for (const vt of visibleTabs) {
      tabCohortGroupCache.set(vt.id, activeGroupName);
      browser.sessions.setTabValue(vt.id, SESSION_COHORT_GROUP_KEY, activeGroupName).catch(() => {});
    }
    windowGroupsMap[winId] = activeGroupName;
  }

  for (const t of tabs) {
    const gName = tabCohortGroupCache.get(t.id);
    if (gName) {
      groupTitlesSet.add(gName);
      tabGroupsMap[t.id] = gName;
    }
  }

  const groups = Array.from(groupTitlesSet).map((title, idx) => ({
    id: title,
    title,
    newTabContainer: "firefox-default",
    index: idx
  }));

  return {
    stgAvailable: false,
    groups,
    tabGroupsMap,
    windowGroupsMap
  };
}

async function collectLocalState() {
  const [tabs, stgStateRaw, nativeGroups] = await Promise.all([
    browser.tabs.query({ windowType: "normal" }),
    getFxBridge()
      ? getFxBridge().getStgState().catch(() => null)
      : Promise.resolve(null),
    browser.tabGroups ? browser.tabGroups.query({}).catch(() => []) : Promise.resolve([])
  ]);

  const stgState =
    stgStateRaw && (stgStateRaw.stgAvailable || Object.keys(stgStateRaw.tabGroupsMap || {}).length > 0)
      ? stgStateRaw
      : await inferFallbackStgState(tabs);

  const stgGroupById = new Map();
  for (const g of stgState.groups || []) {
    stgGroupById.set(String(g.id), g);
  }

  const nativeGroupById = new Map();
  for (const ng of nativeGroups || []) {
    nativeGroupById.set(ng.id, ng);
  }

  syncStats.totalStgGroups = stgGroupById.size;

  const sortedTabs = tabs.slice().sort((a, b) => a.windowId - b.windowId || a.index - b.index);
  const groupCounters = new Map();

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
    const stgGroupObj = stgGroupId !== null ? stgGroupById.get(String(stgGroupId)) : null;
    const stgGroupTitle = stgGroupObj
      ? String(stgGroupObj.title || "").trim()
      : typeof stgGroupId === "string"
        ? stgGroupId
        : "";

    if (stgGroupTitle) {
      tabCohortGroupCache.set(tab.id, stgGroupTitle);
      browser.sessions.setTabValue(tab.id, SESSION_COHORT_GROUP_KEY, stgGroupTitle).catch(() => {});
    }

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

    // If tab is alive locally, ensure it's not in locallyClosedSinceBase
    locallyClosedSinceBase.delete(syncId);

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

async function writeCloudCommit(records, tombstonesObj, commitMeta = {}) {
  const now = Date.now();
  const entries = Object.entries(tombstonesObj || {})
    .filter(([, val]) => val && now - (val.ts || 0) < TOMBSTONE_TTL_MS)
    .sort((a, b) => (b[1].ts || 0) - (a[1].ts || 0))
    .slice(0, MAX_TOMBSTONES);

  const cleanTombstones = Object.fromEntries(entries);

  const chunks = [];
  let currentChunk = [];
  let currentBytes = 2;
  const wireRecords = [];

  for (const r of records) {
    const wireRecord = toWireRecord(r, now);
    wireRecords.push(wireRecord);
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

  const parentId = commitMeta.parentId || baseCommit.commitId || existingSync[META_KEY]?.commitId || "";
  const commitId = commitMeta.commitId || generateCommitId(wireRecords, parentId);
  const message = commitMeta.message || "Синхронизация вкладок";
  const stats = commitMeta.stats || { added: 0, modified: 0, deleted: 0, total: wireRecords.length };

  const payload = {
    [META_KEY]: {
      version: 2,
      commitId,
      parentId,
      message: String(message).slice(0, 120),
      stats,
      updatedAt: now,
      updatedBy: deviceId,
      updatedByName: deviceName,
      chunkCount: chunks.length,
      totalTabs: wireRecords.length,
      tombstones: cleanTombstones
    }
  };

  for (let i = 0; i < chunks.length; i++) {
    payload[`${CHUNK_PREFIX}${i}`] = chunks[i];
  }

  await browser.storage.sync.set(payload);

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
  syncStats.totalSyncedTabs = wireRecords.length;
  scheduleWeaveSync();

  return {
    commitId,
    parentId,
    timestamp: now,
    message,
    stats,
    wireRecords,
    cleanTombstones
  };
}

function scheduleWeaveSync(delayMs = 1200) {
  if (!currentSettings.mirrorEnabled || !getFxBridge()) {
    return;
  }
  if (pendingWeaveSyncTimer) {
    clearTimeout(pendingWeaveSyncTimer);
  }
  pendingWeaveSyncTimer = setTimeout(async () => {
    pendingWeaveSyncTimer = null;
    try {
      const res = await getFxBridge().triggerFirefoxSync();
      if (res && res.ok) {
        syncStats.lastWeaveSyncTime = Date.now();
      }
    } catch (e) {
      console.warn("[STG Mirror Sync] triggerFirefoxSync warning:", e);
    }
  }, delayMs);
}

// === Browser DOM / Tab manipulation helpers (strictly background!) ===

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

    if (currentGroupId !== TAB_GROUP_ID_NONE) {
      try {
        const curNg = await browser.tabGroups.get(currentGroupId);
        if (curNg && String(curNg.title || "").trim() === cleanTitle) {
          return;
        }
      } catch (_) {}
    }

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

async function createTabInBackgroundFromRecord(rem, localContext) {
  let createdTabId = null;
  let targetStgGroupId = null;
  const targetGroupTitle = normalizeGroup(rem.g);

  if (targetGroupTitle && !rem.p && getFxBridge()) {
    const ens = await getFxBridge().ensureStgGroup(targetGroupTitle);
    if (ens && ens.ok && ens.group && ens.group.id) {
      targetStgGroupId = Number(ens.group.id);
      const createRes = await getFxBridge().createMirroredTabInStg({
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

  if (!createdTabId) {
    const wins = await browser.windows.getAll({ windowTypes: ["normal"] });
    const targetWinId = wins[0]?.id;

    const groupSiblings = localContext.localRecords.filter(
      r => normalizeGroup(r.g).toLowerCase() === targetGroupTitle.toLowerCase()
    );
    const createProps = {
      url: rem.u,
      active: false,
      pinned: Boolean(rem.p),
      windowId: targetWinId
    };

    if (groupSiblings.length > 0 && !rem.p) {
      const lastSibling = groupSiblings[groupSiblings.length - 1];
      const sibTab = localContext.allTabs.find(t => t.id === lastSibling.localTabId);
      if (sibTab) {
        createProps.windowId = sibTab.windowId;
        createProps.index = sibTab.index + 1;
      }
    }

    const newTab = await browser.tabs.create(createProps);
    createdTabId = newTab.id;
    suppressedTabIds.add(createdTabId);

    if (targetGroupTitle) {
      tabCohortGroupCache.set(createdTabId, targetGroupTitle);
      await browser.sessions
        .setTabValue(createdTabId, SESSION_COHORT_GROUP_KEY, targetGroupTitle)
        .catch(() => {});
    }

    if (targetStgGroupId && getFxBridge()) {
      await getFxBridge().moveMirroredTabToStgGroup(createdTabId, targetStgGroupId);
    } else if (targetGroupTitle && !rem.p) {
      const siblingsHidden =
        groupSiblings.length > 0 && groupSiblings.every(s => s.localHidden);
      const activeWinGroup = localContext.stgState.windowGroupsMap[newTab.windowId];
      const winOnDifferentGroup =
        activeWinGroup &&
        String(activeWinGroup).toLowerCase() !== String(targetStgGroupId || targetGroupTitle).toLowerCase();

      if (siblingsHidden || winOnDifferentGroup) {
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
  }

  return createdTabId;
}

async function applyRecordUpdateToLocalTab(loc, targetRecord) {
  let changed = false;
  const targetGroupTitle = normalizeGroup(targetRecord.g);

  // 1. URL update
  if (
    currentSettings.syncUrlChanges &&
    normalizeUrl(targetRecord.u) !== normalizeUrl(loc.u)
  ) {
    suppressedTabIds.add(loc.localTabId);
    try {
      await browser.tabs.update(loc.localTabId, { url: targetRecord.u });
      changed = true;
    } catch (_) {
    } finally {
      setTimeout(() => suppressedTabIds.delete(loc.localTabId), 600);
    }
  }

  // 2. STG group move
  if (
    currentSettings.syncMoveGroups &&
    targetGroupTitle &&
    targetGroupTitle.toLowerCase() !== normalizeGroup(loc.g).toLowerCase()
  ) {
    tabCohortGroupCache.set(loc.localTabId, targetGroupTitle);
    await browser.sessions
      .setTabValue(loc.localTabId, SESSION_COHORT_GROUP_KEY, targetGroupTitle)
      .catch(() => {});

    if (getFxBridge()) {
      const ens = await getFxBridge().ensureStgGroup(targetGroupTitle);
      if (ens && ens.ok && ens.group && ens.group.id) {
        suppressedTabIds.add(loc.localTabId);
        try {
          await getFxBridge().moveMirroredTabToStgGroup(
            loc.localTabId,
            Number(ens.group.id)
          );
          changed = true;
        } finally {
          setTimeout(() => suppressedTabIds.delete(loc.localTabId), 600);
        }
      }
    }
  }

  // 3. Native Firefox Tab Group move
  if (
    currentSettings.syncMoveGroups &&
    String(targetRecord.ng || "") !== String(loc.ng || "")
  ) {
    await ensureNativeTabGroupOnTab(
      loc.localTabId,
      loc.localWindowId,
      targetRecord.ng,
      targetRecord.nc
    );
    changed = true;
  }

  localTabTimestamps.set(loc.id, targetRecord.ts || Date.now());
  return changed;
}

async function closeLocalTabForSync(localTabId, syncId) {
  suppressedTabIds.add(localTabId);
  try {
    if (getFxBridge()) {
      const remRes = await getFxBridge().removeMirroredTab(localTabId);
      if (!remRes || !remRes.ok) {
        await browser.tabs.remove(localTabId).catch(() => {});
      }
    } else {
      await browser.tabs.remove(localTabId).catch(() => {});
    }
    tabIdToSyncId.delete(localTabId);
    if (syncId) {
      syncIdToTabId.delete(syncId);
      locallyClosedSinceBase.delete(syncId);
    }
    knownTabSnapshot.delete(localTabId);
  } finally {
    setTimeout(() => suppressedTabIds.delete(localTabId), 500);
  }
}

// === Git 3-Way Merge Engine (BASE + LOCAL + REMOTE) ===

function isSameUrl(a, b) {
  return normalizeUrl(a) === normalizeUrl(b);
}

function isSameGroup(a, b) {
  return normalizeGroup(a).toLowerCase() === normalizeGroup(b).toLowerCase();
}

function isSameNativeGroup(a, b) {
  return String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase();
}

function isRecordEqualToBase(rec, base) {
  if (!rec && !base) return true;
  if (!rec || !base) return false;
  return (
    isSameUrl(rec.u, base.u) &&
    isSameGroup(rec.g, base.g) &&
    isSameNativeGroup(rec.ng, base.ng) &&
    Boolean(rec.p) === Boolean(base.p)
  );
}

function scheduleGitSync(reason = "Изменение вкладок", delayMs = 450) {
  if (!currentSettings.mirrorEnabled || isSyncingGit) {
    return;
  }
  if (pendingGitSyncTimer) {
    clearTimeout(pendingGitSyncTimer);
  }
  pendingGitSyncTimer = setTimeout(() => {
    pendingGitSyncTimer = null;
    runGitThreeWaySync({ reason, allowPush: true });
  }, delayMs);
}

async function runGitThreeWaySync(options = {}) {
  const { reason = "Git Sync", allowPush = true } = options;
  if (!currentSettings.mirrorEnabled || isSyncingGit) {
    return;
  }
  isSyncingGit = true;

  try {
    const [cloud, localContext] = await Promise.all([
      readCloudState(),
      collectLocalState()
    ]);

    const { localRecords } = localContext;

    // Case 0: Cloud is completely empty -> Initial commit from this machine
    if (!cloud.meta) {
      if (allowPush && localRecords.length > 0) {
        const commitRes = await writeCloudCommit(localRecords, {}, {
          parentId: "root",
          message: `Initial commit (${localRecords.length} вкл.)`,
          stats: { added: localRecords.length, modified: 0, deleted: 0, total: localRecords.length }
        });
        baseCommit = {
          commitId: commitRes.commitId,
          parentId: "root",
          timestamp: commitRes.timestamp,
          recordsMap: recordsMapFromArray(commitRes.wireRecords)
        };
        await appendCommitToLog({
          commitId: commitRes.commitId,
          parentId: "root",
          timestamp: commitRes.timestamp,
          authorId: deviceId,
          authorName: deviceName,
          message: commitRes.message,
          stats: commitRes.stats,
          records: commitRes.wireRecords
        });
        syncStats.lastActionText = `Коммит ${shortCommitHash(commitRes.commitId)}: ${commitRes.message}`;
        syncStats.lastError = null;
        await updateBadge();
      }
      return;
    }

    // Record incoming remote commit in log if we haven't seen it yet
    if (
      cloud.meta.commitId &&
      (!commitLog.length || !commitLog.some(c => c.commitId === cloud.meta.commitId))
    ) {
      await appendCommitToLog({
        commitId: cloud.meta.commitId,
        parentId: cloud.meta.parentId || "",
        timestamp: cloud.meta.updatedAt || Date.now(),
        authorId: cloud.meta.updatedBy || "",
        authorName: cloud.meta.updatedByName || "Другой Firefox",
        message: cloud.meta.message || `Синхронизация (${cloud.records.length} вкл.)`,
        stats: cloud.meta.stats || { added: 0, modified: 0, deleted: 0, total: cloud.records.length },
        records: cloud.records.map(r => toWireRecord(r))
      });
    }

    // Build maps for LOCAL, REMOTE, and BASE
    const localBySyncId = new Map();
    const unlinkedLocalByGroupAndUrl = new Map();
    for (const r of localRecords) {
      localBySyncId.set(r.id, r);
      const key = `${normalizeGroup(r.g).toLowerCase()}|||${normalizeUrl(r.u)}`;
      if (!unlinkedLocalByGroupAndUrl.has(key)) {
        unlinkedLocalByGroupAndUrl.set(key, []);
      }
      unlinkedLocalByGroupAndUrl.get(key).push(r);
    }

    // Smart deduplication before 3-way merge: link any local tab that matches a remote (group, url)
    // and isn't already linked to another remote record
    const remoteBySyncId = new Map();
    const sortedRemote = cloud.records
      .slice()
      .sort((a, b) => normalizeGroup(a.g).localeCompare(normalizeGroup(b.g)) || (a.i || 0) - (b.i || 0));

    for (const rem of sortedRemote) {
      if (!rem || !rem.id || !isSyncableUrl(rem.u)) {
        continue;
      }
      const tomb = cloud.tombstones?.[rem.id];
      if (tomb && (tomb.ts || 0) >= (rem.ts || 0)) {
        continue;
      }
      remoteBySyncId.set(rem.id, rem);

      if (!localBySyncId.has(rem.id)) {
        const matchKey = `${normalizeGroup(rem.g).toLowerCase()}|||${normalizeUrl(rem.u)}`;
        const candidates = unlinkedLocalByGroupAndUrl.get(matchKey);
        if (candidates && candidates.length > 0) {
          const matchedCandidate = candidates.shift();
          const oldLocalId = matchedCandidate.id;
          localBySyncId.delete(oldLocalId);
          matchedCandidate.id = rem.id;
          await setTabSyncId(matchedCandidate.localTabId, rem.id);
          localTabTimestamps.set(rem.id, Math.max(matchedCandidate.ts || 0, rem.ts || 0));
          localBySyncId.set(rem.id, matchedCandidate);
          // Also seed BASE if this is our first time linking this tab
          if (!baseCommit.recordsMap[rem.id]) {
            baseCommit.recordsMap[rem.id] = toWireRecord(rem);
          }
        }
      }
    }

    const baseMap = baseCommit.recordsMap || {};
    const nextBaseMap = { ...baseMap };
    const mergedRecordsMap = new Map();
    const mergedTombstones = { ...(cloud.tombstones || {}) };

    // Collect all candidate syncTabIds across BASE, LOCAL, REMOTE, and locallyClosedSinceBase
    const allIds = new Set([
      ...Object.keys(baseMap),
      ...localBySyncId.keys(),
      ...remoteBySyncId.keys(),
      ...locallyClosedSinceBase.keys()
    ]);

    let appliedRemoteChanges = 0;
    let hasLocalDirtyToPush = false;
    let diffAdded = 0;
    let diffModified = 0;
    let diffDeleted = 0;

    for (const syncId of allIds) {
      // If there is already an unresolved conflict for this syncId, preserve conflict state and keep local tab intact
      if (activeConflicts[syncId]) {
        const curLoc = localBySyncId.get(syncId);
        const curRem = remoteBySyncId.get(syncId) || null;
        activeConflicts[syncId].local = curLoc ? toWireRecord(curLoc) : null;
        activeConflicts[syncId].remote = curRem ? toWireRecord(curRem) : null;
        if (curLoc) {
          mergedRecordsMap.set(syncId, toWireRecord(curLoc));
        } else if (baseMap[syncId]) {
          mergedRecordsMap.set(syncId, toWireRecord(baseMap[syncId]));
        }
        continue;
      }

      const B = baseMap[syncId] || null;
      const L = localBySyncId.get(syncId) || null;
      const R = remoteBySyncId.get(syncId) || null;
      const localTomb = locallyClosedSinceBase.get(syncId) || null;
      const remoteTomb = cloud.tombstones?.[syncId] || null;

      // 1. Both L and R are absent
      if (!L && !R) {
        delete nextBaseMap[syncId];
        if (localTomb) {
          mergedTombstones[syncId] = localTomb;
          locallyClosedSinceBase.delete(syncId);
        }
        continue;
      }

      // 2. Added only on REMOTE (!B && !L && R)
      if (!B && !L && R) {
        // Check if we closed it locally very recently
        if (localTomb && (localTomb.ts || 0) > (R.ts || 0)) {
          mergedTombstones[syncId] = localTomb;
          locallyClosedSinceBase.delete(syncId);
          hasLocalDirtyToPush = true;
          diffDeleted++;
          continue;
        }
        const createdTabId = await createTabInBackgroundFromRecord(R, localContext);
        if (createdTabId) {
          appliedRemoteChanges++;
          diffAdded++;
        }
        const wireR = toWireRecord(R);
        nextBaseMap[syncId] = wireR;
        mergedRecordsMap.set(syncId, wireR);
        continue;
      }

      // 3. Added only on LOCAL (!B && L && !R)
      if (!B && L && !R) {
        // Check if remote tombstoned this exact syncId after our local creation
        if (currentSettings.syncCloseTabs && remoteTomb && (remoteTomb.ts || 0) >= (L.ts || 0)) {
          await closeLocalTabForSync(L.localTabId, syncId);
          delete nextBaseMap[syncId];
          appliedRemoteChanges++;
          diffDeleted++;
          continue;
        }
        const wireL = toWireRecord(L);
        nextBaseMap[syncId] = wireL;
        mergedRecordsMap.set(syncId, wireL);
        hasLocalDirtyToPush = true;
        diffAdded++;
        continue;
      }

      // 4. Existed in BASE (B != null), deleted on REMOTE (!R), still exists on LOCAL (L)
      if (B && L && !R) {
        const localModifiedSinceBase = !isRecordEqualToBase(L, B);
        if (!localModifiedSinceBase) {
          // Clean Fast-Forward Delete from Remote!
          if (currentSettings.syncCloseTabs) {
            await closeLocalTabForSync(L.localTabId, syncId);
            delete nextBaseMap[syncId];
            appliedRemoteChanges++;
            diffDeleted++;
          } else {
            mergedRecordsMap.set(syncId, toWireRecord(L));
          }
        } else {
          // CONFLICT: Modified locally on this PC, but closed (deleted) on the other PC!
          activeConflicts[syncId] = {
            id: syncId,
            type: "modify-local-delete-remote",
            detectedAt: Date.now(),
            base: toWireRecord(B),
            local: toWireRecord(L),
            remote: null,
            remoteDeviceName: cloud.meta.updatedByName || "Другой Firefox"
          };
          mergedRecordsMap.set(syncId, toWireRecord(L));
        }
        continue;
      }

      // 5. Existed in BASE (B != null), deleted on LOCAL (!L), still exists on REMOTE (R)
      if (B && !L && R) {
        const remoteModifiedSinceBase = !isRecordEqualToBase(R, B);
        if (!remoteModifiedSinceBase) {
          // Clean Fast-Forward Delete from Local! Push tombstone to cloud.
          if (currentSettings.syncCloseTabs) {
            mergedTombstones[syncId] = localTomb || {
              ts: Date.now(),
              by: deviceId,
              u: B.u,
              g: B.g
            };
            locallyClosedSinceBase.delete(syncId);
            delete nextBaseMap[syncId];
            hasLocalDirtyToPush = true;
            diffDeleted++;
          }
        } else {
          // CONFLICT: Closed (deleted) locally on this PC, but modified on the other PC!
          activeConflicts[syncId] = {
            id: syncId,
            type: "delete-local-modify-remote",
            detectedAt: Date.now(),
            base: toWireRecord(B),
            local: null,
            remote: toWireRecord(R),
            remoteDeviceName: cloud.meta.updatedByName || "Другой Firefox"
          };
          // Keep R in cloud records until user resolves conflict
          mergedRecordsMap.set(syncId, toWireRecord(R));
        }
        continue;
      }

      // 6. Both L and R exist! Perform 3-way property comparison against B (or between L and R if !B)
      if (L && R) {
        const effectiveB = B || toWireRecord(R);
        const localSameAsRemote = isRecordEqualToBase(L, R);

        if (localSameAsRemote) {
          // Both match! Advance BASE
          const wire = toWireRecord({ ...L, i: R.i ?? L.i });
          nextBaseMap[syncId] = wire;
          mergedRecordsMap.set(syncId, wire);
          continue;
        }

        const localChanged = !isRecordEqualToBase(L, effectiveB);
        const remoteChanged = !isRecordEqualToBase(R, effectiveB);

        if (!localChanged && remoteChanged) {
          // Clean Fast-Forward Pull from Remote!
          const changed = await applyRecordUpdateToLocalTab(L, R);
          if (changed) {
            appliedRemoteChanges++;
            diffModified++;
          }
          const wireR = toWireRecord(R);
          nextBaseMap[syncId] = wireR;
          mergedRecordsMap.set(syncId, wireR);
          continue;
        }

        if (localChanged && !remoteChanged) {
          // Clean Fast-Forward Push from Local!
          const wireL = toWireRecord(L);
          nextBaseMap[syncId] = wireL;
          mergedRecordsMap.set(syncId, wireL);
          hasLocalDirtyToPush = true;
          diffModified++;
          continue;
        }

        // Both LOCAL and REMOTE changed since BASE!
        // Check if we can field-level auto-merge (e.g. Local changed URL, Remote changed STG Group)
        const urlChangedL = !isSameUrl(L.u, effectiveB.u);
        const urlChangedR = !isSameUrl(R.u, effectiveB.u);
        const urlConflict = urlChangedL && urlChangedR && !isSameUrl(L.u, R.u);

        const groupChangedL = !isSameGroup(L.g, effectiveB.g);
        const groupChangedR = !isSameGroup(R.g, effectiveB.g);
        const groupConflict = groupChangedL && groupChangedR && !isSameGroup(L.g, R.g);

        if (!urlConflict && !groupConflict) {
          // Clean Field-Level Auto-Merge!
          const mergedRecord = toWireRecord({
            ...L,
            u: urlChangedR ? R.u : L.u,
            t: urlChangedR ? R.t : L.t,
            g: groupChangedR ? R.g : L.g,
            ng: !isSameNativeGroup(R.ng, effectiveB.ng) ? R.ng : L.ng,
            nc: !isSameNativeGroup(R.ng, effectiveB.ng) ? R.nc : L.nc,
            ts: Date.now(),
            by: deviceId
          });
          await applyRecordUpdateToLocalTab(L, mergedRecord);
          nextBaseMap[syncId] = mergedRecord;
          mergedRecordsMap.set(syncId, mergedRecord);
          appliedRemoteChanges++;
          hasLocalDirtyToPush = true;
          diffModified++;
        } else {
          // True Git Merge Conflict on the same field (URL or Group)!
          activeConflicts[syncId] = {
            id: syncId,
            type: urlConflict && groupConflict
              ? "modify-both-url-and-group"
              : urlConflict
                ? "modify-modify-url"
                : "modify-modify-group",
            detectedAt: Date.now(),
            base: toWireRecord(effectiveB),
            local: toWireRecord(L),
            remote: toWireRecord(R),
            remoteDeviceName: cloud.meta.updatedByName || "Другой Firefox"
          };
          mergedRecordsMap.set(syncId, toWireRecord(L));
        }
      }
    }

    // Order merged records by group and index
    const mergedRecordsList = Array.from(mergedRecordsMap.values()).sort(
      (a, b) => normalizeGroup(a.g).localeCompare(normalizeGroup(b.g)) || (a.i || 0) - (b.i || 0)
    );

    const conflictCount = Object.keys(activeConflicts).length;

    // If we have local changes (or auto-merged changes) and no unresolved conflicts blocking a clean commit, push new commit
    if (allowPush && hasLocalDirtyToPush && conflictCount === 0) {
      const parentCommitId = cloud.meta.commitId || baseCommit.commitId || "root";
      const statsObj = {
        added: diffAdded,
        modified: diffModified,
        deleted: diffDeleted,
        total: mergedRecordsList.length
      };
      const commitMsg =
        appliedRemoteChanges > 0
          ? `Auto-merge ${shortCommitHash(parentCommitId)} (+${diffAdded} ~${diffModified} -${diffDeleted})`
          : `${reason} (+${diffAdded} ~${diffModified} -${diffDeleted})`;

      const commitRes = await writeCloudCommit(mergedRecordsList, mergedTombstones, {
        parentId: parentCommitId,
        message: commitMsg,
        stats: statsObj
      });

      baseCommit = {
        commitId: commitRes.commitId,
        parentId: commitRes.parentId,
        timestamp: commitRes.timestamp,
        recordsMap: nextBaseMap
      };

      await appendCommitToLog({
        commitId: commitRes.commitId,
        parentId: commitRes.parentId,
        timestamp: commitRes.timestamp,
        authorId: deviceId,
        authorName: deviceName,
        message: commitRes.message,
        stats: statsObj,
        records: commitRes.wireRecords
      });

      syncStats.lastDiffStats = statsObj;
      syncStats.lastActionText = `Коммит ${shortCommitHash(commitRes.commitId)}: ${commitMsg}`;
    } else {
      // Fast-forward BASE to cloud commit if no conflicts
      if (conflictCount === 0 && cloud.meta.commitId) {
        baseCommit = {
          commitId: cloud.meta.commitId,
          parentId: cloud.meta.parentId || "",
          timestamp: cloud.meta.updatedAt || Date.now(),
          recordsMap: nextBaseMap
        };
      } else {
        baseCommit.recordsMap = nextBaseMap;
      }
      await saveGitLocalState();

      if (conflictCount > 0) {
        syncStats.lastActionText = `⚡ Конфликт слияния (${conflictCount} вкл.) — выберите решение`;
      } else if (appliedRemoteChanges > 0) {
        syncStats.lastDiffStats = { added: diffAdded, modified: diffModified, deleted: diffDeleted };
        syncStats.lastActionText = `Fast-forward ${shortCommitHash(baseCommit.commitId)}: принято ${appliedRemoteChanges} изм.`;
      } else {
        syncStats.lastActionText = `HEAD ${shortCommitHash(baseCommit.commitId)} актуален (${mergedRecordsList.length} вкл.)`;
      }
    }

    syncStats.lastPullTime = Date.now();
    syncStats.totalSyncedTabs = mergedRecordsList.length;
    syncStats.lastError = null;
    await updateBadge();
  } catch (err) {
    console.error("[STG Mirror Sync] runGitThreeWaySync error:", err);
    syncStats.lastError = String(err && err.message ? err.message : err);
    await updateBadge();
  } finally {
    isSyncingGit = false;
  }
}

// === Conflict Resolution (git mergetool: ours / theirs / both) ===

async function resolveSingleConflict(syncId, strategy) {
  const conflict = activeConflicts[syncId];
  if (!conflict) {
    return { ok: false, error: "Conflict not found" };
  }

  const [cloud, localContext] = await Promise.all([
    readCloudState(),
    collectLocalState()
  ]);

  const locTab = localContext.localRecords.find(r => r.id === syncId) || null;
  const remRec = conflict.remote;
  const locRec = conflict.local;

  if (strategy === "ours") {
    // Keep local version (if local was deleted, ensure it's tombstoned; if local exists, update base to local)
    if (!locRec) {
      if (locTab) {
        await closeLocalTabForSync(locTab.localTabId, syncId);
      }
      locallyClosedSinceBase.set(syncId, {
        ts: Date.now(),
        by: deviceId,
        u: conflict.base?.u || remRec?.u || "",
        g: conflict.base?.g || remRec?.g || ""
      });
      delete baseCommit.recordsMap[syncId];
    } else {
      const updatedWire = toWireRecord({ ...locRec, ts: Date.now(), by: deviceId });
      baseCommit.recordsMap[syncId] = updatedWire;
      localTabTimestamps.set(syncId, updatedWire.ts);
    }
  } else if (strategy === "theirs") {
    // Accept remote version (if remote deleted it, close local tab; if remote modified/exists, apply remote in background)
    if (!remRec) {
      if (locTab) {
        await closeLocalTabForSync(locTab.localTabId, syncId);
      }
      delete baseCommit.recordsMap[syncId];
    } else {
      if (locTab) {
        await applyRecordUpdateToLocalTab(locTab, remRec);
      } else {
        await createTabInBackgroundFromRecord(remRec, localContext);
      }
      const updatedWire = toWireRecord({ ...remRec, ts: Date.now() });
      baseCommit.recordsMap[syncId] = updatedWire;
      localTabTimestamps.set(syncId, updatedWire.ts);
    }
  } else if (strategy === "both") {
    // Keep both versions without losing anything!
    // Local stays as syncId (or is recreated if local was deleted), and Remote is forked as a new tab in background if both exist
    if (locRec && remRec) {
      const updatedLocalWire = toWireRecord({ ...locRec, ts: Date.now(), by: deviceId });
      baseCommit.recordsMap[syncId] = updatedLocalWire;

      // Create forked copy for the remote version with a new syncTabId in background
      const forkedId = generateSyncId();
      const forkedRecord = toWireRecord({
        ...remRec,
        id: forkedId,
        ts: Date.now(),
        by: deviceId
      });
      await createTabInBackgroundFromRecord(forkedRecord, localContext);
      baseCommit.recordsMap[forkedId] = forkedRecord;
    } else if (!locRec && remRec) {
      // Local had deleted it, remote modified it -> restore remote tab in background
      await createTabInBackgroundFromRecord(remRec, localContext);
      baseCommit.recordsMap[syncId] = toWireRecord({ ...remRec, ts: Date.now(), by: deviceId });
    } else if (locRec && !remRec) {
      // Remote had deleted it, local modified it -> keep local tab alive
      baseCommit.recordsMap[syncId] = toWireRecord({ ...locRec, ts: Date.now(), by: deviceId });
    }
  }

  delete activeConflicts[syncId];
  await saveGitLocalState();
  await updateBadge();

  // If all conflicts are now resolved, commit the merge result to the cloud
  if (Object.keys(activeConflicts).length === 0) {
    const freshLocal = await collectLocalState();
    const mergedTombstones = { ...(cloud.tombstones || {}) };
    for (const [closedId, tomb] of locallyClosedSinceBase.entries()) {
      mergedTombstones[closedId] = tomb;
    }
    locallyClosedSinceBase.clear();

    // Remove tombstones for tabs that were kept alive
    for (const r of freshLocal.localRecords) {
      delete mergedTombstones[r.id];
    }

    const commitRes = await writeCloudCommit(freshLocal.localRecords, mergedTombstones, {
      parentId: cloud.meta?.commitId || baseCommit.commitId || "root",
      message: `Merge conflict resolved (${strategy})`,
      stats: {
        added: 0,
        modified: 1,
        deleted: 0,
        total: freshLocal.localRecords.length
      }
    });

    baseCommit = {
      commitId: commitRes.commitId,
      parentId: commitRes.parentId,
      timestamp: commitRes.timestamp,
      recordsMap: recordsMapFromArray(commitRes.wireRecords)
    };

    await appendCommitToLog({
      commitId: commitRes.commitId,
      parentId: commitRes.parentId,
      timestamp: commitRes.timestamp,
      authorId: deviceId,
      authorName: deviceName,
      message: commitRes.message,
      stats: commitRes.stats,
      records: commitRes.wireRecords
    });

    syncStats.lastActionText = `Конфликты решены → ${shortCommitHash(commitRes.commitId)}`;
    await updateBadge();
  }

  return { ok: true };
}

async function resolveAllConflicts(strategy) {
  const ids = Object.keys(activeConflicts);
  for (const id of ids) {
    await resolveSingleConflict(id, strategy);
  }
  return { ok: true, resolvedCount: ids.length };
}

// === Git Rollback (git reset --hard <commitId>) ===

async function rollbackToCommit(targetCommitId) {
  const targetCommit = commitLog.find(c => c.commitId === targetCommitId);
  if (!targetCommit || !Array.isArray(targetCommit.records)) {
    return { ok: false, error: "Коммит не найден в локальной истории" };
  }

  isSyncingGit = true;
  try {
    const [cloud, localContext] = await Promise.all([
      readCloudState(),
      collectLocalState()
    ]);

    const targetBySyncId = new Map();
    for (const r of targetCommit.records) {
      if (r && r.id) {
        targetBySyncId.set(r.id, r);
      }
    }

    const localBySyncId = new Map();
    for (const r of localContext.localRecords) {
      localBySyncId.set(r.id, r);
    }

    const mergedTombstones = { ...(cloud.tombstones || {}) };
    const now = Date.now();

    // 1. Close local tabs that are not in the target commit (keep at least 1 tab open so window doesn't close)
    const tabsToClose = localContext.localRecords.filter(r => !targetBySyncId.has(r.id));
    if (tabsToClose.length > 0 && targetBySyncId.size > 0) {
      for (const extra of tabsToClose) {
        mergedTombstones[extra.id] = {
          ts: now,
          by: deviceId,
          u: extra.u,
          g: extra.g
        };
        await closeLocalTabForSync(extra.localTabId, extra.id);
      }
    }

    // 2. Restore or update all tabs from targetCommit.records in background
    for (const targetRec of targetCommit.records) {
      delete mergedTombstones[targetRec.id];
      const existingLoc = localBySyncId.get(targetRec.id);
      if (existingLoc) {
        await applyRecordUpdateToLocalTab(existingLoc, targetRec);
      } else {
        await createTabInBackgroundFromRecord(targetRec, localContext);
      }
    }

    activeConflicts = {};
    locallyClosedSinceBase.clear();

    const restoredRecords = targetCommit.records.map(r => toWireRecord(r, now));
    const commitRes = await writeCloudCommit(restoredRecords, mergedTombstones, {
      parentId: cloud.meta?.commitId || baseCommit.commitId || "root",
      message: `Reset to ${shortCommitHash(targetCommitId)} (${restoredRecords.length} вкл.)`,
      stats: {
        added: 0,
        modified: restoredRecords.length,
        deleted: tabsToClose.length,
        total: restoredRecords.length
      }
    });

    baseCommit = {
      commitId: commitRes.commitId,
      parentId: commitRes.parentId,
      timestamp: commitRes.timestamp,
      recordsMap: recordsMapFromArray(commitRes.wireRecords)
    };

    await appendCommitToLog({
      commitId: commitRes.commitId,
      parentId: commitRes.parentId,
      timestamp: commitRes.timestamp,
      authorId: deviceId,
      authorName: deviceName,
      message: commitRes.message,
      stats: commitRes.stats,
      records: commitRes.wireRecords
    });

    syncStats.lastActionText = `Откат к ${shortCommitHash(targetCommitId)} → ${shortCommitHash(commitRes.commitId)}`;
    syncStats.lastError = null;
    await updateBadge();

    return { ok: true, newCommitId: commitRes.commitId };
  } catch (err) {
    console.error("[STG Mirror Sync] rollbackToCommit error:", err);
    return { ok: false, error: String(err && err.message ? err.message : err) };
  } finally {
    isSyncingGit = false;
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
    if (!currentSettings.mirrorEnabled || isSyncingGit) {
      return;
    }
    try {
      if (getFxBridge()) {
        const res = await getFxBridge().triggerFirefoxSync();
        if (res && res.ok) {
          syncStats.lastWeaveSyncTime = Date.now();
        }
      }
      await runGitThreeWaySync({ reason: "Фоновая синхронизация", allowPush: true });
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
  setTimeout(() => {
    if (!suppressedTabIds.has(tab.id)) {
      scheduleGitSync("Открыта вкладка", 500);
    }
  }, 350);
});

browser.tabs.onUpdated.addListener(
  (tabId, changeInfo, tab) => {
    if (!currentSettings.mirrorEnabled || suppressedTabIds.has(tabId) || tab.incognito) {
      return;
    }
    if (
      changeInfo.status === "complete" ||
      changeInfo.url ||
      "pinned" in changeInfo ||
      "groupId" in changeInfo ||
      "hidden" in changeInfo
    ) {
      scheduleGitSync("Обновлена вкладка", 500);
    }
  },
  { properties: ["status", "url", "pinned", "groupId", "hidden"] }
);

browser.tabs.onMoved.addListener(tabId => {
  if (!currentSettings.mirrorEnabled || suppressedTabIds.has(tabId)) {
    return;
  }
  scheduleGitSync("Перемещена вкладка", 600);
});

browser.tabs.onRemoved.addListener((tabId, removeInfo) => {
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
      locallyClosedSinceBase.set(syncId, {
        ts: Date.now(),
        by: deviceId,
        u: snap?.url || "",
        g: snap?.stgGroupTitle || "",
        t: snap?.title || ""
      });
    }
  }

  scheduleGitSync("Закрыта вкладка", 450);
});

if (browser.tabGroups) {
  browser.tabGroups.onUpdated.addListener(() => {
    if (currentSettings.mirrorEnabled && !isSyncingGit) {
      scheduleGitSync("Обновлена нативная группа", 600);
    }
  });
}

browser.storage.onChanged.addListener((changes, area) => {
  if (area === "sync") {
    if (changes[META_KEY]) {
      const newMeta = changes[META_KEY].newValue;
      if (newMeta && newMeta.updatedBy && newMeta.updatedBy !== deviceId) {
        runGitThreeWaySync({ reason: "Входящий коммит из Firefox Sync", allowPush: true });
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
      if (getFxBridge()) {
        syncAccountInfo = await getFxBridge().getSyncAccountInfo().catch(() => syncAccountInfo);
      }
      await collectLocalState();
      return {
        settings: currentSettings,
        deviceId,
        deviceName,
        syncAccountInfo,
        stats: syncStats,
        conflicts: Object.values(activeConflicts),
        commitLog: commitLog.slice(0, 15).map(c => ({
          commitId: c.commitId,
          parentId: c.parentId,
          timestamp: c.timestamp,
          authorName: c.authorName,
          message: c.message,
          stats: c.stats
        }))
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
        if (getFxBridge()) {
          await getFxBridge().triggerFirefoxSync().catch(() => {});
        }
        await runGitThreeWaySync({ reason: "Включён режим зеркала", allowPush: true });
      }
      return {
        settings: currentSettings,
        stats: syncStats,
        conflicts: Object.values(activeConflicts)
      };
    })();
  }

  if (msg.action === "syncNow") {
    return (async () => {
      if (getFxBridge()) {
        const wRes = await getFxBridge().triggerFirefoxSync();
        if (wRes && wRes.ok) {
          syncStats.lastWeaveSyncTime = Date.now();
        }
      }
      await runGitThreeWaySync({ reason: "Ручной git sync (pull + merge + push)", allowPush: true });
      return {
        settings: currentSettings,
        stats: syncStats,
        conflicts: Object.values(activeConflicts),
        commitLog: commitLog.slice(0, 15)
      };
    })();
  }

  if (msg.action === "resolveConflict") {
    return (async () => {
      await resolveSingleConflict(msg.syncId, msg.strategy);
      return {
        stats: syncStats,
        conflicts: Object.values(activeConflicts),
        commitLog: commitLog.slice(0, 15)
      };
    })();
  }

  if (msg.action === "resolveAllConflicts") {
    return (async () => {
      await resolveAllConflicts(msg.strategy);
      return {
        stats: syncStats,
        conflicts: Object.values(activeConflicts),
        commitLog: commitLog.slice(0, 15)
      };
    })();
  }

  if (msg.action === "rollbackToCommit") {
    return (async () => {
      const res = await rollbackToCommit(msg.commitId);
      return {
        ...res,
        stats: syncStats,
        conflicts: Object.values(activeConflicts),
        commitLog: commitLog.slice(0, 15)
      };
    })();
  }

  if (msg.action === "forcePushAll") {
    return (async () => {
      const [cloud, local] = await Promise.all([readCloudState(), collectLocalState()]);
      activeConflicts = {};
      locallyClosedSinceBase.clear();
      const commitRes = await writeCloudCommit(local.localRecords, cloud.tombstones || {}, {
        parentId: cloud.meta?.commitId || baseCommit.commitId || "root",
        message: `Force push --ours (${local.localRecords.length} вкл.)`,
        stats: {
          added: 0,
          modified: local.localRecords.length,
          deleted: 0,
          total: local.localRecords.length
        }
      });
      baseCommit = {
        commitId: commitRes.commitId,
        parentId: commitRes.parentId,
        timestamp: commitRes.timestamp,
        recordsMap: recordsMapFromArray(commitRes.wireRecords)
      };
      await appendCommitToLog({
        commitId: commitRes.commitId,
        parentId: commitRes.parentId,
        timestamp: commitRes.timestamp,
        authorId: deviceId,
        authorName: deviceName,
        message: commitRes.message,
        stats: commitRes.stats,
        records: commitRes.wireRecords
      });
      await updateBadge();
      return {
        settings: currentSettings,
        stats: syncStats,
        conflicts: [],
        commitLog: commitLog.slice(0, 15)
      };
    })();
  }

  if (msg.action === "forcePullAll") {
    return (async () => {
      if (getFxBridge()) {
        await getFxBridge().triggerFirefoxSync().catch(() => {});
      }
      // Reset base to empty and accept all remote
      const cloud = await readCloudState();
      if (cloud.meta && cloud.records.length > 0) {
        activeConflicts = {};
        locallyClosedSinceBase.clear();
        const local = await collectLocalState();
        const localById = new Map(local.localRecords.map(r => [r.id, r]));
        for (const rem of cloud.records) {
          const ex = localById.get(rem.id);
          if (ex) {
            await applyRecordUpdateToLocalTab(ex, rem);
          } else {
            await createTabInBackgroundFromRecord(rem, local);
          }
        }
        baseCommit = {
          commitId: cloud.meta.commitId || generateCommitId(cloud.records, "root"),
          parentId: cloud.meta.parentId || "root",
          timestamp: cloud.meta.updatedAt || Date.now(),
          recordsMap: recordsMapFromArray(cloud.records)
        };
        await saveGitLocalState();
        syncStats.lastActionText = `Принято состояние облака (--theirs): ${cloud.records.length} вкл.`;
        await updateBadge();
      }
      return {
        settings: currentSettings,
        stats: syncStats,
        conflicts: [],
        commitLog: commitLog.slice(0, 15)
      };
    })();
  }

  return undefined;
});

(async function init() {
  try {
    const stored = await browser.storage.local.get([
      "settings",
      "deviceId",
      "deviceName",
      GIT_BASE_KEY,
      GIT_LOG_KEY,
      GIT_CONFLICTS_KEY
    ]);
    currentSettings = { ...DEFAULT_SETTINGS, ...(stored.settings || {}) };

    if (stored[GIT_BASE_KEY] && typeof stored[GIT_BASE_KEY] === "object") {
      baseCommit = stored[GIT_BASE_KEY];
      syncStats.headCommitId = baseCommit.commitId || "";
      syncStats.parentCommitId = baseCommit.parentId || "";
    }
    if (Array.isArray(stored[GIT_LOG_KEY])) {
      commitLog = stored[GIT_LOG_KEY];
    }
    if (stored[GIT_CONFLICTS_KEY] && typeof stored[GIT_CONFLICTS_KEY] === "object") {
      activeConflicts = stored[GIT_CONFLICTS_KEY];
      syncStats.conflictCount = Object.keys(activeConflicts).length;
    }

    if (getFxBridge()) {
      syncAccountInfo = await getFxBridge().getSyncAccountInfo().catch(() => syncAccountInfo);
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

    setTimeout(async () => {
      if (currentSettings.mirrorEnabled) {
        if (getFxBridge()) {
          await getFxBridge().triggerFirefoxSync().catch(() => {});
        }
        await runGitThreeWaySync({ reason: "Авто-слияние при запуске", allowPush: true });
      }
    }, 1500);
  } catch (err) {
    console.error("[STG Mirror Sync] init error:", err);
  }
})();
