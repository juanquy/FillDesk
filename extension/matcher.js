/*
 * FillDesk field matcher.
 *
 * Deliberately pure: it takes plain objects and returns plain objects, so it can
 * be unit tested in Node without a DOM. content.js walks the page, builds field
 * descriptors, and hands them here for the decision.
 *
 * Order matters: compliance rules are evaluated FIRST so a protected-class or
 * work-authorization field can never be claimed by a looser rule later on.
 */
(function (root) {
  'use strict';

  // ------------------------------------------------------------------ utils
  const norm = (s) => String(s == null ? '' : s).toLowerCase().replace(/[_\-.]+/g, ' ').replace(/\s+/g, ' ').trim();
  const key = (s) => norm(String(s == null ? '' : s).replace(/[^a-zA-Z0-9]+/g, ' '));
  const clip = (s, n) => { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n) + '…' : s; };

  function tokens(s) {
    return norm(s).split(' ').filter((w) => w.length > 2);
  }

  function overlap(a, b) {
    const A = new Set(tokens(a));
    const B = tokens(b);
    if (!A.size || !B.length) return 0;
    let hit = 0;
    for (const w of B) if (A.has(w) || w.startsWith(A) || [...A].some((x) => x.startsWith(w))) hit += 1;
    return hit / Math.max(3, Math.min(A.size, B.length));
  }

  // ------------------------------------------------------------------ compliance
  const BLOCKED = [
    ['protected_class', /\b(race|ethnic|gender|sex(uality|ual orientation)?|religion|creed|faith|national origin|nationality|indigenous|aboriginal|minority|lgbtq|queer|self[- ]identif\w*|demographic|eeo|equal opportunity)\b/],
    ['disability', /\b(disabilit\w+|accommodat\w+|ada\b|mobility|wheelchair|hearing (loss|impairment)|vision (loss|impairment)|mental health|ptsd)\b/],
    ['veteran', /\b(veteran\w*|armed forces|military service|active duty|discharge(d)? type|protected veteran|userra)\b/],
    ['work_authorization', /\b(work (authorization|authorized|authorised)|(legally )?authorized to work|legally authorized|citizen|citizenship|permanent resident|green card|immigration status|visa|sponsor(ship)?|h-?1b|opt\b|stem opt|employment eligibility|i-?9\b|passport)\b/],
    ['age', /\b(age|date of birth|dob\b|birth ?date|born on|year of birth|how old)\b|\b(are|were) you (?:over|under|at least|older than)?\s*1[6-9]\b|\b1[6-9]\s*(?:or older|or above|years of age|years old)\b|\bage requirement\b/],
    ['criminal', /\b(arrest\w*|convict\w*|felon\w*|misdemeanor|misdemeanour|criminal (record|history|background)|incarcerat\w*|court[- ]ordered|dishonorable discharge)\b/],
    ['legal_declaration', /\b(attest|affirm|hereby|under penalty|declaration|certif\w* (that|the)|sworn|notari\w+|electronic signature|e-signature|signature|initials?|i (certify|agree|consent|acknowledge)|terms (and )?(of )?(use|service)|opt[- ]?in|consent to|authorize (us|the company))\b/],
    ['health', /\b(health (condition|history|insurance)\w*|medical (history|record|leave)\w*|fmla|workers[- ]?comp|drug (test|screen)|tobacco|smoking|pregnan\w+|family planning|childcare|familial status|marital status|marriage)\b/],
    ['financial_and_credit', /\b(bank account|routing number|credit (check|report|score)|garnish\w*|social security number|ssn|national insurance number|nino|tax id|tin\b|passport number|driver license number|drivers license number)\b/],
  ].map(([category, rx]) => ({ category, rx: new RegExp(rx.source, 'i') }));

  // Rules that must be checked before identity (e.g. "expected salary" is not "salary history").
  const REVIEW = [
    ['salary', /\b(salar\w+|compensation|base pay|pay expectation|desired (rate|pay)|hourly rate|ctc)\b/],
    ['relocation', /\b(relocat\w*|willing to (move|relocate)|travel (requirement|%|percent)|work ?(model|location|preference)|hybrid|onsite|on[- ]?site|remote)\b/],
    ['start_date', /\b(start date|available (to start|from|date)|when (can|could) you start|earliest start|notice period)\b/],
    ['clearance', /\b(clearance|background check|security (check|screening)|credit check|drug screen)\b/],
    ['references', /\b(reference|referee|recommender)\b/],
    ['sponsor_note', /\b(need sponsorship|require sponsorship)\b/],
  ].map(([category, rx]) => ({ category, rx: new RegExp(rx.source, 'i') }));

  // ------------------------------------------------------------------ structural rules
  // Each rule: key, test on the combined signal, plus optional element-type constraint.
  const RULES = [
    // -- references & employer contacts (must precede personal identity so "reference email" is not candidate email)
    { key: 'ref.first_name', rx: /(?:reference|referee)\s*(?:[1-9]|one|two|three)?\s*(?:first\s*name|given\s*name)/ },
    { key: 'ref.last_name', rx: /(?:reference|referee)\s*(?:[1-9]|one|two|three)?\s*(?:last\s*name|family\s*name|surname)/ },
    { key: 'ref.name', rx: /(?:reference|referee)\s*(?:[1-9]|one|two|three)?\s*(?:full\s*)?name\b|(?:name\s*of\s*(?:the\s*)?(?:reference|referee))/ },
    { key: 'ref.email', rx: /(?:reference|referee)\s*(?:[1-9]|one|two|three)?\s*e-?mail\b/ },
    { key: 'ref.phone', rx: /(?:reference|referee)\s*(?:[1-9]|one|two|three)?\s*(?:phone|mobile|tel|contact(?:\s*number)?)\b/ },
    { key: 'ref.company', rx: /(?:reference|referee)\s*(?:[1-9]|one|two|three)?\s*(?:company|organization|organisation|employer|workplace)\b/ },
    { key: 'ref.title', rx: /(?:reference|referee)\s*(?:[1-9]|one|two|three)?\s*(?:title|position|role|designation)\b/ },
    { key: 'ref.relationship', rx: /(?:reference|referee)\s*(?:[1-9]|one|two|three)?\s*relationship\b|(?:relationship\s*to\s*(?:the\s*)?(?:reference|referee))/ },
    { key: 'exp.phone', rx: /(employer|company|organization|supervisor)\s*(phone|telephone|contact|mobile|number)|phone\s*(number)?\s*of\s*(employer|company|organization|supervisor)/ },

    // -- autocomplete attribute is the strongest single signal when present
    { key: 'identity.first_name', rx: /given name|first name|firstname|forename/, autocomplete: ['given-name'] },
    { key: 'identity.last_name', rx: /family name|last name|surname|lastname/, autocomplete: ['family-name'] },
    { key: 'identity.full_name', rx: /(?:^|\s)(full name|your name|applicant name|candidate name|name of applicant)(?:$|\s)/ },
    { key: 'identity.suffix', rx: /\bsuffix\b/i },
    { key: 'identity.pronouns', rx: /pronoun/ },
    { key: 'identity.email', rx: /e-?mail|email address/, autocomplete: ['email'] },
    { key: 'identity.phone_device_type', rx: /phone\s*(device\s*)?type|device\s*type/i },
    { key: 'identity.phone_extension', rx: /\b(?:phone\s*)?ext(?:ension)?\b/i },
    { key: 'identity.phone_country_code', rx: /(?:country|intl|international)\s*(?:phone\s*)?(?:code|dial\s*code)|phone\s*country\s*code/i },
    { key: 'identity.phone', rx: /phone|mobile|telephone|cell(ular)? (number|phone)|contact number/, autocomplete: ['tel'] },
    { key: 'identity.location', rx: /\b(location\b|current location|where (are|do) you( currently)? (based|located|living|from)|based in|home ?town|hometown|city and state)\b/ },
    { key: 'address.line2', rx: /(?:address\s*(?:line\s*)?2|apartment|suite|\bunit\s*(?:number|#)?\b|\bapt\b)/i, autocomplete: ['address-line2'] },
    { key: 'address.city', rx: /\bcity\b|town|suburb/, autocomplete: ['address-level2'] },
    { key: 'address.state', rx: /\bstate\b|province|region|county/, autocomplete: ['address-level1'] },
    { key: 'address.postal', rx: /zip|postal|post ?code/, autocomplete: ['postal-code'] },
    { key: 'address.country', rx: /\bcountry\b|nation/, autocomplete: ['country-name', 'country'] },
    { key: 'address.line1', rx: /(?:address\s*(?:line\s*)?1|street\s*address|mailing\s*address|(?:^|\b)(?:home\s*)?address(?!\s*(?:line\s*)?2)\b)/i, autocomplete: ['address-line1'] },
    { key: 'identity.timezone', rx: /time ?zone/ },
    { key: 'links.linkedin', types: ['text', 'url', 'textarea'], rx: /linked ?in/ },
    { key: 'links.github', types: ['text', 'url', 'textarea'], rx: /github/ },
    { key: 'links.portfolio', types: ['text', 'url', 'textarea'], rx: /portfolio|personal (site|website|page)|website|url|online presence|dribbble|behance/ },
    { key: 'links.twitter', types: ['text', 'url', 'textarea'], rx: /twitter|x\.com|bluesky|mastodon/ },
    { key: 'links.other', types: ['text', 'url', 'textarea'], rx: /other (link|url|profile)|additional (link|url)|social (media|link)/ },

    // -- documents
    { key: 'doc.resume', types: ['file', 'textarea'], rx: /(resume|résumé|resumé|curriculum vitae|cv\b|latest resume|current resume|upload your resume)/ },
    { key: 'doc.cover_letter', types: ['file', 'textarea', 'text'], rx: /(cover ?(letter|note)|letter of (intent|interest|application)|motivation letter|statement of interest)/ },
    { key: 'doc.other', types: ['file'], rx: /(transcript|writing sample|portfolio (file|upload)|certification file|additional document|supporting document|attachment)/ },

    // -- employment history (indexed; content.js maps "current"/"most recent" to index 0)
    { key: 'exp.company', rx: /(?:current|most recent|previous|present|last)\s*(?:employer|company|organization|organisation)|employer|company(?:\s*name)?|organization(?:\s*name)?|name of (?:employer|company|organization)/i },
    { key: 'exp.title', rx: /(?:current|most recent|previous|present)\s*(?:job\s*)?(?:title|position|role)|job\s*title|position\s*title|role\s*title|your\s*(?:job\s*)?title|designation|\btitle\b/i },
    { key: 'exp.start_month', rx: /\b(start|from|begin|joined)\b.*\b(month|mo)\b|\b(month|mo)\b.*\b(start|from|begin|joined)\b/, requires: 'employment' },
    { key: 'exp.start_year', rx: /\b(start|from|begin|joined)\b.*\b(year|yr)\b|\b(year|yr)\b.*\b(start|from|begin|joined)\b/, requires: 'employment' },
    { key: 'exp.start', rx: /\b(start|from|begin|joining|joined|since)\b\s*(date|month|year|mm)?/, requires: 'employment' },
    { key: 'exp.end_month', rx: /\b(end|to|until|through|leaving)\b.*\b(month|mo)\b|\b(month|mo)\b.*\b(end|to|until|through|leaving)\b/, requires: 'employment' },
    { key: 'exp.end_year', rx: /\b(end|to|until|through|leaving)\b.*\b(year|yr)\b|\b(year|yr)\b.*\b(end|to|until|through|leaving)\b/, requires: 'employment' },
    { key: 'exp.end', rx: /\b(end|to|until|through|leaving|left|terminated)\b\s*(date|month|year|mm)?/, requires: 'employment' },
    { key: 'exp.location', rx: /(?:job|position|role|employer|work|office)?\s*location\b|location of (?:employment|position)/i },
    { key: 'exp.description', types: ['textarea', 'text'], rx: /(?:role|job|work|position|experience)?\s*description\b|responsibilities|duties|summary of duties/i },
    { key: 'exp.reason_for_leaving', rx: /reason (for|of) (leaving|separation|departure)|why (did you leave|are you leaving)/ },

    // -- education
    { key: 'edu.school', rx: /(school|university|college|institution|institute)\b.*(name)?|name of (school|university|college)|institution name/ },
    { key: 'edu.degree', rx: /\b(degree|level of education|education level|highest level of education|qualification|diploma|programme|program of study)\b/ },
    { key: 'edu.minor', rx: /\bminor\b/ },
    { key: 'edu.major', rx: /\b(major|field of study|discipline|area of study)\b/ },
    { key: 'edu.start_month', rx: /\b(start|from|begin|attended from)\b.*\b(month|mo)\b|\b(month|mo)\b.*\b(start|from|begin|attended from)\b/, requires: 'education' },
    { key: 'edu.start_year', rx: /\b(start|from|begin|attended from)\b.*\b(year|yr)\b|\b(year|yr)\b.*\b(start|from|begin|attended from)\b/, requires: 'education' },
    { key: 'edu.end_month', rx: /\b(end|to|through|attended to|graduation|grad)\b.*\b(month|mo)\b|\b(month|mo)\b.*\b(end|to|through|attended to|graduation|grad)\b/, requires: 'education' },
    { key: 'edu.end_year', rx: /\b(end|to|through|attended to|graduation|grad)\b.*\b(year|yr)\b|\b(year|yr)\b.*\b(end|to|through|attended to|graduation|grad)\b/, requires: 'education' },
    { key: 'edu.year', rx: /(graduation|grad)\s*(year|date)|year (you )?(graduated|completed)|expected graduation/ },

    // -- profile bits
    { key: 'skills', rx: /\bskills?\b|core competenc\w+|technical (skills|proficienc)|specialt\w+|areas of expertise/ },
    { key: 'summary', rx: /(professional )?(summary|objective|about you|about yourself|bio|profile description|self description)/ },
    { key: 'languages', rx: /\blanguages?\b|proficiency in (a )?language/ },
    { key: 'certifications', rx: /certificat\w+|licence|license|credential|training and certification/ },

    // -- review-flagged
    { key: 'review.salary', rx: /\b(salar\w+|compensation|desired pay|expected (pay|compensation)|rate expectation)\b/, review: 'salary' },
    { key: 'review.relocation', rx: /(relocat\w*|willing to (move|relocate)|travel\s*(requirement|%|amount)?|work ?(model|preference)|are you (based|located|able to work))/, review: 'relocation' },
    { key: 'review.start_date', rx: /(start date|when (can|could) you start|earliest (start|availability)|available (from|to start)|notice period)/, review: 'start_date' },
    { key: 'review.references', rx: /(reference|referee).*(name|email|phone|relationship)?/, review: 'references' },

    // -- misc common fields
    { key: 'misc.how_heard', rx: /how (did you (hear|find|learn)|about (this|the) (position|role|opening))|source of (application|awareness)|where did you hear/ },
    { key: 'misc.previous_employee', rx: /(?:previously|prior|ever|former)\s*(?:been\s*)?(?:worked|employed|contractor|employee)|previous\s*employment\s*with|previously\s*worked\s*for/i },
    { key: 'misc.currently_employed', rx: /(currently|are you) employed|current employment status/ },
    { key: 'misc.work_model', rx: /(remote|hybrid|onsite|on-site).*(preference|option|acceptab)|preferred (work )?(model|arrangement)/, review: 'relocation' },
    { key: 'misc.availability_hours', rx: /hours per week|availability|part[- ]?time hours/ },
    { key: 'misc.legally_first_name', rx: /legal (first )?name|name (on|as it appears on) (legal )?documents/ },
    { key: 'misc.preferred_name', rx: /preferred name|nickname|name you (go by|prefer)/ },
    { key: 'misc.relocation_assistance', rx: /relocation (assistance|package|support) (needed|required)?/, review: 'relocation' },
    { key: 'misc.notice_period', rx: /notice period|how much notice/, review: 'start_date' },
    { key: 'misc.visa_note', rx: /visa status (details|notes?)/, review: 'sponsor_note' },
  ];

  const INTENTS = [
    // Specific shapes first: the generic "Why <Company>?" fallback must not
    // swallow "Why are you leaving?" (kept in sync with server/packet.py).
    ['why_leaving', /\b(leaving|left (your|last|current)|why are you (looking|searching)|reason for (leaving|searching)|why (did you )?(leave|quit)|want to (leave|move on|make a change)|looking for (a |the )?(new|next|different))\b/],
    ['weakness', /\b(weakness|area of (improvement|growth)|constructive feedback)\b/],
    ['challenge', /\b(challenge|conflict|disagree|disagreement|failure|failed|mistake|setback|obstacle|hardest|toughest)\b/],
    ['strength', /\b(greatest strength|superpower|what do you bring|core strength)\b/],
    ['compensation', /\b(salar\w+|compensation|desired pay|expected (pay|compensation)|rate expectation)\b/],
    ['start_availability', /\b(start date|when (can|could) you start|available (from|to start)|notice period)\b/],
    ['work_auth', /\b(authoriz|sponsor|citizen|visa|work permit|employment eligibility)\b/],
    ['references', /\b(reference|referee|recommender)\b/],
    ['relocation', /\b(relocat\w*|willing to move|onsite|on-site|travel)\b/],
    ['prioritization', /\b(prioriti[sz]|juggl|multitask|manage your time|deadlines|backlog)\b/],
    ['goals', /\b(five years|5 years|career (goal|objective|plan)|where do you (see|want)|long.term)\b/],
    ['gap', /\b(employment gap|gap in (your )?(employment|resume)|unemployed|between roles)\b/],
    ['leadership', /\b(lead(ing|ership)?|manag(e|ing|ed)|mentor|influence without|cross.functional)\b/],
    ['project', /\b(project|ship(ped|ping)?|accomplish(ed)?|proud of|end.to.end|launch)\b/],
    ['learn', /\b(learn(ed|ing)? (a|new)|upskill|feedback you (received|took)|how do you grow)\b/],
    ['remote_work', /\b(remote|hybrid|distributed team|async|time ?zone|home office)\b/],
    ['culture', /\b(culture|values|work environment|ideal (team|workplace)|collaborat\w*)\b/],
    ['diversity_story', /\b(belong(ing)?|identity|background of your|first in family)\b/],
    ['experience', /\b(experience with|background in|familiarity|proficien\w*|years of)\b/],
    ['why_company', /\b(why (do you )?(want|apply|interested|this company|us|our team|join)|what interests you|why should we|why (?!a |an |the |are |do |did |would |you |not )[A-Za-z][A-Za-z0-9&.'-]+)/],
].map(([name, rx]) => ({ name: name, rx: new RegExp(rx.source, 'i') }));

  const intentOf = (text) => {
    for (const it of INTENTS) if (it.rx.test(text || '')) return it.name;
    return '';
  };

  // ------------------------------------------------------------------ value resolution
  function resolve(keyPath, snap) {
    if (!keyPath || !snap) return '';
    const parts = keyPath.split('.');
    let cur = snap;
    for (const p of parts) {
      if (cur == null) break;
      cur = cur[p];
    }
    if ((cur == null || cur === '') && parts[0] === 'identity' && parts[1] && snap[parts[1]] != null) {
      cur = snap[parts[1]];
      if (parts[1] === 'first_name' && !cur && snap.name) cur = snap.name.split(' ')[0];
      if (parts[1] === 'last_name' && !cur && snap.name) cur = snap.name.split(' ').slice(1).join(' ');
      if (parts[1] === 'full_name' && !cur && snap.name) cur = snap.name;
    }
    if (cur == null) return '';
    if (Array.isArray(cur)) return cur.join(', ');
    return String(cur).trim();
  }

  function answerForKey(structuralKey, snap) {
    // A structural key that the user may have answered in prose instead.
    const map = {
      'review.salary': ['salary_expectation'],
      'review.relocation': ['relocation'],
      'review.start_date': ['start_date'],
      'misc.notice_period': ['notice_period'],
      'misc.work_model': ['relocation'],
    };
    const src = (map[structuralKey] || []).map((k) => resolve('review_only.' + k, snap)).filter(Boolean);
    return src[0] || '';
  }

  function matchAnswer(question, snap) {
    const answers = (snap && snap.answers) || [];
    const q = norm(question);
    const qIntent = intentOf(question || '');
    let best = null;
    let bestScore = 0;
    let method = '';
    for (const a of answers) {
      if (a.blocked) continue;
      const ak = norm(a.key || a.question);
      let score = 0;
      if (ak && (ak === q || q.includes(ak) || ak.includes(q))) {
        score = 1;
        method = 'exact';
      } else {
        score = overlap(ak, question);
        if (qIntent && intentOf(a.question) === qIntent) {
          score = Math.max(score, 0.72);
          method = 'intent:' + qIntent;
        } else if (score > 0.34) {
          method = 'overlap';
        }
      }
      if (score > bestScore) { bestScore = score; best = a; }
    }
    if (!best) return { answer: null, score: 0, method: 'none' };
    return { answer: best, score: bestScore, method: method || 'overlap' };
  }

  // ------------------------------------------------------------------ option matching (select / radio)
  function normalizeOption(s) {
    return norm(String(s || ''))
      .replace(/\(optional\)|optional|please select|select an option|choose one|\bna\b/g, ' ')
      .replace(/[-\u2013\u2014]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  const US_STATES = {
    al: 'alabama', ak: 'alaska', az: 'arizona', ar: 'arkansas', ca: 'california', co: 'colorado',
    ct: 'connecticut', de: 'delaware', fl: 'florida', ga: 'georgia', hi: 'hawaii', id: 'idaho',
    il: 'illinois', in: 'indiana', ia: 'iowa', ks: 'kansas', ky: 'kentucky', la: 'louisiana',
    me: 'maine', md: 'maryland', ma: 'massachusetts', mi: 'michigan', mn: 'minnesota', ms: 'mississippi',
    mo: 'missouri', mt: 'montana', ne: 'nebraska', nv: 'nevada', nh: 'new hampshire', nj: 'new jersey',
    nm: 'new mexico', ny: 'new york', nc: 'north carolina', nd: 'north dakota', oh: 'ohio', ok: 'oklahoma',
    or: 'oregon', pa: 'pennsylvania', ri: 'rhode island', sc: 'south carolina', sd: 'south dakota',
    tn: 'tennessee', tx: 'texas', ut: 'utah', vt: 'vermont', va: 'virginia', wa: 'washington',
    wv: 'west virginia', wi: 'wisconsin', wy: 'wyoming'
  };

  const DEGREE_ALIASES = [
    [/^(bachelor|bs\b|b\.s|ba\b|b\.a|undergraduate)/i, ['bachelor of science', 'bachelor of arts', "bachelor's", 'bachelor']],
    [/^(master|ms\b|m\.s|ma\b|m\.a|graduate)/i, ['master of science', 'master of arts', "master's", 'master']],
    [/^(phd|ph\.d|doctorate|doctoral)/i, ['doctorate', 'ph.d', 'doctoral degree']],
    [/^(associate|as\b|a\.s|aa\b|a\.a)/i, ["associate's degree", 'associate of science', 'associate of arts', 'associate']],
  ];

  function matchOption(options, wanted, context) {
    const w = normalizeOption(wanted);
    if (!w || !options || !options.length) return -1;
    for (let i = 0; i < options.length; i++) {
      if (normalizeOption(options[i].label) === w) return i;
    }
    for (let i = 0; i < options.length; i++) {
      const label = normalizeOption(options[i].label);
      if (label && (label.startsWith(w) || w.startsWith(label) || label.includes(w) || w.includes(label))) return i;
    }

    // State expansion: e.g. "KS" vs "Kansas"
    const stateFull = US_STATES[w] || Object.keys(US_STATES).find(k => US_STATES[k] === w);
    if (stateFull) {
      for (let i = 0; i < options.length; i++) {
        const label = normalizeOption(options[i].label);
        if (label === stateFull || label.includes(stateFull) || (w.length === 2 && new RegExp('\\b' + w + '\\b', 'i').test(options[i].label))) return i;
      }
    }

    // Degree matching: e.g. "BS" vs "Bachelor of Science"
    if (context === 'edu.degree' || /degree|education/i.test(context || '')) {
      for (const [rx, aliases] of DEGREE_ALIASES) {
        if (rx.test(w)) {
          for (let i = 0; i < options.length; i++) {
            const label = normalizeOption(options[i].label);
            if (aliases.some(a => label.includes(a) || a.includes(label))) return i;
          }
        }
      }
    }

    // EEOC matching:
    // Gender
    if (/gender|sex/i.test(context || '')) {
      if (/^male\b/i.test(w)) {
        for (let i = 0; i < options.length; i++) {
          if (/\bmale\b|\bman\b/i.test(options[i].label) && !/female/i.test(options[i].label)) return i;
        }
      } else if (/^female\b/i.test(w)) {
        for (let i = 0; i < options.length; i++) {
          if (/\bfemale\b|\bwoman\b/i.test(options[i].label)) return i;
        }
      }
    }

    // Race
    if (/race|ethnic/i.test(context || '')) {
      if (/hispanic|latino/i.test(w)) {
        for (let i = 0; i < options.length; i++) {
          if (/hispanic|latino/i.test(options[i].label)) return i;
        }
      } else if (/white/i.test(w)) {
        for (let i = 0; i < options.length; i++) {
          if (/white/i.test(options[i].label) && !/not hispanic/i.test(options[i].label)) return i;
        }
      } else if (/black|african/i.test(w)) {
        for (let i = 0; i < options.length; i++) {
          if (/black|african/i.test(options[i].label)) return i;
        }
      } else if (/asian/i.test(w)) {
        for (let i = 0; i < options.length; i++) {
          if (/asian/i.test(options[i].label)) return i;
        }
      }
    }

    // Veteran
    if (/veteran/i.test(context || '')) {
      const isNot = /not|no\b/i.test(w);
      for (let i = 0; i < options.length; i++) {
        const opt = options[i].label;
        if (isNot && (/\b(not|no)\b/i.test(opt) && !/decline|prefer not/i.test(opt))) return i;
        if (!isNot && (/\b(identify|yes|protected veteran)\b/i.test(opt) && !/\bnot\b/i.test(opt))) return i;
      }
    }

    // Disability
    if (/disability/i.test(context || '')) {
      const isNo = /^(no|none|not)\b/i.test(w);
      for (let i = 0; i < options.length; i++) {
        const opt = options[i].label;
        if (isNo && (/\bno\b/i.test(opt) && !/decline|prefer not/i.test(opt))) return i;
        if (!isNo && (/\byes\b/i.test(opt) && !/\bnot\b/i.test(opt))) return i;
      }
    }

    // Decline / Prefer not to say fallback
    if (/decline|choose not|prefer not/i.test(w)) {
      for (let i = 0; i < options.length; i++) {
        if (/\b(decline|choose not|prefer not|do not wish|opt out|not disclosed)\b/i.test(options[i].label)) return i;
      }
    }

    // School "Other" Fallback
    if (context === 'edu.school' || /school|institution/i.test(context || '')) {
      for (let i = 0; i < options.length; i++) {
        if (/^(other|not listed|other institution|institution not listed|none of the above|foreign|unlisted)\b/i.test(normalizeOption(options[i].label))) return i;
      }
    }

    // Proficiency matching: e.g. "Basic" vs "Beginner", "None" vs "No", "Advanced" vs "Expert"
    const PROFICIENCY_ALIASES = [
      [/^(none|no|not applicable|n\/a|never)/i, ['none', 'no', 'not applicable', 'n/a', "haven't", 'no experience', 'never']],
      [/^(basic|beginner|novice|foundational|entry)/i, ['basic', 'beginner', 'novice', 'foundational', 'entry', 'entry-level', 'fundamentals']],
      [/^(intermediate|competent|proficient|mid)/i, ['intermediate', 'competent', 'proficient', 'mid-level', 'mid', 'working knowledge', 'working experience']],
      [/^(advanced|expert|senior)/i, ['advanced', 'expert', 'senior', 'deep expertise', 'subject matter expert']],
    ];
    for (const [rx, aliases] of PROFICIENCY_ALIASES) {
      if (rx.test(w)) {
        for (let i = 0; i < options.length; i++) {
          const label = normalizeOption(options[i].label);
          if (aliases.some(a => label === a || label.startsWith(a) || label.includes(a))) return i;
        }
      }
    }

    // Month matching: e.g. "09" vs "September" vs "Sep" vs "9"
    if (/month/i.test(context || '')) {
      const monthNames = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
      const monthAbbrs = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
      let targetMo = 0;
      const numW = parseInt(w, 10);
      if (!isNaN(numW) && numW >= 1 && numW <= 12) targetMo = numW;
      else {
        const idxFull = monthNames.findIndex(m => m.startsWith(w) || w.startsWith(m));
        if (idxFull >= 0) targetMo = idxFull + 1;
      }
      if (targetMo >= 1 && targetMo <= 12) {
        const full = monthNames[targetMo - 1];
        const abbr = monthAbbrs[targetMo - 1];
        const numStr = String(targetMo);
        const padStr = String(targetMo).padStart(2, '0');
        for (let i = 0; i < options.length; i++) {
          const opt = normalizeOption(options[i].label);
          if (opt === full || opt === abbr || opt === numStr || opt === padStr ||
              opt.startsWith(full) || opt.startsWith(abbr) ||
              new RegExp('\\b' + padStr + '\\b').test(opt) || new RegExp('\\b' + numStr + '\\b').test(opt)) {
            return i;
          }
        }
      }
    }

    // numeric coercion: "5" vs "5 years" vs "5+ years of experience"
    const num = (w.match(/\d+/) || [])[0];
    if (num) {
      for (let i = 0; i < options.length; i++) {
        const label = normalizeOption(options[i].label);
        if (new RegExp('\\b' + num + '\\b').test(label)) return i;
      }
    }
    const yes = /^(yes|y|true|1|available|current|present)\b/.test(w);
    const no = /^(no|n|false|0|none|not )\b/.test(w);
    if (yes || no) {
      for (let i = 0; i < options.length; i++) {
        const label = normalizeOption(options[i].label);
        if (yes && /^(yes|y|true|1)\b/.test(label)) return i;
        if (no && /^(no|n|false|0)\b/.test(label)) return i;
      }
    }
    return -1;
  }

  function booleanFor(text, wanted) {
    // Decide yes/no for a checkbox or radio group from a value like "yes" or an option name.
    const label = normalizeOption(text);
    const w = normalizeOption(wanted);
    if (/^(yes|y|true|1|current|present|available)\b/.test(w)) {
      if (/^(no|n|false|0|non|not)\b/.test(label)) return false;
      if (/(yes|current|present|\btrue\b)/.test(label)) return true;
    }
    if (/^(no|n|false|0|none)\b/.test(w)) {
      if (/\bno\b|^n$|non/.test(label)) return true;
      if (/yes/.test(label)) return false;
    }
    if (w && label && !/^(yes|no|true|false)\b/.test(w) && (label === w || label.includes(w) || w.includes(label))) return true;
    return null;
  }

  function isProficiencyOptions(options) {
    if (!options || options.length < 2) return false;
    const labels = options.map((o) => normalizeOption(o.label || ''));
    const matches = labels.filter((l) => /\b(none|basic|beginner|intermediate|advanced|expert|novice|proficient|competent|foundational)\b/i.test(l));
    return matches.length >= 2;
  }

  function rateSkillExperience(topic, snap, options) {
    const t = norm(topic)
      .replace(/\b(how would you rate|rate your (level of )?experience with|level of (your )?experience with|experience with|familiarity with|proficiency in|what is your)\b/gi, '')
      .replace(/[*?:!]/g, '')
      .trim();
    if (!t) return 'Intermediate';

    const words = t.split(/\s+/).filter((w) => w.length > 2 && !/^(the|and|for|with|your|about|this|that|from)\b/i.test(w));

    const candidateText = norm([
      (snap.skills || []).join(' '),
      snap.resume_markdown || snap.master_resume_markdown || '',
      (snap.experience || []).map((e) => (e.title || '') + ' ' + (e.bullets || []).join(' ')).join(' '),
      snap.summary || '',
    ].join(' '));

    let hits = 0;
    for (const w of words) {
      if (/^(security|tools|ability|level|experience|hands|management)$/i.test(w)) continue;
      if (candidateText.includes(w)) hits++;
    }

    if (/\b(script|scripts|scripting|automate|automation)\b/i.test(t)) {
      if (/\b(powershell|python|bash|scripting|automation|automate|n8n)\b/i.test(candidateText)) hits += 3;
    }
    if (/\b(vendor|vendors)\b/i.test(t)) {
      if (/\b(vendor|vendors|sla)\b/i.test(candidateText)) hits += 3;
    }
    if (/\b(endpoint|endpoints|endpoint management|endpoint tools)\b/i.test(t)) {
      if (/\b(endpoint|intune|defender|ninjaone|rmm|mdm)\b/i.test(candidateText)) hits += 3;
    }
    if (/\b(aws|amazon web services)\b/i.test(t)) {
      if (/\b(aws|amazon web services)\b/i.test(candidateText)) hits += 3;
    }

    const optLabels = (options || []).map((o) => normalizeOption(o.label || ''));
    const hasNone = optLabels.some((l) => /^(none|no|not applicable|n\/a|never)\b/i.test(l));
    const hasBasic = optLabels.some((l) => /^(basic|foundational|entry)\b/i.test(l));
    const hasBeginner = optLabels.some((l) => /^(beginner|novice)\b/i.test(l));

    if (hits >= 3) return 'Advanced';
    if (hits >= 2) return 'Intermediate';
    if (hits >= 1) return hasBasic ? 'Basic' : (hasBeginner ? 'Beginner' : 'Basic');
    if (hasNone) return 'None';
    return null;
  }

  // ------------------------------------------------------------------ value shaping
  const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };

  // A date that cannot exist must never reach an application. "2026-24" parses into
  // month 24 and would type 24/2026 into a real form, so every parsed date has to
  // look like a calendar date before it is used.
  function sane(d) {
    if (!d || d.raw) return d;
    const yearNow = new Date().getFullYear();
    if (!d.y || d.y < 1900 || d.y > yearNow + 1) return null;
    if (d.mo < 0 || d.mo > 12) return null;
    if (d.d < 0 || d.d > 31) return null;
    return d;
  }

  function parseDate(value) {
    const s = String(value || '').trim();
    if (!s) return null;
    if (/^(present|current|now|ongoing|tbd|unknown|n\/?a)$/i.test(s)) return null;
    let m = s.match(/^(\d{4})[-/](\d{1,2})(?:[-/](\d{1,2}))?$/);
    if (m) return sane({ y: +m[1], mo: +m[2], d: m[3] ? +m[3] : 0, partial: m[3] ? '' : 'month' });
    m = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})$/);
    if (m) return sane({ y: +m[3] < 100 ? 2000 + +m[3] : +m[3], mo: +m[1], d: +m[2] });
    m = s.match(/^([a-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/i);
    if (m) return sane({ y: +m[3], mo: MONTHS[m[1].slice(0, 3).toLowerCase()], d: +m[2] });
    m = s.match(/^([a-z]{3,9})\.?\s+(\d{4})$/i);
    if (m) return sane({ y: +m[2], mo: MONTHS[m[1].slice(0, 3).toLowerCase()], d: 0, partial: 'month' });
    m = s.match(/^(\d{4})$/);
    if (m) return sane({ y: +m[1], mo: 0, d: 0, partial: 'year' });
    m = s.match(/^(\d{1,2})[-/.](\d{4})$/);
    if (m) return sane({ y: +m[2], mo: +m[1], d: 0, partial: 'month' });
    // Anything else is passed through as written ("Summer 2020", "Expected May 2026")
    // but only if it is short and actually contains a plausible year -- otherwise a
    // typo reaches the form as free text.
    if (s.length <= 24 && /\b(19|20)\d{2}\b/.test(s)) {
      const year = +(s.match(/\b((?:19|20)\d{2})\b/) || [])[1];
      if (year >= 1900 && year <= new Date().getFullYear() + 1) return { raw: s };
    }
    return null;
  }

  // "2023" is not January. A resume that says only the year must not become
  // 01/01/2023 on a real application.
  function datePrecision(value) {
    const d = parseDate(value);
    return d && d.partial ? d.partial : '';
  }

  function formatDate(value, field) {
    const d = parseDate(value);
    if (!d) return '';
    const p2 = (n) => String(n).padStart(2, '0');
    if (field && field.type === 'month') return d.mo ? `${d.y}-${p2(d.mo)}` : '';
    if (field && field.type === 'number') {
      const label = norm((field.label || '') + ' ' + (field.name || ''));
      if (/year/.test(label) && !/month/.test(label)) return String(d.y);
      if (/month/.test(label)) return d.mo ? String(d.mo) : '';
    }
    if (d.raw) return d.raw;
    const fmt = (field && field.dateHint) || 'mdy';
    if (!d.mo) return (field && field.type === 'month') ? '' : String(d.y);
    if (!d.d && fmt !== 'my' && fmt !== 'monthname') {
      // day unknown: month/year beats inventing the first of the month
      return fmt === 'ymd' ? `${d.y}-${p2(d.mo)}` : `${p2(d.mo)}/${d.y}`;
    }
    if (fmt === 'ymd') return `${d.y}-${p2(d.mo)}-${p2(d.d)}`;
    if (fmt === 'my') return `${p2(d.mo)}/${d.y}`;
    if (fmt === 'dmy') return `${p2(d.d)}/${p2(d.mo)}/${d.y}`;
    if (fmt === 'monthname') {
      const names = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
      return `${names[(d.mo || 1) - 1]} ${d.y}`;
    }
    return `${p2(d.mo)}/${p2(d.d)}/${d.y}`;
  }

  // Which date format does this control want? Inferred from placeholder/mask/name.
  function dateHintFor(field) {
    const hint = norm((field.placeholder || '') + ' ' + (field.name || '') + ' ' + (field.id || ''));
    if (/mm\/yy\b|mm\/yyyy|\bmm[-/ ]yyyy/.test(hint)) return 'my';
    if (/dd\/mm|yyyy[-/]mm[-/]dd|iso/.test(hint)) return 'ymd';
    if (/dd\/mm\/(yyyy|yy)/.test(hint)) return 'dmy';
    if (/month.*year|month \/ year/.test(hint)) return 'monthname';
    if (/\bmm\/dd\/yy/.test(hint)) return 'mdy';
    return '';
  }

  // Is this control a date control? Stops "willing TO relocate" being read as an
  // employment end date, which is exactly the kind of confident nonsense to avoid.
  function looksLikeDate(field) {
    if (field.type === 'date' || field.type === 'month') return true;
    if (field.label && field.label.split(/\s+/).length > 6) return false;
    const sig = norm((field.label || '') + ' ' + (field.placeholder || '') + ' ' + (field.name || '') + ' ' + (field.id || ''));
    if (/\b(date|month|year)\b/.test(sig)) return true;
    return /\d{1,2}\/\d{1,2}\/\d{2,4}|yyyy|mm\/dd|dd\/mm|####/.test(norm(field.placeholder || ''));
  }

  // A start/end date belongs to an employment row only when the surrounding section
  // says so. Without this, "Earliest start date" gets filled with the first job's
  // start date -- a wrong answer that looks completely plausible.
  function employmentContext(field) {
    const hay = norm((field.section || '') + ' ' + (field.legend || '') + ' ' + (field.groupLabel || '') + ' ' + (field.id || '') + ' ' + (field.name || '') + ' ' + (field.testid || ''));
    return /\b(experience|employment|work history|previous (job|role|position|employer)|professional background|job history|workexperience)\b/i.test(hay);
  }

  function educationContext(field) {
    const hay = norm((field.section || '') + ' ' + (field.legend || '') + ' ' + (field.groupLabel || ''));
    if (/\b(education|academic|degree|school|university|college)\b/.test(hay)) return true;
    const self = norm((field.label || '') + ' ' + (field.placeholder || '') + ' ' + (field.name || '') + ' ' + (field.id || ''));
    return /\b(school|degree|major|minor|institution|college|university|gpa|graduat)\b/.test(self);
  }

  // A sentence on a form is an employer question; a short string is a field label.
  function looksLikeQuestion(field) {
    const label = String(field.label || field.legend || field.section || '').trim();
    if (!label) return false;
    const words = label.split(/\s+/).length;
    if (/[?]$/.test(label) && words >= 3) return true;
    return words >= 8;
  }

  function splitLocation(location) {
    const parts = String(location || '').split(',').map((s) => s.trim()).filter(Boolean);
    return { city: parts[0] || '', state: parts[1] || '', country: parts.slice(2).join(', ') || parts[1] || '' };
  }

  function digits(phone) { return String(phone || '').replace(/[^\d+]/g, ''); }

  function getWorkAuthInfo(snap) {
    if (!snap) return null;
    if (snap.work_authorization && typeof snap.work_authorization === 'object') {
      const wa = snap.work_authorization;
      if (wa.status || wa.is_citizen || wa.authorized != null) {
        return {
          status: wa.status || '',
          is_citizen: !!wa.is_citizen,
          authorized: wa.authorized !== false,
          requires_sponsorship: wa.requires_sponsorship,
        };
      }
    }
    const raw = String((snap.review_only && snap.review_only.work_authorization) || snap.work_authorization_note || snap.work_authorization || '').trim();
    if (!raw) return null;
    const l = raw.toLowerCase();
    const isCitizen = /\b(u\.?s\.?\s*)?citizen\b/i.test(l);
    const isPR = /\b(permanent resident|green card)\b/i.test(l);
    const needsSponsor = /\b(require(s)?\s*sponsor|need(s)?\s*sponsor|visa|h-?1b)\b/i.test(l);
    return {
      status: raw,
      is_citizen: isCitizen,
      authorized: isCitizen || isPR || !needsSponsor || l.includes('authorized'),
      requires_sponsorship: needsSponsor ? true : ((isCitizen || isPR) ? false : null),
    };
  }

  function classifyWorkAuth(field, n, snap) {
    const info = getWorkAuthInfo(snap);
    if (!info) return null;

    const allOpts = (field.options && field.options.length) ? field.options : (field.radioLabels || []);
    const optLabels = allOpts.map((o) => normalizeOption(o.label));
    const hasYes = optLabels.some((l) => /^(yes|y|true)\b/.test(l));
    const hasCitizenOpt = optLabels.some((l) => /\bcitizen\b/.test(l));

    // 1. Foreign or dual citizenship: "citizenship elsewhere", "foreign citizenship", "dual citizenship", "other citizenship"
    if (/\b(citizenship elsewhere|foreign citizenship|dual citizenship|other citizenship|citizenship in another country)\b/i.test(n)) {
      return {
        action: 'fill',
        key: 'work_authorization.foreign_citizenship',
        value: 'No',
        confidence: 0.95,
        category: 'work_authorization',
        review: 'work_authorization',
        method: 'work_authorization',
      };
    }

    // 2. Are you a citizen? / Citizenship status
    if (/\b(are you (a )?(u\.?\s*s\.?|united states)?\s*citizen|u\.?\s*s\.?\s*citizen(ship)?|citizenship\s*(status)?|citizen of the united states)\b/i.test(n) ||
        (/(?:^|\b)citizenship(?:\s*(status|\?|:|$))/i.test(n) && !/\b(if not|unless|other than)\b/i.test(n))) {
      let val = info.is_citizen ? 'Yes' : 'No';
      if (info.is_citizen && hasCitizenOpt && !hasYes) {
        const citizenOpt = allOpts.find((o) => /\b(u\.?\s*s\.?|united states)?\s*citizen\b/i.test(normalizeOption(o.label)));
        val = citizenOpt ? citizenOpt.label : 'U.S. Citizen';
      }
      return {
        action: 'fill',
        key: 'work_authorization.citizenship',
        value: val,
        confidence: 0.95,
        category: 'work_authorization',
        review: 'work_authorization',
        method: 'work_authorization',
      };
    }

    // 3. Are you legally authorized to work in the United States?
    if (/\b(legally authorized|authorized to work|work authoriz\w*|employment eligibility|eligible to work)\b/i.test(n)) {
      if (info.authorized != null) {
        return {
          action: 'fill',
          key: 'work_authorization.authorized',
          value: info.authorized ? 'Yes' : 'No',
          confidence: 0.95,
          category: 'work_authorization',
          review: 'work_authorization',
          method: 'work_authorization',
        };
      }
    }

    // 4. Will you now or in the future require visa sponsorship?
    if (/\b(require.*sponsor\w*|need.*sponsor\w*|visa sponsor\w*|sponsorship.*require\w*|sponsorship for (an )?employment visa)\b/i.test(n)) {
      if (info.requires_sponsorship != null) {
        return {
          action: 'fill',
          key: 'work_authorization.sponsorship',
          value: info.requires_sponsorship ? 'Yes' : 'No',
          confidence: 0.95,
          category: 'work_authorization',
          review: 'work_authorization',
          method: 'work_authorization',
        };
      }
    }

    return null;
  }

  function classifyEEOC(field, n, snap) {
    if (!snap) return null;
    const eeoc = snap.eeoc || {};

    // 1. Gender / Sex (exclude sexual orientation)
    if (/\b(gender|sex)\b/i.test(n) && !/\b(orientation|sexual orientation)\b/i.test(n)) {
      const val = eeoc.gender || snap.gender || '';
      if (val) {
        return {
          action: 'fill',
          key: 'eeoc.gender',
          value: val,
          context: 'eeoc.gender',
          confidence: 0.95,
          category: 'eeoc',
          review: 'eeoc',
          method: 'eeoc_profile',
        };
      }
    }

    // 2. Race / Ethnicity
    if (/\b(race|ethnic|ethnicity)\b/i.test(n)) {
      const val = eeoc.race || snap.race || '';
      if (val) {
        return {
          action: 'fill',
          key: 'eeoc.race',
          value: val,
          context: 'eeoc.race',
          confidence: 0.95,
          category: 'eeoc',
          review: 'eeoc',
          method: 'eeoc_profile',
        };
      }
    }

    // 3. Veteran Status
    if (/\b(veteran|military service|armed forces|protected veteran)\b/i.test(n)) {
      const val = eeoc.veteran || snap.veteran || '';
      if (val) {
        return {
          action: 'fill',
          key: 'eeoc.veteran',
          value: val,
          context: 'eeoc.veteran',
          confidence: 0.95,
          category: 'eeoc',
          review: 'eeoc',
          method: 'eeoc_profile',
        };
      }
    }

    // 4. Disability Status
    if (/\b(disabilit\w+|handicap)\b/i.test(n)) {
      const val = eeoc.disability || snap.disability || '';
      if (val) {
        return {
          action: 'fill',
          key: 'eeoc.disability',
          value: val,
          context: 'eeoc.disability',
          confidence: 0.95,
          category: 'eeoc',
          review: 'eeoc',
          method: 'eeoc_profile',
        };
      }
    }

    return null;
  }

  // ------------------------------------------------------------------ decision
  function signal(field) {
    return [
      field.label, field.aria, field.placeholder, field.name, field.id, field.title, field.testid,
      field.legend, field.section, field.help, field.role, field.groupLabel,
      (field.options || []).slice(0, 6).map((o) => o.label).join(' '),
    ].filter(Boolean).join(' | ');
  }

  function classify(field, snap, settings) {
    const sig = signal(field);
    const n = norm(sig);
    const out = {
      action: 'skip',
      key: null,
      value: '',
      reason: '',
      confidence: 0,
      category: null,
      review: null,
      method: '',
    };

    if (!field.visible && field.type !== 'file') { out.reason = 'hidden'; return out; }
    if (field.type === 'password') { out.reason = 'password field'; return out; }
    if (/(credit ?card|cvv|card number|cvc|expiry)/.test(n)) { out.action = 'block'; out.category = 'financial_and_credit'; out.reason = 'payment credential'; return out; }

    // 1. compliance wall -- absolute, not user-configurable. A wrong answer here is a
    //    legal problem for the applicant, not a formatting problem.
    for (const b of BLOCKED) {
      if (b.rx.test(n)) {
        if (b.category === 'work_authorization' && (!settings || settings.autofill_work_auth !== false)) {
          const wa = classifyWorkAuth(field, n, snap);
          if (wa) return wa;
        }
        if ((b.category === 'protected_class' || b.category === 'disability' || b.category === 'veteran') && (!settings || settings.autofill_eeoc !== false)) {
          const eeoc = classifyEEOC(field, n, snap);
          if (eeoc) return eeoc;
        }
        out.action = 'block';
        out.category = b.category;
        out.reason = b.category;
        out.confidence = 1;
        return out;
      }
    }

    // 2. password managers' own territory / irrelevant
    if (/(captcha|recaptcha|searchbox|query|newsletter|subscribe|remember me|username|password)/.test(n) && field.type !== 'email') {
      out.reason = 'not application data';
      return out;
    }

    // 3. a sentence on a form is a question, not a label: consult your approved
    //    answers first so rules like "willing TO relocate" cannot hijack it.
    const proseTarget = field.tag === 'textarea' || field.type === 'textarea' || field.type === 'text'
      || field.tag === 'select' || field.type === 'radio' || field.type === 'checkbox';

    function answerAttempt() {
      const q = field.label || field.legend || field.section || field.placeholder;
      const m = matchAnswer(q, snap);
      if (m.answer && m.answer.blocked) {
        if (m.answer.category === 'work_authorization' && (!settings || settings.autofill_work_auth !== false)) {
          const wa = classifyWorkAuth(field, n, snap);
          if (wa) return wa;
        }
        if ((m.answer.category === 'protected_class' || m.answer.category === 'disability' || m.answer.category === 'veteran') && (!settings || settings.autofill_eeoc !== false)) {
          const eeoc = classifyEEOC(field, n, snap);
          if (eeoc) return eeoc;
        }
        return { action: 'block', category: m.answer.category || 'compliance', reason: 'your packet marks this as a question only you may answer', confidence: 1, value: '' };
      }
      if (m.answer && m.score >= 0.6 && m.answer.answer && !m.answer.needs_input && !/\[needs input\]/i.test(m.answer.answer)) {
        return { action: 'fill', key: 'answer:' + clip(q, 60), value: m.answer.answer, confidence: m.score, method: m.method, review: m.answer.review || null, reason: '' };
      }
      if (m.answer && (m.answer.needs_input || /\[needs input\]/i.test(m.answer.answer || ''))) {
        return { action: 'skip', reason: 'your approved draft for this still has an open gap', confidence: m.score, value: '' };
      }
      return { action: null, score: m.score, reason: m.answer ? `closest answer only ${Math.round(m.score * 100)}% match` : 'no drafted answer for this question' };
    }

    // Plenty of short "questions" are really facts wearing a question mark:
    // "Where are you based?", "What is your salary expectation?". Answer those from
    // the profile rather than matching them against drafted prose.
    function factRuleAhead() {
      const words = String(field.label || field.aria || '').split(/\s+/).filter(Boolean).length;
      if (words > 9) return false;
      return RULES.some((rule) => {
        if (!/^(identity|review|misc|ref|address|exp|edu)\./.test(rule.key)) return false;
        if (rule.requires === 'date' && !looksLikeDate(field)) return false;
        if (rule.requires === 'employment') return false;
        return rule.rx.test(n);
      });
    }

    const isRating = isProficiencyOptions(field.radioLabels || field.options) &&
      /\b(rate your (level of )?experience|level of (your )?experience|how would you rate|experience with|familiarity with|proficiency in)\b/i.test(n);
    if (isRating) {
      const qText = field.label || field.groupLabel || field.legend || '';
      const level = rateSkillExperience(qText, snap, field.radioLabels || field.options);
      if (!level) return out;
      return {
        action: 'fill',
        key: 'skill_rating:' + clip(qText, 50),
        value: level,
        confidence: 0.85,
        category: 'skill_rating',
        review: 'rating',
        method: 'skill_rating',
        context: 'skill_rating',
      };
    }

    if (proseTarget && looksLikeQuestion(field) && !factRuleAhead()) {
      const attempt = answerAttempt();
      if (attempt.action) { Object.assign(out, attempt); return out; }
    }

    // 4. structural rules
    let chosen = null;
    let ruleAutocomplete = null;
    if (field.groupLabel && (field.type === 'checkbox' || field.kind === 'checkbox' || field.type === 'radio' || field.kind === 'radio')) {
      const gNorm = norm(field.groupLabel);
      for (const rule of RULES) {
        if (rule.rx.test(gNorm)) {
          chosen = rule;
          break;
        }
      }
    }
    if (!chosen) {
      for (const rule of RULES) {
        if (rule.requires === 'date' && !looksLikeDate(field)) continue;
        if (rule.requires === 'employment' && !(looksLikeDate(field) && employmentContext(field))) continue;
        if (rule.requires === 'education' && !(looksLikeDate(field) && educationContext(field))) continue;
        if (rule.types && field.tag !== 'input' && field.tag !== 'textarea' && field.tag !== 'select' && field.tag !== 'file') continue;
        if (rule.types && rule.types.indexOf(field.type) < 0 && rule.types.indexOf(field.tag) < 0) continue;
        if (rule.key === 'identity.location' && (employmentContext(field) || (field.index && field.index > 0))) continue;
        if (rule.key === 'exp.location' && !employmentContext(field) && !(field.index && field.index > 0) && !/(?:job|position|role|employer|work|office)\s*location/i.test(n)) continue;
        let hit = false;
        if (rule.rx.test(n)) hit = true;
        if (!hit && rule.autocomplete && field.autocomplete && rule.autocomplete.indexOf(field.autocomplete) >= 0) hit = true;
        if (!hit && rule.key === 'identity.phone' && field.type === 'tel') hit = true;
        if (hit) { chosen = rule; ruleAutocomplete = rule.autocomplete && field.autocomplete && rule.autocomplete.indexOf(field.autocomplete) >= 0; break; }
      }
    }
    if (!chosen && field.isDedicatedUploadStep && (field.type === 'file' || field.tag === 'file')) {
      chosen = { key: 'doc.resume', types: ['file', 'textarea'] };
    }

    if (chosen) {
      out.key = chosen.key;
      out.confidence = ruleAutocomplete ? 0.97 : 0.8;
      out.method = ruleAutocomplete ? 'autocomplete' : 'label-rule';
      out.review = chosen.review || null;

      if (chosen.key === 'doc.resume') {
        if (!field.isDedicatedUploadStep && /(autofill|auto-fill|pre-fill|prefill|import|parse)\s*(?:from|with|using)?\s*(?:your\s*)?(?:resume|cv)/i.test(n)) {
          out.action = 'skip';
          out.reason = 'ats autofill widget';
          return out;
        }
        if (field.tag === 'textarea' || field.type === 'textarea') {
          const md = (snap.resume_markdown || '').trim();
          out.action = md ? 'fill' : 'skip';
          out.value = md;
          if (!md) out.reason = 'no resume in snapshot';
          return out;
        }
        out.action = 'upload';
        out.value = 'resume';
        out.confidence = 0.9;
        return out;
      }
      if (chosen.key === 'doc.cover_letter') {
        if (field.type !== 'file') {
          const rawLetter = (typeof snap.cover_letter === 'object' ? snap.cover_letter?.text : snap.cover_letter) || '';
          const letter = String(rawLetter || '').trim();
          out.action = letter ? 'fill' : 'skip';
          out.value = letter;
          if (!letter) out.reason = 'no cover letter in snapshot';
          return out;
        }
        out.action = 'upload';
        out.value = 'cover_letter';
        out.confidence = 0.9;
        return out;
      }
      if (chosen.key === 'doc.other') { out.action = 'skip'; out.reason = 'upload needs your judgement'; return out; }

      let value = '';
      if (chosen.key.indexOf('exp.') === 0) {
        const sub = chosen.key.slice(4);
        const idx = field.index || 0;
        const e = ((snap.experience || [])[idx]) || (snap.experience || [])[0] || {};
        if (sub === 'start_month') {
          const d = parseDate(e.start);
          value = (d && d.mo) ? String(d.mo) : '';
          out.context = 'exp.start_month';
        } else if (sub === 'start_year') {
          const d = parseDate(e.start);
          value = (d && d.y) ? String(d.y) : '';
        } else if (sub === 'end_month') {
          const d = parseDate(e.end);
          value = (d && d.mo) ? String(d.mo) : '';
          out.context = 'exp.end_month';
        } else if (sub === 'end_year') {
          const d = parseDate(e.end);
          value = (d && d.y) ? String(d.y) : '';
        } else if (sub === 'phone' || sub === 'company_phone') {
          value = digits(e.company_phone || e.phone || '');
          out.context = 'exp.phone';
        } else if (sub === 'ref_name' || sub === 'ref_first_name') {
          value = e.ref_name || '';
        } else if (sub === 'ref_last_name') {
          value = e.ref_last_name || '';
        } else if (sub === 'ref_phone') {
          value = digits(e.ref_phone || '');
        } else if (sub === 'ref_email') {
          value = e.ref_email || '';
        } else if (sub === 'description') {
          value = (e.bullets && e.bullets.length) ? e.bullets.map(b => '• ' + b).join('\n') : (e.description || e.summary || '');
        } else {
          value = String(e[sub] || '');
          if (sub === 'end' && (e.end || '').match(/present|current/i)) value = '';
          if (sub === 'start' || sub === 'end') out.isDate = true;
        }
      } else if (chosen.key.indexOf('edu.') === 0) {
        const sub = chosen.key.slice(4);
        const idx = field.index || 0;
        const e = (snap.education || [])[idx] || (snap.education || [])[0] || {};
        const combined = `${e.degree || ''} ${e.field || ''}`.trim();
        if (sub === 'year') {
          value = String(e.year || e.end_year || e.end || '');
          out.isDate = true;
        } else if (sub === 'school') {
          value = String(e.school || '');
          out.context = 'edu.school';
        } else if (sub === 'degree') {
          if (field.tag === 'select') {
            value = String(e.degree || '');
          } else if (/\b(field of study|major)\b/i.test(n) && combined.length > String(e.degree || '').length) {
            value = combined;
          } else {
            value = combined.length > String(e.degree || '').length + 1 ? combined : String(e.degree || '');
          }
          out.context = 'edu.degree';
        } else if (sub === 'major') {
          value = String(e.field || e.major || '');
          out.context = 'edu.major';
        } else if (sub === 'minor') {
          value = String(e.minor || '');
          out.context = 'edu.minor';
        } else if (sub === 'start_month') {
          value = String(e.start_month || '');
          out.context = 'edu.start_month';
        } else if (sub === 'start_year') {
          value = String(e.start_year || '');
          out.context = 'edu.start_year';
        } else if (sub === 'end_month') {
          value = String(e.end_month || '');
          out.context = 'edu.end_month';
        } else if (sub === 'end_year') {
          value = String(e.end_year || e.year || '');
          out.context = 'edu.end_year';
        } else if (sub === 'start') {
          value = String(e.start || e.start_year || '');
          out.isDate = true;
        } else if (sub === 'end') {
          value = String(e.end || e.end_year || e.year || '');
          out.isDate = true;
        } else {
          value = combined.length > String(e.degree || '').length + 1 ? combined : String(e.degree || '');
        }
      } else if (chosen.key.indexOf('ref.') === 0) {
        const sub = chosen.key.slice(4);
        const idx = field.index || 0;
        const r = ((snap.references || [])[idx]) || ((snap.experience || [])[idx]) || (snap.references || [])[0] || (snap.experience || [])[0] || {};
        if (sub === 'first_name') value = r.first_name || r.ref_name || (r.name ? r.name.split(' ')[0] : '');
        else if (sub === 'last_name') value = r.last_name || r.ref_last_name || (r.name ? r.name.split(' ').slice(1).join(' ') : '');
        else if (sub === 'name') value = r.name || `${r.first_name || r.ref_name || ''} ${r.last_name || r.ref_last_name || ''}`.trim();
        else if (sub === 'email') value = r.email || r.ref_email || '';
        else if (sub === 'phone') value = digits(r.phone || r.ref_phone || '');
        else if (sub === 'company') value = r.company || '';
        else if (sub === 'title') value = r.title || r.position || '';
        else if (sub === 'relationship') value = r.relationship || '';
      } else if (chosen.key.indexOf('review.') === 0 || chosen.key.indexOf('misc.') === 0) {
        value = answerForKey(chosen.key, snap);
        if (chosen.key === 'review.references' && (snap.references || []).length) {
          value = (snap.references || []).map((r) => {
            const name = r.name || `${r.first_name || ''} ${r.last_name || ''}`.trim();
            const desc = (r.title || r.company) ? ` (${[r.title, r.company].filter(Boolean).join(' at ')})` : '';
            return `${name}${desc} - Email: ${r.email || ''}, Phone: ${r.phone || ''}` + (r.relationship ? `, Relationship: ${r.relationship}` : '');
          }).join('\n\n');
        }
        if (chosen.key === 'misc.currently_employed') {
          const latest = (snap.experience || [])[0] || {};
          value = latest.current ? 'yes' : 'no';
        }
        if (chosen.key === 'misc.how_heard') {
          value = (snap.preferences && snap.preferences.how_heard) || resolve('misc.how_heard', snap) || '';
          if (!value) { out.action = 'skip'; out.reason = 'only you know how you found it'; return out; }
          if (field.type === 'checkbox' || field.kind === 'checkbox') {
            const opt = field.optionLabel || (field.radioLabels && field.radioLabels[0] && field.radioLabels[0].label) || field.label;
            const normOpt = norm(opt);
            const normVal = norm(value);
            const isMatch = (normOpt && normVal && (normOpt.includes(normVal) || normVal.includes(normOpt))) ||
                            booleanFor(opt, value) === true;
            if (isMatch) {
              out.action = 'fill';
              out.value = 'yes';
              out.confidence = 0.95;
              out.method = 'checkbox-match';
              return out;
            } else {
              out.action = 'skip';
              out.reason = 'not selected';
              return out;
            }
          }
        }
        if (chosen.key === 'misc.work_model') {
          value = (snap.preferences && snap.preferences.work_model) || resolve('misc.work_model', snap) || value;
        }
        if (chosen.key === 'review.relocation') {
          const rel = snap.preferences && snap.preferences.willing_to_relocate;
          if (rel != null && rel !== '') value = rel ? 'Yes' : 'No';
        }
        if (chosen.key === 'misc.previous_employee') {
          value = (snap.preferences && snap.preferences.previous_employee) || 'No';
        }
        if (chosen.key === 'misc.preferred_name' || chosen.key === 'misc.legally_first_name') value = resolve('identity.first_name', snap);
      } else if (chosen.key === 'identity.phone_device_type') {
        value = (snap.identity && snap.identity.phone_device_type) || 'Mobile';
        out.context = 'identity.phone_device_type';
      } else if (chosen.key === 'identity.phone_extension') {
        value = (snap.identity && snap.identity.phone_extension) || '';
      } else if (chosen.key === 'identity.phone_country_code') {
        const isSelect = field.tag === 'select' || field.isCustomCombobox;
        value = isSelect ? ((snap.address && snap.address.country) || 'United States') : '+1';
        out.context = 'identity.phone_country_code';
      } else if (chosen.key === 'identity.suffix') {
        value = (snap.identity && snap.identity.suffix) || '';
        if (!value && field.options && field.options.some((o) => /^(none|n\/?a|not applicable)$/i.test(o.label || o.value))) {
          value = 'None';
        }
      } else if (chosen.key.indexOf('address.') === 0) {
        const sub = chosen.key.slice(8);
        const addr = (snap.address && typeof snap.address === 'object') ? snap.address : {};
        const loc = splitLocation(resolve('identity.location', snap));
        if (sub === 'line1') value = addr.line1 || addr.address_line1 || resolve('identity.address', snap) || '';
        else if (sub === 'line2') value = addr.line2 || addr.address_line2 || '';
        else if (sub === 'city') value = addr.city || resolve(chosen.key, snap) || loc.city || '';
        else if (sub === 'state') { value = addr.state || resolve(chosen.key, snap) || loc.state || ''; out.context = 'address.state'; }
        else if (sub === 'postal') value = addr.postal_code || addr.postal || resolve(chosen.key, snap) || '';
        else if (sub === 'country') { value = addr.country || resolve(chosen.key, snap) || loc.country || 'United States'; out.context = 'address.country'; }
      } else if (chosen.key === 'identity.location') {
        value = resolve('identity.location', snap);
      } else if (chosen.key === 'identity.phone') {
        const rawPhone = resolve('identity.phone', snap);
        value = digits(rawPhone);
        if (value.startsWith('+1') && value.length === 12) {
          if (field.placeholder && !field.placeholder.includes('+')) value = value.slice(2);
        } else if (value.startsWith('1') && value.length === 11) {
          if (field.placeholder && !field.placeholder.includes('+')) value = value.slice(1);
        }
      } else if (chosen.key.indexOf('links.') === 0) {
        value = resolve(chosen.key, snap);
        if (!value) {
          if (chosen.key === 'links.portfolio') value = resolve('links.github', snap) || resolve('links.other', snap);
          else if (chosen.key === 'links.github') value = resolve('links.portfolio', snap) || resolve('links.other', snap);
        }
        if (value && !/^https?:\/\//i.test(value)) {
          value = 'https://' + value;
        }
      } else if (chosen.key === 'skills') {
        value = (snap.skills || []).join(', ');
      } else {
        value = resolve(chosen.key, snap);
      }

      if (!value || /\[needs input\]/i.test(value)) { out.action = 'skip'; out.reason = 'nothing in your profile for ' + chosen.key; out.key = chosen.key; return out; }
      out.action = 'fill';
      out.value = value;
      if (out.isDate) {
        const shaped = formatDate(value, field);
        const partial = datePrecision(value);
        if (!shaped) {
          out.action = 'skip';
          out.reason = partial
            ? `your profile only has the ${partial === 'year' ? 'year' : 'month'} for this, and the field wants more`
            : `the date in your profile ("${value}") is not valid -- fix it in Profile`;
          return out;
        }
        out.value = shaped;
        if (partial) out.review = out.review || 'date_precision';
      }
      else if (field.dateHint || (field.type === 'month')) out.value = formatDate(value, field) || value;
      return out;
    }

    // 5. treat it as an employer question
    if (proseTarget && (field.label || field.legend || field.section || '').length >= 6) {
      const attempt = answerAttempt();
      if (attempt.action) { Object.assign(out, attempt); return out; }
      out.reason = attempt.reason || 'no drafted answer for this question';
      out.confidence = attempt.score || 0;
      return out;
    }

    out.reason = 'unrecognised field';
    return out;
  }

  function isSubmitText(text) {
    return /\b(submit|apply now|apply|finish|send application|complete application|review and submit|confirm and submit|sign and submit)\b/i.test(String(text || ''));
  }

  function isNextText(text) {
    const t = String(text || '').trim();
    if (isSubmitText(t)) return false;
    return /^(next|continue|next step|next page|save and continue|save & continue|forward|›|>)$/i.test(t);
  }

  root.FILLDESK_MATCHER = {
    norm, key, signal, classify, matchAnswer, matchOption, normalizeOption, booleanFor,
    formatDate, parseDate, datePrecision, dateHintFor, looksLikeDate, looksLikeQuestion,
    employmentContext, educationContext,
    splitLocation, digits, isSubmitText, isNextText, intentOf, BLOCKED, REVIEW, RULES, INTENTS, overlap,
    getWorkAuthInfo, classifyWorkAuth, classifyEEOC, isProficiencyOptions, rateSkillExperience,
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
