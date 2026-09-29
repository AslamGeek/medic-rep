# MedRep Field Companion

A mobile-first website for a single medical representative. Bookmark its URL and open it in your mobile browser; no app installation is needed. Records and pending edits remain in IndexedDB, and changes synchronize with Google Sheets through Google Apps Script while the page is open. Loading or reloading the website requires a network connection.

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
- Light/dark mode and bookmark-friendly mobile browser access
- Legacy doctor-header adapter without rewriting existing rows

## Data flow

`UI ↔ IndexedDB ↔ background queue ↔ Vercel API ↔ Apps Script ↔ Google Sheets`

Changes are persisted locally and queued in one transaction, then sent immediately
through the Vercel API. Push and pull share one coordinator (and a Web Lock across
open tabs). Refresh waits for an in-flight write, then reads Sheets before sending
queued edits. Confirmed doctors missing from the complete response are deleted
locally. Missing doctors with pending edits stay local until you choose Keep Local
(restore to Sheets) or Discard. Edits made during refresh are queued locally and
sent after refresh finishes unless a deletion conflict blocks them. Transient failures retry after
2 seconds, backing off to 30 seconds, with at most 8 attempts. Tap the cloud icon
to retry paused transport failures with the same operation IDs.
The header distinguishes saving to Sheets, refreshing, offline storage, and errors.

Sheet data is refreshed on opening the app, returning to it, reconnecting, or tapping
the refresh control. There is no one-minute refresh loop. Pending edits and changes
made while a refresh is running are protected from older responses.

IndexedDB holds the device cache and durable unsent changes; it is not a waiting
period before saving. A 3–5 second Sheet update is a target for a healthy connection,
not a guaranteed deadline: Apps Script execution and Google response redirects can
take longer. Both the Vercel app/API and generated `gas/dist/Code.gs` must be deployed for these
changes to be active.

Legacy prescribing-product text is matched against the master catalog using
normalized spacing and dosage abbreviations (for example, `Syrup` and `Syr`).
The API, doctor form, and queued saves use the same matcher. Unmatched or ambiguous
products remain visible for correction; they are never silently dropped or guessed.
Master-list validation failures pause automatic retries. Correcting and saving the
doctor replaces its rejected edit. Refresh never clears a validation rejection.
Temporary connection failures retry automatically within the retry limit.

The spreadsheet uses these human-readable tabs:

- `Doctors`
- `Visits`
- `Settings`
- `Products`

The retired DoctorAvailability tab can be deleted by deploying the new generated
GAS script, then running `removeDoctorAvailability` in the Apps Script editor.
This removes its call-window data. Redeploy the frontend to remove its editor and
profile display. OP Timing and Call Schedule remain supported.

Spreadsheet ID: `1Zg5Rxn6TNskev1EFwwrZI9gWP1mDyifBg6ACI_YTFxU`

## First-time Google setup

Setup safely reuses a blank `Sheet1` as `Doctors`, creates any missing tabs, canonicalizes recognized legacy headers, and appends missing visit identity columns. It never clears existing records.

1. Open the Apps Script project associated with the web-app deployment.
2. Run `npm run build:gas`, then replace its `Code.gs` with the generated `gas/dist/Code.gs`.
3. Run `setupSpreadsheet` once in the Apps Script editor and approve access.
4. Update the web-app deployment to a new version, executing as **Me**, with access for **Anyone**.
5. Confirm that opening the `/exec` URL shows `"API is ready."`.

The default Apps Script URL is defined once in `shared/sync-config.js`. Both the
Vercel API and local Vite proxy use it. Set `GAS_WEB_APP_URL` on Vercel and match
`GAS_WEB_APP_URL` / `VITE_GAS_WEB_APP_URL` in local `.env`. Vite loads `.env` for its
proxy; the browser only calls `/api/sync`. When both variables are present, a mismatch
fails configuration validation. Different environments must still be compared manually.

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

If the Apps Script URL changes, update `GAS_WEB_APP_URL` in Vercel (if set) and redeploy. An existing override takes precedence over the default URL in the code. Local development uses `.env` or the shared default imported by `vite.config.ts`.

## Master-data behavior

Areas, specialties, camps, potentials, stockists, OP timings, and call schedules come only from the `Settings` sheet. Products come only from the `Products` sheet. The app intentionally provides no Settings screen; edit these lists directly in Google Sheets, then reopen the website online.

## Versioned sync deployment checklist

1. Run `npm test`, `npm run lint`, and `npm run build`.
2. Copy generated `gas/dist/Code.gs` into Apps Script. Run `setupSpreadsheet`
   again to initialize durable visit IDs and versions in ID-cell notes.
3. Deploy → Manage deployments → Edit → **New version** → Deploy.
   Verify **Execute as: Me** and **Who has access: Anyone** in the editor.
4. Compare Vercel **GAS_WEB_APP_URL** with client/dev **VITE_GAS_WEB_APP_URL**
   in `.env` (or the shared default used by `vite.config.ts`). They must point
   to the same `/exec` deployment. Redeploy Vercel after changing environment values.
5. Run `npm run check:deployment`. It makes read-only requests and reports only
   the required headers. `/api/sync?action=health` must
   return `schemaVersion: 2` and the four supported tabs.
   Anonymous access proves public reachability; it cannot prove the execute-as setting.
6. Test offline editing → reconnect → verify the row in Sheets, then edit that
   row in Sheets → refresh → verify the mobile record. Start refresh and edit a
   doctor while it is loading: the edit must remain visible and save afterward.

Exact headers (additional custom columns are allowed):

| Tab | Required headers |
| --- | --- |
| Doctors | ID, Name, Specialties, Hospital, Pharmacy, Area, Camp, Potential, Stockist, Prescriber, OP Timing, Call Schedule, Prescribing Products, Notes |
| Visits | Date, Day, Camp, Doctors (count), Pharmacy (count), Doctors, Pharmacy, Visit ID, Doctor IDs |
| Settings | Areas, Specialties, Camps, Potentials, Stockist, OP Timings, Call Schedule |
| Products | ProdID, Name, DosageForm |

All IndexedDB records carry ISO `updatedAt` and `_synced` metadata. Device-only
presets, preferences and queue records remain unconfirmed (they are not written
as records to Sheets). Doctor/visit writes become confirmed only after GAS returns
a valid server timestamp. Pending successors keep their local version and flag.
Pull mirrors confirmed doctors from the complete Sheets snapshot, including
deletions, while preserving pending edits. Visit history retains its versioned
merge behavior. Incomplete or invalid responses cannot delete local data.
GAS stores versions and content hashes in notes on ID / Visit ID cells, so repeated
reads do not invent new versions. UpdatedAt and SyncHash columns are not required.
Visit ID remains stable when rows move or new visits are inserted. To remove the
legacy columns, deploy the generated GAS bundle as a new web-app version, then run
`removeSyncColumns` in the Apps Script editor. This preserves existing versions
and record data before deleting the columns; see [GAS deployment](gas/README.md).

The green Synced indicator requires an empty queue, no unconfirmed records or
conflicts, and an exact match between local doctor IDs and the last complete
Sheets response. It describes that snapshot; later Sheet edits require a refresh.

Open Settings (the gear icon) → Clear Local Cache & Refresh to recover the local
database. This clears all IndexedDB stores, including pending edits and presets,
and imports a fresh snapshot. It first validates the fresh response; offline or
failed requests leave the current cache intact. The reset waits for active sync
operations and blocks saves while it runs. It does not change data in Sheets.

Offline writes are sent while the website is open or reopened;
there is no operating-system background worker that runs after the app closes.
