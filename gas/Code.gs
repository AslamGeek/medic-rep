/**
 * MedRep offline-first API.
 *
 * Deploy as a Google Apps Script Web App:
 *   Execute as: Me
 *   Who has access: Anyone
 *
 * The browser never receives Google credentials. This script is the only layer
 * that reads or writes the spreadsheet.
 */

var CONFIG = {
  SPREADSHEET_ID: '1Zg5Rxn6TNskev1EFwwrZI9gWP1mDyifBg6ACI_YTFxU',
  TIME_ZONE: 'Asia/Kolkata',
  MAX_REMEMBERED_OPERATIONS: 100
};

// Reuse the spreadsheet handle during one Apps Script invocation. Opening the
// same spreadsheet for every tab is one of the largest bootstrap delays.
var ACTIVE_SPREADSHEET_ = null;

var SHEET_HEADERS = {
  Doctors: [
    'ID', 'Name', 'Specialties', 'Hospital', 'Pharmacy', 'Area', 'Camp',
    'Potential', 'Stockist', 'Prescriber', 'OP Timing', 'Call Schedule',
    'Prescribing Products', 'Notes'
  ],
  Visits: [
    'Date', 'Day', 'Camp', 'Doctors (count)', 'Pharmacy (count)',
    'Doctors', 'Pharmacy'
  ],
  Settings: [
    'Areas', 'Specialties', 'Camps', 'Potentials', 'Stockist',
    'OP Timings', 'Call Schedule'
  ],
  Products: ['ProdID', 'Name', 'DosageForm']
};

var HEADER_ALIASES = {
  'ID': ['DocID'],
  'OP Timing': ['OPTimings', 'OP Timings'],
  'Call Schedule': ['CallSchedule'],
  'Prescribing Products': ['PrescribingProducts'],
  'Notes': ['Remarks']
};

// Official doctor-ID prefixes retained from the original app. Camp names stay
// unchanged in Settings, Doctors and Visits; this map is used only for Doc IDs.
var CAMP_CODE_MAP = {
  'proddatur': 'PDTR',
  'mydukuru/gv satram': 'MYGV',
  'yerraguntla/kamalapuram': 'YEKA',
  'jammalamadugu': 'JAMD',
  'porumamilla/kalasapadu': 'POKA'
};

function doGet(e) {
  try {
    var action = e && e.parameter ? e.parameter.action : '';
    if (action === 'bootstrap') return json_(bootstrap_());
    return json_({
      success: true,
      service: 'MedRep API',
      spreadsheetId: CONFIG.SPREADSHEET_ID,
      message: 'API is ready.'
    });
  } catch (error) {
    return jsonError_(error);
  }
}

function doPost(e) {
  var operationLock = null;
  try {
    var request = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    var action = String(request.action || '');
    var opId = cleanText_(request.opId, 120);
    var payload = request.payload || {};

    if (!opId) throw new Error('Operation ID is required.');
    operationLock = LockService.getScriptLock();
    operationLock.waitLock(20000);
    if (wasProcessed_(opId)) {
      var previous = { success: true, duplicate: true };
      if (action === 'upsertDoctor') {
        var savedId = PropertiesService.getScriptProperties().getProperty('MEDREP_DOCTOR_OP_' + opId);
        var matches = getDoctors_().filter(function (doctor) {
          if (savedId) return doctor.id === savedId;
          // Compatibility with receipts written by the previous deployment.
          return payload.isNewRecord
            ? normalized_(doctor.name) === normalized_(payload.name) && normalized_(doctor.hospital) === normalized_(payload.hospital)
            : doctor.id === payload.id;
        });
        if (matches.length !== 1) throw new Error('Could not recover the saved doctor. Refresh and check the record.');
        previous.doctor = matches[0];
      }
      return json_(previous);
    }

    var result;
    if (action === 'upsertDoctor') result = upsertDoctor_(payload, true);
    else if (action === 'saveVisit') result = saveVisit_(payload, true);
    else if (action === 'undoVisit') result = undoVisit_(payload.visit || payload, true);
    else throw new Error('Unsupported action: ' + action);

    // Commit buffered Sheet writes before confirming the save or releasing the lock.
    SpreadsheetApp.flush();
    rememberOperation_(opId, result);
    result.success = true;
    return json_(result);
  } catch (error) {
    return jsonError_(error);
  } finally {
    if (operationLock) operationLock.releaseLock();
  }
}

