# Focus Alarm — v0.2 (matches the V1 spec)

A Chrome extension that watches for distracted browsing (YouTube, Instagram, Reddit, etc.),
and once you cross a time threshold, shows a full-screen alarm overlay — on whatever tab
you're on — that only clears once you solve N short coding challenges. Alarm state is
global, not tied to a tab: switch tabs, close the distracting site, whatever — the alarm
stays active until you solve the challenge or use a limited snooze.

This version follows the uploaded `focus-alarm-v1-spec.md` architecture. If anything below
conflicts with that file, the spec file is the source of truth going forward.

## What changed from the very first version
- **No more separate lock tab.** The alarm now renders as an overlay injected directly into
  the page you're on, via a content script + closed Shadow DOM (isolated from the page's own
  CSS/JS). This is what makes "alarm follows you across tabs" possible.
- **Alarm state is global**, stored in `chrome.storage.local`, not attached to any tab ID.
- **Idle time doesn't count.** Uses `chrome.idle` so stepping away from your computer doesn't
  quietly burn down your distraction threshold.
- **Viewing the popup/debug panel pauses tracking instead of resetting it.** Fixed a real bug
  where checking your status would wipe your progress.
- **Timer survives service worker suspension.** MV3 kills the background script when it's
  idle; the timer is rebuilt from real timestamps stored in `chrome.storage.local`, not from
  an in-memory `setInterval`.
- **Answers never leave the background script.** The content script (running inside web
  pages) only ever receives the question text — never the correct answer. Checking happens
  in `background.js`, which the page can't inspect.
- **YouTube gets special handling**: a content script pauses the `<video>` element when the
  alarm fires, and separately reports the current channel name so a "study channel allowlist"
  can exempt educational channels from counting as distraction.
- **Manual "Start Focus Session"** lets you test/use the product without waiting for automatic
  detection to trigger.
- **Debug panel** (`debug.html`) shows live detection state — active tab, distraction/idle
  status, accumulated time vs threshold, snooze/session info — with buttons to force a tick,
  force-trigger the alarm, or reset all state.
- **Hint + reveal system** (new): 3 wrong attempts unlocks a hint (a nudge, not the answer);
  5 wrong attempts unlocks "reveal answer" so you're never permanently stuck. Revealing still
  advances you past the question (it has to, or you'd be stuck forever), but it's tracked
  separately from genuinely solved questions.
- **Glassmorphism redesign**: the page behind the alarm is blurred via `backdrop-filter`, and
  the question sits in a frosted, semi-transparent glass card with shadow/lift — replacing the
  old flat dark-navy card.
- **Reliability fix (critical)**: the background timer now stays alive on its own via an
  invisible offscreen document that sends a heartbeat every 15 seconds, plus backup triggers
  on real tab/window/idle events. Previously, detection quietly stopped working whenever no
  extension page (popup/debug) was open, because Chrome suspends the background service
  worker after ~30s of inactivity. See "Why it needed a keepalive" below.
- **Offscreen keepalive made diagnosable + self-healing**: rather than guessing why it wasn't
  reliable, the debug panel now shows the offscreen document's real status directly
  ("Offscreen keepalive: ACTIVE / MISSING / FAILED — [reason]"), and `tick()` now recreates
  the offscreen document itself if it's ever found missing, from any trigger (alarm, tab
  event, or heartbeat).
- **Keyboard input on the underlying page is now blocked while the alarm is active.**
  Previously, YouTube's own keyboard shortcuts (space to play/pause, arrow keys to seek, etc.)
  still worked even with the overlay visually on top, because keyboard events go to whatever
  has focus, not whatever's on top visually. The content script now intercepts all keyboard
  events in the capture phase and blocks anything not typed into the overlay's own input.

## Why it needed a keepalive (and why v1 of that fix wasn't enough)
Manifest V3 extensions run their background logic in a "service worker" — a script with no
persistent memory that Chrome kills after ~30 seconds of inactivity to save resources. The
`chrome.alarms` API is supposed to reliably wake it back up on schedule even after it's been
killed — but in practice, on a real Chrome install, that wake-up can be delayed or occasionally
missed with nothing else going on. The first fix (an offscreen document that just pinged the
background script to keep it "warm") turned out not to be enough on its own — the ping kept
the service worker alive, but detection still ultimately depended on `chrome.alarms` firing on
schedule, which was still the unreliable part.

