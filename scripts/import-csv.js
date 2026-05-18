#!/usr/bin/env node
// Bulk-import meals from a CSV file straight into the SQLite database.
//
// Usage:
//   node scripts/import-csv.js [path-to-csv]      (default: ./food-log.csv)
//   node scripts/import-csv.js --replace-tags     (replace tags instead of merging)
//   node scripts/import-csv.js --dry-run          (parse + show summary, no writes)
//
// CSV format:
//   * First row is a header. Recognized columns (case-insensitive, any of):
//       name:  name | dish | dish name | meal | meal name        (REQUIRED)
//       tags:  tags | tag | category | categories | cuisine | cuisine type | type
//       notes: notes | note | description | comment | comments
//   * Tags inside the tags field are delimited by `;` `|` or `,`.
//   * Extra columns are ignored.
//   * Quoted fields supported, "" escapes a quote inside a quoted field.
//
// Idempotent: re-running the same CSV adds nothing new, just merges tags.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { bulkImportMeals } = require('../db');

// --- argv parsing --------------------------------------------------------
const argv = process.argv.slice(2);
const flags = new Set(argv.filter(a => a.startsWith('--')));
const positional = argv.filter(a => !a.startsWith('--'));
const csvPath = path.resolve(positional[0] || 'food-log.csv');
const dryRun = flags.has('--dry-run');
const replaceTags = flags.has('--replace-tags');

if (!fs.existsSync(csvPath)) {
  console.error(`✖ CSV file not found: ${csvPath}`);
  process.exit(1);
}

// --- minimal CSV parser (RFC-4180-ish) -----------------------------------
function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') { inQuotes = false; }
      else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (!(row.length === 1 && row[0] === '')) rows.push(row);
      row = [];
    } else {
      field += c;
    }
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// --- read + map ----------------------------------------------------------
const text = fs.readFileSync(csvPath, 'utf8').replace(/^\uFEFF/, ''); // strip BOM
const rows = parseCSV(text);
if (rows.length < 2) {
  console.error('✖ CSV must have a header row and at least one data row.');
  process.exit(1);
}

// Header aliases. Keep in sync with public/app.js (parseCsvForUpload).
const NAME_ALIASES  = ['name', 'dish', 'dish name', 'meal', 'meal name', 'food'];
const TAGS_ALIASES  = ['tags', 'tag', 'category', 'categories', 'cuisine', 'cuisine type', 'type'];
const NOTES_ALIASES = ['notes', 'note', 'description', 'comment', 'comments'];

const headers = rows[0].map(h => h.trim().toLowerCase());
const findCol = (aliases) => headers.findIndex(h => aliases.includes(h));
const nameIdx  = findCol(NAME_ALIASES);
const tagsIdx  = findCol(TAGS_ALIASES);
const notesIdx = findCol(NOTES_ALIASES);

if (nameIdx === -1) {
  console.error(`✖ CSV needs a name column (one of: ${NAME_ALIASES.join(', ')}).`);
  console.error(`  Got headers: ${headers.join(', ')}`);
  process.exit(1);
}
console.log(`Columns: name="${headers[nameIdx]}"`
  + (tagsIdx  > -1 ? `, tags="${headers[tagsIdx]}"`   : ', tags=(none)')
  + (notesIdx > -1 ? `, notes="${headers[notesIdx]}"` : ', notes=(none)'));

const records = rows.slice(1)
  .map(r => ({
    name:  r[nameIdx],
    tags:  tagsIdx  > -1 ? r[tagsIdx]  : '',
    notes: notesIdx > -1 ? r[notesIdx] : '',
  }))
  .filter(r => (r.name || '').trim());

console.log(`Parsed ${records.length} meal rows from ${csvPath}`);

if (dryRun) {
  console.log('\nDry run — first 5 parsed records:');
  for (const r of records.slice(0, 5)) console.log('  •', r);
  process.exit(0);
}

const summary = bulkImportMeals(records, { mergeTags: !replaceTags });
console.log(`✓ created: ${summary.created}   updated: ${summary.updated}   skipped (no name): ${summary.skipped}`);
if (summary.errors.length) {
  console.log('Errors:');
  for (const e of summary.errors) console.log(`  row ${e.row} (${e.name}): ${e.error}`);
}
