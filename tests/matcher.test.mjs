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

test('EEOC voluntary disclosures autofill when enabled in settings', () => {
  const eeocSnap = {
    ...SNAP,
    eeoc: {
      gender: 'Male',
      race: 'Hispanic or Latino',
      veteran: 'I am not a protected veteran',
      disability: 'No, I do not have a disability',
    },
  };
  const settingsEEOC = { autofill_eeoc: true };

  // Gender
  const qGender = f({ label: 'Gender / Sex', tag: 'select' });
  const rGender = M.classify(qGender, eeocSnap, settingsEEOC);
  assert.equal(rGender.action, 'fill');
  assert.equal(rGender.value, 'Male');
  assert.equal(rGender.context, 'eeoc.gender');

  // Race
  const qRace = f({ label: 'Race / Ethnicity', tag: 'select' });
  const rRace = M.classify(qRace, eeocSnap, settingsEEOC);
  assert.equal(rRace.action, 'fill');
  assert.equal(rRace.value, 'Hispanic or Latino');
  assert.equal(rRace.context, 'eeoc.race');

  // Veteran
  const qVet = f({ label: 'Veteran Status', tag: 'select' });
  const rVet = M.classify(qVet, eeocSnap, settingsEEOC);
  assert.equal(rVet.action, 'fill');
  assert.equal(rVet.value, 'I am not a protected veteran');
  assert.equal(rVet.context, 'eeoc.veteran');

  // Disability
  const qDis = f({ label: 'Disability Status', tag: 'select' });
  const rDis = M.classify(qDis, eeocSnap, settingsEEOC);
  assert.equal(rDis.action, 'fill');
  assert.equal(rDis.value, 'No, I do not have a disability');
  assert.equal(rDis.context, 'eeoc.disability');

  // Option matching with realistic ATS options
  const raceOptions = [
    { label: 'Please select' },
    { label: 'White (Not Hispanic or Latino)' },
    { label: 'Hispanic or Latino' },
    { label: 'Black or African American' },
    { label: 'Asian' },
  ];
  assert.equal(M.matchOption(raceOptions, 'Hispanic or Latino', 'eeoc.race'), 2);

  const vetOptions = [
    { label: 'Select status' },
    { label: 'I identify as one or more of the classifications of protected veteran' },
    { label: 'I am not a protected veteran' },
    { label: 'I decline to state' },
  ];
  assert.equal(M.matchOption(vetOptions, 'I am not a protected veteran', 'eeoc.veteran'), 2);

  const disOptions = [
    { label: 'Select' },
    { label: 'Yes, I have a disability, or have a history/record of having a disability' },
    { label: 'No, I do not have a disability, or have a history/record of having a disability' },
    { label: 'I do not wish to answer' },
  ];
  assert.equal(M.matchOption(disOptions, 'No, I do not have a disability', 'eeoc.disability'), 2);
});

test('School other fallback and education date and major matching', () => {
  const schoolOptions = [
    { label: 'Please select institution' },
    { label: 'Harvard University' },
    { label: 'Stanford University' },
    { label: 'Other' },
  ];
  // Foreign or unlisted school falls back to 'Other'
  assert.equal(M.matchOption(schoolOptions, 'Universidad de Oriente', 'edu.school'), 3);

  const eduSnap = {
    ...SNAP,
    education: [{
      degree: 'B.S. in Computer Science',
      school: 'Universidad de Oriente',
      field: 'Computer Science',
      minor: 'Mathematics',
      start_year: '1990',
      start_month: 'September',
      end_year: '1995',
      end_month: 'July',
    }],
  };

  const fStartMo = f({ label: 'From Month', tag: 'select', section: 'Education' });
  const rStartMo = M.classify(fStartMo, eduSnap, {});
  assert.equal(rStartMo.key, 'edu.start_month');
  assert.equal(rStartMo.value, 'September');

  const fStartYr = f({ label: 'From Year', tag: 'select', section: 'Education' });
  const rStartYr = M.classify(fStartYr, eduSnap, {});
  assert.equal(rStartYr.key, 'edu.start_year');
  assert.equal(rStartYr.value, '1990');

  const fMajor = f({ label: 'Major', tag: 'input', section: 'Education' });
  const rMajor = M.classify(fMajor, eduSnap, {});
  assert.equal(rMajor.key, 'edu.major');
  assert.equal(rMajor.value, 'Computer Science');

  const fMinor = f({ label: 'Minor', tag: 'input', section: 'Education' });
  const rMinor = M.classify(fMinor, eduSnap, {});
  assert.equal(rMinor.key, 'edu.minor');
  assert.equal(rMinor.value, 'Mathematics');
});