The real fix: the offscreen document's heartbeat now **directly runs the detection check
itself**, every ~10 seconds, instead of just pinging to say "I'm here." This matters because
the heartbeat runs on a normal page-context timer (`setInterval` inside `offscreen.js`) — not
inside the service worker — so it isn't subject to service-worker suspension timing at all. It
just keeps running, the whole time, regardless of tab switches, window focus, or whether any
extension page is open. `chrome.alarms` is still there as a backup, but it's no longer the
thing detection actually depends on.

You don't need to do anything to use this — it's automatic once the extension is loaded. The
debug panel's **"Last background tick"** row is how you verify it's working: it should stay
under ~20 seconds at all times, even with every Focus Alarm page closed.

## ⚠️ Important: how to load this update
The `offscreen` permission was added in the previous version. For NEW permissions, a plain
**reload** on the extension card doesn't always reliably re-grant them for unpacked
extensions — this is the most likely reason the offscreen keepalive wasn't actually working
despite the code being correct. To be certain it's applied cleanly this time:

1. Go to `chrome://extensions`
2. **Remove** the Focus Alarm extension entirely (not just reload)
3. **Load unpacked** again, pointing at the fresh folder
4. Refresh any already-open YouTube/distracting-site tabs (F5)
5. Open the debug panel and check the new **"Offscreen keepalive"** row — it should say
   **ACTIVE**. If it instead says MISSING or FAILED, it'll now show you the actual error
   message instead of failing silently, so we can fix the real cause directly.

## File-by-file
- `manifest.json` — MV3 config. `content_scripts` now matches `<all_urls>` (needed so the
  overlay can appear on ANY tab, not just distracting ones).
- `background.js` — the brain. Runs a ~1-minute tick (`chrome.alarms`), tracks distracted
  time using idle-aware, timestamp-based math, triggers the alarm, selects challenge
  questions, and validates submitted answers. All messaging (popup ↔ background ↔ content
  script) is handled here.
- `content-script.js` — injected into every page. Renders the overlay in a closed Shadow DOM
  when `alarmStatus` becomes `"ACTIVE"` (via `chrome.storage.onChanged`), and on YouTube
  specifically, pauses video playback and reports the channel name for the study allowlist.
- `popup.html` / `popup.css` / `popup.js` — settings (distracting sites, study channels,
  threshold, challenge mode/difficulty, topics, snooze limit) + manual focus session +
  basic stats + a "Test alarm now" button.
- `data/questions.json` — the local question bank, **120 questions** (tripled from the
  original 40), covering DSA topics (arrays, strings, linked lists, stacks/queues, sorting,
  recursion, hashmaps, two-pointers, binary search, trees, DP, graphs, complexity) plus core
  CS fundamentals (OOP, Operating Systems, Databases, Networking, language concepts). Format:
  `{ id, topic, type, difficulty, question, code?, hint, answer }`. Types are `output`,
  `debug`, `concept`, `complexity`, `implementation` — all short-answer, no code
  execution/sandbox needed for v1.
- `debug.html` / `debug.js` — a live status page (opens as a real tab, not a popup) showing
  exactly what the background script currently sees: whether the active tab counts as
  distracting, idle state, accumulated time vs threshold, snooze/session state, and how
  recently the background last ticked — refreshed every second, plus buttons to force a tick,
  force-trigger the alarm, or reset all state.
