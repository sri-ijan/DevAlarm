// debug.js
// Polls the background script once a second and renders exactly what it's seeing.
// This page stays open as a normal tab (unlike the popup, which closes when you
// click away), so you can leave it open in a second window while you browse a
// distracting site in another tab and watch the numbers move in real time.

function fmtSeconds(ms) {
  const totalSec = Math.round(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}m ${s}s`;
}

function setValue(id, text, cls) {
  const el = document.getElementById(id);
  el.textContent = text;
  el.className = "value" + (cls ? " " + cls : "");
}

async function refresh() {
  const info = await chrome.runtime.sendMessage({ type: "GET_DEBUG_INFO" });
  if (!info) return;

  setValue("alarm-status", info.alarmStatus, info.alarmStatus === "ACTIVE" ? "bad" : "good");

  if (info.offscreenActive) {
    setValue("offscreen-status", "ACTIVE", "good");
  } else if (info.offscreenError) {
    setValue("offscreen-status", `FAILED — ${info.offscreenError}`, "bad");
  } else {
    setValue("offscreen-status", "MISSING", "bad");
  }

  if (info.distraction.lastTickAt) {
    const secondsAgo = Math.round((info.now - info.distraction.lastTickAt) / 1000);
    const stale = secondsAgo > 30; // heartbeat runs every ~10s, so this should almost never be high
    setValue("last-tick", `${secondsAgo}s ago`, stale ? "bad" : "good");
  } else {
    setValue("last-tick", "never yet", "neutral");
  }

  setValue("active-tab", info.hostname || "(internal page)");

  if (info.distractionReason === "internal") {
    setValue("is-distracting", "paused (viewing this debug/popup page)", "neutral");
  } else if (info.isDistracting) {
    setValue("is-distracting", "YES", "bad");
  } else if (info.distractionReason === "study-channel") {
    setValue("is-distracting", "no (recognized study channel)", "good");
  } else {
    setValue("is-distracting", "no", "good");
  }

  setValue("is-idle", info.idle ? "YES (idle)" : "no (active)", info.idle ? "neutral" : "good");
  setValue("yt-channel", info.youtubeChannelForActiveTab || "(none detected)");

  const thresholdMs = info.thresholdMinutes * 60 * 1000;
  const pct = Math.min(100, Math.round((info.distraction.accumulatedMs / thresholdMs) * 100));
  document.getElementById("progress-bar").style.width = pct + "%";
  setValue("accumulated", `${fmtSeconds(info.distraction.accumulatedMs)} / ${info.thresholdMinutes}m (${pct}%)`);

  const snoozeActive = info.snooze.snoozeUntil && info.now < info.snooze.snoozeUntil;
  setValue(
    "snooze-status",
    snoozeActive ? `active, ${fmtSeconds(info.snooze.snoozeUntil - info.now)} left` : "not snoozed",
    snoozeActive ? "neutral" : "good"
  );
  setValue("snoozes-used", String(info.snooze.snoozesUsedThisAlarm));

  const sessionActive = info.focusSession.active && info.focusSession.endsAt > info.now;
  setValue(
    "focus-session",
    sessionActive ? `running, ${fmtSeconds(info.focusSession.endsAt - info.now)} left` : "not running",
    sessionActive ? "neutral" : "good"
  );
}

document.getElementById("force-tick-btn").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "FORCE_TICK" });
  refresh();
});

document.getElementById("force-alarm-btn").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "FORCE_TRIGGER_ALARM" });
  refresh();
});

document.getElementById("reset-btn").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "RESET_STATE" });
  refresh();
});

refresh();
setInterval(refresh, 1000);
