# MedRep Field Companion

A mobile-first, installable Progressive Web App for a single medical representative. The app works from IndexedDB first, so search, editing, and visit logging remain fast and available without a network connection. Changes synchronize with Google Sheets in the background through Google Apps Script.

## Included

- Fast local doctor search and multi-select filters
- Saved filter presets stored privately on the device
- Total, Rx, NRx, hospital, and pharmacy metrics
- Rx highlighting and prescribing products on doctor cards
- Add/edit doctor with sheet-controlled master values
- Doctor profile, recent visit context, and quick visit entry
- Camp-based doctor selection ordered by oldest/never visited
- Automatic linked-pharmacy derivation and live bundle preview
- Sunday, Holiday, and Leave logging without doctor selection
- Local-first save, automatic retry, and short Undo
- Visit history and monthly calendar
- Light/dark mode and installable offline app shell
- Legacy doctor-header adapter without rewriting existing rows

## Data flow

`UI ↔ IndexedDB ↔ background queue ↔ Apps Script ↔ Google Sheets`

Changes are persisted locally and queued in one transaction, then sent immediately
through the Vercel API. Saving does not wait for a refresh. Failed saves retry after
2 seconds, backing off to at most 30 seconds between attempts while the app is open.
The header distinguishes saving to Sheets, refreshing, offline storage, and errors.

Sheet data is refreshed on opening the app, returning to it, reconnecting, or tapping
the refresh control. There is no one-minute refresh loop. Pending edits and changes
made while a refresh is running are protected from older responses.

IndexedDB holds the device cache and durable unsent changes; it is not a waiting
period before saving. A 3–5 second Sheet update is a target for a healthy connection,
not a guaranteed deadline: Apps Script execution and Google response redirects can
take longer. Both the Vercel app/API and `gas/Code.gs` must be deployed for these
changes to be active.

Legacy prescribing-product text is matched against the master catalog using
normalized spacing and dosage abbreviations (for example, `Syrup` and `Syr`).
The API, doctor form, and queued saves use the same matcher. Unmatched or ambiguous
products remain visible for correction; they are never silently dropped or guessed.
Master-list validation failures pause automatic retries. Correcting and saving the
doctor replaces its rejected edit; refreshing retries it against the current master
list. Temporary connection failures continue to retry automatically.

The spreadsheet is human-readable and contains only:

- `Doctors`
- `Visits`
- `Settings`
- `Products`

Spreadsheet ID: `1Zg5Rxn6TNskev1EFwwrZI9gWP1mDyifBg6ACI_YTFxU`

## First-time Google setup

The target spreadsheet is currently blank. The included setup safely reuses a blank `Sheet1` as `Doctors`, creates the other three agreed tabs, and adds headers. It never clears an existing row.

1. Open the Apps Script project associated with the web-app deployment.
2. Replace its `Code.gs` with [`gas/Code.gs`](gas/Code.gs).
3. Run `setupSpreadsheet` once in the Apps Script editor and approve access.
4. Update the web-app deployment to a new version, executing as **Me**, with access for **Anyone**.
5. Confirm that opening the `/exec` URL shows `"API is ready."`.

The supplied Apps Script URL is the default in the Vercel API and local Vite proxy. To override the Vercel API's deployment, set the server-side `GAS_WEB_APP_URL` environment variable in Vercel. The older `VITE_GAS_WEB_APP_URL` variable is not used by the API.

Because the deployment is public, anyone who obtains its URL can call the API. No Google credentials or private service credentials are placed in the browser.

## Local development

Requirements: Node.js and npm.

```bash
npm install
npm run dev
```

Production check:

```bash
npm run build
```

Regression checks: `npm test` and `npm run lint`. The sync tests simulate failed
reads/writes, concurrent edits, retries, new-doctor IDs, and undo during a save.

## Vercel

Push this folder to GitHub, import it in Vercel, and keep the defaults:

- Framework: Vite
- Build command: `npm run build`
- Output directory: `dist`

If the Apps Script URL changes, update `GAS_WEB_APP_URL` in Vercel (if set) and redeploy. An existing override takes precedence over the default URL in the code. Local development uses the default URL in `vite.config.ts`.

## Master-data behavior

Areas, specialties, camps, potentials, stockists, OP timings, and call schedules come only from the `Settings` sheet. Products come only from the `Products` sheet. The app intentionally provides no Settings screen; edit these lists directly in Google Sheets, then reopen the PWA online.
