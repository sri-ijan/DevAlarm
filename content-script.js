// content-script.js
//
// Registered dynamically (see background.js syncOverlayScriptLocked) for every site the user
// granted access to: all sites, or just the blocklist. Alarm state is GLOBAL — if the
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
  // Registered scripts and on-demand injection can both load this file into the same tab.
  if (window.__focusAlarmLoaded) return;
  window.__focusAlarmLoaded = true;

  const isYouTube = location.hostname.includes("youtube.com") || location.hostname.includes("youtu.be");

  let shadowHost = null;
  let shadowRoot = null;
  let previousFocus = null; // restored when the overlay goes away
  let inertSet = false; // we made <body> inert and must undo it
  let watchdog = null; // cleans up if the overlay is orphaned or removed
  let loadFailures = 0; // consecutive failures to load the current question

  // Every message goes through send(). If the extension was reloaded or updated while this
  // tab stayed open, the old script can no longer reach the background; in that case the
  // overlay is removed instead of being left behind with dead buttons.
  async function send(message) {
    try {
      if (!chrome.runtime || !chrome.runtime.id) throw new Error("extension context invalidated");
      return await chrome.runtime.sendMessage(message);
    } catch (e) {
      removeOverlay();
      document.documentElement.style.overflow = "";
      return null;
    }
  }

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
    if (watchdog) {
      clearInterval(watchdog);
      watchdog = null;
    }
    const hadOverlay = !!shadowHost;
    if (shadowHost) {
      shadowHost.remove();
      shadowHost = null;
      shadowRoot = null;
    }
    detachKeyboardBlocker();
    setPageInert(false);
    if (hadOverlay && previousFocus && previousFocus.isConnected && typeof previousFocus.focus === "function") {
      try {
        previousFocus.focus({ preventScroll: true });
      } catch (e) {
        /* focus restore is best effort */
      }
    }
    previousFocus = null;
  }

  // While the overlay is up the page behind it must be unreachable for keyboard AND screen
  // reader users (aria-modal is not honoured everywhere), so <body> is made inert. The
  // overlay host is a child of <html>, so it is unaffected.
  function setPageInert(on) {
    try {
      if (on) {
        if (!inertSet && document.body && !document.body.inert) {
          document.body.inert = true;
          inertSet = true;
        }
      } else if (inertSet) {
        if (document.body) document.body.inert = false;
        inertSet = false;
      }
    } catch (e) {
      /* inert unsupported: the keyboard blocker and overlay still work */
    }
  }

  // An inert page must never outlive its overlay: if the extension was reloaded under this
  // tab, or the overlay element was removed, put the page back.
  function startWatchdog() {
    if (watchdog) return;
    watchdog = setInterval(() => {
      const orphaned = !(chrome.runtime && chrome.runtime.id);
      if (orphaned || !shadowHost || !shadowHost.isConnected) {
        removeOverlay();
        document.documentElement.style.overflow = "";
      }
    }, 1500);
  }

  function focusableControls() {
    if (!shadowRoot) return [];
    return [...shadowRoot.querySelectorAll("button, input, pre[tabindex]")].filter(
      (el) => !el.disabled && el.getAttribute("tabindex") !== "-1" && el.getClientRects().length > 0
    );
  }

  // Puts keyboard focus on the thing the user needs next: the option group or the answer box.
  function focusPrimary() {
    if (!shadowRoot) return;
    const option = shadowRoot.querySelector('.fa-option[tabindex="0"]:not(:disabled)');
    const input = shadowRoot.querySelector("#fa-answer");
    const target = option && option.getClientRects().length ? option : input && input.getClientRects().length ? input : focusableControls()[0];
    if (target) target.focus({ preventScroll: true });
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
    // Focus somehow ended up on the page: Tab brings it back into the dialog.
    if (event.type === "keydown" && event.key === "Tab") focusPrimary();
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
      background: linear-gradient(135deg, rgba(20, 10, 45, 0.74), rgba(10, 15, 35, 0.74));
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
    .fa-header p { color: rgba(245, 243, 255, 0.88); font-size: 13px; margin: 0; }

    /* The floating glass card -- sits visually "above" the blurred plane behind it. */
    .fa-card {
      background: rgba(30, 24, 62, 0.55);
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
    .fa-input::placeholder { color: rgba(245, 243, 255, 0.68); }
    .fa-input:focus { border-color: rgba(167, 139, 250, 0.9); }

    /* Multiple-choice options */
    .fa-options { display: flex; flex-direction: column; gap: 8px; margin-top: 12px; }
    .fa-option {
      width: 100%;
      text-align: left;
      padding: 11px 14px;
      font-size: 14px;
      line-height: 1.4;
      font-family: inherit;
      border-radius: 12px;
      border: 1px solid rgba(255, 255, 255, 0.18);
      background: rgba(255, 255, 255, 0.06);
      color: #f5f3ff;
      cursor: pointer;
      transition: background 0.12s, border-color 0.12s;
    }
    .fa-option:hover:not(:disabled) { background: rgba(255, 255, 255, 0.12); }
    .fa-option.selected {
      border-color: rgba(167, 139, 250, 0.9);
      background: rgba(139, 92, 246, 0.22);
    }
    .fa-option { min-height: 44px; }
    .fa-option:disabled { opacity: 0.6; cursor: not-allowed; }
    .fa-submit:disabled { opacity: 0.5; cursor: not-allowed; filter: none; }

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
      color: rgba(245, 243, 255, 0.8);
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

    .fa-why { margin: 6px 0 0; font-size: 13px; color: rgba(245, 243, 255, 0.88); }
    .fa-snooze-row { margin-top: 18px; text-align: center; font-size: 13px; color: rgba(245, 243, 255, 0.85); }
    .fa-snooze-btn {
      margin-left: 6px;
      min-height: 32px;
      padding: 5px 10px;
      font-size: 12px;
      border-radius: 8px;
      border: 1px solid rgba(255, 255, 255, 0.25);
      background: rgba(255, 255, 255, 0.07);
      color: rgba(245, 243, 255, 0.95);
      cursor: pointer;
    }
    .fa-snooze-btn:hover { background: rgba(255, 255, 255, 0.12); }
    .fa-hint-line { text-align: center; font-size: 12px; color: rgba(245, 243, 255, 0.82); margin: 8px 0 0; }
    .fa-recovery {
      margin-top: 14px;
      padding: 12px 14px;
      border-radius: 12px;
      border: 1px solid rgba(250, 204, 21, 0.4);
      background: rgba(250, 204, 21, 0.1);
      font-size: 13px;
      text-align: center;
      color: #fde68a;
    }
    .fa-recovery p { margin: 0 0 8px; }
    .fa-recovery[hidden] { display: none; }

    /* Keyboard focus must always be visible. */
    button:focus-visible, input:focus-visible, pre:focus-visible {
      outline: 3px solid #fde68a;
      outline-offset: 2px;
    }

    @media (prefers-reduced-motion: reduce) {
      .fa-overlay, .fa-card { animation: none; }
      .fa-option, .fa-help-btn { transition: none; }
    }
  `;

  async function renderOverlay() {
    previousFocus = document.activeElement && document.activeElement !== document.body ? document.activeElement : null;
    const root = ensureShadowRoot();
    root.innerHTML = "";

    const styleEl = document.createElement("style");
    styleEl.textContent = OVERLAY_STYLES;
    root.appendChild(styleEl);

    const overlay = document.createElement("div");
    overlay.className = "fa-overlay";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-labelledby", "fa-title");
    overlay.setAttribute("aria-describedby", "fa-progress fa-why");
    overlay.innerHTML = `
      <div class="fa-wrap">
        <div class="fa-header">
          <h1 id="fa-title">Time to refocus</h1>
          <p id="fa-progress" aria-live="polite">Loading...</p>
          <p class="fa-why" id="fa-why"></p>
        </div>
        <div class="fa-card">
          <div class="fa-badges">
            <span class="fa-badge" id="fa-difficulty"></span>
            <span class="fa-badge" id="fa-type"></span>
            <span class="fa-badge" id="fa-attempts"></span>
          </div>
          <div class="fa-question" id="fa-question"></div>
          <pre class="fa-code" id="fa-code" tabindex="0" role="region" aria-label="Code for this question" style="display:none;"></pre>
          <div class="fa-options" id="fa-options" role="radiogroup" aria-labelledby="fa-question" style="display:none;"></div>
          <input class="fa-input" id="fa-answer" type="text" aria-labelledby="fa-question" placeholder="Type the missing word or value" autocomplete="off" />
          <button class="fa-submit" id="fa-submit" type="button">Submit</button>
          <p class="fa-feedback" id="fa-feedback" role="status" aria-live="polite" aria-atomic="true"></p>

          <div class="fa-help-row">
            <button class="fa-help-btn hint" id="fa-hint-btn" type="button" aria-disabled="true">Hint</button>
            <button class="fa-help-btn reveal" id="fa-reveal-btn" type="button" aria-disabled="true">Reveal answer</button>
          </div>
          <p class="fa-hint-text" id="fa-hint-text" role="status" aria-live="polite"></p>
        </div>
        <div class="fa-snooze-row" id="fa-snooze-row" role="group" aria-label="Snooze this alarm">
          <span>Not ready yet?</span>
          <button class="fa-snooze-btn" type="button" data-minutes="5" aria-label="Snooze for 5 minutes">Snooze 5m</button>
          <button class="fa-snooze-btn" type="button" data-minutes="10" aria-label="Snooze for 10 minutes">Snooze 10m</button>
          <button class="fa-snooze-btn" type="button" data-minutes="30" aria-label="Snooze for 30 minutes">Snooze 30m</button>
          <button class="fa-snooze-btn" type="button" data-minutes="60" aria-label="Snooze for 1 hour">Snooze 1h</button>
        </div>
        <p class="fa-hint-line" id="fa-snooze-info" role="status" aria-live="polite"></p>
        <div class="fa-recovery" id="fa-recovery" hidden>
          <p>This alarm could not load its question.</p>
          <button class="fa-snooze-btn" id="fa-recover-btn" type="button">Dismiss this alarm</button>
        </div>
        <p class="fa-hint-line">To stop Focus Alarm entirely, click its toolbar icon and use the big switch.</p>
      </div>
    `;
    root.appendChild(overlay);

    document.documentElement.style.overflow = "hidden";
    attachKeyboardBlocker();
    setPageInert(true);
    startWatchdog();

    // Keep Tab and Shift+Tab inside the dialog.
    overlay.addEventListener("keydown", (e) => {
      if (e.key !== "Tab") return;
      const list = focusableControls();
      if (!list.length) return;
      const i = list.indexOf(shadowRoot.activeElement);
      if (e.shiftKey && i <= 0) {
        e.preventDefault();
        list[list.length - 1].focus();
      } else if (!e.shiftKey && i === list.length - 1) {
        e.preventDefault();
        list[0].focus();
      }
    });

    // Keys typed inside the dialog stay inside it: without this they bubble out through the
    // shadow host to the page's own document/window listeners (site hotkeys, key loggers).
    for (const type of ["keydown", "keyup", "keypress"]) {
      overlay.addEventListener(type, (e) => e.stopPropagation());
    }

    await loadCurrentQuestion();
    focusPrimary();

    root.querySelector("#fa-recover-btn").addEventListener("click", async () => {
      const res = await send({ type: "RECOVER_ALARM" });
      if (res && res.ok === false && shadowRoot) {
        shadowRoot.querySelector("#fa-snooze-info").textContent = res.reason || "Could not dismiss the alarm.";
      }
    });

    root.querySelector("#fa-submit").addEventListener("click", handleSubmit);
    root.querySelector("#fa-answer").addEventListener("keydown", (e) => {
      if (e.key === "Enter") handleSubmit();
    });
    root.querySelector("#fa-hint-btn").addEventListener("click", handleHintClick);
    root.querySelector("#fa-reveal-btn").addEventListener("click", handleRevealClick);

    root.querySelectorAll(".fa-snooze-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const minutes = parseInt(btn.dataset.minutes, 10);
        const res = await send({ type: "SNOOZE", minutes });
        const infoEl = root.querySelector("#fa-snooze-info");
        if (!res) return;
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
    const label = (name, unlocked, unlockAt) => {
      const remaining = unlockAt - attempts;
      return unlocked ? name : `${name} (locked: ${remaining} more wrong attempt${remaining === 1 ? "" : "s"})`;
    };

    hintBtn.classList.toggle("unlocked", hintUnlocked);
    hintBtn.setAttribute("aria-disabled", String(!hintUnlocked));
    hintBtn.textContent = label("Hint", hintUnlocked, hintUnlockAt);

    revealBtn.classList.toggle("unlocked", revealUnlocked);
    revealBtn.setAttribute("aria-disabled", String(!revealUnlocked));
    revealBtn.textContent = label("Reveal answer", revealUnlocked, revealUnlockAt);
  }

  async function loadCurrentQuestion() {
    if (!shadowRoot) return;
    const challenge = await send({ type: "GET_PUBLIC_CHALLENGE" });
    if (!challenge) {
      // The alarm may simply have ended elsewhere (solved, snoozed, switched off): re-check the
      // real state first. If it is still ringing and the question will not load, retry, and
      // after a couple of failures offer the recovery button instead of a blank card.
      loadFailures += 1;
      await syncOverlayWithState();
      if (!shadowRoot) return;
      shadowRoot.querySelector("#fa-progress").textContent = "Loading the question...";
      if (loadFailures >= 2) shadowRoot.querySelector("#fa-recovery").hidden = false;
      if (loadFailures < 6) setTimeout(loadCurrentQuestion, 1500);
      return;
    }
    loadFailures = 0;
    shadowRoot.querySelector("#fa-recovery").hidden = true;

    const { question, index, total, attempts, hintUnlocked, revealUnlocked, hintUnlockAt, revealUnlockAt, trigger, snoozesLeft } = challenge;
    localAdvance = false;
    shownIndex = index;

    const whyEl = shadowRoot.querySelector("#fa-why");
    whyEl.textContent =
      trigger && trigger.hostname
        ? `You spent about ${trigger.minutes} min on ${trigger.hostname}. Solve ${total === 1 ? "this question" : `these ${total} questions`} to continue.`
        : "This alarm was started manually.";

    const snoozeRow = shadowRoot.querySelector("#fa-snooze-row");
    const snoozeInfo = shadowRoot.querySelector("#fa-snooze-info");
    if (typeof snoozesLeft === "number" && snoozesLeft <= 0) {
      snoozeRow.style.display = "none";
      snoozeInfo.textContent = "No snoozes left. Solve the question to continue.";
    } else {
      snoozeRow.style.display = "";
      snoozeInfo.textContent = typeof snoozesLeft === "number" ? `Snoozes left: ${snoozesLeft}` : "";
    }

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
    const optionsEl = shadowRoot.querySelector("#fa-options");
    const submitBtn = shadowRoot.querySelector("#fa-submit");

    selectedOption = null;
    currentFormat = question.format === "mcq" ? "mcq" : "blank";
    answerInput.value = "";
    optionsEl.innerHTML = "";
    submitBtn.disabled = false;
    submitBtn.textContent = "Submit";

    if (currentFormat === "mcq" && Array.isArray(question.options)) {
      // Multiple choice is a radio group: one tab stop, arrow keys move and select.
      answerInput.style.display = "none";
      optionsEl.style.display = "flex";
      question.options.forEach((optionText, i) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "fa-option";
        btn.setAttribute("role", "radio");
        btn.setAttribute("aria-checked", "false");
        btn.tabIndex = i === 0 ? 0 : -1;
        btn.textContent = `${String.fromCharCode(65 + i)}.  ${optionText}`;
        btn.addEventListener("click", () => selectOption(btn, optionText));
        btn.addEventListener("keydown", (e) => onOptionKey(e, btn));
        optionsEl.appendChild(btn);
      });
    } else {
      // Fill in the blank: a single text input.
      optionsEl.style.display = "none";
      answerInput.style.display = "block";
    }

    shadowRoot.querySelector("#fa-feedback").textContent = "";
    shadowRoot.querySelector("#fa-feedback").className = "fa-feedback";

    const hintTextEl = shadowRoot.querySelector("#fa-hint-text");
    hintTextEl.textContent = "";
    hintTextEl.classList.remove("visible");

    updateHelpButtons(attempts, hintUnlockAt, revealUnlockAt, hintUnlocked, revealUnlocked);
    if (currentFormat === "blank") answerInput.focus();
  }

  // Which question format is on screen, and which MCQ option (if any) is selected.
  let currentFormat = "blank";
  let selectedOption = null;
  let shownIndex = -1; // which question this tab is currently showing
  let localAdvance = false; // this tab just advanced the question itself

  function optionButtons() {
    return shadowRoot ? [...shadowRoot.querySelectorAll(".fa-option")] : [];
  }

  function selectOption(btn, optionText) {
    selectedOption = optionText;
    optionButtons().forEach((b) => {
      const on = b === btn;
      b.classList.toggle("selected", on);
      b.setAttribute("aria-checked", String(on));
      b.tabIndex = on ? 0 : -1;
    });
  }

  function textOfOption(btn) {
    return btn.textContent.replace(/^[A-Z]\.\s+/, "");
  }

  function onOptionKey(e, btn) {
    const list = optionButtons();
    const i = list.indexOf(btn);
    let next = null;
    if (e.key === "ArrowDown" || e.key === "ArrowRight") next = list[(i + 1) % list.length];
    else if (e.key === "ArrowUp" || e.key === "ArrowLeft") next = list[(i - 1 + list.length) % list.length];
    else if (e.key === "Enter") {
      e.preventDefault();
      if (selectedOption === null) selectOption(btn, textOfOption(btn));
      handleSubmit();
      return;
    }
    if (next) {
      e.preventDefault();
      next.focus();
      selectOption(next, textOfOption(next));
    }
  }

  // Short lock after a wrong multiple-choice pick, so the answer can't be found by
  // mashing options. Kept deliberately small so it never gets annoying.
  function startCooldown(seconds) {
    if (!shadowRoot) return;
    const submitBtn = shadowRoot.querySelector("#fa-submit");
    const optionBtns = shadowRoot.querySelectorAll(".fa-option");
    let left = seconds;

    // Disabling the control that has focus would drop focus to the page. Park it on the
    // feedback line (focusable by script only) so keyboard and screen-reader users stay put.
    const feedbackEl = shadowRoot.querySelector("#fa-feedback");
    if (feedbackEl && shadowRoot.activeElement && shadowRoot.activeElement !== feedbackEl) {
      feedbackEl.tabIndex = -1;
      feedbackEl.focus({ preventScroll: true });
    }

    selectedOption = null;
    optionBtns.forEach((b, i) => {
      b.classList.remove("selected");
      b.setAttribute("aria-checked", "false");
      b.tabIndex = i === 0 ? 0 : -1;
      b.disabled = true;
    });
    submitBtn.disabled = true;
    submitBtn.textContent = `Try again in ${left}s`;

    const timer = setInterval(() => {
      left -= 1;
      if (!shadowRoot) {
        clearInterval(timer); // overlay was removed (solved, snoozed or disabled)
        return;
      }
      if (left <= 0) {
        clearInterval(timer);
        optionBtns.forEach((b) => (b.disabled = false));
        submitBtn.disabled = false;
        submitBtn.textContent = "Submit";
        focusPrimary();
      } else {
        submitBtn.textContent = `Try again in ${left}s`;
      }
    }, 1000);
  }

  async function handleSubmit() {
    if (!shadowRoot) return;
    const answerInput = shadowRoot.querySelector("#fa-answer");
    const feedbackEl = shadowRoot.querySelector("#fa-feedback");

    let answer;
    if (currentFormat === "mcq") {
      if (selectedOption === null) {
        feedbackEl.textContent = "Pick one of the options first.";
        feedbackEl.className = "fa-feedback info";
        return;
      }
      answer = selectedOption;
    } else {
      answer = answerInput.value;
      if (!answer.trim()) {
        feedbackEl.textContent = "Type your answer first.";
        feedbackEl.className = "fa-feedback info";
        return;
      }
    }

    const res = await send({ type: "SUBMIT_ANSWER", answer });

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
      feedbackEl.textContent = "Correct.";
      feedbackEl.className = "fa-feedback correct";
      if (res.done) {
        feedbackEl.textContent = "All done. Unlocking.";
        // storage.onChanged will remove the overlay once alarmStatus flips to INACTIVE
      } else {
        localAdvance = true;
        setTimeout(loadCurrentQuestion, 500);
      }
    } else {
      feedbackEl.textContent = "Not quite. Try again.";
      feedbackEl.className = "fa-feedback wrong";
      shadowRoot.querySelector("#fa-attempts").textContent = `attempts: ${res.attempts}`;
      updateHelpButtons(res.attempts, HINT_UNLOCK_ATTEMPTS_FALLBACK, REVEAL_UNLOCK_ATTEMPTS_FALLBACK, res.hintUnlocked, res.revealUnlocked);
      if (currentFormat === "mcq") startCooldown(2);
    }
  }

  // Fallback thresholds only used for immediate button-label updates before the next
  // full GET_PUBLIC_CHALLENGE refresh -- the background script is the source of truth.
  const HINT_UNLOCK_ATTEMPTS_FALLBACK = 3;
  const REVEAL_UNLOCK_ATTEMPTS_FALLBACK = 5;

  async function handleHintClick() {
    if (!shadowRoot) return;
    const res = await send({ type: "GET_HINT" });
    const hintTextEl = shadowRoot.querySelector("#fa-hint-text");
    const feedbackEl = shadowRoot.querySelector("#fa-feedback");

    if (!res) return;
    if (!res.ok) {
      feedbackEl.textContent = res.reason || "Hint not available yet.";
      feedbackEl.className = "fa-feedback info";
      return;
    }
    hintTextEl.textContent = `Hint: ${res.hint}`;
    hintTextEl.classList.add("visible");
  }

  async function handleRevealClick() {
    if (!shadowRoot) return;
    const feedbackEl = shadowRoot.querySelector("#fa-feedback");
    const res = await send({ type: "REVEAL_ANSWER" });

    if (!res) return;
    if (!res.ok) {
      feedbackEl.textContent = res.reason || "Reveal not available yet.";
      feedbackEl.className = "fa-feedback info";
      return;
    }

    feedbackEl.textContent = `Answer was: ${res.answer} — moving on...`;
    feedbackEl.className = "fa-feedback info";

    if (!res.done) {
      localAdvance = true;
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
    if (area !== "local" || !changes.state) return;
    const next = changes.state.newValue;
    syncOverlayWithState().then(() => {
      // Another tab answered a question: show the current one here too, not a stale one.
      const idx = next && next.currentChallenge ? next.currentChallenge.currentIndex : -1;
      if (shadowRoot && next && next.alarmStatus === "ACTIVE" && !localAdvance && idx !== shownIndex) {
        loadCurrentQuestion();
      }
    });
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
    // null = nothing sent yet, "" = "this page has no channel" (home, shorts, search...).
    // Reporting "" matters: otherwise the last watched channel would keep the tab classified
    // as study time after the user navigates to the home feed.
    let lastReported = null;
    const currentChannel = () => (location.pathname.startsWith("/watch") ? getYouTubeChannelName() || "" : "");
    const report = () => {
      const channel = currentChannel();
      if (channel === lastReported) return;
      lastReported = channel;
      send({ type: "YOUTUBE_CHANNEL_INFO", channel });
    };

    report();
    window.addEventListener("yt-navigate-finish", report);
    setInterval(report, 3000);
    setInterval(() => {
      if (shadowRoot) pauseYouTubeVideo();
    }, 2000);
  }
})();