"use strict";

const mirrorEnabledToggle = document.getElementById("mirrorEnabledToggle");
const headCommitBadge = document.getElementById("headCommitBadge");
const fxAccountVal = document.getElementById("fxAccountVal");
const deviceNameVal = document.getElementById("deviceNameVal");
const tabsGroupsVal = document.getElementById("tabsGroupsVal");
const lastActionVal = document.getElementById("lastActionVal");

const conflictsCard = document.getElementById("conflictsCard");
const conflictCountText = document.getElementById("conflictCountText");
const conflictsList = document.getElementById("conflictsList");
const resolveAllOursBtn = document.getElementById("resolveAllOursBtn");
const resolveAllTheirsBtn = document.getElementById("resolveAllTheirsBtn");
const resolveAllBothBtn = document.getElementById("resolveAllBothBtn");

const syncNowBtn = document.getElementById("syncNowBtn");
const forcePushBtn = document.getElementById("forcePushBtn");
const forcePullBtn = document.getElementById("forcePullBtn");

const tabBtnLog = document.getElementById("tabBtnLog");
const tabBtnSettings = document.getElementById("tabBtnSettings");
const panelLog = document.getElementById("panelLog");
const panelSettings = document.getElementById("panelSettings");
const commitLogList = document.getElementById("commitLogList");

const syncCloseTabs = document.getElementById("syncCloseTabs");
const syncUrlChanges = document.getElementById("syncUrlChanges");
const syncMoveGroups = document.getElementById("syncMoveGroups");
const syncPinnedTabs = document.getElementById("syncPinnedTabs");
const pollIntervalSec = document.getElementById("pollIntervalSec");

function formatShortHash(commitId) {
  if (!commitId) return "#root";
  return commitId.replace(/^c_/, "#");
}

