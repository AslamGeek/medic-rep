# Google Apps Script deployment

1. From the repository root run `npm run build:gas` (also part of `npm run build`).
2. Replace the Apps Script project's `Code.gs` with **`gas/dist/Code.gs`**.
   `gas/Code.gs` is source only and deliberately does not contain the parser.
3. Run **setupSpreadsheet** again. It creates missing tabs, canonicalizes legacy
   headers, appends `UpdatedAt` / `SyncHash` and visit identity columns, and
   initializes existing record versions without clearing records.
4. **Deploy → Manage deployments → Edit → New version → Deploy**.
   Confirm **Execute as: Me** and **Who has access: Anyone**. Keep the deployment URL.
5. Match Vercel `GAS_WEB_APP_URL` and local `.env` `VITE_GAS_WEB_APP_URL` (or the
   shared default imported by `vite.config.ts`). Deploy the matching frontend/API.
6. Run `npm run check:deployment`. The `/exec?action=health` and
   `/api/sync?action=health` responses must contain `schemaVersion: 2`, all five
   exact header sets, and `availabilityValid: true`.

Both reads and writes now go through the same Apps Script deployment. A Google
CSV endpoint is used only by the read-only deployment diagnostic, never app sync.
See the repository README for the exact header checklist and smoke tests.

## Parser source

Edit only `shared/availability.js`, then rebuild. Never manually copy parser
logic into this source or the generated artifact. `npm test` executes the
same cases against the browser module and generated Apps Script bundle.

DoctorAvailability has one window per row, with headers `Doctor ID`, `Days`,
`From`, `Until`, `Notes`. Use `Mon, Wed` and `HH:mm` 24-hour times; Until can be
blank, otherwise it must follow From on the same day.

## Versioning and retries

Doctor/visit records store UpdatedAt and a content hash in the sheet. Bootstrap
uses a script lock shared with writes and updates versions only for changed
content, including availability edits. This detects manual edits, pasted ranges,
and edits made by other scripts without requiring an onEdit trigger. Visit IDs
remain stable through row insertion and sorting; old rows receive IDs during setup.
Do not edit the sync metadata columns manually.

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