test('Address line 1 vs line 2 separation', () => {
  const addrSnap = {
    ...SNAP,
    address: {
      line1: '5 1/2 S Jefferson Ave',
      line2: 'Suite 200',
      city: 'Iola',
      state: 'Kansas',
      postal_code: '66749',
      country: 'United States',
    },
  };

  const fLine1 = f({ label: 'Address Line 1', tag: 'input' });
  const rLine1 = M.classify(fLine1, addrSnap, {});
  assert.equal(rLine1.key, 'address.line1');
  assert.equal(rLine1.value, '5 1/2 S Jefferson Ave');

  const fLine2 = f({ label: 'Address Line 2', tag: 'input' });
  const rLine2 = M.classify(fLine2, addrSnap, {});
  assert.equal(rLine2.key, 'address.line2');
  assert.equal(rLine2.value, 'Suite 200');
});

test('Ashby HQ fields: phone type=tel, checkbox how_heard, and skill proficiency ratings', () => {
  const ashbySnap = {
    ...SNAP,
    preferences: {
      how_heard: 'LinkedIn',
    },
    skills: [
      'Microsoft 365', 'Defender for Endpoint', 'NinjaOne RMM', 'Intune', 'PowerShell automation',
      'Python', 'Bash', 'n8n', 'Vendor & SLA Management', 'Cybersecurity', 'AWS security'
    ],
    resume_markdown: 'Senior DevOps Specialist. Managed vendor relationships. PowerShell automation, Python, Bash.',
  };

  // 1. Phone with type="tel" and generic label
  const fPhone = f({ label: 'Type here...', type: 'tel', tag: 'input' });
  const rPhone = M.classify(fPhone, ashbySnap, {});
  assert.equal(rPhone.key, 'identity.phone');
  assert.equal(rPhone.value, '+14155550100');

  // 2. Checkboxes for "How did you hear about us?"
  const fHeardLinkedIn = f({ label: 'LinkedIn', type: 'checkbox', tag: 'input', groupLabel: 'How did you hear about us?*' });
  const rHeardLinkedIn = M.classify(fHeardLinkedIn, ashbySnap, {});
  assert.equal(rHeardLinkedIn.action, 'fill');
  assert.equal(rHeardLinkedIn.value, 'yes');

  const fHeardReferral = f({ label: 'Employee Referral', type: 'checkbox', tag: 'input', groupLabel: 'How did you hear about us?*' });
  const rHeardReferral = M.classify(fHeardReferral, ashbySnap, {});
  assert.equal(rHeardReferral.action, 'skip');

  // 3. Skill rating proficiency radio groups
  const ratingOpts = [
    { label: "None: I haven't worked directly" },
    { label: "Beginner: I have foundational knowledge" },
    { label: "Intermediate: I have hands-on experience" },
    { label: "Advanced: I have deep expertise" },
    { label: "Expert: Recognized subject matter expert" },
  ];

  const fScripting = f({
    label: 'How would you rate your level of experience with writing scripts to automate tasks?*',
    type: 'radio',
    tag: 'input',
    radioLabels: ratingOpts,
  });
  const rScripting = M.classify(fScripting, ashbySnap, {});
  assert.equal(rScripting.action, 'fill');
  assert.equal(rScripting.value, 'Advanced');
  assert.equal(rScripting.review, 'rating');

  const fVendor = f({
    label: 'How would you rate your level of experience with vendor management?*',
    type: 'radio',
    tag: 'input',
    radioLabels: ratingOpts,
  });
  const rVendor = M.classify(fVendor, ashbySnap, {});
  assert.equal(rVendor.action, 'fill');
  assert.equal(rVendor.value, 'Advanced');

  const fEndpoint = f({
    label: 'How would you rate your level of experience with endpoint management/security tools?*',
    type: 'radio',
    tag: 'input',
    radioLabels: ratingOpts,
  });
  const rEndpoint = M.classify(fEndpoint, ashbySnap, {});
  assert.equal(rEndpoint.action, 'fill');
  assert.equal(rEndpoint.value, 'Advanced');

  const fAWS = f({
    label: 'How would you rate your level of experience with AWS security?*',
    type: 'radio',
    tag: 'input',
    radioLabels: ratingOpts,
  });
  const rAWS = M.classify(fAWS, ashbySnap, {});
  assert.equal(rAWS.action, 'fill');
  assert.ok(['Intermediate', 'Advanced'].includes(rAWS.value));
});

