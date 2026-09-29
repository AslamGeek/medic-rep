# Google Apps Script deployment

1. From the repository root run `npm run build:gas` (also part of `npm run build`).
2. Replace the Apps Script project's `Code.gs` with **`gas/dist/Code.gs`**.
   The build prepares the deployable script from `gas/Code.gs`.
3. Run **setupSpreadsheet** again. It creates missing tabs, canonicalizes legacy
   headers, appends missing visit identity columns, and
   initializes existing record versions without clearing records.
4. **Deploy → Manage deployments → Edit → New version → Deploy**.
   Confirm **Execute as: Me** and **Who has access: Anyone**. Keep the deployment URL.
5. Match Vercel `GAS_WEB_APP_URL` and local `.env` `VITE_GAS_WEB_APP_URL` (or the
   shared default imported by `vite.config.ts`). Deploy the matching frontend/API.
6. Run `npm run check:deployment`. The `/exec?action=health` and
   `/api/sync?action=health` responses must contain `schemaVersion: 2`, the four
   exact header sets: Doctors, Visits, Settings and Products.

Both reads and writes now go through the same Apps Script deployment. A Google
CSV endpoint is used only by the read-only deployment diagnostic, never app sync.
See the repository README for the exact header checklist and smoke tests.

## Remove the retired tab

Deploy the generated script as a **new version of the existing web app**, then
run **removeDoctorAvailability** in the Apps Script editor. This deletes the old
DoctorAvailability tab and its call-window data. It leaves the four supported
tabs intact and is safe to run again. Setup no longer creates the retired tab.
Redeploy the frontend to remove the call-window editor and profile display.
OP Timing and Call Schedule remain supported doctor fields.

## Versioning and retries

To remove existing `UpdatedAt` and `SyncHash` columns, build and replace Code.gs,
then **deploy a new version of the existing web app first**. After deployment,
run **removeSyncColumns** once in the Apps Script editor. It migrates existing
versions into ID-cell notes before deleting those two columns from Doctors and
Visits. It preserves records, custom columns, and existing note text, and can be
run again safely. Do not delete the columns while the older deployment is active.
New spreadsheets and later setup runs do not add these columns.

Doctor/visit records store timestamps and content hashes in notes on ID / Visit ID cells. Bootstrap
uses a script lock shared with writes and updates versions only for changed
record content. This detects manual edits, pasted ranges,
and edits made by other scripts without requiring an onEdit trigger. Visit IDs
remain stable through row insertion and sorting; old rows receive IDs during setup.
Keep the `MedRep sync:` line in ID-cell notes; other note text is preserved.

Writes retain operation IDs through network retries. Doctor receipts recover the
assigned ID, and visit receipts recover the saved visit and timestamp. Validation
errors require a corrected local save and do not retry on refresh. Transient
failures retry at most eight times; manual retry preserves the original operation ID.
Past visit dates are accepted so records made offline can sync on a later day.

## Existing data helpers

`normalizeProductIds` converts legacy product IDs to `PROD-###` and updates
matching doctor references; it also installs the existing product edit trigger.
`sortDoctors` optionally sorts Doctors by Camp then ID. App doctor saves perform
this same sort. Prescribing Products stores readable `Name (DosageForm)` labels;
legacy IDs and labels continue to resolve against Products.

A GitHub push or Vercel deployment does not deploy Apps Script. Always generate
and deploy the GAS artifact explicitly, then verify the new version.
