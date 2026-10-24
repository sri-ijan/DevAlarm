# Focus Alarm privacy policy

> DRAFT for the developer to review. Fill every [BRACKET], host the final text at a stable public HTTPS URL, and paste that URL into the Developer Dashboard. This is a plain-language draft, not legal advice; have it checked if you operate commercially or serve users in regulated regions. Delete this note before publishing.

Effective date: [DATE]
Developer: [YOUR NAME OR ORGANISATION]
Contact: [CONTACT EMAIL]

## Summary

Focus Alarm works entirely on your device. It does not send any data to the developer or to anyone else. It has no account, no analytics, no advertising and no remote servers.

## What the extension reads

- **The address (host name) of the tab you are on**, only to decide whether it is on the list of distracting sites that you wrote. This is used for the single purpose of timing your time on those sites and showing the alarm.
- **On YouTube watch pages, the name of the channel**, only to let you mark study channels as not distracting.
- **Whether you are idle or the browser is focused**, to avoid counting time when you are away.

The extension does not read page content (other than the YouTube channel name), form fields, passwords, cookies, history, bookmarks or search queries. It does not record the pages you visit.

## What the extension stores

Stored only in your browser (`chrome.storage`), on your device:

- Your settings: site list, study channels, threshold, number of questions, difficulty, topics, snooze limits.
- Timing state: how long you have been on listed sites in the current streak, which listed site triggered the last alarm, and whether an alarm, snooze or study mode is active.
- Simple counters: alarms triggered, questions solved, answers revealed, snoozes.
- Whether you finished the first-run setup.
- Temporary (cleared when the browser closes): the YouTube channel of each open tab.

Nothing stored identifies you. This data is never uploaded.

## Sharing and sale

None. The extension does not transmit, share, sell or transfer user data to any third party, and does not use it for advertising, credit or lending decisions, or any purpose other than the features described above.

## Permissions and why

- `storage`: save your settings and progress on your device.
- `alarms`: wake the extension to check your time on schedule.
- `idle`: detect when you are away so that time is not counted.
- `scripting`: show the full-screen alarm on pages you have allowed.
- Site access (optional, requested by you): lets the extension see which site you are on and show the alarm there. Choose "only my list" to limit this to the sites you listed, or "all sites" to show the alarm on any tab while one is ringing. You can remove this access at any time at `chrome://extensions`.

## Your choices and deleting data

- Turn the alarm off with the switch in the extension popup. Nothing is then timed.
- Remove site access at `chrome://extensions` (Details, Site access).
- Remove the extension to delete everything it stored. It also leaves no data anywhere else.

## Children

The extension is a general productivity tool and does not knowingly collect personal information from anyone, including children.

## Changes

If this policy changes, the new text will be posted at this address with a new effective date. Any change that adds data collection would require a new version of the extension and a store-visible disclosure.

## Contact

[CONTACT EMAIL]

---

## Developer notes (remove before publishing)

Requirements this draft is meant to satisfy, and what you must keep true:

1. The policy must be linked in the Developer Dashboard (Privacy tab), served over HTTPS, and available without login.
2. It must match the dashboard data-use disclosure exactly (see STORE_LISTING.md, "Data usage form").
3. If you ever add telemetry, a backend, sync or AI classification, this policy and the dashboard form must be updated **before** that version ships.
4. Hosting options: GitHub Pages from the repo, a public GitHub Gist is not recommended (not a stable site). A single static page on any host you control works.
5. Keep the claim "no network requests" true: the only fetch in the code is the extension's own `data/questions.json`. Re-check with `grep -rn "fetch(" *.js` before each release.