test('Ashby HQ: Are you authorized to work in the US matches work_authorization, not address.line2', () => {
  const snapCitizen = {
    ...SNAP,
    work_authorization: { status: 'Citizen', is_citizen: true, authorized: true, requires_sponsorship: false },
    review_only: { work_authorization: 'Citizen' },
  };

  const fWorkAuth = f({
    label: 'Are you authorized to work in the United States?*',
    type: 'radio',
    tag: 'input',
    options: [{ label: 'Yes' }, { label: 'No' }],
  });

  const rWorkAuth = M.classify(fWorkAuth, snapCitizen, { autofill_work_auth: true });
  assert.equal(rWorkAuth.action, 'fill');
  assert.equal(rWorkAuth.key, 'work_authorization.authorized');
  assert.equal(rWorkAuth.value, 'Yes');

  const fSponsorship = f({
    label: 'Will you now, or in the future, require sponsorship for an employment visa status?*',
    type: 'radio',
    tag: 'input',
    options: [{ label: 'Yes' }, { label: 'No' }],
  });

  const rSponsorship = M.classify(fSponsorship, snapCitizen, { autofill_work_auth: true });
  assert.equal(rSponsorship.action, 'fill');
  assert.equal(rSponsorship.key, 'work_authorization.sponsorship');
  assert.equal(rSponsorship.value, 'No');
});

test('Ashby HQ: unlisted skills select None and option matcher supports Basic alias', () => {
  const snapNoAWS = {
    ...SNAP,
    skills: ['Python', 'Bash', 'Defender for Endpoint', 'Vendor Management'],
    resume_markdown: 'Python automation, Bash, Defender suite, Vendor SLAs',
  };

  const ashbyOpts = [
    { label: 'None' },
    { label: 'Basic' },
    { label: 'Intermediate' },
    { label: 'Advanced' },
  ];

  const fAWS = f({
    label: 'How would you rate your hands-on AWS security experience?*',
    type: 'radio',
    tag: 'input',
    radioLabels: ashbyOpts,
  });

  const rAWS = M.classify(fAWS, snapNoAWS, {});
  assert.equal(rAWS.action, 'fill');
  assert.equal(rAWS.value, 'None');
  assert.equal(M.matchOption(ashbyOpts, rAWS.value), 0);

  // Beginner alias matches Basic
  assert.equal(M.matchOption(ashbyOpts, 'Beginner'), 1);
  assert.equal(M.matchOption(ashbyOpts, 'Basic'), 1);
  assert.equal(M.matchOption(ashbyOpts, 'Intermediate'), 2);
  assert.equal(M.matchOption(ashbyOpts, 'Advanced'), 3);
});

