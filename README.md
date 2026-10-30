# Focus Alarm

**Stop doomscrolling. Earn your way back by solving questions.**

Focus Alarm is a Chrome extension that helps you control distracting browsing. Spend too long on a site you have marked as distracting, and a full-screen challenge appears. Solve a set of programming and computer science questions to dismiss it.

Built for students, developers, and anyone who wants to spend less time scrolling and more time focusing.

> **Status: Public testing / Pre-release v0.3**
>
> Focus Alarm is currently distributed as an unpacked Chrome extension. It is not yet published on the Chrome Web Store. Manual testing on real machines is ongoing. Some features may have known issues; please report bugs using the instructions below.

## Features

- **Automatic distraction tracking:** Tracks time spent on configured distracting websites.
- **Full-screen challenge overlay:** Displays a question when your distraction threshold is reached.
- **Two question formats:** Multiple-choice questions and fill-in-the-blank questions.
- **120-question bank:** Programming and core computer science topics, with easy, medium, and hard difficulty levels.
- **Progressive assistance:** Hints unlock after 3 wrong attempts; the answer is revealed after 5.
- **YouTube study channels:** Configure channels that should count as studying rather than distraction.
- **Take a break:** Temporarily pauses distraction tracking for a set time, for studying or a real rest.
- **Snooze:** Temporarily postpones an alarm, with configurable durations and limits.
- **Master switch:** Turn tracking and alarms on or off from the popup.
- **Configurable settings:** Choose distracting websites, trigger threshold, topics, difficulty, number of questions, and snooze limits.
- **First-run setup:** A welcome page explains the setup and lets you choose site access.
- **Persistent progress:** Saves progress locally and handles browser and service-worker restarts.
- **Accessibility support:** Includes keyboard navigation and focus management for the challenge overlay.
- **Fail-open behaviour:** If a question cannot be loaded, the extension is designed to avoid trapping you behind a broken challenge.

## Installation

You do not need to install dependencies or build the extension to use it.

### Requirements

- Google Chrome 116 or newer, or a compatible Chromium-based browser.
- A downloaded copy of this repository.
- Permission to load unpacked extensions in your browser.

### Option A: Download from GitHub

1. Open this repository on GitHub.
2. Click **Code → Download ZIP**.
3. Extract the downloaded ZIP to a folder on your computer.
4. Open `chrome://extensions` in Chrome.
5. Enable **Developer mode** using the toggle in the top-right corner.
6. Click **Load unpacked**.
7. Select the extracted project folder containing `manifest.json`. Do not select the ZIP file itself or an inner folder that does not contain the manifest.
8. Pin Focus Alarm using Chrome's Extensions menu if you want quick access to its popup.
9. Follow the instructions on the welcome page to configure your distracting sites and grant the required site access.

### Option B: Clone the repository

If you have Git installed, open a terminal and run:

```bash
git clone https://github.com/sri-ijan/DevAlarm.git
```

Replace `YOUR-USERNAME` with the actual GitHub repository owner's username.

Then open `chrome://extensions`, enable Developer mode, click **Load unpacked**, and select the cloned folder containing `manifest.json`.

### Important setup notes

- The extension needs site access to identify and track the websites you configure.
- Choose the site-access scope presented during setup: only your listed sites or all sites.
- Without the necessary access, tracking may not work as expected.
- If Chrome displays a permission prompt, review it before granting access.
- Incognito browsing is not supported unless you explicitly enable **Allow in Incognito** in the extension's details.
- The extension cannot inject its overlay into restricted Chrome pages such as `chrome://settings`, the Chrome Web Store, or the new tab page.

## How to Use

1. Click the Focus Alarm icon in Chrome.
2. Add the websites you tend to get distracted by, such as `youtube.com` or `reddit.com`.
3. Select the desired site-access scope and grant access.
4. Set the number of distracted minutes before an alarm triggers.
5. Choose your preferred topics, difficulty, and number of questions.
6. Click **Save settings**.
7. Browse normally. When your configured threshold is reached, the challenge overlay should appear.

### Available settings

| Setting | Description |
|---|---|
| Alarm ON / OFF | Enables or disables tracking and alarms. |
| Distracting sites | Domains whose browsing time should count as distraction. |
| Trigger after | Number of distracted minutes before the alarm triggers. |
| Questions to solve | Configure the challenge length, from 1 to 10 questions. |
| Topics | Select which subjects can appear. Leaving all unchecked uses all topics. |
| Difficulty | Choose mixed, easy, medium, or hard. |
| YouTube study channels | Add channel names that should count as studying. |
| Take a break | Pause tracking for a set time. |
| Max snoozes in a row | Set how many times an alarm can be snoozed before a question must be solved. |
| Daily snooze limit | Optionally limit snoozes per day. |

After changing settings, click **Save settings**.

### What happens when an alarm appears?

A question appears over the current page. Answer it correctly to dismiss the challenge. Wrong attempts are rate-limited; hints become available after three wrong attempts, and the answer can be revealed after five.

The master switch remains available as an emergency way to disable the extension. Focus Alarm is intended as a productivity aid, not an unbreakable restriction.

## How Tracking Works

Focus Alarm uses Chrome's extension APIs and locally stored timestamps to track distraction time.

- Time counts when the active tab is on a configured distracting site, the browser window is focused, and the user is not considered idle.
- Audio playback can affect idle handling; for example, a video playing while the user is away may still count according to the extension's rules.
- Switching briefly to an unrelated tab does not immediately erase progress.
- Longer periods away may reset progress according to the configured tracking logic.
- Browser restarts preserve progress under the extension's restart rules, without counting time while the browser is closed.
- Taking a break pauses tracking temporarily.

