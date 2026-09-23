# Store assets

Assets and copy for the Chrome Web Store listing. None of this is part of the
extension package that gets uploaded.

| File | Purpose | Status |
| --- | --- | --- |
| `icon-128.png` | Store icon (128×128) | ready |
| `promo-tile-440x280.png` | Small promo tile (440×280) | ready |
| `screenshot-1.png` | Store screenshot (1280×800) | **placeholder — capture a real screenshot** |
| `screenshot-2.png` | Store screenshot (1280×800) | **placeholder — capture a real screenshot** |
| `listing.md` | Name, summary, description, category | final copy |
| `reviewer-notes.md` | "Notes for reviewers" | ready |
| `../docs/privacy-policy.md` | Privacy policy | publish via GitHub Pages |

The production icons live in `../icons/` (`16/32/48/128.png`); `icon-128.png`
here is the same 128×128 image.

Before publishing, also:

- Publish `../docs/privacy-policy.md` via GitHub Pages and confirm that
  `https://mxkeaton.github.io/ReVint/privacy-policy.html` loads.
- Build a clean zip of the extension: `manifest.json` at the zip root, and
  exclude `.git/`, `store/`, `docs/`, `README.md` and `*.zip`.