/**
 * Run once from the Apps Script editor before deploying.
 * It is intentionally non-destructive:
 * - reuses a completely blank Sheet1 as Doctors;
 * - creates only missing agreed tabs;
 * - never clears or replaces existing rows;
 * - accepts the legacy GAS header aliases.
 */
function setupSpreadsheet() {
  var ss = spreadsheet_();
  var doctors = ss.getSheetByName('Doctors');
  var defaultSheet = ss.getSheetByName('Sheet1');

  if (!doctors && defaultSheet && isBlankSheet_(defaultSheet)) {
    defaultSheet.setName('Doctors');
    doctors = defaultSheet;
  }

  Object.keys(SHEET_HEADERS).forEach(function (name) {
    ensureSheet_(ss, name, SHEET_HEADERS[name]);
  });

  return 'MedRep spreadsheet is ready.';
}

function spreadsheet_() {
  if (!ACTIVE_SPREADSHEET_) {
    ACTIVE_SPREADSHEET_ = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  }
  return ACTIVE_SPREADSHEET_;
}

function sheet_(name) {
  var sheet = spreadsheet_().getSheetByName(name);
  if (!sheet) throw new Error('Missing ' + name + ' sheet. Run setupSpreadsheet once.');
  return sheet;
}

function isBlankSheet_(sheet) {
  return sheet.getLastRow() <= 1 && sheet.getLastColumn() <= 1 && !sheet.getRange(1, 1).getValue();
}

function ensureSheet_(ss, name, expectedHeaders) {
  var sheet = ss.getSheetByName(name) || ss.insertSheet(name);
  if (isBlankSheet_(sheet)) {
    sheet.getRange(1, 1, 1, expectedHeaders.length).setValues([expectedHeaders]);
    sheet.getRange(1, 1, 1, expectedHeaders.length)
      .setFontWeight('bold')
      .setBackground('#e3f3eb')
      .setFontColor('#0d6045');
    sheet.setFrozenRows(1);
    return;
  }

  var headers = readHeaders_(sheet);
  expectedHeaders.forEach(function (header) {
    columnIndex_(headers, header);
  });
}

function readHeaders_(sheet) {
  var lastColumn = Math.max(1, sheet.getLastColumn());
  return sheet.getRange(1, 1, 1, lastColumn).getDisplayValues()[0]
    .map(function (value) { return String(value || '').trim(); });
}

function normalizedHeader_(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function columnIndex_(headers, canonical) {
  var candidates = [canonical].concat(HEADER_ALIASES[canonical] || [])
    .map(normalizedHeader_);
  for (var i = 0; i < headers.length; i++) {
    if (candidates.indexOf(normalizedHeader_(headers[i])) !== -1) return i;
  }
  throw new Error('Missing column "' + canonical + '".');
}

function valueAt_(headers, row, canonical) {
  return row[columnIndex_(headers, canonical)];
}

function cleanText_(value, maxLength) {
  return String(value === null || value === undefined ? '' : value)
    .trim()
    .slice(0, maxLength || 500);
}

function cleanList_(value) {
  if (Array.isArray(value)) {
    return unique_(value.map(function (item) { return cleanText_(item, 150); }).filter(Boolean));
  }
  var text = cleanText_(value, 5000);
  if (!text) return [];
  if (text.charAt(0) === '[') {
    try {
      var parsed = JSON.parse(text);
      if (Array.isArray(parsed)) return cleanList_(parsed);
    } catch (ignored) {}
  }
  return unique_(text.split(/,|\n/).map(function (item) { return item.trim(); }).filter(Boolean));
}

function unique_(values) {
  var seen = {};
  return values.filter(function (value) {
    var key = String(value).trim().toLowerCase();
    if (!key || seen[key]) return false;
    seen[key] = true;
    return true;
  });
}

function normalized_(value) {
  return cleanText_(value, 500).toLowerCase();
}

function normalizedPrescriber_(value) {
  var normalized = normalized_(value);
  return normalized === 'rx' || normalized === 'yes' ? 'Rx' : 'NRx';
}

function campCode_(camp) {
  var normalizedCamp = normalized_(camp);
  return CAMP_CODE_MAP[normalizedCamp]
    || cleanText_(camp, 120).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4)
    || 'DOC';
}