test('Cover letter and resume support both file upload and textarea modes', () => {
  const snapWithLetter = {
    ...SNAP,
    cover_letter: 'Dear Hiring Team,\nI am writing to apply for this role with deep enthusiasm and experience.',
    resume_markdown: '# Jane Doe\n## Summary\nStaff systems engineer.',
    docs: {
      resume_docx: '/api/packets/123/file?fmt=docx&type=resume',
      cover_letter_docx: '/api/packets/123/file?fmt=docx&type=cover',
    },
    doc_names: {
      resume: 'jane-doe-resume.docx',
      cover_letter: 'jane-doe-cover-letter.docx',
    },
  };

  // 1. File input mode
  const fCoverFile = f({ label: 'Cover Letter', type: 'file', tag: 'input', name: 'cover_letter' });
  const rCoverFile = M.classify(fCoverFile, snapWithLetter, {});
  assert.equal(rCoverFile.action, 'upload');
  assert.equal(rCoverFile.value, 'cover_letter');

  const fResumeFile = f({ label: 'Resume/CV*', type: 'file', tag: 'input', name: 'resume' });
  const rResumeFile = M.classify(fResumeFile, snapWithLetter, {});
  assert.equal(rResumeFile.action, 'upload');
  assert.equal(rResumeFile.value, 'resume');

  // 2. Textarea mode
  const fCoverText = f({ label: 'Cover letter / Note to hiring team', type: 'textarea', tag: 'textarea', name: 'cover_letter_text' });
  const rCoverText = M.classify(fCoverText, snapWithLetter, {});
  assert.equal(rCoverText.action, 'fill');
  assert.equal(rCoverText.key, 'doc.cover_letter');
  assert.equal(rCoverText.value, snapWithLetter.cover_letter);

  const fResumeText = f({ label: 'Paste your resume here', type: 'textarea', tag: 'textarea', name: 'resume_text' });
  const rResumeText = M.classify(fResumeText, snapWithLetter, {});
  assert.equal(rResumeText.action, 'fill');
  assert.equal(rResumeText.key, 'doc.resume');
  assert.equal(rResumeText.value, snapWithLetter.resume_markdown);
});

test('Ashby autofill widget is ignored and checkbox option matching works', () => {
  const snap = {
    identity: { email: 'test@example.com', phone: '5551234567' },
    links: { github: 'https://github.com/myuser', other: 'https://example.com' },
    preferences: { how_heard: 'www.linkedin.com/in/myuser' },
    work_authorization: { status: 'Citizen', is_citizen: true, authorized: true, requires_sponsorship: false },
    docs: { resume_docx: '/resume.docx' },
  };

  // 1. Autofill widget file input must be skipped
  const fAutofill = f({
    label: 'Autofill from resume',
    help: 'Upload your resume here to autofill key application fields.',
    type: 'file',
    tag: 'input',
  });
  const rAutofill = M.classify(fAutofill, snap, {});
  assert.equal(rAutofill.action, 'skip');
  assert.equal(rAutofill.reason, 'ats autofill widget');

  // Real resume file input must be uploaded
  const fRealResume = f({ label: 'Resume*', type: 'file', tag: 'input', name: '_systemfield_resume' });
  const rRealResume = M.classify(fRealResume, snap, {});
  assert.equal(rRealResume.action, 'upload');
  assert.equal(rRealResume.value, 'resume');

  // 2. Checkbox option matching for "How did you hear about us?"
  const fLinkedInChk = f({
    label: 'How did you hear about us?*',
    type: 'checkbox',
    kind: 'checkbox',
    optionLabel: 'LinkedIn',
    radioLabels: [{ label: 'LinkedIn' }],
  });
  const rLinkedInChk = M.classify(fLinkedInChk, snap, {});
  assert.equal(rLinkedInChk.action, 'fill');
  assert.equal(rLinkedInChk.value, 'yes');

  const fIndeedChk = f({
    label: 'How did you hear about us?*',
    type: 'checkbox',
    kind: 'checkbox',
    optionLabel: 'Indeed',
    radioLabels: [{ label: 'Indeed' }],
  });
  const rIndeedChk = M.classify(fIndeedChk, snap, {});
  assert.equal(rIndeedChk.action, 'skip');
  assert.equal(rIndeedChk.reason, 'not selected');

  // 3. Links fallback: Personal Website falls back to GitHub when portfolio is blank
  const fWeb = f({ label: 'Website / Portfolio', type: 'text', tag: 'input' });
  const rWeb = M.classify(fWeb, snap, {});
  assert.equal(rWeb.action, 'fill');
  assert.equal(rWeb.value, 'https://github.com/myuser');

  // 4. Work auth autofills by default when settings is empty object
  const fAuth = f({ label: 'Are you authorized to work in the United States?*', type: 'radio' });
  const rAuth = M.classify(fAuth, snap, {});
  assert.equal(rAuth.action, 'fill');
  assert.equal(rAuth.value, 'Yes');
});