These behaviours are part of the current implementation and are still being verified on real machines.

## Manual Testing

**We need testers.** Automated tests cover the extension's logic, but real-browser testing is also necessary.

Please install the extension and try the following scenarios:

- [ ] Installation works without errors.
- [ ] The welcome page opens and setup instructions are understandable.
- [ ] Site access can be granted and revoked.
- [ ] Only configured distracting websites are counted under the restricted-access configuration.
- [ ] The timer increases while browsing a configured distracting site.
- [ ] The timer does not increase on unrelated websites.
- [ ] The alarm appears when the threshold is reached.
- [ ] Incorrect answers are rejected.
- [ ] Correct answers dismiss the challenge.
- [ ] Hints unlock after three wrong attempts.
- [ ] Answer reveal works after five wrong attempts.
- [ ] Take a break pauses tracking and tracking resumes when the break ends.
- [ ] The master switch stops tracking and alarms when disabled.
- [ ] Switching tabs behaves as expected.
- [ ] Browser restart preserves progress according to the documented rules.
- [ ] Idle detection stops counting when appropriate.
- [ ] Snooze expires and the alarm/timer resumes as expected.
- [ ] Restricted Chrome pages are not counted.
- [ ] Reloading or updating the extension does not leave the browser in a broken state.

### Known issues under investigation

The following behaviours have been observed during real-browser testing and are not yet confirmed fixed:

**1. Snooze recovery:** After clicking Snooze, the timer may remain stopped after the snooze duration expires, and the alarm may fail to return.

**2. Idle detection:** The distraction timer may continue increasing even when the user has stopped interacting with the computer and the video is paused.

Please test these scenarios if possible, but do not assume they work correctly until a fix has been verified.

### How to report a bug

Open the repository's **Issues** tab and create a report containing:

- Operating system and version.
- Chrome version.
- Extension version or commit tested.
- Steps to reproduce the problem.
- Expected behaviour.
- Actual behaviour.
- Screenshot or short screen recording, if useful.
- Whether the issue happens consistently or intermittently.

Do not include passwords, private browsing information, or other sensitive data in reports.

## Run Automated Tests

If you have Node.js 20 or newer installed, clone or download the repository and open a terminal in the project directory.

Run:

```bash
npm test
```

The test suite uses Node's built-in test runner and does not require additional packages to run.

The tests cover timer calculations, threshold crossing, service-worker restarts, browser restarts, sleep gaps, tab switching, idle and focus behaviour, snoozing, answer validation, rate limiting, access control, malformed stored data, and question-bank validation.

**Note:** Passing automated tests does not guarantee that every feature works correctly in a real Chrome session. Please report real-browser failures even if the test suite passes.

## Project Structure

```text
focus-alarm-extension/
├── manifest.json
├── engine.js
├── background.js
├── content-script.js
├── popup.html
├── popup.css
├── popup.js
├── welcome.html
├── welcome.css
├── welcome.js
├── icons/
├── data/
│   └── questions.json
├── tests/
├── scripts/
├── docs/
├── package.json
├── AUDIT.md
└── README.md
```

- `engine.js` — Tracking logic, classification, snoozing, questions, and validation.
- `background.js` — Service worker, Chrome events, timers, and alarms.
- `content-script.js` — Challenge overlay and page interaction.
- `popup.*` — Extension popup and settings.
- `welcome.*` — First-run setup and site-access controls.
- `data/questions.json` — Question bank.
- `tests/` — Automated tests and Chrome API mocks.
- `docs/` — Testing, privacy, and release-related documentation.
- `scripts/` — Packaging and release utilities.

## Permissions and Privacy

Focus Alarm uses Chrome extension permissions to provide its functionality.

- **Storage:** Stores settings, progress, and statistics locally.
- **Alarms:** Schedules timer updates and threshold checks.
- **Idle:** Detects periods of user inactivity.
- **Scripting:** Registers the overlay script for websites you allow.
- **Site access:** Allows the extension to inspect the active site's address and run the challenge overlay where permitted.

The intended design stores settings and progress locally and does not require an account. The extension is designed not to record browsing history or send browsing activity to a remote server.

Site access is necessary for the extension to identify configured sites. Review the permissions requested by the installed build and the project's privacy documentation before use.

See `docs/PRIVACY_POLICY.md` for the current draft privacy policy and `AUDIT.md` for security and release notes.

## Limitations

- Focus Alarm is a commitment device, not a security boundary. Users can disable or remove it.
- The overlay cannot run on certain restricted Chrome pages.
- YouTube study-channel detection depends on page elements and may be inaccurate after YouTube changes its interface.
- The question bank currently focuses on recall and reasoning questions. It does not include a code editor or code execution environment.
- Accessibility checks have included automated and keyboard-based testing; additional screen-reader testing is still needed.
- Real-world browser behaviour may differ from automated test results.

## Contributing

Contributions, bug reports, and suggestions are welcome.

Useful ways to contribute:

- Test the extension on different operating systems and Chrome versions.
- Report reproducible bugs.
- Suggest improvements to the interface or setup instructions.
- Add and review questions in `data/questions.json`.

If you modify the code, run `npm test` before submitting a pull request.

## Roadmap

- More question topics and a larger question bank.
- More flexible productivity profiles.
- Improved testing across operating systems and browser sessions.
- Code-editor-style questions with an isolated execution environment.

## License

Check the repository for the applicable license before redistributing or modifying this project. If no license has been added yet, reuse and redistribution permissions have not been explicitly granted.

---

**Thanks for helping test Focus Alarm.** Real-world feedback is essential for making the extension more reliable before its first stable release.