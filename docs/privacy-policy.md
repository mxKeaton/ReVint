# ReVint — Privacy Policy

_Last updated: 2026-09-23 · Publisher: mxKeaton · Contact: https://github.com/mxKeaton/ReVint/issues_

> This page is written to be published as-is on GitHub Pages and linked from the Chrome Web Store listing.

## Summary

ReVint is a browser extension that helps you back up and re-create **your own** Vinted listings. It runs entirely in your browser. **It does not send any data to the developer or to any third party, and it contains no analytics, tracking, or advertising.**

## What ReVint accesses

- **Your own Vinted pages** (`/member*` and `/items/new*`) on Vinted domains. When you click "Save as relisting", ReVint reads the listing page you are already viewing — including the title, description, price, category, size, condition, brand, colour, material, ISBN, platform, age rating and the photo URLs.
- **The photos** of your listing, downloaded from Vinted's image servers so they can be stored with the saved listing.
- **The sell form** (`/items/new*`), where ReVint fills in the fields for you when you re-list a saved item.

ReVint only acts on pages you open yourself. It does not scan other websites and does not collect data about other users. It does not read or store your password, login cookies or any other authentication data.

## What ReVint changes on Vinted

- **Filling the sell form.** When you re-list an item, ReVint fills Vinted's sell form. Vinted's own form widgets ignore values that are set by an extension (they only accept values typed by a person), so ReVint also corrects the outgoing "create listing" request inside the page, just before it is sent, for the fields Vinted dropped (price, brand, colour and ISBN). This only affects the request that you trigger by submitting the form.
- **"Upload & delete".** If you click the "Upload & delete" button, ReVint publishes the new listing and then deletes the original listing you saved, through Vinted's own API. This is never automatic; it happens only for the one original listing you chose, and only after the new listing has been published.

## What ReVint stores and where

All saved listings — including the photos as text (Base64) — are stored **locally on your device**, inside the extension's own storage (IndexedDB, plus a small bookkeeping entry in `chrome.storage.local` for the queue). Nothing is uploaded anywhere. There is no account, no server and no cloud sync.

## What ReVint shares

Nothing. ReVint has no network endpoints of its own and transmits no data to the developer or any third party. The only network requests it makes are to the Vinted pages, image URLs and Vinted's own create/delete endpoints described above, made on your behalf while you use the extension.

## Data retention and deletion

- You can delete saved listings at any time in the ReVint panel ("Delete").
- Uninstalling the extension removes all locally stored data.

## Permissions

- `storage` — to keep your saved listings and the queue that opens several items in sequence.
- `scripting` — to run a small helper inside the Vinted sell page that corrects the outgoing create-listing request (see "What ReVint changes on Vinted"). It runs only on Vinted pages you have open and only around the moment you submit the form.
- **Host permissions for Vinted domains** — to read your own listing pages and the sell form, and to load the images you uploaded to Vinted.

ReVint does not request permission to read other websites.

## Limited use

ReVint does not sell or transfer user data to third parties. It does not use or transfer user data for purposes that are unrelated to its single purpose (saving and re-listing your own Vinted items), and it does not use or transfer user data to determine creditworthiness or for lending purposes. All data stays on your device.

## Children

ReVint is not directed to children and does not knowingly collect information from children.

## Legal notice

ReVint is an independent tool and is **not affiliated with, endorsed by, or connected to Vinted**. "Vinted" is a trademark of its respective owner and is used only to describe compatibility.

## Changes

If this policy changes, the updated version will be published at this URL with a new "last updated" date.

## Contact

Questions about this policy: https://github.com/mxKeaton/ReVint/issues.
