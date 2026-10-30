/*
 * Matcher tests: `node --test tests/`
 *
 * These describe the whole product promise in data form: what FillDesk is allowed
 * to type, what it must refuse, and what it must leave alone rather than guess.
 * Field descriptors mimic what content.js builds from Greenhouse / Lever /
 * Workday / Workable / generic HTML forms.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

vm.runInThisContext(readFileSync(new URL('../extension/matcher.js', import.meta.url), 'utf8'));
const M = globalThis.FILLDESK_MATCHER;

const SNAP = {
  version: 1,
  packet_id: 'packet_test',
  job: { title: 'Senior Product Manager', company: 'Linear', location: 'Remote (US)' },
  identity: {
    first_name: 'Alex', last_name: 'Rivera', full_name: 'Alex Rivera',
    email: 'alex@example.com', phone: '+1 (415) 555-0100', location: 'San Francisco, CA',
    headline: 'Senior Product Manager', pronouns: 'they/them', timezone: 'PT',
  },
  links: { linkedin: 'https://linkedin.com/in/alexrivera', github: 'https://github.com/alexrivera' },
  resume_markdown: '# Alex Rivera',
  cover_letter: 'Dear Linear hiring team,',
  skills: ['SQL', 'A/B testing', 'roadmapping'],
  languages: ['English (native)'],
  certifications: ['CSM'],
  summary: 'PM with 7+ years in growth products.',
  experience: [
    { company: 'Figma', title: 'Senior Product Manager', location: 'Remote', start: '2021-06', end: 'Present', current: true, bullets: ['+23% conversion'] },
    { company: 'Dropbox', title: 'Product Manager', location: 'SF', start: '2018-07', end: '2021-05', current: false, bullets: ['-40% tickets'] },
  ],
  education: [{ school: 'UC Berkeley', degree: 'BS', field: 'EECS', start: '2014', end: '2018' }],
  answers: [
    { question: 'Why Linear?', key: 'why linear', answer: 'I have run my roadmap in Linear for two years.', confidence: 0.9, needs_input: false },
    { question: 'How do you approach prioritization?', key: 'how do you approach prioritization', answer: 'Frequency times severity, filtered by owned metric.', confidence: 0.85, needs_input: false },
    { question: 'Are you legally authorized to work in the US?', key: 'are you legally authorized', answer: '', blocked: true, category: 'work_authorization' },
    { question: 'What is your experience with Kubernetes?', key: 'what is your experience with kubernetes', answer: '[NEEDS INPUT] not drafted', confidence: 0.2, needs_input: true },
  ],
  review_only: { salary_expectation: '$185,000', relocation: 'Remote or SF hybrid', start_date: '4 weeks', notice_period: '4 weeks' },
  never_autofill: ['protected_class', 'disability', 'veteran', 'work_authorization', 'age', 'criminal', 'legal_declaration', 'health'],
};

const SETTINGS = { refuse_blocked_fields: true, overwrite_filled: false, click_navigation: true, upload_documents: true };

const f = (o) => ({ tag: 'input', type: 'text', visible: true, label: '', name: '', id: '', placeholder: '', options: [], ...o });
const decide = (field) => M.classify(field, SNAP, SETTINGS);

// ------------------------------------------------------------------ identity
test('greenhouse-style name/email/phone map correctly', () => {
  assert.equal(decide(f({ label: 'First name', name: 'first_name' })).key, 'identity.first_name');
  assert.equal(decide(f({ label: 'Last name', name: 'last_name' })).value, 'Rivera');
  assert.equal(decide(f({ label: 'Email address', name: 'email', type: 'email' })).value, 'alex@example.com');
  assert.equal(decide(f({ label: 'Phone number', name: 'phone', type: 'tel' })).value, '+14155550100');
  assert.equal(decide(f({ label: 'Where are you based?', name: 'location' })).value, 'San Francisco, CA');
});

test('autocomplete attribute wins when the label is useless', () => {
  const r = decide(f({ label: '', name: 'f3k2', autocomplete: 'given-name' }));
  assert.equal(r.key, 'identity.first_name');
  assert.equal(r.method, 'autocomplete');
  assert.ok(r.confidence > 0.9);
});

test('links go to the right place', () => {
  assert.equal(decide(f({ label: 'LinkedIn profile', name: 'linkedin_url' })).value, 'https://linkedin.com/in/alexrivera');
  assert.equal(decide(f({ label: 'GitHub', name: 'github' })).value, 'https://github.com/alexrivera');
});

test('location splits into city/state/country selects', () => {
  assert.deepEqual(M.splitLocation('San Francisco, CA'), { city: 'San Francisco', state: 'CA', country: 'CA' });
  assert.equal(decide(f({ label: 'City', name: 'city' })).value, 'San Francisco');
  assert.equal(decide(f({ label: 'State / Province', name: 'state' })).value, 'CA');
});

// ------------------------------------------------------------------ compliance wall
const MUST_REFUSE = [
  ['Are you legally authorized to work in the United States?', 'work_authorization'],
  ['Will you now or in the future require sponsorship?', 'work_authorization'],
  ['What is your citizenship or immigration status?', 'work_authorization'],
  ['Self-identification: Race or Ethnicity', 'protected_class'],
  ['Please indicate your gender', 'protected_class'],
  ['Do you identify as a person with a disability?', 'disability'],
  ['Do you require a reasonable accommodation?', 'disability'],
  ['Are you a protected veteran?', 'veteran'],
  ['What is your date of birth?', 'age'],
  ['Have you ever been convicted of a felony?', 'criminal'],
  ['I certify that all information provided is true and complete', 'legal_declaration'],
  ['Signature', 'legal_declaration'],
  ['Are you 18 or older?', 'age'],
  ['Social Security Number', 'financial_and_credit'],
  ['Card number', 'financial_and_credit'],
  ['Do you have any health conditions?', 'health'],
  ['What is your marital status?', 'health'],
];

test('compliance questions are refused, never guessed', () => {
  for (const [label, category] of MUST_REFUSE) {
    const r = decide(f({ label, name: label.toLowerCase().replace(/\W+/g, '_').slice(0, 24) }));
    assert.equal(r.action, 'block', `"${label}" must be blocked, got ${r.action}/${r.category}`);
    assert.equal(r.category, category, `"${label}" expected ${category}, got ${r.category}`);
    assert.equal(r.value, '', `"${label}" must carry no value`);
  }
});

test('a blocked question in the packet stays blocked on the form', () => {
  const r = decide(f({ tag: 'textarea', type: 'textarea', label: 'Are you legally authorized to work in the US?' }));
  assert.equal(r.action, 'block');
});

test('review-flagged fields are filled from profile but marked for a second look', () => {
  const salary = decide(f({ label: 'Preferred salary', name: 'salary_expectation' }));
  assert.equal(salary.action, 'fill');
  assert.equal(salary.value, '$185,000');
  assert.equal(salary.review, 'salary');
  const reloc = decide(f({ label: 'Are you willing to relocate?', name: 'relocate' }));
  assert.equal(reloc.action, 'fill');
  assert.equal(reloc.review, 'relocation');
});

// ------------------------------------------------------------------ documents
test('file inputs are classified as resume vs cover letter', () => {
  const resume = decide(f({ tag: 'input', type: 'file', label: 'Resume / CV', name: 'resume' }));
  assert.equal(resume.action, 'upload');
  assert.equal(resume.value, 'resume');
  const cover = decide(f({ tag: 'input', type: 'file', label: 'Cover letter', name: 'cover_letter' }));
  assert.equal(cover.action, 'upload');
  assert.equal(cover.value, 'cover_letter');
  const other = decide(f({ tag: 'input', type: 'file', label: 'Transcripts', name: 'transcript' }));
  assert.equal(other.action, 'skip');
});

// ------------------------------------------------------------------ history
test('employment history maps to the snapshot in order', () => {
  const exp = { section: 'Employment history' };
  assert.equal(decide(f({ label: 'Current/Most recent company', name: 'company', ...exp })).value, 'Figma');
  assert.equal(decide(f({ label: 'Job Title', name: 'title', ...exp })).value, 'Senior Product Manager');
  const start = decide(f({ label: 'Start Date', name: 'start_date', placeholder: 'mm/dd/yyyy', dateHint: 'mdy', ...exp }));
  assert.equal(start.action, 'fill');
  assert.equal(start.value, '06/2021');
  const end = decide(f({ label: 'End Date', name: 'end_date', ...exp }));
  assert.equal(end.action, 'skip', 'a current role has no end date to invent');
  assert.equal(decide(f({ label: 'School / University', name: 'school', section: 'Education' })).value, 'UC Berkeley');
});

test('workday-style month input gets YYYY-MM', () => {
  const r = decide(f({ label: 'Start Date', name: 'start', type: 'month', section: 'Employment history' }));
  assert.equal(r.value, '2021-06');
});

// ------------------------------------------------------------------ answers
test('employer questions match packet answers by intent', () => {
  const r = decide(f({ tag: 'textarea', type: 'textarea', label: 'Why do you want to work at Linear?' }));
  assert.equal(r.action, 'fill');
  assert.match(r.value, /run my roadmap in Linear/);
  assert.match(r.method, /intent:why_company/);
});

test('exact question text match wins', () => {
  const r = decide(f({ tag: 'textarea', type: 'textarea', label: 'How do you approach prioritization?' }));
  assert.equal(r.method, 'exact');
  assert.match(r.value, /Frequency times severity/);
});

test('a drafted answer with an open gap is never typed into a form', () => {
  const snap = JSON.parse(JSON.stringify(SNAP));
  snap.answers[0] = { question: 'Why Linear?', key: 'why linear', answer: '[NEEDS INPUT] customise this', confidence: 0.9, needs_input: false };
  const r = M.classify(f({ tag: 'textarea', type: 'textarea', label: 'Why do you want to work at Linear?' }), snap, SETTINGS);
  assert.equal(r.action, 'skip');
  assert.match(r.reason, /open gap/);
});

test('unknown questions are left blank, not guessed', () => {
  const r = decide(f({ tag: 'textarea', type: 'textarea', label: 'Describe your experience with Kubernetes and Terraform.' }));
  assert.equal(r.action, 'skip');
  assert.ok(r.reason.length > 4, 'must explain why it skipped');
});

test('unrecognised inputs are skipped with a reason', () => {
  const r = decide(f({ label: 'Favourite colour', name: 'fav_colour' }));
  assert.equal(r.action, 'skip');
});

test('hidden and password fields are never touched', () => {
  assert.equal(decide(f({ label: 'First name', visible: false })).reason, 'hidden');
  assert.equal(decide(f({ label: 'Password', type: 'password' })).reason, 'password field');
});

// ------------------------------------------------------------------ options
test('employment dates need employment context', () => {
  const inExperience = decide(f({ label: 'Start date', name: 'start', placeholder: 'mm/yyyy', dateHint: 'my', section: 'Experience' }));
  assert.equal(inExperience.key, 'exp.start');
  assert.equal(inExperience.value, '06/2021');

  const inIdentityBlock = decide(f({ label: 'Earliest start date', name: 'start_date', placeholder: 'mm/dd/yyyy', section: 'Your details' }));
  assert.equal(inIdentityBlock.key, 'review.start_date', 'must not steal the first job start date');
  assert.equal(inIdentityBlock.value, '4 weeks');
  assert.equal(inIdentityBlock.review, 'start_date');

  const noContext = decide(f({ label: 'Start date', name: 'start', placeholder: 'mm/yyyy' }));
  assert.notEqual(noContext.key, 'exp.start', 'no section means no guessing which start date it is');
});

test('degree includes field of study when both exist', () => {
  const r = decide(f({ label: 'Degree / Field of study', name: 'degree', section: 'Education' }));
  assert.equal(r.key, 'edu.degree');
  assert.equal(r.value, 'BS EECS');
});

test('radio groups inherit the question above them', () => {
  const yes = decide(f({ type: 'radio', tag: 'input', label: 'Yes', name: 'work_auth', groupLabel: 'Are you legally authorized to work in the United States?' }));
  assert.equal(yes.action, 'block');
  assert.equal(yes.category, 'work_authorization');
  const no = decide(f({ type: 'radio', tag: 'input', label: 'No', name: 'accommodation', groupLabel: 'Do you require a reasonable accommodation to complete the application process?' }));
  assert.equal(no.action, 'block');
  assert.equal(no.category, 'disability');
  const benign = decide(f({ type: 'radio', tag: 'input', label: 'Full-time', name: 'employment_type', groupLabel: 'Which best describes the role you are applying for?' }));
  assert.notEqual(benign.action, 'block');
});

test('a date that cannot exist is never typed', () => {
  assert.equal(M.formatDate('2026-24', { type: 'text', dateHint: 'mdy' }), '', 'month 24 is not a date');
  assert.equal(M.formatDate('13/05/2020', { type: 'text', dateHint: 'mdy' }), '', 'ambiguous or impossible');
  assert.equal(M.formatDate('08-1995', { type: 'text', dateHint: 'mdy' }), '08/1995', 'MM-YYYY is understood');
  assert.equal(M.formatDate('nonsense', { type: 'text' }), '', 'free text is not a date');
  assert.equal(M.formatDate('Summer 2020', { type: 'number', label: 'Graduation year', name: 'year' }), '2020');
  assert.equal(M.parseDate('1899'), null, 'implausible year');

  const snapshot = { ...SNAP, experience: [{ company: 'Acme', title: 'Engineer', start: '2026-24', end: '' }] };
  const r = M.classify(f({ label: 'Start date', name: 'start', placeholder: 'mm/dd/yyyy', dateHint: 'mdy', section: 'Employment history' }),
    snapshot, { refuse_blocked_fields: true });
  assert.notEqual(r.action, 'fill', 'an impossible date must not be typed into a real form');
});

test('short fact questions come from the profile, not from drafted prose', () => {
  const based = decide(f({ tag: 'textarea', type: 'textarea', label: 'Where are you based?' }));
  assert.equal(based.key, 'identity.location');
  assert.equal(based.value, 'San Francisco, CA');

  // the five-years question also starts with "where do you" and must NOT be
  // answered with a city
  const five = decide(f({ tag: 'textarea', type: 'textarea', label: 'Where do you see yourself in five years?' }));
  assert.notEqual(five.key, 'identity.location');

  const long = decide(f({ tag: 'textarea', type: 'textarea', label: 'Where are you based, and how do you feel about the hybrid schedule in this role?' }));
  assert.notEqual(long.key, 'identity.location', 'a long prompt is a question, not a form field');
});

test('select option matching is conservative', () => {
  const opts = [{ label: 'Please select' }, { label: 'Full-time' }, { label: 'Part-time' }, { label: 'Contract' }];
  assert.equal(M.matchOption(opts, 'Full-time'), 1);
  assert.equal(M.matchOption(opts, 'full-time'), 1, 'punctuation differences are not meaning differences');
  assert.equal(M.matchOption(opts, 'Contract'), 3);
  assert.equal(M.matchOption(opts, 'freelance'), -1, 'must not guess across wording');
  assert.equal(M.matchOption([{ label: 'Yes' }, { label: 'No' }], 'yes'), 0);
  assert.equal(M.matchOption([{ label: 'No' }, { label: 'Yes' }], 'no'), 0);
  assert.equal(M.matchOption([{ label: '1-2 years' }, { label: '3-5 years' }, { label: '5+ years' }], '7 years'), -1, 'never pick a wrong seniority bucket');
  assert.equal(M.matchOption([{ label: 'January' }, { label: 'June' }], 'June'), 1);
});

test('radio yes/no resolution', () => {
  assert.equal(M.booleanFor('Yes, I am authorized', 'yes'), true);
  assert.equal(M.booleanFor('No', 'no'), true);
  assert.equal(M.booleanFor('Yes', 'no'), false);
  assert.equal(M.booleanFor('Something unrelated', 'yes'), null);
});

// ------------------------------------------------------------------ submit guard
test('never treats submit as navigation', () => {
  for (const t of ['Submit', 'Submit application', 'Apply now', 'Apply for this job', 'Finish', 'Review and submit', 'Send application']) {
    assert.equal(M.isSubmitText(t), true, t + ' must count as submit');
    assert.equal(M.isNextText(t), false, t + ' must never be clicked as Next');
  }
  for (const t of ['Next', 'Continue', 'Save and continue', 'Next step']) {
    assert.equal(M.isNextText(t), true, t + ' is navigation');
  }
});

// ------------------------------------------------------------------ dates
test('date shaping handles the formats ATS forms actually use', () => {
  assert.equal(M.formatDate('2021-06', { type: 'text', dateHint: 'mdy' }), '06/2021', 'no invented day');
  assert.equal(M.formatDate('2021-06-15', { type: 'text', dateHint: 'mdy' }), '06/15/2021');
  assert.equal(M.formatDate('June 2021', { type: 'text', dateHint: 'my' }), '06/2021');
  assert.equal(M.formatDate('2021-06-15', { type: 'text', dateHint: 'ymd' }), '2021-06-15');
  assert.equal(M.formatDate('2018', { type: 'number', label: 'Graduation year', name: 'grad_year' }), '2018');
  assert.equal(M.formatDate('2021-06', { type: 'text', dateHint: 'monthname' }), 'June 2021');
  assert.equal(M.formatDate('Present', { type: 'text' }), '', 'no invented date');
});

test('a year-only date never becomes January the first', () => {
  assert.equal(M.formatDate('2023', { type: 'text', dateHint: 'my' }), '2023');
  assert.equal(M.formatDate('2023', { type: 'text', dateHint: 'mdy' }), '2023');
  assert.equal(M.formatDate('2023', { type: 'month' }), '', 'YYYY-MM cannot be faked from a bare year');
  assert.equal(M.datePrecision('2023'), 'year');
  assert.equal(M.datePrecision('2023-04'), 'month');
  assert.equal(M.datePrecision('2023-04-09'), '');

  const start = decide(f({ label: 'Start date', name: 'start', placeholder: 'mm/dd/yyyy', dateHint: 'mdy', section: 'Employment history' }));
  assert.equal(start.value, '06/2021');
  assert.equal(start.review, 'date_precision', 'amber: the month is a guess the user must confirm');

  const strict = decide(f({ label: 'Start date', name: 'start', type: 'month', section: 'Employment history' }));
  assert.equal(strict.action, 'fill');
  assert.equal(strict.value, '2021-06');
});

test('surrounding container text cannot steer the decision', () => {
  // content.js deliberately does not feed parent text into the signal: a form
  // section titled "Compensation and benefits" sitting above a phone field must
  // not turn that field into a salary field.
  const noisy = f({ label: 'Phone number', name: 'phone', type: 'tel', prefixText: 'Compensation and benefits salary expectation bonus equity' });
  const quiet = f({ label: 'Phone number', name: 'phone', type: 'tel' });
  assert.equal(decide(noisy).key, decide(quiet).key);
  assert.equal(decide(noisy).value, '+14155550100');
  assert.notEqual(decide(noisy).review, 'salary');
  // and the signal builder itself must ignore it
  assert.equal(M.signal({ label: 'a', prefixText: 'salary bonus equity' }), M.signal({ label: 'a' }));
});

test('overlap scoring is sane', () => {
  assert.ok(M.overlap('why linear', 'Why Linear?') > 0.3);
  assert.ok(M.overlap('unrelated topic here', 'Do you have a disability?') < 0.35);
});

test('citizenship and work authorization are autofilled when enabled in settings', () => {
  const citizenSnap = {
    ...SNAP,
    work_authorization: {
      status: 'Citizen',
      is_citizen: true,
      authorized: true,
      requires_sponsorship: false,
    },
    review_only: { ...SNAP.review_only, work_authorization: 'Citizen' },
  };
  const settingsOn = { ...SETTINGS, autofill_work_auth: true };
  const settingsOff = { ...SETTINGS, autofill_work_auth: false };

  // 1. "Are you a U.S. citizen?"
  const qCitizen = f({ label: 'Are you a U.S. citizen?' });
  const rCitizenOn = M.classify(qCitizen, citizenSnap, settingsOn);
  assert.equal(rCitizenOn.action, 'fill');
  assert.equal(rCitizenOn.value, 'Yes');
  assert.equal(rCitizenOn.review, 'work_authorization');

  const rCitizenOff = M.classify(qCitizen, citizenSnap, settingsOff);
  assert.equal(rCitizenOff.action, 'block');
  assert.equal(rCitizenOff.category, 'work_authorization');

  // 2. "Citizenship status" dropdown
  const qCitizenSelect = f({
    tag: 'select',
    label: 'Citizenship status',
    options: [{ label: 'Select...' }, { label: 'U.S. Citizen' }, { label: 'Permanent Resident' }],
  });
  const rCitizenSelect = M.classify(qCitizenSelect, citizenSnap, settingsOn);
  assert.equal(rCitizenSelect.action, 'fill');
  assert.equal(rCitizenSelect.value, 'U.S. Citizen');

  // 3. "Are you legally authorized to work in the United States?"
  const qAuth = f({ label: 'Are you legally authorized to work in the United States?' });
  const rAuthOn = M.classify(qAuth, citizenSnap, settingsOn);
  assert.equal(rAuthOn.action, 'fill');
  assert.equal(rAuthOn.value, 'Yes');
  assert.equal(rAuthOn.review, 'work_authorization');

  // 4. "Will you now or in the future require visa sponsorship?"
  const qSponsor = f({ label: 'Will you now or in the future require visa sponsorship?' });
  const rSponsorOn = M.classify(qSponsor, citizenSnap, settingsOn);
  assert.equal(rSponsorOn.action, 'fill');
  assert.equal(rSponsorOn.value, 'No');
  assert.equal(rSponsorOn.review, 'work_authorization');

  // 5. "Do you hold citizenship elsewhere?"
  const qForeign = f({ label: 'Do you hold citizenship elsewhere?' });
  const rForeign = M.classify(qForeign, citizenSnap, settingsOn);
  assert.equal(rForeign.action, 'fill');
  assert.equal(rForeign.value, 'No');
  assert.equal(rForeign.review, 'work_authorization');

  // 6. Radio buttons inherit group questions
  const radioCitizenYes = f({ type: 'radio', tag: 'input', label: 'Yes', name: 'citizen_radio', groupLabel: 'Are you a U.S. citizen?' });
  const rRadioCitizen = M.classify(radioCitizenYes, citizenSnap, settingsOn);
  assert.equal(rRadioCitizen.action, 'fill');
  assert.equal(rRadioCitizen.value, 'Yes');

  const radioSponsorNo = f({ type: 'radio', tag: 'input', label: 'No', name: 'sponsor_radio', groupLabel: 'Will you now or in the future require visa sponsorship?' });
  const rRadioSponsor = M.classify(radioSponsorNo, citizenSnap, settingsOn);
  assert.equal(rRadioSponsor.action, 'fill');
  assert.equal(rRadioSponsor.value, 'No');

  // 7. Protected classes remain strictly blocked even with autofill_work_auth: true
  const qRace = f({ label: 'Please indicate your race or ethnicity' });
  assert.equal(M.classify(qRace, citizenSnap, settingsOn).action, 'block');
  assert.equal(M.classify(qRace, citizenSnap, settingsOn).category, 'protected_class');

  const qDisability = f({ label: 'Do you have a disability?' });
  assert.equal(M.classify(qDisability, citizenSnap, settingsOn).action, 'block');
  assert.equal(M.classify(qDisability, citizenSnap, settingsOn).category, 'disability');

  const qVeteran = f({ label: 'Are you a protected veteran?' });
  assert.equal(M.classify(qVeteran, citizenSnap, settingsOn).action, 'block');
  assert.equal(M.classify(qVeteran, citizenSnap, settingsOn).category, 'veteran');
});
