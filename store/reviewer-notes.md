# Notes for reviewers

ReVint is a personal tool to back up and re-create your **own** Vinted listings. It does not scrape other users' data and does not contact any third-party server. All data stays in the browser.

Some features need a login because they only run on your own pages: `…/member*` (your items) and `…/items/new` (the sell form).

## How to test
1. Load the extension and log in to any Vinted domain (e.g. https://www.vinted.de).
2. Open your member page (`/member/...`). The ReVint panel appears top right, and each "Push" button gets a "Save as relisting" button.
3. Click it on one of your own listings: the listing is stored locally in the extension (no download, no server).
4. Open the sell form (`/items/new`). The saved relisting is listed in the panel. Click it to fill the form automatically (title, description, price, category, condition, size, brand, colour, material, photos). Nothing is submitted automatically.
5. Optional: select several relistings and use "Relist selection" to open them one by one.

## Permissions
- `storage`: keeps your saved listings and a queue used to open items in sequence.
- Host permissions for Vinted domains: to read your own pages and photos.

No remote code, no analytics, no external server.

## Data
All data stays in the browser (extension IndexedDB). Deleting a relisting removes it; uninstalling removes all data.
