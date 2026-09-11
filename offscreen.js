// offscreen.js
//
// Runs inside the invisible offscreen document. This is the extension's REAL heartbeat.
//
// Why this exists: Chrome suspends (kills) the MV3 service worker after ~30 seconds of no
// activity, and chrome.alarms -- while documented as reliable -- can in practice be delayed
// or occasionally missed as the sole trigger for periodic work. An offscreen document runs
// in a normal page-like context (no tab, no window, nothing the user sees), which is NOT
// subject to service-worker suspension timing at all -- its setInterval just keeps running.
//
// So instead of only pinging the background script to keep it "warm," this heartbeat directly
// tells it to run a detection check every ~10 seconds. That means distraction tracking no
// longer depends on chrome.alarms firing on schedule, or on any tab/window event happening --
// it happens on this reliable page-context timer regardless of what else is going on.

function sendHeartbeat() {
  chrome.runtime.sendMessage({ type: "HEARTBEAT_TICK" }).catch(() => {
    // If this fails it just means the service worker is mid-restart -- harmless,
    // the next heartbeat (10s later) will reach it fine.
  });
}

sendHeartbeat();
setInterval(sendHeartbeat, 10000);