- `offscreen.html` / `offscreen.js` — an invisible keepalive page (see "Why it needed a
  keepalive" above). Never shown to the user; exists purely to keep the background service
  worker from going dormant.

## Step 1 — Load it into Chrome
1. `chrome://extensions`
2. Enable **Developer mode** (top right)
3. **Load unpacked** → select the `focus-alarm-extension` folder
4. Pin the extension icon so you can reach the popup easily

## Step 2 — Configure
Open the popup and set:
- Distracting sites (defaults are prefilled)
- YouTube study channels (optional — leave empty to treat all YouTube as distracting)
- Threshold minutes
- Challenge mode (Light/Normal/Hard, or a custom count) + difficulty
- Topics (optional filter — leave all unchecked to allow every topic)
- Max snoozes

Click **Save settings**.

## Step 3 — Verify the timer/detection actually works (not just "Test alarm now")
"Test alarm now" force-triggers the overlay directly — it proves the overlay/challenge/unlock
flow works, but it skips the timer and detection logic entirely. To verify *that*, use the
debug panel:

1. Open the popup → **Open debug panel** (opens as a normal tab, so it won't close when you
   click into another tab like the popup would).
2. Leave it open in a separate window. Open a distracting site (e.g. YouTube) in another tab.
3. Watch the debug panel: `Counts as distracting?` should flip to **YES**, and the progress
   bar should climb once a minute as the background tick runs.
4. Click **Force tick now** to run one detection cycle immediately instead of waiting up to
   a minute — useful for fast iteration.
5. Click **Reset all state** any time to wipe the timer/alarm/snooze state back to zero and
   start a clean test.
6. For the raw log line-by-line: `chrome://extensions` → find Focus Alarm → click
   **service worker** under "Inspect views" → Console tab. Every tick prints what URL it
   checked, whether it counted as distracting, whether you were idle, and the running total.

This is the real way to confirm the automatic pipeline (tick → idle check → site match →
accumulate → threshold → trigger) is working, separately from the manual override.

## Step 4 — Test the real end-to-end flow (matches the spec's test scenarios)
Set threshold to 1 minute temporarily, then run through:
- **Browser YouTube**: open YouTube, wait ~1 min, confirm video pauses + overlay appears;
  solve the challenge(s); confirm overlay disappears and timer resets.
- **Switch tabs**: trigger the alarm, switch to a different tab — overlay should follow you.
- **Close the distracting tab**: trigger the alarm, close the YouTube tab, open a new tab —
  alarm should still be active there.
- **Idle**: sit on a distracting site, then let your computer go idle (or lock it) — confirm
  the distracted-minutes counter doesn't climb while idle.
- **Snooze**: trigger the alarm, snooze it, confirm it doesn't re-trigger until the snooze
  window passes, and confirm you can't snooze more than your configured max.
- **Study channel allowlist**: add a channel to the allowlist, watch a video from that
  channel — should NOT trigger the alarm even past the threshold.

Set the threshold back to a real value (15–25 min) once everything checks out.

## What's intentionally NOT built yet (per the spec's "What NOT to Build in V1")
- No backend, auth, database, cloud sync, or mobile app.
- No AI/ML YouTube classification — just the allowlist.
- No settings-change friction (e.g., delaying a change that weakens the alarm) — the spec
  lists this as a Phase 5 polish item; settings apply immediately for now.
- No onboarding flow or Ko-fi support link yet.
- No real code execution/sandbox — all questions are short-answer by design (this is
  explicitly recommended in the spec to avoid an unnecessary judge/sandbox in v1).

## Known limitations, stated plainly
- **This is a friction tool, not an unbreakable lock.** Anyone can disable the extension from
  `chrome://extensions`. That's expected and matches the spec ("hard to casually bypass, not
  impossible to bypass").
- **YouTube channel detection uses DOM selectors** that may break if YouTube changes its
  layout. If that happens, the extension still falls back to treating YouTube as distracting
  (fails safe, not silently disabled).
- **Desktop apps (e.g. the YouTube desktop app, not the browser) are out of scope** — a
  browser extension cannot see or control them, and the spec explicitly says not to pretend
  otherwise.

## Next steps, in spec order
1. Run through the testing scenarios above yourself for a few days.
2. Expand `data/questions.json` based on which questions you actually see most / find too
   easy or too hard.
3. Add settings-change friction (delay applying changes that weaken the alarm).
4. Add onboarding + the Ko-fi link.
5. Only after v1 is validated: consider real code execution, smarter YouTube classification,
   and (much later) the mobile app.