function nextDoctorIdForCamp_(headers, rows, camp) {
  var campIndex = columnIndex_(headers, 'Camp');
  var idIndex = columnIndex_(headers, 'ID');
  var code = campCode_(camp);
  var maxSequence = 0;

  rows.forEach(function (row) {
    if (normalized_(row[campIndex]) !== normalized_(camp)) return;
    var match = cleanText_(row[idIndex], 120).match(/^(.+)-(\d+)$/);
    if (!match || normalized_(match[1]) !== normalized_(code)) return;
    var sequence = Number(match[2]);
    if (isFinite(sequence)) maxSequence = Math.max(maxSequence, sequence);
  });

  return code + '-' + ('000' + (maxSequence + 1)).slice(-3);
}

function localDate_(date) {
  return Utilities.formatDate(date, CONFIG.TIME_ZONE, 'yyyy-MM-dd');
}

function displayDateValue_(value) {
  if (value instanceof Date) return localDate_(value);
  return cleanText_(value, 20);
}

function json_(data) {
  return ContentService.createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

function jsonError_(error) {
  console.error(error && error.stack ? error.stack : error);
  return json_({
    success: false,
    message: error && error.message ? error.message : String(error || 'Unknown error')
  });
}

function getSettings_() {
  var sheet = sheet_('Settings');
  var values = sheet.getDataRange().getDisplayValues();
  var headers = values.shift().map(function (value) { return String(value).trim(); });

  function column(name) {
    var index = columnIndex_(headers, name);
    return unique_(values.map(function (row) { return cleanText_(row[index], 150); }).filter(Boolean));
  }

  return {
    areas: column('Areas'),
    specialties: column('Specialties'),
    camps: column('Camps'),
    potentials: column('Potentials'),
    stockists: column('Stockist'),
    opTimings: column('OP Timings'),
    callSchedules: column('Call Schedule')
  };
}

function getProducts_() {
  var sheet = sheet_('Products');
  var rows = sheet.getDataRange().getDisplayValues();
  var headers = rows.shift().map(function (value) { return String(value).trim(); });
  return rows.map(function (row) {
    return {
      prodId: cleanText_(valueAt_(headers, row, 'ProdID'), 100),
      name: cleanText_(valueAt_(headers, row, 'Name'), 150),
      dosageForm: cleanText_(valueAt_(headers, row, 'DosageForm'), 100)
    };
  }).filter(function (product) { return product.prodId && product.name; });
}

function formatProductId_(sequence) {
  return 'PROD-' + ('000' + sequence).slice(-Math.max(3, String(sequence).length));
}

function productLabel_(product) {
  return product.name + (product.dosageForm ? ' (' + product.dosageForm + ')' : '');
}

// Keep legacy reference matching compatible with shared/products.js.
function productKey_(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function productFormKey_(value) {
  var aliases = {
    tab: 'tabs', tablet: 'tabs', tablets: 'tabs', syrup: 'syr', syrups: 'syr',
    injection: 'inj', injections: 'inj', suspension: 'susp', suspensions: 'susp',
    cap: 'caps', capsule: 'caps', capsules: 'caps', sachet: 'sac', sachets: 'sac',
    'skin cream': 'cream', creams: 'cream', drop: 'drops'
  };
  return aliases[productKey_(value)] || productKey_(value);
}

// IDs remain internal; Sheets stores comma-separated readable product labels.
// Match complete labels before separators so commas in product names survive.
function productReferences_(value, products) {
  if (Array.isArray(value)) return unique_(value.map(function (item) { return String(item).trim(); }));
  var text = String(value || '').trim();
  if (!text) return [];
  if (text.charAt(0) === '[') {
    try {
      var parsed = JSON.parse(text);
      if (Array.isArray(parsed)) return productReferences_(parsed, products);
    } catch (ignored) {}
  }
  var patterns = products.map(function (product) { return product.name.trim(); }).filter(Boolean)
    .sort(function (a, b) { return b.length - a.length; }).map(function (name) {
      return new RegExp('^' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')
        + '(?:\\s*\\([^()]*\\))?(?=\\s*(?:,|\\r?\\n|$))', 'i');
    });
  var references = [];
  while (text) {
    var match = patterns.map(function (pattern) { return text.match(pattern); }).filter(Boolean)[0];
    var reference = match ? match[0] : text.split(/,|\r?\n/)[0];
    references.push(reference.trim());
    text = text.slice(reference.length).replace(/^\s*[,\r\n]\s*/, '').trim();
  }
  return unique_(references);
}

function productIdsFromCell_(value, products) {
  return unique_(productReferences_(value, products).map(function (reference) {
    var byId = products.filter(function (item) { return productKey_(item.prodId) === productKey_(reference); })[0];
    if (byId) return byId.prodId;
    var label = reference.trim().match(/^(.*)\(([^()]*)\)$/);
    var matches = products.filter(function (item) {
      return label
        ? productKey_(item.name) === productKey_(label[1]) && productFormKey_(item.dosageForm) === productFormKey_(label[2])
        : productKey_(item.name) === productKey_(reference);
    });
    return matches.length === 1 ? matches[0].prodId : reference;
  }));
}

/**
 * Converts legacy/missing product IDs to PROD-001, PROD-002, ... while
 * preserving already-valid unique IDs. Exact references in Doctors are
 * updated at the same time so prescribing-product links do not break.
 * Run normalizeProductIds once after deploying this version.
 */
function normalizeProductIds() {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var result = normalizeProductIds_(spreadsheet_());
    ensureProductEditTrigger_();
    return result;
  } finally {
    lock.releaseLock();
  }
}

function ensureProductEditTrigger_() {
  var exists = ScriptApp.getProjectTriggers().some(function (trigger) {
    return trigger.getHandlerFunction() === 'handleProductEdit_'
      && trigger.getEventType() === ScriptApp.EventType.ON_EDIT;
  });
  if (!exists) {
    ScriptApp.newTrigger('handleProductEdit_')
      .forSpreadsheet(CONFIG.SPREADSHEET_ID)
      .onEdit()
      .create();
  }
}

function normalizeProductIds_(ss) {
  var productSheet = ss.getSheetByName('Products');
  var doctorSheet = ss.getSheetByName('Doctors');
  if (!productSheet) throw new Error('Missing Products sheet.');

  var headers = readHeaders_(productSheet);
  var idIndex = columnIndex_(headers, 'ProdID');
  var nameIndex = columnIndex_(headers, 'Name');
  var rowCount = Math.max(0, productSheet.getLastRow() - 1);
  if (!rowCount) return { updatedProducts: 0, updatedDoctors: 0 };

  var rows = productSheet.getRange(2, 1, rowCount, headers.length).getDisplayValues();
  var oldIdCounts = {};
  rows.forEach(function (row) {
    if (!cleanText_(row[nameIndex], 150)) return;
    var key = normalized_(row[idIndex]);
    if (key) oldIdCounts[key] = (oldIdCounts[key] || 0) + 1;
  });

  var used = {};
  var preserved = {};
  rows.forEach(function (row, index) {
    if (!cleanText_(row[nameIndex], 150)) return;
    var match = cleanText_(row[idIndex], 100).toUpperCase().match(/^PROD-(\d{3,})$/);
    if (!match) return;
    var sequence = Number(match[1]);
    if (sequence < 1) return;
    var canonical = formatProductId_(sequence);
    if (!used[canonical]) {
      used[canonical] = true;
      preserved[index] = canonical;
    }
  });

  var replacements = {};
  var updatedProducts = 0;
  var nextSequence = 1;
  var idValues = rows.map(function (row, index) {
    var name = cleanText_(row[nameIndex], 150);
    var oldId = cleanText_(row[idIndex], 100);
    if (!name) {
      if (oldId) updatedProducts += 1;
      return [''];
    }

    var newId = preserved[index];
    if (!newId) {
      while (used[formatProductId_(nextSequence)]) nextSequence += 1;
      newId = formatProductId_(nextSequence);
      used[newId] = true;
      nextSequence += 1;
    }

    if (oldId !== newId) {
      updatedProducts += 1;
      var oldKey = normalized_(oldId);
      if (oldKey && oldIdCounts[oldKey] === 1) replacements[oldKey] = newId;
    }
    return [newId];
  });

  productSheet.getRange(2, idIndex + 1, rowCount, 1).setValues(idValues);

  var updatedDoctors = 0;
  if (doctorSheet && doctorSheet.getLastRow() > 1 && Object.keys(replacements).length) {
    var products = getProducts_();
    var doctorHeaders = readHeaders_(doctorSheet);
    var productIndex = columnIndex_(doctorHeaders, 'Prescribing Products');
    var doctorRowCount = doctorSheet.getLastRow() - 1;
    var referenceRange = doctorSheet.getRange(2, productIndex + 1, doctorRowCount, 1);
    var referenceValues = referenceRange.getDisplayValues().map(function (row) {
      var changed = false;
      var values = productReferences_(row[0], products).map(function (value) {
        var replacement = replacements[normalized_(value)];
        if (replacement) changed = true;
        return replacement || value;
      });
      if (changed) updatedDoctors += 1;
      return [changed ? values.join(', ') : row[0]];
    });
    referenceRange.setValues(referenceValues);
  }

  return { updatedProducts: updatedProducts, updatedDoctors: updatedDoctors };
}

// Products are maintained directly in Sheets. Assign/correct IDs whenever a
// product row is edited, including multi-row paste operations.
function handleProductEdit_(e) {
  if (!e || !e.range || e.range.getSheet().getName() !== 'Products' || e.range.getRow() < 2) return;
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return;
  try {
    normalizeProductIds_(e.source);
  } finally {
    lock.releaseLock();
  }
}

function doctorFromRow_(headers, row, products) {
  var id = cleanText_(valueAt_(headers, row, 'ID'), 120);
  if (!id) return null;
  return {
    id: id,
    name: cleanText_(valueAt_(headers, row, 'Name'), 120),
    specialties: cleanList_(valueAt_(headers, row, 'Specialties')),
    hospital: cleanText_(valueAt_(headers, row, 'Hospital'), 150),
    pharmacy: cleanText_(valueAt_(headers, row, 'Pharmacy'), 150),
    area: cleanText_(valueAt_(headers, row, 'Area'), 120),
    camp: cleanText_(valueAt_(headers, row, 'Camp'), 120),
    potential: cleanText_(valueAt_(headers, row, 'Potential'), 100),
    stockist: cleanText_(valueAt_(headers, row, 'Stockist'), 120),
    prescriber: normalizedPrescriber_(valueAt_(headers, row, 'Prescriber')),
    opTiming: cleanText_(valueAt_(headers, row, 'OP Timing'), 120),
    callSchedule: cleanText_(valueAt_(headers, row, 'Call Schedule'), 120),
    prescribingProductIds: productIdsFromCell_(valueAt_(headers, row, 'Prescribing Products'), products),
    notes: cleanText_(valueAt_(headers, row, 'Notes'), 500),
    updatedAt: new Date().toISOString(),
    syncState: 'synced'
  };
}

function getDoctors_(products) {
  var sheet = sheet_('Doctors');
  var rows = sheet.getDataRange().getValues();
  var headers = rows.shift().map(function (value) { return String(value).trim(); });
  products = products || getProducts_();
  return rows
    .map(function (row) { return doctorFromRow_(headers, row, products); })
    .filter(Boolean);
}

function validateChoice_(label, value, allowed, optional) {
  if (!value && optional) return '';
  var match = allowed.filter(function (item) { return normalized_(item) === normalized_(value); })[0];
  if (!match) throw new Error(label + ' must come from the spreadsheet master list.');
  return match;
}

function validateDoctor_(input, products) {
  var settings = getSettings_();
  var productIds = products.map(function (product) { return product.prodId; });
  var prescriber = normalizedPrescriber_(input.prescriber);
  var specialties = cleanList_(input.specialties).map(function (value) {
    return validateChoice_('Specialty', value, settings.specialties, false);
  });

  var doctor = {
    id: cleanText_(input.id, 120),
    name: cleanText_(input.name, 120),
    specialties: specialties,
    hospital: cleanText_(input.hospital, 150),
    pharmacy: cleanText_(input.pharmacy, 150),
    area: validateChoice_('Area', cleanText_(input.area, 120), settings.areas, false),
    camp: validateChoice_('Camp', cleanText_(input.camp, 120), settings.camps, false),
    potential: validateChoice_('Potential', cleanText_(input.potential, 100), settings.potentials, true),
    stockist: validateChoice_('Stockist', cleanText_(input.stockist, 120), settings.stockists, true),
    prescriber: prescriber,
    opTiming: validateChoice_('OP timing', cleanText_(input.opTiming, 120), settings.opTimings, true),
    callSchedule: validateChoice_('Call schedule', cleanText_(input.callSchedule, 120), settings.callSchedules, true),
    prescribingProductIds: prescriber === 'Rx'
      ? productIdsFromCell_(input.prescribingProductIds, products).map(function (value) {
          return validateChoice_('Product', value, productIds, false);
        })
      : [],
    notes: cleanText_(input.notes, 500),
    updatedAt: new Date().toISOString(),
    syncState: 'synced'
  };

  if (!doctor.id || !doctor.name) throw new Error('Doctor ID and name are required.');
  return doctor;
}

function doctorCellValue_(doctor, canonical, products) {
  var map = {
    'ID': doctor.id,
    'Name': doctor.name,
    'Specialties': doctor.specialties.join(', '),
    'Hospital': doctor.hospital,
    'Pharmacy': doctor.pharmacy,
    'Area': doctor.area,
    'Camp': doctor.camp,
    'Potential': doctor.potential,
    'Stockist': doctor.stockist,
    'Prescriber': doctor.prescriber,
    'OP Timing': doctor.opTiming,
    'Call Schedule': doctor.callSchedule,
    'Prescribing Products': doctor.prescribingProductIds.map(function (id) {
      return productLabel_(products.filter(function (product) { return product.prodId === id; })[0]);
    }).join(', '),
    'Notes': doctor.notes
  };
  return map[canonical];
}

function upsertDoctor_(input, lockHeld) {
  var isNewRecord = input && input.isNewRecord === true;
  var products = getProducts_();
  var doctor = validateDoctor_(input, products);
  var lock = LockService.getScriptLock();
  if (!lockHeld) lock.waitLock(20000);
  try {
    var sheet = sheet_('Doctors');
    var rows = sheet.getDataRange().getValues();
    var headers = rows.shift().map(function (value) { return String(value).trim(); });
    var idIndex = columnIndex_(headers, 'ID');
    var nameIndex = columnIndex_(headers, 'Name');
    var hospitalIndex = columnIndex_(headers, 'Hospital');
    var rowNumber = -1;

    if (isNewRecord) doctor.id = nextDoctorIdForCamp_(headers, rows, doctor.camp);

    rows.forEach(function (row, index) {
      var existingId = cleanText_(row[idIndex], 120);
      if (existingId === doctor.id) rowNumber = index + 2;
      if (
        existingId !== doctor.id &&
        normalized_(row[nameIndex]) === normalized_(doctor.name) &&
        normalized_(row[hospitalIndex]) === normalized_(doctor.hospital)
      ) {
        throw new Error('A doctor with the same name and hospital already exists (' + existingId + ').');
      }
    });

    var existingRow = rowNumber > 0
      ? rows[rowNumber - 2].slice()
      : new Array(headers.length).fill('');

    SHEET_HEADERS.Doctors.forEach(function (canonical) {
      existingRow[columnIndex_(headers, canonical)] = doctorCellValue_(doctor, canonical, products);
    });

    if (rowNumber > 0) {
      sheet.getRange(rowNumber, 1, 1, headers.length).setValues([existingRow]);
    } else {
      sheet.appendRow(existingRow);
    }
    return { doctor: doctor };
  } finally {
    if (!lockHeld) lock.releaseLock();
  }
}

function visitDay_(dateString) {
  var parts = dateString.split('-').map(Number);
  return ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][
    new Date(parts[0], parts[1] - 1, parts[2]).getDay()
  ];
}

