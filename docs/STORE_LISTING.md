# Chrome Web Store listing pack

Status: **draft material only. Nothing has been submitted and no approval exists.** Chrome's policies and the Developer Dashboard change; re-read the current "Program Policies", "User Data FAQ" and "Listing requirements" pages in the Chrome Web Store developer documentation on the day you submit.

## 1. Single purpose statement (Dashboard, Privacy tab)

> Focus Alarm interrupts time spent on distracting websites you choose, with a full-screen alarm that is dismissed by solving a few short coding questions.

Keep every feature tied to this. Taking a break, snoozes and YouTube study channels all exist to make that one purpose usable, which is how to describe them if asked.

## 2. Listing text

**Name:** Focus Alarm (check the name is free and not confusingly similar to an existing product before paying).

**Short description (max 132 characters):**
`Doomscrolling alarm for developers: solve a few coding questions to get back to your tab. All data stays on your device.`

**Detailed description (draft):**

> Focus Alarm helps you stop losing hours to YouTube, Reddit and other feeds.
>
> You choose the distracting sites and a time limit. When you reach it, a full-screen alarm covers the page until you solve a few short programming and computer-science questions (data structures, algorithms, complexity, operating systems, databases, networking and more). Multiple choice and fill in the blank, easy to hard, 120 questions.
>
> - You pick the sites, the time limit and the number of questions.
> - Take a break pauses tracking for 15 to 60 minutes.
> - YouTube study channels never count as distraction.
> - Snooze a limited number of times if you really need to.
> - One big switch in the popup turns everything off at any moment. It is a commitment device, not a lock.
> - Keyboard friendly and screen-reader labelled.
>
> Privacy: everything stays on your device. No account, no analytics, no servers. The extension only looks at which site your active tab is on, to compare it with your list. It asks for site access only when you allow it, and you can limit that to your listed sites.
>
> Built for developers and learners. [Add a repo link only if you publish the source; do not say "open source" until a licence is chosen.]

Avoid: "blocks websites" (it does not block), medical or productivity guarantees, "AI", and any claim of store approval or endorsement.

**Category:** Productivity. **Language:** English.

## 3. Permission justifications (Dashboard "Privacy practices" tab)

| Permission | Justification text to paste |
| --- | --- |
| `storage` | Saves the user's settings (site list, time limit, question preferences), timing progress and simple counters locally on the device. |
| `alarms` | Schedules the checks that measure time spent on the user's listed sites, and the moment the limit is reached, even when the extension's background worker is asleep. |
| `idle` | Stops counting when the user is away from the computer or the screen is locked, so away time is not treated as distraction. |
| `scripting` | Registers the script that shows the full-screen alarm on pages the user has allowed. Used with the optional site access below. |
| Optional host permission `<all_urls>` | Requested only after the user clicks "Allow" during setup. Without it Chrome hides the address of the active tab, so the extension cannot tell whether the user is on a listed site, and cannot draw the alarm. The user may instead grant only their listed sites. No page content is read or transmitted. |

Not requested: `tabs`, `webNavigation`, `history`, `cookies`, `offscreen`, any required (install-time) host permission, any content script declared in the manifest.

The reviewer may still ask why not only the listed sites. Honest answer: the product intent is that the alarm appears on whatever tab you are looking at (otherwise switching tabs hides it), so "all sites" is offered; "only my list" is offered for users who prefer less access, and works with the trade-off that the alarm appears only on listed sites. See AUDIT.md section 5 for the full trade-off.

## 4. Data usage form (Dashboard, Privacy practices)

Answer to match PRIVACY_POLICY.md exactly. Suggested answers; confirm against the live form.

| Question | Answer |
| --- | --- |
| Does the extension collect or use any of these user data types? | **Web history**: tick only if the form's definition covers "pages visited"; the extension reads the current tab's host to compare with the user's list and does not record visited pages. Read the form's definition. If unsure, disclose it, since the cost of over-disclosing is lower than of under-disclosing. **Website content**: no (YouTube channel name only; disclose it if the form treats this as page content). Everything else (personally identifiable information, health, financial, authentication, personal communications, location, user activity such as clicks or keystrokes): no. |
| Sell user data to third parties? | No |
| Use or transfer for purposes unrelated to the single purpose? | No |
| Use or transfer to determine creditworthiness or for lending? | No |

Certifications to tick: data is used only for the single purpose, not sold, not used for unrelated purposes (the Limited Use requirements).

Limited Use statement (also place in the policy and, if there is a website, on it):

> The use of information received from Chrome APIs will adhere to the Chrome Web Store User Data Policy, including the Limited Use requirements.

## 5. Assets checklist

| Asset | Spec (verify against the live dashboard) | Status |
| --- | --- | --- |
| Extension icons 16, 32, 48, 128 px PNG | In `icons/`, referenced in `manifest.json`. Simple original alarm-clock mark. | **Done (placeholder-quality design; consider a designer)** |
| Store icon 128 x 128 | Use `icons/icon128.png`. The dashboard wants 96 x 96 visible artwork with transparent padding; check how it crops. | Check on upload |
| Screenshots, at least 1, up to 5 | 1280 x 800 (preferred) or 640 x 400, PNG or JPEG, no rounded or alpha corners | **Not made** |
| Small promo tile | 440 x 280 | **Not made** (recommended; required for featuring) |
| Marquee promo tile | 1400 x 560 | Optional, not made |
| Promo video | Optional | No |

Screenshots to capture (real product, real pages, no fake UI, no third-party logos or copyrighted page content in them; use a neutral page or your own site):

1. The alarm overlay over a page, multiple choice question visible. Caption: "Solve a few questions to get back to your tab."
2. The alarm with a fill-in-the-blank question.
3. The popup: alarm ON, status line, take-a-break card.
4. The popup settings: sites, threshold, number of questions.
5. The welcome page: blocklist, privacy and turning it off.

Capture method: browser window 1280 x 800, 100% zoom, light desktop clutter hidden. Do not show your own history, tabs or email. I generated working-quality dev screenshots during testing, but they use a fake page named "Pretend feed" and are not suitable for the store.

## 6. Pre-submission checklist

Tick only what is true.

- [ ] `node --test` passes on the exact commit being shipped.
- [ ] `node scripts/package.mjs` produced the zip; unzipped copy loaded and works (TESTING.md C).
- [ ] TESTING.md sections A and B done on Windows and macOS; results recorded.
- [ ] Version in `manifest.json` bumped for every upload (store rejects a repeated version).
- [ ] Privacy policy published at an HTTPS URL; URL entered in the dashboard.
- [ ] Data usage form answered to match the policy.
- [ ] Permission justifications pasted.
- [ ] Screenshots and promo tile uploaded.
- [ ] Single purpose statement entered.
- [ ] Contact email in the dashboard is monitored and verified.
- [ ] LICENSE decision made (docs/LICENSE_DECISION.md); repo link valid if you list one.
- [ ] Distribution: start with "Private" or "Unlisted" to trusted testers before "Public".
- [ ] One-time developer registration fee paid (currently quoted at USD 5; confirm) only at this point.
- [ ] Review expectations: wide-host extensions and extensions that read browsing activity may get longer review. Optional host permissions and no content scripts at install should help, but nothing here guarantees approval or timing.