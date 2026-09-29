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
- Visit now: actual local weekday/time, call windows, camp/call schedule/OP timing filters
- Availability order and persistent manual card order for each camp on this device
- Weekday-specific representative call windows, stored in DoctorAvailability

## Data flow

`UI ↔ IndexedDB ↔ background queue ↔ Vercel API ↔ Apps Script ↔ Google Sheets`

Changes are persisted locally and queued in one transaction, then sent immediately
through the Vercel API. Push and pull share one coordinator (and a Web Lock across
open tabs). Refresh first drains the queue; if any operation remains, refresh is
deferred and the UI lists the preserved records. Edits made during refresh are
queued locally and sent after refresh finishes. Transient failures retry after
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
- `DoctorAvailability`

## Visit now and call windows

Before deploying this feature, build and deploy `gas/dist/Code.gs`, run
`setupSpreadsheet` once to create `DoctorAvailability`, and deploy a **new version
of the existing web-app deployment**. Then push/deploy Vercel. Existing records
remain intact. This setup step is required even if the other four tabs already
exist; a failed availability read does not silently become an empty timing list.

Open **Visit now** in the bottom navigation. The top camp and call schedule filters
apply here; use Availability, OP timing, and search to narrow the cards further.
The planner uses actual device-local time, refreshed every minute and on returning
to the app. The date picker in Visits does not affect it.

**By availability** places open windows first (earliest closing first), then
upcoming windows. Unconfirmed timings, ended windows, and other weekdays are
clearly labelled. **My order** preserves a separate order for every camp. Use
the up/down arrows to customize it. Switching camps, modes, reopening, or clock
updates preserves the custom order. New doctors join its end. Filtering and
moving visible cards does not discard hidden doctors. OP/status/search filters
are also remembered per camp. Orders are device preferences, like filter presets;
they do not rearrange Sheets or sync to another device. Clearing browser data
removes them. Doctor availability itself syncs to Sheets across devices.

Use **Edit timings → Add call window** for a doctor. Select weekdays, a start time,
an optional closing time, and an optional note. End times must be after start times
on the same day. Multiple windows support morning/evening calls or different days.
These windows take priority over legacy OP timing when determining availability.
General OP timing and Call schedule remain master-list selections and filters.

Without windows, exact legacy labels such as `After 11 am` and `10 am to 11 am`
are recognized with common weekday call schedules such as `Everyday` or
`Tue & Fri`. Unknown text remains **Timing unknown**. An omitted closing time is
shown as unknown; once its start time passes the app asks you to confirm availability.

DoctorAvailability uses one row per window:

| Doctor ID | Days | From | Until | Notes |
| --- | --- | --- | --- | --- |
| PDTR-001 | Tue, Fri | 10:00 | 11:00 | Morning calls |
| PDTR-001 | Mon, Wed | 14:00 | 15:00 | Afternoon clinic |

Use the doctor's exact ID, comma-separated weekday names (`Mon` through `Sun`),
and 24-hour `HH:mm` times. Recognized 12-hour displayed times also work.
Leave Until empty only when it is unknown. Edit these rows directly in Sheets
and refresh the app to retrieve them. Do not rename these headers.

The only availability parser source is `shared/availability.js`. `npm run build:gas`
generates `gas/dist/Code.gs`, bundling it with `gas/Code.gs`. Deploy the generated
file, never the source file alone. Do not copy parser code manually. `npm test`
compares parser results and rejection messages in browser and generated GAS runtimes.

Spreadsheet ID: `1Zg5Rxn6TNskev1EFwwrZI9gWP1mDyifBg6ACI_YTFxU`

## First-time Google setup

Setup safely reuses a blank `Sheet1` as `Doctors`, creates any missing tabs, canonicalizes recognized legacy headers, and appends sync metadata columns. It never clears existing records.

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

Areas, specialties, camps, potentials, stockists, OP timings, and call schedules come only from the `Settings` sheet. Products come only from the `Products` sheet. The app intentionally provides no Settings screen; edit these lists directly in Google Sheets, then reopen the PWA online.

## Versioned sync deployment checklist

1. Run `npm test`, `npm run lint`, and `npm run build`.
2. Copy generated `gas/dist/Code.gs` into Apps Script. Run `setupSpreadsheet`
   again to append metadata columns and initialize durable visit IDs and versions.
3. Deploy → Manage deployments → Edit → **New version** → Deploy.
   Verify **Execute as: Me** and **Who has access: Anyone** in the editor.
4. Compare Vercel **GAS_WEB_APP_URL** with client/dev **VITE_GAS_WEB_APP_URL**
   in `.env` (or the shared default used by `vite.config.ts`). They must point
   to the same `/exec` deployment. Redeploy Vercel after changing environment values.
5. Run `npm run check:deployment`. It makes read-only requests and reports only
   headers and invalid availability row numbers. `/api/sync?action=health` must
   return `schemaVersion: 2`, all five tabs, and `availabilityValid: true`.
   Anonymous access proves public reachability; it cannot prove the execute-as setting.
6. Test offline editing → reconnect → verify the row in Sheets, then edit that
   row in Sheets → refresh → verify the mobile record. Start refresh and edit a
   doctor while it is loading: the edit must remain visible and save afterward.

Exact headers (additional custom columns are allowed; do not edit sync columns):

| Tab | Required headers |
| --- | --- |
| Doctors | ID, Name, Specialties, Hospital, Pharmacy, Area, Camp, Potential, Stockist, Prescriber, OP Timing, Call Schedule, Prescribing Products, Notes, UpdatedAt, SyncHash |
| Visits | Date, Day, Camp, Doctors (count), Pharmacy (count), Doctors, Pharmacy, Visit ID, Doctor IDs, UpdatedAt, SyncHash |
| Settings | Areas, Specialties, Camps, Potentials, Stockist, OP Timings, Call Schedule |
| Products | ProdID, Name, DosageForm |
| DoctorAvailability | Doctor ID, Days, From, Until, Notes |

Use `Mon, Wed` weekday lists and 24-hour `HH:mm` times for availability.
The optional Until must be later than From. The shared parser still recognizes
legacy 12-hour displays, but the deployment check flags noncanonical formats.

All IndexedDB records carry ISO `updatedAt` and `_synced` metadata. Device-only
presets, preferences and queue records remain unconfirmed (they are not written
as records to Sheets). Doctor/visit writes become confirmed only after GAS returns
a valid server timestamp. Pending successors keep their local version and flag.
Pull replaces an existing record only when it is confirmed and the Sheet timestamp
is strictly newer; unsynced and older remote records are listed in the UI.
GAS stores versions in UpdatedAt and detects direct cell/availability edits using
SyncHash, so repeated reads do not invent new versions. Visit ID remains stable
when rows move or new visits are inserted.

A missing remote row is not a deletion receipt: refresh preserves local records.
Manual deletion propagation requires explicit tombstones and is outside this
merge protocol. Offline writes are sent while the PWA is open or reopened;
there is no operating-system background worker that runs after the app closes.
