// content-script.js
//
// Runs on EVERY page (matches: <all_urls>) because alarm state is GLOBAL — if the
// alarm is active, the overlay must show up no matter which tab the user switches to,
// not just the tab that triggered it. Kept deliberately small and framework-free per
// the v1 spec (no React/bundle in the content script).
//
// Two independent jobs:
//   1. Watch chrome.storage for alarmStatus changes and show/hide a full-screen glass
//      overlay (rendered inside a closed Shadow DOM so the host page's CSS/JS can't
//      interfere with it, and the page can't easily read the answer field from it).
//   2. On youtube.com specifically: report the current channel name to the background
//      (for the study-channel allowlist) and pause the video when the alarm fires.

(function () {
  const isYouTube = location.hostname.includes("youtube.com") || location.hostname.includes("youtu.be");

  let shadowHost = null;
  let shadowRoot = null;

  // ---------------------------------------------------------------------
  // Overlay rendering (glassmorphism: blurred backdrop + floating frosted card)
  // ---------------------------------------------------------------------

  function ensureShadowRoot() {
    if (shadowRoot) return shadowRoot;
    shadowHost = document.createElement("div");
    shadowHost.id = "__focus_alarm_host__";
    shadowHost.style.all = "initial";
    document.documentElement.appendChild(shadowHost);
    shadowRoot = shadowHost.attachShadow({ mode: "closed" });
    return shadowRoot;
  }

  function removeOverlay() {
    if (shadowHost) {
      shadowHost.remove();
      shadowHost = null;
      shadowRoot = null;
    }
    detachKeyboardBlocker();
  }

  // -----------------------------------------------------------------------
  // Keyboard blocking -- while the overlay is up, keystrokes must not reach
  // the underlying page. Without this, YouTube's own hotkeys (space to
  // play/pause, arrow keys to seek, 'f' for fullscreen, etc.) still fire even
  // though the overlay is visually on top, because keyboard events target
  // whatever element has focus, not whatever's on top visually.
  //
  // This listens in the CAPTURE phase on `window` -- capture phase runs
  // top-down (window before document before the actual target), so as long
  // as the page's own listeners are attached to `document` or lower (the
  // overwhelming majority of sites, including YouTube), this intercepts the
  // event first, regardless of when either listener was registered.
  // -----------------------------------------------------------------------

  let keyboardBlockerAttached = false;

  function handleGlobalKeyCapture(event) {
    if (!shadowHost) return;

    // For a CLOSED shadow root, event.target is retargeted to the shadow HOST
    // itself when observed from outside the shadow tree -- so this correctly
    // lets real typing into our own answer input through untouched, while
    // blocking everything else (the underlying page's own listeners).
    if (event.target === shadowHost) return;

    event.stopPropagation();
    if (event.stopImmediatePropagation) event.stopImmediatePropagation();
    event.preventDefault();
  }

  function attachKeyboardBlocker() {
    if (keyboardBlockerAttached) return;
    window.addEventListener("keydown", handleGlobalKeyCapture, true);
    window.addEventListener("keyup", handleGlobalKeyCapture, true);
    window.addEventListener("keypress", handleGlobalKeyCapture, true);
    keyboardBlockerAttached = true;
  }

  function detachKeyboardBlocker() {
    if (!keyboardBlockerAttached) return;
    window.removeEventListener("keydown", handleGlobalKeyCapture, true);
    window.removeEventListener("keyup", handleGlobalKeyCapture, true);
    window.removeEventListener("keypress", handleGlobalKeyCapture, true);
    keyboardBlockerAttached = false;
  }

  const OVERLAY_STYLES = `
    :host, * { box-sizing: border-box; }

    .fa-overlay {
      position: fixed;
      inset: 0;
      z-index: 2147483647;
      /* Blurs whatever is behind this element -- the actual page underneath. */
      background: linear-gradient(135deg, rgba(20, 10, 45, 0.55), rgba(10, 15, 35, 0.55));
      backdrop-filter: blur(22px) saturate(150%);
      -webkit-backdrop-filter: blur(22px) saturate(150%);
      color: #f5f3ff;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
      animation: fa-overlay-in 0.25s ease-out;
    }

    @keyframes fa-overlay-in {
      from { opacity: 0; }
      to { opacity: 1; }
    }

    @keyframes fa-card-in {
      from { opacity: 0; transform: translateY(16px) scale(0.96); }
      to { opacity: 1; transform: translateY(0) scale(1); }
    }

    .fa-wrap { max-width: 620px; width: 100%; }

    .fa-header { text-align: center; margin-bottom: 18px; }
    .fa-header h1 {
      font-size: 26px;
      margin: 0 0 6px;
      font-weight: 700;
      text-shadow: 0 2px 20px rgba(139, 92, 246, 0.4);
    }
    .fa-header p { color: rgba(245, 243, 255, 0.7); font-size: 13px; margin: 0; }

    /* The floating glass card -- sits visually "above" the blurred plane behind it. */
    .fa-card {
      background: rgba(255, 255, 255, 0.08);
      backdrop-filter: blur(28px) saturate(180%);
      -webkit-backdrop-filter: blur(28px) saturate(180%);
      border: 1px solid rgba(255, 255, 255, 0.18);
      border-radius: 22px;
      padding: 26px;
      box-shadow:
        0 25px 60px -15px rgba(0, 0, 0, 0.55),
        0 0 0 1px rgba(255, 255, 255, 0.04) inset,
        0 1px 0 rgba(255, 255, 255, 0.15) inset;
      animation: fa-card-in 0.35s ease-out;
    }

    .fa-badges { display: flex; gap: 6px; margin-bottom: 12px; flex-wrap: wrap; }
    .fa-badge {
      display: inline-block;
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      padding: 4px 11px;
      border-radius: 20px;
      background: rgba(255, 255, 255, 0.12);
      border: 1px solid rgba(255, 255, 255, 0.15);
      color: rgba(245, 243, 255, 0.85);
    }

    .fa-question { font-size: 15px; line-height: 1.55; margin: 10px 0; color: #f5f3ff; }

    .fa-code {
      white-space: pre-wrap;
      font-family: "SF Mono", "Courier New", monospace;
      font-size: 13px;
      background: rgba(0, 0, 0, 0.28);
      backdrop-filter: blur(10px);
      border: 1px solid rgba(255, 255, 255, 0.08);
      padding: 14px;
      border-radius: 12px;
      line-height: 1.5;
      overflow-x: auto;
      margin: 10px 0;
      color: #e2d9ff;
    }

    .fa-input {
      width: 100%;
      padding: 11px 14px;
      font-size: 14px;
      border-radius: 12px;
      border: 1px solid rgba(255, 255, 255, 0.18);
      background: rgba(255, 255, 255, 0.06);
      backdrop-filter: blur(10px);
      color: #f5f3ff;
      margin-top: 12px;
      outline: none;
    }
    .fa-input::placeholder { color: rgba(245, 243, 255, 0.4); }
    .fa-input:focus { border-color: rgba(167, 139, 250, 0.6); }

    .fa-submit {
      margin-top: 12px;
      width: 100%;
      padding: 11px;
      background: linear-gradient(135deg, #8b5cf6, #6366f1);
      color: white;
      font-weight: 600;
      border: none;
      border-radius: 12px;
      font-size: 14px;
      cursor: pointer;
      box-shadow: 0 8px 20px -6px rgba(139, 92, 246, 0.6);
    }
    .fa-submit:hover { filter: brightness(1.08); }

    .fa-feedback { min-height: 20px; font-size: 13px; margin-top: 10px; }
    .fa-feedback.correct { color: #86efac; }
    .fa-feedback.wrong { color: #fca5a5; }
    .fa-feedback.info { color: #fde68a; }

    .fa-help-row { display: flex; gap: 8px; margin-top: 14px; }
    .fa-help-btn {
      flex: 1;
      padding: 9px 10px;
      font-size: 12px;
      border-radius: 10px;
      border: 1px solid rgba(255, 255, 255, 0.14);
      background: rgba(255, 255, 255, 0.05);
      color: rgba(245, 243, 255, 0.55);
      cursor: not-allowed;
      transition: all 0.15s;
    }
    .fa-help-btn.unlocked {
      cursor: pointer;
      color: #f5f3ff;
    }
    .fa-help-btn.hint.unlocked {
      background: rgba(250, 204, 21, 0.14);
      border-color: rgba(250, 204, 21, 0.35);
    }
    .fa-help-btn.hint.unlocked:hover { background: rgba(250, 204, 21, 0.22); }
    .fa-help-btn.reveal.unlocked {
      background: rgba(248, 113, 113, 0.14);
      border-color: rgba(248, 113, 113, 0.35);
    }
    .fa-help-btn.reveal.unlocked:hover { background: rgba(248, 113, 113, 0.22); }

    .fa-hint-text {
      margin-top: 10px;
      padding: 10px 12px;
      background: rgba(250, 204, 21, 0.1);
      border: 1px solid rgba(250, 204, 21, 0.25);
      border-radius: 10px;
      font-size: 13px;
      color: #fde68a;
      display: none;
    }
    .fa-hint-text.visible { display: block; }

    .fa-snooze-row { margin-top: 18px; text-align: center; font-size: 12px; color: rgba(245, 243, 255, 0.55); }
    .fa-snooze-btn {
      margin-left: 6px;
      padding: 5px 10px;
      font-size: 11px;
      border-radius: 8px;
      border: 1px solid rgba(255, 255, 255, 0.15);
      background: rgba(255, 255, 255, 0.05);
      color: rgba(245, 243, 255, 0.75);
      cursor: pointer;
    }
    .fa-snooze-btn:hover { background: rgba(255, 255, 255, 0.12); }
    .fa-hint-line { text-align: center; font-size: 11px; color: rgba(245, 243, 255, 0.4); margin-top: 8px; }
  `;

  async function renderOverlay() {
    const root = ensureShadowRoot();
    root.innerHTML = "";

    const styleEl = document.createElement("style");
    styleEl.textContent = OVERLAY_STYLES;
    root.appendChild(styleEl);

    const overlay = document.createElement("div");
    overlay.className = "fa-overlay";
    overlay.innerHTML = `
      <div class="fa-wrap">
        <div class="fa-header">
          <h1>🔒 Time to refocus</h1>
          <p id="fa-progress">Loading...</p>
        </div>
        <div class="fa-card">
          <div class="fa-badges">
            <span class="fa-badge" id="fa-difficulty"></span>
            <span class="fa-badge" id="fa-type"></span>
            <span class="fa-badge" id="fa-attempts"></span>
          </div>
          <div class="fa-question" id="fa-question"></div>
          <pre class="fa-code" id="fa-code" style="display:none;"></pre>
          <input class="fa-input" id="fa-answer" type="text" placeholder="Your answer" autocomplete="off" />
          <button class="fa-submit" id="fa-submit">Submit</button>
          <p class="fa-feedback" id="fa-feedback"></p>

          <div class="fa-help-row">
            <button class="fa-help-btn hint" id="fa-hint-btn">💡 Hint</button>
            <button class="fa-help-btn reveal" id="fa-reveal-btn">👁 Reveal answer</button>
          </div>
          <p class="fa-hint-text" id="fa-hint-text"></p>
        </div>
        <div class="fa-snooze-row" id="fa-snooze-row">
          <span>Not ready yet?</span>
          <button class="fa-snooze-btn" data-minutes="5">Snooze 5m</button>
          <button class="fa-snooze-btn" data-minutes="10">Snooze 10m</button>
          <button class="fa-snooze-btn" data-minutes="30">Snooze 30m</button>
          <button class="fa-snooze-btn" data-minutes="60">Snooze 1h</button>
        </div>
        <p class="fa-hint-line" id="fa-snooze-info"></p>
      </div>
    `;
    root.appendChild(overlay);

    document.documentElement.style.overflow = "hidden";
    attachKeyboardBlocker();

    await loadCurrentQuestion();

    root.querySelector("#fa-submit").addEventListener("click", handleSubmit);
    root.querySelector("#fa-answer").addEventListener("keydown", (e) => {
      if (e.key === "Enter") handleSubmit();
    });
    root.querySelector("#fa-hint-btn").addEventListener("click", handleHintClick);
    root.querySelector("#fa-reveal-btn").addEventListener("click", handleRevealClick);

    root.querySelectorAll(".fa-snooze-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const minutes = parseInt(btn.dataset.minutes, 10);
        const res = await chrome.runtime.sendMessage({ type: "SNOOZE", minutes });
        const infoEl = root.querySelector("#fa-snooze-info");
        if (!res.ok) {
          infoEl.textContent = res.reason || "Could not snooze.";
        }
        // If ok, storage.onChanged will fire and remove the overlay automatically.
      });
    });
  }

  function updateHelpButtons(attempts, hintUnlockAt, revealUnlockAt, hintUnlocked, revealUnlocked) {
    if (!shadowRoot) return;
    const hintBtn = shadowRoot.querySelector("#fa-hint-btn");
    const revealBtn = shadowRoot.querySelector("#fa-reveal-btn");

    if (hintUnlocked) {
      hintBtn.classList.add("unlocked");
      hintBtn.textContent = "💡 Hint";
    } else {
      hintBtn.classList.remove("unlocked");
      const remaining = hintUnlockAt - attempts;
      hintBtn.textContent = `💡 Hint (locked — ${remaining} more wrong attempt${remaining === 1 ? "" : "s"})`;
    }

    if (revealUnlocked) {
      revealBtn.classList.add("unlocked");
      revealBtn.textContent = "👁 Reveal answer";
    } else {
      revealBtn.classList.remove("unlocked");
      const remaining = revealUnlockAt - attempts;
      revealBtn.textContent = `👁 Reveal (locked — ${remaining} more wrong attempt${remaining === 1 ? "" : "s"})`;
    }
  }

  async function loadCurrentQuestion() {
    if (!shadowRoot) return;
    const challenge = await chrome.runtime.sendMessage({ type: "GET_PUBLIC_CHALLENGE" });
    if (!challenge) return;

    const { question, index, total, attempts, hintUnlocked, revealUnlocked, hintUnlockAt, revealUnlockAt } = challenge;

    shadowRoot.querySelector("#fa-progress").textContent = `Question ${index + 1} of ${total}`;
    shadowRoot.querySelector("#fa-difficulty").textContent = question.difficulty;
    shadowRoot.querySelector("#fa-type").textContent = question.type;
    shadowRoot.querySelector("#fa-attempts").textContent = `attempts: ${attempts}`;
    shadowRoot.querySelector("#fa-question").textContent = question.question;

    const codeEl = shadowRoot.querySelector("#fa-code");
    if (question.code) {
      codeEl.textContent = question.code;
      codeEl.style.display = "block";
    } else {
      codeEl.style.display = "none";
    }

    const answerInput = shadowRoot.querySelector("#fa-answer");
    answerInput.value = "";
    shadowRoot.querySelector("#fa-feedback").textContent = "";
    shadowRoot.querySelector("#fa-feedback").className = "fa-feedback";

    const hintTextEl = shadowRoot.querySelector("#fa-hint-text");
    hintTextEl.textContent = "";
    hintTextEl.classList.remove("visible");

    updateHelpButtons(attempts, hintUnlockAt, revealUnlockAt, hintUnlocked, revealUnlocked);
    answerInput.focus();
  }

  async function handleSubmit() {
    if (!shadowRoot) return;
    const answerInput = shadowRoot.querySelector("#fa-answer");
    const feedbackEl = shadowRoot.querySelector("#fa-feedback");

    const res = await chrome.runtime.sendMessage({ type: "SUBMIT_ANSWER", answer: answerInput.value });

    if (!res) {
      feedbackEl.textContent = "Something went wrong. Try again.";
      feedbackEl.className = "fa-feedback wrong";
      return;
    }

    if (res.ok === false) {
      feedbackEl.textContent = res.reason || "Something went wrong.";
      feedbackEl.className = "fa-feedback wrong";
      return;
    }

    if (res.correct) {
      feedbackEl.textContent = "✅ Correct!";
      feedbackEl.className = "fa-feedback correct";
      if (res.done) {
        feedbackEl.textContent = "✅ All done! Unlocking...";
        // storage.onChanged will remove the overlay once alarmStatus flips to INACTIVE
      } else {
        setTimeout(loadCurrentQuestion, 500);
      }
    } else {
      feedbackEl.textContent = "❌ Not quite. Try again.";
      feedbackEl.className = "fa-feedback wrong";
      shadowRoot.querySelector("#fa-attempts").textContent = `attempts: ${res.attempts}`;
      updateHelpButtons(res.attempts, HINT_UNLOCK_ATTEMPTS_FALLBACK, REVEAL_UNLOCK_ATTEMPTS_FALLBACK, res.hintUnlocked, res.revealUnlocked);
    }
  }

  // Fallback thresholds only used for immediate button-label updates before the next
  // full GET_PUBLIC_CHALLENGE refresh -- the background script is the source of truth.
  const HINT_UNLOCK_ATTEMPTS_FALLBACK = 3;
  const REVEAL_UNLOCK_ATTEMPTS_FALLBACK = 5;

  async function handleHintClick() {
    if (!shadowRoot) return;
    const res = await chrome.runtime.sendMessage({ type: "GET_HINT" });
    const hintTextEl = shadowRoot.querySelector("#fa-hint-text");
    const feedbackEl = shadowRoot.querySelector("#fa-feedback");

    if (!res.ok) {
      feedbackEl.textContent = res.reason || "Hint not available yet.";
      feedbackEl.className = "fa-feedback info";
      return;
    }
    hintTextEl.textContent = `💡 ${res.hint}`;
    hintTextEl.classList.add("visible");
  }

  async function handleRevealClick() {
    if (!shadowRoot) return;
    const feedbackEl = shadowRoot.querySelector("#fa-feedback");
    const res = await chrome.runtime.sendMessage({ type: "REVEAL_ANSWER" });

    if (!res.ok) {
      feedbackEl.textContent = res.reason || "Reveal not available yet.";
      feedbackEl.className = "fa-feedback info";
      return;
    }

    feedbackEl.textContent = `Answer was: ${res.answer} — moving on...`;
    feedbackEl.className = "fa-feedback info";

    if (!res.done) {
      setTimeout(loadCurrentQuestion, 1200);
    }
    // if done, storage.onChanged removes the overlay once alarmStatus flips to INACTIVE
  }

  // ---------------------------------------------------------------------
  // React to global alarm state changes
  // ---------------------------------------------------------------------

  async function syncOverlayWithState() {
    const stored = await chrome.storage.local.get("state");
    const alarmStatus = stored.state ? stored.state.alarmStatus : "INACTIVE";
    if (alarmStatus === "ACTIVE") {
      if (!shadowRoot) await renderOverlay();
      if (isYouTube) pauseYouTubeVideo();
      document.documentElement.style.overflow = "hidden";
    } else {
      removeOverlay();
      document.documentElement.style.overflow = "";
    }
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.state) {
      syncOverlayWithState();
    }
  });

  syncOverlayWithState();

  // ---------------------------------------------------------------------
  // YouTube-specific: pause video + report channel name
  // ---------------------------------------------------------------------

  function pauseYouTubeVideo() {
    const video = document.querySelector("video");
    if (video && !video.paused) {
      try {
        video.pause();
      } catch (e) {
        // best-effort only -- the overlay is the real enforcement mechanism
      }
    }
  }

  function getYouTubeChannelName() {
    const selectors = [
      "ytd-channel-name#channel-name a",
      "#owner #channel-name a",
      "ytd-video-owner-renderer ytd-channel-name a",
      "#upload-info #channel-name a"
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && el.textContent.trim()) return el.textContent.trim();
    }
    return null;
  }

  if (isYouTube) {
    let lastReportedChannel = null;

    const reportChannel = () => {
      const channel = getYouTubeChannelName();
      if (channel && channel !== lastReportedChannel) {
        lastReportedChannel = channel;
        chrome.runtime.sendMessage({ type: "YOUTUBE_CHANNEL_INFO", channel });
      }
    };

    reportChannel();
    setInterval(reportChannel, 3000);

    const observer = new MutationObserver(() => reportChannel());
    observer.observe(document.documentElement, { childList: true, subtree: true });

    setInterval(async () => {
      const stored = await chrome.storage.local.get("state");
      if (stored.state && stored.state.alarmStatus === "ACTIVE") {
        pauseYouTubeVideo();
      }
    }, 2000);
  }
})();
