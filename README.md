# Focus Alarm

A Chrome extension that stops you from doomscrolling. When you spend too long on distracting sites, a full-screen alarm covers the page and **will not go away until you solve a set number of coding and CS questions**.

Built for beginners and for people who code every day but still lose hours to YouTube, Reddit and friends.

> Status: pre-release (v0.3). Runs as an unpacked extension; not on the Chrome Web Store. See [AUDIT.md](AUDIT.md) for the audit and release blockers, [docs/TESTING.md](docs/TESTING.md) for the manual tests that still have to be done on real machines, and [docs/STORE_LISTING.md](docs/STORE_LISTING.md) for the store checklist.

---

## Features

- **Automatic detection.** Time on your distracting sites is tracked. Hit the limit and the alarm fires.
- **Full-screen glass overlay** on your open tabs, with keyboard shortcuts blocked so sites like YouTube cannot be controlled behind it. It tells you why it appeared.
- **Real questions, two formats.** Sentence-length answers are multiple choice. Single-word answers are fill in the blank.
- **120 questions** across programming and core CS, easy / medium / hard.
- **Hints after 3 wrong attempts, full reveal after 5.**
- **Study-friendly.** Study channels on YouTube never count as distraction, and **study mode** pauses tracking for a block of time you choose.
- **Snoozes** (5, 10, 30 or 60 minutes) with a limit per streak and an optional daily limit.
- **Master on/off switch** in the popup.
- **First-run setup page** that explains the site list, threshold, study mode, privacy and how to turn the extension off, and asks for site access only when you click.
- **Accessible overlay.** Focus moves into the dialog, Tab stays inside it, multiple choice works like a radio group (arrow keys), answers are announced, and focus returns to the page afterwards.
- **Reliable timer.** Built on `chrome.alarms` and timestamps, not on keeping the background worker alive. It survives the worker being killed and the browser restarting.
- **Fails open.** If questions cannot load, the alarm is skipped instead of locking you out.

## How it works

1. The background service worker wakes on browser events (tab switch, navigation, window focus, idle change) and on `chrome.alarms`: a one-shot alarm set for the moment your limit would be reached, plus a one-minute backstop.
2. Each time it wakes it looks at the active tab and credits the time since the last observation to whatever you were doing **then**. Late alarms or sleeping laptops cannot inflate the count.
3. Time counts only when the active tab is on your blocklist, the browser window is focused, and you are not idle (idle with sound playing, such as a video, still counts).
4. Looking at an unrelated tab for under 5 minutes does not erase your progress. Being away longer resets it.
5. When the limit is reached, the alarm state is saved and every open tab shows the overlay.
6. Questions are chosen from your topics. **Answers are checked only in the background.** Pages and storage only ever hold the public part of a question (text and options), never the answer or hint.

### Browser restarts

Progress is stored locally. If the browser was closed for less than 5 minutes, progress is kept, but the closed time is not counted. After longer, it starts from zero. An alarm that is ringing when you close the browser is still ringing when you reopen it. Snooze and study mode use real clock time, so they keep running while the browser is closed.

## Requirements

- Google Chrome **116 or newer** (or another Chromium browser with the same APIs)
- No account, no build step, no dependencies

## Install (Load unpacked)

1. Clone or download this repo.

   ```bash
   git clone https://github.com/<your-username>/focus-alarm-extension.git
   ```

2. Open `chrome://extensions`.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and select the project folder (the one containing `manifest.json`).
5. Pin the extension from the puzzle-piece menu so the popup is one click away.

A **Welcome** tab opens after install. Add your sites, then choose site access (see Permissions). Nothing is tracked until you do, because Chrome hides tab addresses from extensions that have no site access. Once access is granted the overlay script is also injected into tabs that are already open. The extension does not run in Incognito unless you enable **Allow in Incognito** on its card.

### Updating

After changing any file, click the reload icon on the extension card in `chrome://extensions`. Open tabs may need a refresh for the new overlay code. If `permissions` in `manifest.json` changed, remove and re-add the extension instead.

## Usage

Click the extension icon.

| Setting | What it does |
| --- | --- |
| **Alarm ON / OFF** | Master switch. Off means nothing is tracked and no alarm can ring. |
| **Study mode** | Pauses tracking for 15 to 60 minutes. Stop it any time. |
| **Distracting sites** | One domain per line, e.g. `youtube.com`. Subdomains match (`m.x.com` matches `x.com`); lookalikes do not (`dropbox.com` is not `x.com`). |
| **YouTube study channels** | Channel names you count as studying. Matching is case-insensitive and needs at least 3 characters. |
| **Trigger after** | Distracted minutes before the alarm fires. |
| **Questions to solve** | 1, 2 or 3 via presets, or any number from 1 to 10. |
| **Difficulty** | Mixed, easy, medium or hard. A topic with too few questions of that difficulty is filled from the others. |
| **Max snoozes in a row** | Snoozes allowed before you must solve a question. Solving resets the count. |
| **Daily snooze limit** | Optional cap per day. 0 means no cap. |
| **Topics** | Which topics questions come from. None checked means all. |

Press **Save settings** after changing anything. The popup also shows your site-access status and a **Setup guide, site access and privacy** link that reopens the welcome page.

### Turning it off while it is ringing

Open the popup and click the big switch. The alarm is cleared on every tab immediately. This is intentional, so you are never locked out of your own browser, but it also means the alarm is a commitment device, not a lock.

### Wrong site flagged?

Remove it from **Distracting sites**, or start **Study mode** for a while. For a YouTube channel you trust, add its name under **YouTube study channels**. Channel detection reads the page, so it can be wrong or late. Treat it as a convenience, not a guarantee.

## Testing