function formatTime(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  return d.toLocaleTimeString("ru-RU", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

function formatRecordSummary(rec) {
  if (!rec) {
    return "✖ Вкладка закрыта (удалена)";
  }
  const grp = rec.g ? `[${rec.g}] ` : "[Без группы] ";
  return `${grp}${rec.t || rec.u} (${rec.u})`;
}

function formatConflictType(type) {
  switch (type) {
    case "modify-modify-url":
      return "Конфликт URL (вкладка перешла по разным адресам на двух ПК)";
    case "modify-modify-group":
      return "Конфликт группы (вкладка перемещена в разные группы на двух ПК)";
    case "modify-both-url-and-group":
      return "Конфликт URL и группы (изменена на обоих ПК)";
    case "modify-local-delete-remote":
      return "Изменена на этом ПК, но закрыта на другом ПК";
    case "delete-local-modify-remote":
      return "Закрыта на этом ПК, но изменена на другом ПК";
    default:
      return "Конфликт слияния";
  }
}

function createDiffLine(tagText, tagClass, valueText) {
  const row = document.createElement("div");
  row.className = "conflict-diff-line";
  row.title = valueText;

  const tag = document.createElement("span");
  tag.className = `tag ${tagClass}`;
  tag.textContent = tagText;

  const val = document.createElement("span");
  val.textContent = valueText;

  row.appendChild(tag);
  row.appendChild(val);
  return row;
}

function renderConflicts(conflicts) {
  while (conflictsList.firstChild) {
    conflictsList.removeChild(conflictsList.firstChild);
  }

  const list = Array.isArray(conflicts) ? conflicts : [];
  conflictCountText.textContent = String(list.length);

  if (list.length === 0) {
    conflictsCard.classList.add("hidden");
    return;
  }

  conflictsCard.classList.remove("hidden");

  for (const c of list) {
    const item = document.createElement("div");
    item.className = "conflict-item";

    const badge = document.createElement("div");
    badge.className = "conflict-badge";
    badge.textContent = formatConflictType(c.type);
    item.appendChild(badge);

    if (c.base) {
      item.appendChild(createDiffLine("BASE:", "tag-base", formatRecordSummary(c.base)));
    }
    item.appendChild(createDiffLine("LOCAL:", "tag-ours", formatRecordSummary(c.local)));
    item.appendChild(createDiffLine("REMOTE:", "tag-theirs", formatRecordSummary(c.remote)));

    const actions = document.createElement("div");
    actions.className = "conflict-item-actions";

    const btnOurs = document.createElement("button");
    btnOurs.className = "btn btn-xs btn-ours";
    btnOurs.textContent = "Моё (Local)";
    btnOurs.addEventListener("click", async () => {
      const res = await browser.runtime.sendMessage({
        action: "resolveConflict",
        syncId: c.id,
        strategy: "ours"
      });
      renderStatus(res);
    });

    const btnTheirs = document.createElement("button");
    btnTheirs.className = "btn btn-xs btn-theirs";
    btnTheirs.textContent = "Удалённое";
    btnTheirs.addEventListener("click", async () => {
      const res = await browser.runtime.sendMessage({
        action: "resolveConflict",
        syncId: c.id,
        strategy: "theirs"
      });
      renderStatus(res);
    });

    const btnBoth = document.createElement("button");
    btnBoth.className = "btn btn-xs btn-both";
    btnBoth.textContent = "Обе вкладки";
    btnBoth.addEventListener("click", async () => {
      const res = await browser.runtime.sendMessage({
        action: "resolveConflict",
        syncId: c.id,
        strategy: "both"
      });
      renderStatus(res);
    });

    actions.appendChild(btnOurs);
    actions.appendChild(btnTheirs);
    actions.appendChild(btnBoth);
    item.appendChild(actions);

    conflictsList.appendChild(item);
  }
}

function renderCommitLog(commitLog, headCommitId) {
  while (commitLogList.firstChild) {
    commitLogList.removeChild(commitLogList.firstChild);
  }

  const list = Array.isArray(commitLog) ? commitLog : [];
  if (list.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-log";
    empty.textContent = "История коммитов пока пуста";
    commitLogList.appendChild(empty);
    return;
  }

  for (const c of list) {
    const row = document.createElement("div");
    row.className = "commit-row";

    const info = document.createElement("div");
    info.className = "commit-info";

    const top = document.createElement("div");
    top.className = "commit-top";

    const hashSpan = document.createElement("span");
    hashSpan.className = "commit-hash";
    const isHead = c.commitId === headCommitId;
    hashSpan.textContent = formatShortHash(c.commitId) + (isHead ? " (HEAD)" : "");

    const authorSpan = document.createElement("span");
    authorSpan.className = "commit-author";
    authorSpan.textContent = c.authorName || "Firefox";

    const timeSpan = document.createElement("span");
    timeSpan.className = "commit-time";
    timeSpan.textContent = formatTime(c.timestamp);

    top.appendChild(hashSpan);
    top.appendChild(authorSpan);
    top.appendChild(timeSpan);

    const msgDiv = document.createElement("div");
    msgDiv.className = "commit-msg";
    msgDiv.textContent = c.message || "";
    msgDiv.title = c.message || "";

    info.appendChild(top);
    info.appendChild(msgDiv);

    const resetBtn = document.createElement("button");
    resetBtn.className = "btn btn-reset";
    resetBtn.textContent = "Откатить";
    resetBtn.title = `git reset --hard ${formatShortHash(c.commitId)}`;
    resetBtn.addEventListener("click", async () => {
      resetBtn.disabled = true;
      resetBtn.textContent = "Откат...";
      try {
        const res = await browser.runtime.sendMessage({
          action: "rollbackToCommit",
          commitId: c.commitId
        });
        renderStatus(res);
      } finally {
        resetBtn.disabled = false;
        resetBtn.textContent = "Откатить";
      }
    });

    row.appendChild(info);
    row.appendChild(resetBtn);
    commitLogList.appendChild(row);
  }
}

function renderStatus(res) {
  if (!res) return;
  const { settings, deviceName, syncAccountInfo, stats, conflicts, commitLog } = res;

  if (settings) {
    mirrorEnabledToggle.checked = Boolean(settings.mirrorEnabled);
    syncCloseTabs.checked = Boolean(settings.syncCloseTabs);
    syncUrlChanges.checked = Boolean(settings.syncUrlChanges);
    syncMoveGroups.checked = Boolean(settings.syncMoveGroups);
    syncPinnedTabs.checked = Boolean(settings.syncPinnedTabs);
    pollIntervalSec.value = settings.pollIntervalSec || 8;
  }

  if (syncAccountInfo && syncAccountInfo.enabled) {
    fxAccountVal.textContent = syncAccountInfo.username || "Подключён";
    fxAccountVal.style.color = "#10b981";
  } else {
    fxAccountVal.textContent = "browser.storage.sync активен";
    fxAccountVal.style.color = "#38bdf8";
  }

  if (deviceName) {
    deviceNameVal.textContent = deviceName;
  }

  if (stats) {
    headCommitBadge.textContent = formatShortHash(stats.headCommitId);
    tabsGroupsVal.textContent = `${stats.totalSyncedTabs || 0} вкл. / ${stats.totalStgGroups || 0} гр.`;
    if (stats.lastError) {
      lastActionVal.textContent = `Ошибка: ${stats.lastError}`;
      lastActionVal.style.color = "#ef4444";
    } else {
      lastActionVal.textContent = stats.lastActionText || "Готово";
      lastActionVal.style.color = stats.conflictCount > 0 ? "#fbbf24" : "#38bdf8";
    }
  }

  if (conflicts !== undefined) {
    renderConflicts(conflicts);
  }

  if (commitLog !== undefined) {
    renderCommitLog(commitLog, stats?.headCommitId);
  }
}

async function saveCurrentSettings() {
  const settings = {
    mirrorEnabled: mirrorEnabledToggle.checked,
    syncCloseTabs: syncCloseTabs.checked,
    syncUrlChanges: syncUrlChanges.checked,
    syncMoveGroups: syncMoveGroups.checked,
    syncPinnedTabs: syncPinnedTabs.checked,
    pollIntervalSec: Math.max(4, Math.min(120, Number(pollIntervalSec.value) || 8))
  };
  const res = await browser.runtime.sendMessage({
    action: "saveSettings",
    settings
  });
  renderStatus(res);
}

[
  mirrorEnabledToggle,
  syncCloseTabs,
  syncUrlChanges,
  syncMoveGroups,
  syncPinnedTabs,
  pollIntervalSec
].forEach(el => {
  el.addEventListener("change", saveCurrentSettings);
});

resolveAllOursBtn.addEventListener("click", async () => {
  const res = await browser.runtime.sendMessage({
    action: "resolveAllConflicts",
    strategy: "ours"
  });
  renderStatus(res);
});

resolveAllTheirsBtn.addEventListener("click", async () => {
  const res = await browser.runtime.sendMessage({
    action: "resolveAllConflicts",
    strategy: "theirs"
  });
  renderStatus(res);
});

resolveAllBothBtn.addEventListener("click", async () => {
  const res = await browser.runtime.sendMessage({
    action: "resolveAllConflicts",
    strategy: "both"
  });
  renderStatus(res);
});

syncNowBtn.addEventListener("click", async () => {
  syncNowBtn.disabled = true;
  syncNowBtn.textContent = "⏳ Выполняется 3-way merge...";
  try {
    const res = await browser.runtime.sendMessage({ action: "syncNow" });
    renderStatus(res);
  } finally {
    syncNowBtn.disabled = false;
    syncNowBtn.textContent = "🔄 Git Sync (Merge + Push)";
  }
});

forcePushBtn.addEventListener("click", async () => {
  forcePushBtn.disabled = true;
  try {
    const res = await browser.runtime.sendMessage({ action: "forcePushAll" });
    renderStatus(res);
  } finally {
    forcePushBtn.disabled = false;
  }
});

forcePullBtn.addEventListener("click", async () => {
  forcePullBtn.disabled = true;
  try {
    const res = await browser.runtime.sendMessage({ action: "forcePullAll" });
    renderStatus(res);
  } finally {
    forcePullBtn.disabled = false;
  }
});

tabBtnLog.addEventListener("click", () => {
  tabBtnLog.classList.add("active");
  tabBtnSettings.classList.remove("active");
  panelLog.classList.remove("hidden");
  panelSettings.classList.add("hidden");
});

tabBtnSettings.addEventListener("click", () => {
  tabBtnSettings.classList.add("active");
  tabBtnLog.classList.remove("active");
  panelSettings.classList.remove("hidden");
  panelLog.classList.add("hidden");
});

(async function initPopup() {
  const res = await browser.runtime.sendMessage({ action: "getStatus" });
  renderStatus(res);
})();
