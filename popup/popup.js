"use strict";

const elMirrorEnabled = document.getElementById("mirrorEnabled");
const elSyncCloseTabs = document.getElementById("syncCloseTabs");
const elSyncUrlChanges = document.getElementById("syncUrlChanges");
const elSyncMoveGroups = document.getElementById("syncMoveGroups");
const elSyncPinnedTabs = document.getElementById("syncPinnedTabs");
const elPollIntervalSec = document.getElementById("pollIntervalSec");

const elFxAccountVal = document.getElementById("fxAccountVal");
const elDeviceNameVal = document.getElementById("deviceNameVal");
const elStatTabsCount = document.getElementById("statTabsCount");
const elStatGroupsCount = document.getElementById("statGroupsCount");
const elStatusLine = document.getElementById("statusLine");

const btnSyncNow = document.getElementById("btnSyncNow");
const btnForcePush = document.getElementById("btnForcePush");
const btnForcePull = document.getElementById("btnForcePull");

function renderState(res) {
  if (!res) {
    return;
  }
  const { settings, deviceName, syncAccountInfo, stats } = res;
  if (settings) {
    elMirrorEnabled.checked = Boolean(settings.mirrorEnabled);
    elSyncCloseTabs.checked = Boolean(settings.syncCloseTabs);
    elSyncUrlChanges.checked = Boolean(settings.syncUrlChanges);
    elSyncMoveGroups.checked = Boolean(settings.syncMoveGroups);
    elSyncPinnedTabs.checked = Boolean(settings.syncPinnedTabs);
    elPollIntervalSec.value = Number(settings.pollIntervalSec) || 8;
  }

  if (syncAccountInfo && syncAccountInfo.username) {
    elFxAccountVal.textContent = syncAccountInfo.username;
    elFxAccountVal.style.color = "#34d399";
  } else {
    elFxAccountVal.textContent = "Не авторизован в Firefox Sync";
    elFxAccountVal.style.color = "#f87171";
  }

  elDeviceNameVal.textContent =
    (syncAccountInfo && syncAccountInfo.clientName) || deviceName || "Firefox PC";

  if (stats) {
    elStatTabsCount.textContent = String(stats.totalSyncedTabs || 0);
    elStatGroupsCount.textContent = String(stats.totalStgGroups || 0);

    if (stats.lastError) {
      elStatusLine.className = "status-line error";
      elStatusLine.textContent = `Ошибка: ${stats.lastError}`;
    } else {
      elStatusLine.className = "status-line";
      elStatusLine.textContent = stats.lastActionText || "Зеркало активно";
    }
  }
}

async function saveCurrentSettings() {
  const settings = {
    mirrorEnabled: elMirrorEnabled.checked,
    syncCloseTabs: elSyncCloseTabs.checked,
    syncUrlChanges: elSyncUrlChanges.checked,
    syncMoveGroups: elSyncMoveGroups.checked,
    syncPinnedTabs: elSyncPinnedTabs.checked,
    pollIntervalSec: Math.max(4, Math.min(120, Number(elPollIntervalSec.value) || 8))
  };
  await browser.runtime.sendMessage({ action: "saveSettings", settings });
  const fresh = await browser.runtime.sendMessage({ action: "getStatus" });
  renderState(fresh);
}

for (const el of [
  elMirrorEnabled,
  elSyncCloseTabs,
  elSyncUrlChanges,
  elSyncMoveGroups,
  elSyncPinnedTabs,
  elPollIntervalSec
]) {
  el.addEventListener("change", saveCurrentSettings);
}

btnSyncNow.addEventListener("click", async () => {
  elStatusLine.textContent = "Синхронизация с Firefox Sync...";
  await browser.runtime.sendMessage({ action: "syncNow" });
  const fresh = await browser.runtime.sendMessage({ action: "getStatus" });
  renderState(fresh);
});

btnForcePush.addEventListener("click", async () => {
  elStatusLine.textContent = "Отправка всех вкладок в облако Firefox Sync...";
  await browser.runtime.sendMessage({ action: "forcePushAll" });
  const fresh = await browser.runtime.sendMessage({ action: "getStatus" });
  renderState(fresh);
});

btnForcePull.addEventListener("click", async () => {
  elStatusLine.textContent = "Загрузка вкладок из облака Firefox Sync...";
  await browser.runtime.sendMessage({ action: "forcePullAll" });
  const fresh = await browser.runtime.sendMessage({ action: "getStatus" });
  renderState(fresh);
});

(async function initPopup() {
  const res = await browser.runtime.sendMessage({ action: "getStatus" });
  renderState(res);
})();