function validateVisitDate_(value) {
  var date = cleanText_(value, 20);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('A valid visit date is required.');
  if (date < localDate_(new Date())) throw new Error('Past dates cannot be logged.');
  return date;
}

function saveVisit_(input, lockHeld) {
  var date = validateVisitDate_(input.date);
  var camp = cleanText_(input.camp, 120);
  var kind = cleanText_(input.kind, 20) || 'Visit';
  if (['Visit', 'Sunday', 'Holiday', 'Leave'].indexOf(kind) === -1) throw new Error('Invalid visit type.');
  if (!camp) throw new Error('Camp is required.');

  var doctorLines = [];
  var pharmacyLines = [];
  var doctorIds = [];

  if (kind === 'Visit') {
    var requestedIds = cleanList_(input.doctorIds);
    var doctorById = {};
    getDoctors_().forEach(function (doctor) { doctorById[doctor.id] = doctor; });
    var pharmacyMap = {};
    requestedIds.forEach(function (id) {
      var doctor = doctorById[id];
      if (!doctor || doctor.camp !== camp) return;
      doctorIds.push(doctor.id);
      doctorLines.push(
        (doctorLines.length + 1) + '. ' + doctor.name
          + ' (' + (doctor.specialties.join(', ') || 'General') + ')'
      );
      if (doctor.pharmacy && !pharmacyMap[normalized_(doctor.pharmacy)]) {
        pharmacyMap[normalized_(doctor.pharmacy)] = true;
        pharmacyLines.push((pharmacyLines.length + 1) + '. ' + doctor.pharmacy);
      }
    });
    if (!doctorLines.length) throw new Error('Select at least one doctor from this camp.');
  } else {
    doctorLines = ['NO_VISIT:' + kind];
  }

  var lock = LockService.getScriptLock();
  if (!lockHeld) lock.waitLock(20000);
  try {
    var sheet = sheet_('Visits');
    var headers = readHeaders_(sheet);
    var row = new Array(headers.length).fill('');
    row[columnIndex_(headers, 'Date')] = date;
    row[columnIndex_(headers, 'Day')] = visitDay_(date);
    row[columnIndex_(headers, 'Camp')] = camp;
    row[columnIndex_(headers, 'Doctors (count)')] = kind === 'Visit' ? doctorLines.length : 0;
    row[columnIndex_(headers, 'Pharmacy (count)')] = kind === 'Visit' ? pharmacyLines.length : 0;
    row[columnIndex_(headers, 'Doctors')] = doctorLines.join('\n');
    row[columnIndex_(headers, 'Pharmacy')] = pharmacyLines.join('\n');
    sheet.insertRowBefore(2);
    sheet.getRange(2, 1, 1, headers.length).setValues([row]);
    sheet.getRange(2, columnIndex_(headers, 'Doctors') + 1).setWrap(true);
    sheet.getRange(2, columnIndex_(headers, 'Pharmacy') + 1).setWrap(true);
    return { visit: visitFromRow_(headers, row, 2), doctorIds: doctorIds };
  } finally {
    if (!lockHeld) lock.releaseLock();
  }
}

