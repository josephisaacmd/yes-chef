// Deterministic tests for the v2 pick algorithm (lib/pick-algorithm.js).
// Seeds a throwaway DB with synthetic eating patterns and asserts the scorer
// ranks them the way the household actually behaves.
//
//   node scripts/test-scorer.js
//
// Exits non-zero on failure.

const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'yes-chef-test-'));

const { db } = require('../db');
const { scoreMeals, pickMeals } = require('../lib/pick-algorithm');

const TODAY = '2026-07-02';
const ins = db.prepare('INSERT INTO meals (name) VALUES (?)');
const ent = db.prepare(`INSERT INTO entries (meal_id, on_date, slot, status, eater, reaction)
                        VALUES (?, ?, 'lunch', 'eaten', ?, ?)`);
const iso = (o) => { const d = new Date(TODAY + 'T00:00'); d.setDate(d.getDate() + o); return d.toISOString().slice(0, 10); };

// Synthetic household patterns.
const A = ins.run('Weekly soup').lastInsertRowid;            // due exactly on cadence
[-28, -21, -14, -7].forEach(o => ent.run(A, iso(o), 'christine', null));
const B = ins.run('Kick dish').lastInsertRowid;              // active kick (dense + fresh)
[-40, -8, -5, -2].forEach(o => ent.run(B, iso(o), 'christine', null));
const C = ins.run('Bad curry').lastInsertRowid;              // sat poorly recently
[-30, -5].forEach(o => ent.run(C, iso(o), 'christine', o === -5 ? 'sat_poorly' : null));
const D = ins.run('Old favorite').lastInsertRowid;           // long-overdue → floor, not zero
[-100, -90, -80, -70, -60].forEach(o => ent.run(D, iso(o), 'christine', null));
ins.run('Never tried dish');
const F = ins.run('Joseph cafeteria special').lastInsertRowid; // his history ≠ her history
[-3, -1].forEach(o => ent.run(F, iso(o), 'joseph', null));
const G = ins.run('Just had it').lastInsertRowid;            // weekly meal eaten yesterday
[-22, -15, -8, -1].forEach(o => ent.run(G, iso(o), 'christine', null));
const H = ins.run('Cooling kick').lastInsertRowid;           // kick gone quiet → satiation
[-13, -10, -6].forEach(o => ent.run(H, iso(o), 'christine', null));

const { scored } = scoreMeals({ eater: 'christine', today: TODAY });
console.log('score | meal                       | why');
for (const m of scored) console.log(m._score.toFixed(3), '|', m.name.padEnd(26), '|', m._why);
console.log('');

let failures = 0;
const get = (id) => scored.find(m => m.id === id);
const rank = (id) => scored.findIndex(m => m.id === id);
const assert = (c, msg) => { if (!c) { failures++; console.error('FAIL:', msg); } else console.log('PASS:', msg); };

assert(rank(A) === 0, 'meal perfectly on cadence ranks #1');
assert(!get(A)._why.includes('cooling'), 'normal weekly cadence is not a cooling kick');
assert(get(B)._why.includes('kick') && rank(B) <= 1, 'dense recent eating detected as an active kick');
assert(!get(G)._why.includes('kick'), 'a single recent eat is not a kick');
assert(get(G)._score < 0.35, 'just-eaten weekly meal scores low');
assert(get(H)._why.includes('cooling'), 'quiet kick gets the satiation cooldown');
assert(get(C)._score < 0.2, 'sat_poorly suppresses hard');
assert(get(F)._why.includes('never tried'), "joseph-only history reads never-tried for christine");
assert(get(D)._score >= 0.3, 'long-overdue favourite keeps a floor score');

// pickMeals: determinism of the scoring layer + avoid-days hard filter.
const { picks } = pickMeals({ eater: 'christine', today: TODAY, variety: 1, avoidDays: 2, limit: 3 });
assert(picks.every(p => p._days_since == null || p._days_since >= 2), 'avoidDays hard filter respected');
assert(picks.every(p => typeof p._why === 'string' && p._why.length), 'every pick carries a why');

fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
console.log(failures ? `\n${failures} FAILURES` : '\nAll scorer tests passed.');
process.exit(failures ? 1 : 0);
