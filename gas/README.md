# Google Apps Script setup

The app is already configured for spreadsheet:

`1Zg5Rxn6TNskev1EFwwrZI9gWP1mDyifBg6ACI_YTFxU`

The current web-app deployment is:

`https://script.google.com/macros/s/AKfycbwfIkuC5YNNNb2KykmVsCQiD9PDwmHKUmIwOhItV6xvlOp7RvgVPOgOC6xNN-eEuAc4/exec`

1. Open the Apps Script project used for the web-app URL.
2. Replace its `Code.gs` with the included `Code.gs`.
3. Run `setupSpreadsheet` once from the editor and approve spreadsheet access.
4. Run `normalizeProductIds` once. This safely converts legacy product IDs to
   `PROD-001`, `PROD-002`, ... and updates matching doctor references.
5. Choose **Deploy → Manage deployments → Edit**.
6. Select **New version**, execute as **Me**, allow access to **Anyone**, and deploy.
7. If Vercel has a `GAS_WEB_APP_URL` environment variable, update it to the resulting `/exec` URL and redeploy. Otherwise the API uses the checked-in default. The local development proxy uses the URL in `vite.config.ts`.

The setup is non-destructive. A blank `Sheet1` is reused as `Doctors`; only the missing agreed tabs and headers are created. Existing rows are not cleared or replaced.

After migration, editing or pasting product rows in the `Products` tab automatically
assigns any missing or invalid IDs in the same `PROD-###` format.

## Prescribing products storage

New and edited doctors store `Name (DosageForm)` in **Prescribing Products**,
with multiple products separated by commas in the same cell. A product without
a dosage form stores its name alone.
The app still uses product IDs internally for selection and validation. Both
read paths accept existing ID cells and the readable labels.

To activate this change, deploy the updated `api/sync.js` to Vercel, then replace
the Apps Script `Code.gs` and update its existing web-app deployment to a new
version. Existing doctor rows are converted when saved again; no bulk migration
is required.

## Sync reliability update

Deploy the matching Vercel frontend/API and this Apps Script version together.
The frontend sends queued changes immediately, independently of refreshing, and
automatically retries transient failures. The API retries failed connections and
invalid Google responses while retaining the same operation ID.

This Apps Script version checks operation receipts and performs writes under one
lock. If the Google response is lost after creating a doctor, a retry returns the
assigned doctor ID instead of just a duplicate flag. Master data and doctor rows
are read in batches to reduce service calls. Existing queued changes are preserved.

Validate deployment by renaming a known test doctor, checking its Sheets row and
the **Saved to Sheets** indicator, then editing the name in Sheets and tapping
refresh. Measure end-to-end write time on the deployed app; local regression tests
do not establish a production latency guarantee.

## Updating an existing deployment

### Automatic doctor row ordering

Every doctor saved from the app sorts the Doctors tab by Camp (A–Z), then ID
(ascending). For example, `PDTR-016` appears immediately after `PDTR-015` in the
same camp group. Sorting includes all populated columns and excludes the header.
IDs are retained; row ordering does not change visit references.

Replace `Code.gs` and deploy a new version of the existing Apps Script deployment
to activate this behavior. Optionally run `sortDoctors` once in the Apps Script
editor to sort existing records immediately; otherwise the next app doctor save
sorts them. Direct edits in Sheets are sorted on the next app doctor save or by
running `sortDoctors`.

### Deployment steps

A GitHub push and Vercel deployment do **not** update Apps Script. Replace the
Apps Script project's `Code.gs` with this file, save it, then open **Deploy →
Manage deployments → Edit → Version → New version → Deploy**. Keep the existing
deployment URL. The previous `setupSpreadsheet` and `normalizeProductIds` setup
steps do not need to be rerun for this code update.

After both deployments are updated, reopen the app and tap refresh. Queued doctor
edits can resolve older product labels such as `API-TOP  (Syrup)` to current master
IDs before resending. Any label that no longer has an unambiguous master match is
shown in the edit form so the user can remove or reselect it.