function undoVisit_(input, lockHeld) {
  var targetDate = cleanText_(input.date, 20);
  var targetCamp = cleanText_(input.camp, 120);
  var targetDoctors = Array.isArray(input.doctorLines)
    ? input.doctorLines.map(function (line) { return cleanText_(line, 1000); }).filter(Boolean).join('\n')
    : cleanText_(input.doctorLines, 5000).replace(/\r\n/g, '\n');
  var lock = LockService.getScriptLock();
  if (!lockHeld) lock.waitLock(20000);
  try {
    var sheet = sheet_('Visits');
    var headers = readHeaders_(sheet);
    if (sheet.getLastRow() <= 1) return { removed: false };
    var rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, headers.length).getValues();
    var dateIndex = columnIndex_(headers, 'Date');
    var campIndex = columnIndex_(headers, 'Camp');
    var doctorsIndex = columnIndex_(headers, 'Doctors');
    for (var index = 0; index < rows.length; index++) {
      var rowDoctors = cleanText_(rows[index][doctorsIndex], 5000).replace(/\r\n/g, '\n');
      if (
        displayDateValue_(rows[index][dateIndex]) === targetDate &&
        cleanText_(rows[index][campIndex], 120) === targetCamp &&
        rowDoctors === targetDoctors
      ) {
        sheet.deleteRow(index + 2);
        return { removed: true };
      }
    }
    return { removed: false };
  } finally {
    if (!lockHeld) lock.releaseLock();
  }
}

