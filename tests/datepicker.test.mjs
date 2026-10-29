/*
 * Calendar widget tests: `node --test tests/datepicker.test.mjs`
 *
 * Dates are where autofillers quietly lie. A year-only date became 01/01/2023 on a
 * real form once, so the widget refuses to invent a day and the shape it hands back
 * must match what the specific field asked for.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

globalThis.window = globalThis;
vm.runInThisContext(readFileSync(new URL('../extension/datepicker.js', import.meta.url), 'utf8'));
vm.runInThisContext(readFileSync(new URL('../extension/matcher.js', import.meta.url), 'utf8'));

const C = globalThis.FILLDESK_CAL;
const M = globalThis.FILLDESK_MATCHER;

test('the module exposes what the two callers use', () => {
  for (const fn of ['monthMatrix', 'pickToValue', 'parseLoose', 'valid', 'buildPicker', 'attachAll', 'daysInMonth']) {
    assert.equal(typeof C[fn], 'function', `${fn} missing`);
  }
  assert.equal(C.MONTHS.length, 12);
  assert.equal(C.DOW.length, 7);
});

test('month grids are right, including February in a leap year', () => {
  assert.equal(C.daysInMonth(2024, 2), 29);
  assert.equal(C.daysInMonth(2023, 2), 28);
  assert.equal(C.daysInMonth(2024, 4), 30);
  const feb = C.monthMatrix(2024, 2, 0).flat().filter(Boolean);
  assert.equal(feb.length, 29);
  assert.equal(feb[0].day, 1);
  assert.equal(feb[feb.length - 1].day, 29);
  for (const week of C.monthMatrix(2024, 2, 0)) assert.equal(week.length, 7);
  // a Sunday-start month must not shift when the week starts on Monday
  const sun = C.monthMatrix(2024, 2, 0)[0].filter(Boolean)[0];
  const mon = C.monthMatrix(2024, 2, 1)[0].filter(Boolean)[0];
  assert.ok(sun.day <= 7 && mon.day <= 7, 'first week always holds the 1st-ish');
  assert.deepEqual(C.monthMatrix(2024, 13, 0), [], 'month 13 is not a month');
  assert.deepEqual(C.monthMatrix(0, 2, 0), [], 'year 0 is not a year');
});

test('it reads dates the way people already typed them', () => {
  assert.deepEqual(C.parseLoose('2021'), { year: 2021 });
  assert.deepEqual(C.parseLoose('2021-06'), { year: 2021, month: 6 });
  assert.deepEqual(C.parseLoose('2021-6'), { year: 2021, month: 6 });
  assert.deepEqual(C.parseLoose('06/2021'), { year: 2021, month: 6 });
  assert.deepEqual(C.parseLoose('6.2021'), { year: 2021, month: 6 });
  assert.deepEqual(C.parseLoose('06/15/2024'), { year: 2024, month: 6, day: 15 });
  assert.deepEqual(C.parseLoose('15/06/2024'), { year: 2024, month: 6, day: 15 }, 'day-first when only that is possible');
  for (const junk of ['', '   ', 'Present', 'current', 'n/a', '4 weeks after offer', 'summer of 2021']) {
    assert.equal(C.parseLoose(junk), null, `"${junk}" is not a date`);
  }
});

test('a pick becomes the shape the field asked for', () => {
  assert.equal(C.pickToValue({ year: 2021 }, 'y'), '2021');
  assert.equal(C.pickToValue({ year: 2021, month: 6 }, 'ym'), '2021-06');
  assert.equal(C.pickToValue({ year: 2021, month: 6 }, 'y'), '2021', 'year mode never leaks a month');
  assert.equal(C.pickToValue({ year: 2021, month: 6 }, 'mdy'), '2021-06', 'no invented day, ever');
  assert.equal(C.pickToValue({ year: 2024, month: 6, day: 5 }, 'mdy'), '2024-06-05');
  assert.equal(C.pickToValue({}, 'ym'), '');
});

test('impossible picks are refused, not written', () => {
  assert.equal(C.valid({ year: 2024, month: 13 }, 'ym'), false);
  assert.equal(C.valid({ year: 2024, month: 2, day: 30 }, 'mdy'), false);
  assert.equal(C.valid({ year: 2024, month: 2, day: 29 }, 'mdy'), true, 'leap day is real');
  assert.equal(C.valid({ year: 2023, month: 2, day: 29 }, 'mdy'), false);
  assert.equal(C.valid({ year: 2024, month: 6 }, 'mdy'), false, 'mdy needs a day');
  assert.equal(C.valid({ year: 2024 }, 'y'), true);
});

test('what the widget picks is what the matcher types, in the form\'s own format', () => {
  const pickedMonth = C.pickToValue({ year: 2021, month: 6 }, 'ym');     // 2021-06
  assert.equal(M.formatDate(pickedMonth, { dateHint: 'mdy' }), '06/2021');
  assert.equal(M.formatDate(pickedMonth, { dateHint: 'dmy' }), '06/2021');
  assert.equal(M.formatDate(pickedMonth, { dateHint: 'ymd', type: 'text' }), '2021-06');
  assert.equal(M.formatDate(pickedMonth, { type: 'month' }), '2021-06');
  const pickedYear = C.pickToValue({ year: 2023 }, 'y');                  // 2023
  assert.equal(M.formatDate(pickedYear, { dateHint: 'mdy' }), '2023', 'a bare year stays bare');
  const pickedDay = C.pickToValue({ year: 2024, month: 6, day: 5 }, 'mdy');
  assert.equal(M.formatDate(pickedDay, { dateHint: 'mdy' }), '06/05/2024');
  assert.equal(M.formatDate(pickedDay, { dateHint: 'dmy' }), '05/06/2024');
});

test('attachAll is harmless where there is no DOM', () => {
  assert.deepEqual(C.attachAll(null, null), []);
  assert.deepEqual(C.attachAll({ querySelectorAll: () => [] }, null), []);
});
