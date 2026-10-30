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

// Problems with the page itself (a refused request, or this file disagreeing with the shape
// background.js returns) are shown on the page. Before, an exception here only reached the
// console and the page just kept showing "-", which looks like "the extension is not working".
function showProblem(text) {
  const el = document.getElementById("alarm-status");
  if (!el) return;
  el.textContent = text;
  el.className = "value bad";
}

async function refresh() {
  try {
    await render();
  } catch (e) {
    console.error("[FocusAlarm debug] render failed:", e);
    showProblem(`Debug page error: ${(e && e.message) || e}. Is debug.js from the same version as background.js?`);
  }
}

async function render() {
  const info = await chrome.runtime.sendMessage({ type: "GET_DEBUG_INFO" });
  if (!info || info.ok === false) {
    showProblem(`Background did not return debug info: ${(info && info.reason) || "no reply"}`);
    return;
  }

  setValue("alarm-status", info.alarmStatus, info.alarmStatus === "ACTIVE" ? "bad" : "good");

  if (info.bank.ok) setValue("bank-status", `${info.bank.count} questions loaded`, "good");
  else setValue("bank-status", `FAILED: ${info.bank.error}`, "bad");

  setValue("last-error", info.lastError || "none", info.lastError ? "bad" : "good");
  setValue(
    "alarms-list",
    info.alarms.length
      ? info.alarms.map((a) => `${a.name} in ${fmtSeconds(Math.max(0, a.scheduledTime - info.now))}`).join(", ")
      : "none",
    info.alarms.length ? "good" : "bad"
  );

  const obs = info.lastObservation;
  if (obs) {
    const secondsAgo = Math.round((info.now - obs.at) / 1000);
    setValue("last-tick", `${secondsAgo}s ago (${obs.why})`, secondsAgo > 120 ? "bad" : "good");
    setValue("active-tab", obs.hostname || "(none / internal page)");
    const label = { countable: "YES, counting", away: "no", paused: "paused" }[obs.kind] || obs.kind;
    setValue("is-distracting", `${label} (${obs.reason})`, obs.kind === "countable" ? "bad" : "good");
    setValue("is-idle", obs.idleState === "active" ? "no (active)" : `YES (${obs.idleState})`, obs.idleState === "active" ? "good" : "neutral");
  } else {
    setValue("last-tick", "none yet. Click \"Force tick now\"", "neutral");
  }
  setValue("yt-channel", (obs && obs.channel) || "(none detected)");

  const thresholdMs = info.thresholdMinutes * 60 * 1000;
  const acc = info.tracking.accumulatedMs;
  const pct = Math.min(100, Math.round((acc / thresholdMs) * 100));
  document.getElementById("progress-bar").style.width = pct + "%";
  setValue("accumulated", `${fmtSeconds(acc)} / ${info.thresholdMinutes}m (${pct}%)`);

  const snoozeActive = info.snooze.snoozeUntil && info.now < info.snooze.snoozeUntil;
  setValue(
    "snooze-status",
    snoozeActive ? `active, ${fmtSeconds(info.snooze.snoozeUntil - info.now)} left` : "not snoozed",
    snoozeActive ? "neutral" : "good"
  );
  setValue("snoozes-used", String(info.snooze.usedThisEpisode));

  const studying = info.studyMode.until && info.studyMode.until > info.now;
  setValue(
    "focus-session",
    studying ? `on, ${fmtSeconds(info.studyMode.until - info.now)} left` : "off",
    studying ? "neutral" : "good"
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