function visitFromRow_(headers, row, sheetRow) {
  var date = displayDateValue_(valueAt_(headers, row, 'Date'));
  var doctorsText = cleanText_(valueAt_(headers, row, 'Doctors'), 5000).replace(/\r\n/g, '\n');
  var doctorLines = doctorsText ? doctorsText.split('\n').filter(Boolean) : [];
  var pharmacyText = cleanText_(valueAt_(headers, row, 'Pharmacy'), 5000).replace(/\r\n/g, '\n');
  var pharmacyLines = pharmacyText ? pharmacyText.split('\n').filter(Boolean) : [];
  var noVisit = doctorsText.indexOf('NO_VISIT:') === 0 ? doctorsText.slice(9) : '';
  var kind = ['Sunday', 'Holiday', 'Leave'].indexOf(noVisit) !== -1 ? noVisit : 'Visit';
  var doctorIds = doctorLines.map(function (line) {
    var unnumbered = line.replace(/^\s*\d+\.\s*/, '');
    var separator = unnumbered.indexOf(' — ');
    return separator > 0 ? unnumbered.slice(0, separator).trim() : '';
  }).filter(Boolean);

  var fingerprint = Utilities.base64EncodeWebSafe(
    Utilities.computeDigest(
      Utilities.DigestAlgorithm.SHA_256,
      [date, valueAt_(headers, row, 'Camp'), doctorsText, pharmacyText, sheetRow].join('|')
    )
  ).slice(0, 18);

  return {
    localId: 'server-' + fingerprint,
    date: date,
    day: cleanText_(valueAt_(headers, row, 'Day'), 20) || visitDay_(date),
    camp: cleanText_(valueAt_(headers, row, 'Camp'), 120),
    kind: kind,
    doctorIds: doctorIds,
    doctorCount: Number(valueAt_(headers, row, 'Doctors (count)')) || 0,
    pharmacyCount: Number(valueAt_(headers, row, 'Pharmacy (count)')) || 0,
    doctorLines: doctorLines,
    pharmacyLines: pharmacyLines,
    createdAt: date ? date + 'T00:00:00.000Z' : new Date().toISOString(),
    syncState: 'synced'
  };
}

