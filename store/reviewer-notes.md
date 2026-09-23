# Notes for reviewers (paste into the "Notes for reviewers" field)

ReVint is a personal tool for a seller to back up and re-create their **own** Vinted listings. It does not scrape other users' data and does not contact any third-party server.

## Why some features need a login
The extension only adds its panel on your own pages:
- `https://www.vinted.<tld>/member*` (your own items)
- `https://www.vinted.<tld>/items/new*` (the sell form)

Without a Vinted account these pages are not reachable, so the extension appears inactive on a fresh profile.

## How to test
1. Load the unpacked extension and log in to any Vinted domain (e.g. https://www.vinted.de).
2. Open **My items** (`/member/...`). A "ReVint" panel appears in the top right. Below each "Push/Pushen" button there is an "Als Relisting speichern" button.
3. Click it on one of your own listings: the extension reads that page and stores the listing locally inside the extension (no download, no server).
4. Open the sell page `https://www.vinted.de/items/new`. The saved relisting is listed in the ReVint panel. Click it: the form fields are filled automatically (title, description, price, category, condition, size, brand, colour, material, photos, …). Nothing is submitted until the user clicks a button; the user reviews the form first.
5. Optional: after reviewing, click **"Upload & delete"**. ReVint publishes the new listing and then deletes the original listing that was saved, using Vinted's own API. This only runs for the single original item the user saved, and only after the new listing is published.
6. Optional: select several relistings and use "Auswahl relisten" to open them one by one.

## Permissions justification
- `storage`: remembers your saved relistings and the queue used to open several items in sequence.
- `scripting`: required to run a small helper inside the sell page. Vinted's form widgets discard values that are set by an extension for price, brand, colour and ISBN, so the helper corrects the outgoing create-listing request inside the page, just before it is sent. It runs only on Vinted sell pages the user has open, and only for the request the user triggers by submitting the form.
- Host permissions for Vinted domains: required to read your own listing pages and the sell form, and to load the images you uploaded to Vinted.
- Everything runs locally; there is no remote code, no analytics and no external server.

## Data
All data stays in the browser (extension IndexedDB). Deleting a relisting in the panel removes it. Uninstalling the extension removes all data.