test('Company phone and professional references match correctly', () => {
  const snap = JSON.parse(JSON.stringify(SNAP));
  snap.experience = [
    {
      company: 'TechCorp',
      company_phone: '555-888-9999',
      title: 'Engineer',
      start: '2020-01',
      end: '2022-01',
    },
    {
      company: 'OldCorp',
      company_phone: '555-777-6666',
      title: 'Analyst',
      start: '2018-01',
      end: '2020-01',
    },
  ];
  snap.references = [
    {
      name: 'Alice Smith',
      first_name: 'Alice',
      last_name: 'Smith',
      title: 'VP of Engineering',
      company: 'TechCorp',
      email: 'alice@example.com',
      phone: '555-111-2222',
      relationship: 'Former Manager',
    },
    {
      name: 'Bob Jones',
      first_name: 'Bob',
      last_name: 'Jones',
      title: 'Lead Architect',
      company: 'PartnerCorp',
      email: 'bob@example.com',
      phone: '555-333-4444',
      relationship: 'Former Colleague',
    },
  ];

  // 1. Company phone on employment history
  const fCompPhone = f({ label: 'Employer phone number', type: 'text', tag: 'input', index: 0 });
  const rCompPhone = M.classify(fCompPhone, snap, {});
  assert.equal(rCompPhone.action, 'fill');
  assert.equal(rCompPhone.value, '5558889999');

  const fOldCompPhone = f({ label: 'Company phone', type: 'text', tag: 'input', index: 1 });
  const rOldCompPhone = M.classify(fOldCompPhone, snap, {});
  assert.equal(rOldCompPhone.action, 'fill');
  assert.equal(rOldCompPhone.value, '5557776666');

  // 2. Reference 1 fields
  const fRef1Name = f({ label: 'Reference 1 Name', type: 'text', tag: 'input', index: 0 });
  const rRef1Name = M.classify(fRef1Name, snap, {});
  assert.equal(rRef1Name.action, 'fill');
  assert.equal(rRef1Name.value, 'Alice Smith');

  const fRef1Email = f({ label: 'Reference 1 Email', type: 'email', tag: 'input', index: 0 });
  const rRef1Email = M.classify(fRef1Email, snap, {});
  assert.equal(rRef1Email.action, 'fill');
  assert.equal(rRef1Email.value, 'alice@example.com');

  const fRef1Phone = f({ label: 'Reference 1 Phone', type: 'tel', tag: 'input', index: 0 });
  const rRef1Phone = M.classify(fRef1Phone, snap, {});
  assert.equal(rRef1Phone.action, 'fill');
  assert.equal(rRef1Phone.value, '5551112222');

  const fRef1Company = f({ label: 'Reference 1 Company', type: 'text', tag: 'input', index: 0 });
  const rRef1Company = M.classify(fRef1Company, snap, {});
  assert.equal(rRef1Company.action, 'fill');
  assert.equal(rRef1Company.value, 'TechCorp');

  const fRef1Rel = f({ label: 'Reference 1 Relationship', type: 'text', tag: 'input', index: 0 });
  const rRef1Rel = M.classify(fRef1Rel, snap, {});
  assert.equal(rRef1Rel.action, 'fill');
  assert.equal(rRef1Rel.value, 'Former Manager');

  // 3. Reference 2 fields
  const fRef2Name = f({ label: 'Reference 2 Name', type: 'text', tag: 'input', index: 1 });
  const rRef2Name = M.classify(fRef2Name, snap, {});
  assert.equal(rRef2Name.action, 'fill');
  assert.equal(rRef2Name.value, 'Bob Jones');

  // 4. Reference textarea summary
  const fRefSummary = f({ label: 'Professional References', type: 'textarea', tag: 'textarea' });
  const rRefSummary = M.classify(fRefSummary, snap, {});
  assert.equal(rRefSummary.action, 'fill');
  assert.ok(rRefSummary.value.includes('Alice Smith'));
  assert.ok(rRefSummary.value.includes('Bob Jones'));
});