function getVisits_() {
  var sheet = sheet_('Visits');
  var rows = sheet.getDataRange().getValues();
  var headers = rows.shift().map(function (value) { return String(value).trim(); });
  return rows.map(function (row, index) { return visitFromRow_(headers, row, index + 2); })
    .filter(function (visit) { return visit.date; })
    .sort(function (a, b) {
      if (a.date === b.date) return b.localId.localeCompare(a.localId);
      return b.date.localeCompare(a.date);
    });
}

function bootstrap_() {
  var products = getProducts_();
  return {
    success: true,
    doctors: getDoctors_(products),
    visits: getVisits_(),
    settings: getSettings_(),
    products: products,
    serverTime: new Date().toISOString()
  };
}

function processedOperations_() {
  var raw = PropertiesService.getScriptProperties().getProperty('MEDREP_PROCESSED_OPS');
  if (!raw) return [];
  try {
    var parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (ignored) {
    return [];
  }
}

function wasProcessed_(opId) {
  return processedOperations_().indexOf(opId) !== -1;
}

function rememberOperation_(opId, result) {
  var properties = PropertiesService.getScriptProperties();
  if (result.doctor) properties.setProperty('MEDREP_DOCTOR_OP_' + opId, result.doctor.id);
  var operations = processedOperations_();
  operations.push(opId);
  // Leave room below the per-property size limit, even for non-UUID IDs.
  while (operations.length > CONFIG.MAX_REMEMBERED_OPERATIONS || JSON.stringify(operations).length > 2000) {
    properties.deleteProperty('MEDREP_DOCTOR_OP_' + operations.shift());
  }
  properties.setProperty(
    'MEDREP_PROCESSED_OPS',
    JSON.stringify(operations)
  );
}
