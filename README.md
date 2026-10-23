# Focus Alarm

A Chrome extension that stops you from doomscrolling. When you spend too long on distracting sites, a full-screen alarm covers the page and **will not go away until you solve a set number of coding and CS questions**.

Built for beginners and for people who code every day but still lose hours to YouTube, Reddit and friends.

> Status: early version (v0.3). Runs as an unpacked extension. A mobile app is a possible future step.

---

## Features

- **Automatic detection.** Time spent on your distracting sites is tracked. Hit the limit and the alarm fires.
- **Full-screen glass overlay** on every open tab, with keyboard shortcuts blocked so sites like YouTube cannot be controlled behind it.
- **Real questions, two formats.**
  - Sentence-length answers are **multiple choice**.
  - Single-word answers are **fill in the blank**.
- **120 questions** across programming and core CS, easy / medium / hard.
- **Hints after 3 wrong attempts, full reveal after 5.**
- **Study-friendly.** Channels you mark as study channels never count as distraction.
- **Snoozes** (5, 10, 30 or 60 minutes) with a limit you set.
- **Manual focus sessions** for a fixed block of time.
- **Master on/off switch** in the popup. Turning it off pauses all tracking and hides every setting.
- **Works with no extension page open.** Detection runs from the background, not from the popup.

## How it works

1. A background service worker is kept awake by a small offscreen document that ticks every 10 seconds.
2. Each tick checks the active tab. If it is a distracting site and you are not idle, the distraction timer grows. Internal pages (`chrome://`, the extension's own pages) pause the timer instead of resetting it.
3. When the timer passes your threshold, the alarm state is saved globally and a content script draws the overlay on every tab.
4. Questions are picked from the topics you selected. **Answers are checked only in the background script.** The overlay never receives the correct answer, hint or accepted variants until they are requested.
5. Solve all required questions and the overlay disappears everywhere.

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

Tabs that were already open before installing need a refresh (F5) once, so the overlay script can attach.

### Updating

After changing any file, go to `chrome://extensions` and click the reload icon on the extension, then refresh your open tabs. If you changed `permissions` in `manifest.json`, remove and re-add the extension instead.

## Usage

Click the extension icon.

| Setting | What it does |
| --- | --- |
| **Alarm ON / OFF** | Master switch. Off means nothing is tracked and no alarm can ring. |
| **Manual focus session** | Starts a timed block (15 to 60 min). |
| **Distracting sites** | One domain per line, e.g. `youtube.com`. |
| **YouTube study channels** | Channels that count as studying. |
| **Trigger after** | Distracted minutes before the alarm fires. |
| **Questions to solve** | 1, 2 or 3 via presets, or any number from 1 to 10. |
| **Difficulty** | Mixed, easy, medium or hard. |
| **Max snoozes** | How many snoozes you get per alarm. |
| **Topics** | Which topics questions come from. None checked means all. |

Press **Save settings** after changing anything.

### Turning it off while it is ringing

Open the popup and click the big switch. The alarm is cleared on every tab immediately. This is intentional, so you are never locked out of your own browser, but it also means the alarm is a commitment device, not a lock.

## Testing and debugging

- **Test alarm now** in the popup fires the alarm immediately so you can see the overlay.
- **Debug panel** (button in the popup) shows current state, the distraction timer, the last tick, the offscreen heartbeat and the alarm status. When the switch is off it reads `DISABLED`.
- To test automatic detection quickly, set **Trigger after** to 1 minute, open a listed site and stay on it.

## Question bank

Questions live in `data/questions.json`, which you can edit directly.

```json
{
  "id": 42,
  "topic": "arrays",
  "type": "conceptual",
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
| `format` | `"mcq"` or `"blank"` |
| `options` | MCQ only. Must include the exact `answer` text. Order is shuffled for each alarm. |
| `accept` | Blank only. Optional list of other accepted answers. |
| `answer` | Blank answers ignore case, spaces and punctuation. |
| `code` | Optional code snippet shown under the question. |
| `topic` | One of: `arrays`, `strings`, `linkedlist`, `stacks-queues`, `sorting`, `recursion`, `hashmaps`, `two-pointers`, `binary-search`, `trees`, `dp`, `graphs`, `complexity`, `oop`, `os`, `dbms`, `networking`, `language-concepts` |

Use a one-word answer for `blank`. If the answer is a sentence, make it `mcq`.

## Project structure

```
focus-alarm-extension/
├── manifest.json        Extension manifest (MV3)
├── background.js        Service worker: detection, alarm state, answer checking
├── content-script.js    Overlay UI (closed shadow DOM) and key blocking
├── offscreen.html/js    10-second heartbeat that keeps detection running
├── popup.html/css/js    Toolbar popup
├── debug.html/js        Debug panel
└── data/
    └── questions.json   Question bank
```

## Permissions

| Permission | Why |
| --- | --- |
| `storage` | Saves settings and alarm state locally. |
| `alarms` | Backup wake-up for the service worker. |
| `tabs` | Reads the active tab's URL to detect distracting sites. |
| `idle` | Stops counting when you step away. |
| `offscreen` | Hosts the heartbeat timer. |
| Host access `<all_urls>` | Lets the overlay appear on any page. |

## Privacy

Everything stays on your machine. Settings, timers and stats are kept in `chrome.storage.local`. The extension makes no network requests and has no analytics.

## Known limitations

- Turning the switch off, or disabling the extension, ends the alarm. It cannot stop a determined user.
- Multiple choice can be brute-forced. A wrong pick triggers a 2 second cooldown to slow that down.
- The overlay cannot appear on `chrome://` pages, the Chrome Web Store or the new tab page, because Chrome blocks content scripts there.
- Open tabs need one refresh after installing or updating.
- Not published on the Chrome Web Store.

## Roadmap

- More topics and a bigger bank
- Code-editor style questions with test cases
- Streaks and weekly stats
- Mobile app

## Contributing

Issues and pull requests are welcome. Adding questions to `data/questions.json` is the easiest way to help.