# ReVint

Repository: <https://github.com/mxKeaton/ReVint>

A Chromium extension that saves your own Vinted listings locally and refills the sell form in one click, allowing for quick relisting.

## Usage

- On your member page, every **Push** button gains a **Save as relisting** button. It reads that listing and stores it locally in the extension (no folder, no download, no server).
- A **ReVint** panel lists your saved relistings. Click one to open the sell form and fill it automatically. Select several and use **Relist selection** to open them one by one.
- **Delete selection** removes saved relistings; **Save all** / **Save listed** export your current listings in bulk.

Nothing is ever submitted automatically.

## Languages

Works on all Vinted domains. The UI language follows the domain (e.g. `.de` → German) and falls back to English. All strings live in `lang/*.json`.

## Data

Everything stays in the browser (extension IndexedDB). No analytics, no external server. Deleting a relisting removes it; uninstalling removes all data.

Not affiliated with Vinted.

## Publishing

Store text and placeholder assets are in `store/`; the privacy policy is in `docs/` and published via GitHub Pages.