The pure logic lives in `engine.js` and is tested without a browser. The background worker is tested against an in-memory fake of the `chrome.*` APIs.

```bash
node --test        # Node 20 or newer, no dependencies to install
```

The tests cover timer maths and threshold crossing, worker restarts, browser restarts, sleep gaps, tab switching, idle and focus, snoozing and daily limits, answer checking and rate limiting, malformed storage, duplicate and concurrent events, message authorisation, YouTube study channels, and validity of the whole question bank.

To check the real extension by hand:

- **Test alarm now** in the popup fires the overlay immediately.
- **Debug panel** (popup button) shows the observed tab, why it does or does not count, the progress bar, scheduled alarms, the question bank and the last error.
- To test automatic detection quickly, set **Trigger after** to 1 minute, open a listed site and stay on it.

## Question bank

Questions live in `data/questions.json`, which you can edit directly. `node --test` fails if a question is malformed.

```json
{
  "id": 42,
  "topic": "arrays",
  "type": "concept",
  "difficulty": "easy",
  "format": "mcq",
  "question": "What is the time complexity of accessing an array element by index?",
  "options": ["O(1)", "O(log n)", "O(n)", "O(n log n)"],
  "answer": "O(1)",
  "hint": "Think about how the address is computed."
}
```

| Field | Notes |
| --- | --- |
| `id` | Unique number. |
| `format` | `"mcq"` or `"blank"` |
| `options` | MCQ only, at least 2. Must include the exact `answer` text. Order is shuffled for each alarm. |
| `accept` | Blank only. Optional list of other accepted answers. |
| `answer` | Blank answers ignore case, spaces and punctuation. |
| `code` | Optional code snippet shown under the question. |
| `hint` | Required. Shown after 3 wrong attempts. Do not put the answer in it. |
| `topic` | One of: `arrays`, `strings`, `linkedlist`, `stacks-queues`, `sorting`, `recursion`, `hashmaps`, `two-pointers`, `binary-search`, `trees`, `dp`, `graphs`, `complexity`, `oop`, `os`, `dbms`, `networking`, `language-concepts` |

Use a one-word answer for `blank`. If the answer is a sentence, make it `mcq`.

## Project structure

```
focus-alarm-extension/
├── manifest.json        Extension manifest (MV3)
├── engine.js            Pure logic: tracking, classification, snoozing, questions, validation
├── background.js        Service worker: wires Chrome events and alarms to engine.js
├── content-script.js    Overlay UI (closed shadow DOM), key blocking, focus handling
├── popup.html/css/js    Toolbar popup
├── welcome.html/css/js  First-run setup and site-access page
├── icons/               16, 32, 48, 128 px icons
├── debug.html/js        Debug panel
├── data/
│   └── questions.json   Question bank
├── tests/               node --test suites and a fake chrome.* for the worker
├── scripts/package.mjs  Release checks and zip builder (node scripts/package.mjs)
├── docs/                TESTING.md, PRIVACY_POLICY.md (draft), STORE_LISTING.md, LICENSE_DECISION.md
├── package.json         Only used to run the tests
└── AUDIT.md             Audit findings, threat model, release checklist, beta plan
```

## Permissions

| Permission | Why |
| --- | --- |
| `storage` | Saves settings, progress and stats locally. |
| `alarms` | Wakes the background worker on schedule. |
| `idle` | Stops counting when you step away or lock the screen. |
| `scripting` | Registers the overlay script for the sites you allow. |
| Site access (**optional**, asked on the welcome page) | Without it Chrome hides the active tab's address and nothing can be tracked. You choose **only my listed sites** or **all sites**. Not granted at install; remove it any time at `chrome://extensions`. |

There is no `tabs`, `offscreen` or `webNavigation` permission, no install-time host permission and no content script declared in the manifest. Trade-offs of the two access choices: [AUDIT.md](AUDIT.md) section 5.

## Privacy

Everything stays on your machine. Settings, progress and stats are kept in `chrome.storage.local` (the YouTube channel of each open tab is kept in memory-only session storage). The extension makes no network requests, runs no remote code and has no analytics. Browsing activity is used only to decide whether the active tab is on your blocklist; no history is recorded. The draft policy is in [docs/PRIVACY_POLICY.md](docs/PRIVACY_POLICY.md) (not yet published anywhere).

## Known limitations

- Turning the switch off, disabling the extension, running in Incognito (when not allowed), or editing the extension's storage ends or avoids the alarm. It cannot stop a determined user, and is not meant to.
- Multiple choice can be brute-forced. The background enforces a minimum 1.5 seconds between attempts and the overlay adds a 2 second cooldown after a wrong pick.
- The overlay cannot appear on `chrome://` pages, the Chrome Web Store or the new tab page, because Chrome blocks content scripts there.
- If the extension is reloaded while an alarm is showing, that tab keeps its old overlay until you click something on it, then the overlay removes itself; refresh the tab.
- With **only my listed sites**, the alarm shows only on those sites; switching to an unrelated tab shows no overlay.
- The overlay's keyboard and screen-reader behaviour was checked with an automated axe-core run and a keyboard script, not yet with NVDA or VoiceOver.
- YouTube study-channel detection reads page elements and may be late or wrong after YouTube layout changes.
- Questions are recall and reasoning questions. There is no code editor or test runner yet.
- Not published on the Chrome Web Store. Not yet tested on Windows or macOS, after a real browser restart, or as a packaged install (see docs/TESTING.md).

## Roadmap

- More topics and a bigger bank
- Student and general-productivity challenge profiles
- Code-editor style questions with test cases (only with an isolated runner)
- Mobile app

## Contributing

Issues and pull requests are welcome. Adding questions to `data/questions.json` is the easiest way to help. Run `node --test` before opening a pull request.