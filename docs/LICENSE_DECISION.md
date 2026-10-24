# LICENSE decision

No LICENSE file has been added. Choosing a licence is the owner's decision; without one the default is "all rights reserved", meaning nobody may legally copy or reuse the code, even though it may be public on GitHub. This note exists so you can choose deliberately. It is not legal advice.

## Options

| Option | What it means | Good if | Watch out |
| --- | --- | --- | --- |
| **MIT** | Anyone may use, modify, sell it, including closed forks. Keep the copyright notice. | You want maximum adoption and contributions and do not mind competitors reusing it. | A company could repackage and sell it. Does not protect a future paid tier from being copied. |
| **Apache-2.0** | Like MIT plus an express patent grant and trademark clause. | You want contributor and user patent clarity. Slightly heavier text. | Same copying risk as MIT. |
| **GPL-3.0 / AGPL-3.0** | Anyone may use and modify but derivatives must stay open under the same licence. | You want forks to stay open. | Deters some companies. Complicates relicensing and dual licensing later, unless you hold contributor rights (CLA). |
| **Source-available (for example BUSL, PolyForm Noncommercial)** | Code visible, commercial reuse restricted. Not "open source" by OSI. | You plan a paid product and want to stop direct commercial clones. | Some contributors and store reviewers read "open source" claims strictly: do not call it open source. |
| **All rights reserved (no licence)** | Nobody may reuse. | Closed product, or you have not decided and want to keep options open. | Do not say "open source" in the listing or README. Contributions get legally murky. |

## What matters for your situation

- You may want a paid tier later (the brief mentions it as a future idea). A permissive licence does not stop you charging, but it lets others copy the free parts. If you want to keep commercial control, consider "no licence yet" now, then choose later.
- The question bank (`data/questions.json`) is content. You can license it separately (for example CC BY 4.0 so others can contribute) from the code.
- If you accept outside pull requests, decide how you will hold the right to relicense later (a short CLA or a "contributions are under the project licence" statement).
- Fonts, icons and libraries: the extension uses none from outside. The icons in `icons/` are original drawings generated for this project, so they carry whichever licence you choose.

## Suggested default

If the aim is a developer-community extension with contributors and you are comfortable with others reusing it: **MIT**. If a paid product is likely within a year: **keep it unlicensed (all rights reserved) until you decide**, and say so plainly in the README rather than claiming open source.

To apply MIT: add a `LICENSE` file with the standard MIT text and your name and year, and set `"license": "MIT"` in `package.json`. Tell me your choice and I will add the file.