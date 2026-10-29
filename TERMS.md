# FillDesk Terms of Sale and Use

**Version 0.1. Effective for purchases from the date of publication.**
**Fill in the bracketed lines before you publish these.**

These terms apply between you (the buyer) and **[legal name or trading name]**
("**the author**") for one paid license to the FillDesk software
("**FillDesk**", "**the Software**"). By paying, you accept them. Reading them takes
about four minutes, which is roughly the time it takes to install the Software.

---

## 1. What you are buying

A **perpetual license for one person** to install and run FillDesk on machines you
own or control, for your own job applications. One purchase, no subscription, no
seat count, and that version is yours to keep using indefinitely.

You supply your own model API key. FillDesk includes **no hosted service and no
inference**: the author does not sell you model usage and does not take on the cost
or the availability of any model provider. With no key configured, the Software
still works — it drafts from your own saved answers and flags every gap instead of
inventing one.

## 2. Delivery

You receive a download link (or, by arrangement, access to a private repository)
after payment through the author's payment processor. The download is the whole
product: local server, dashboard, browser extension, tests, and documentation. There
is no activation server, no phone-home, and no remote kill switch — so a copy you
have downloaded keeps working even if the author stops maintaining the project.

## 3. Price, tax, and **no refunds**

The price is a **one-time** charge shown at checkout. Where tax applies, it is
calculated and collected by the payment processor.

**Purchases are non-refundable.** This is a digital good delivered instantly, its
behaviour is fully documented, and you can see exactly what it will fill before it
fills anything — including `tools/dry_run.py`, which runs your own resume through the
whole pipeline and prints every fill, attach, verify, leave-alone and refuse decision.
If something is broken, the author will fix it rather than argue about it (section 5).

> **[Consumer law note for the author, delete before publishing]** In the EU, UK and
> some other jurisdictions, buyers of digital content have a statutory 14-day right
> of withdrawal **unless** they give explicit prior consent to begin delivery before
> the period ends and acknowledge they lose the right. If you sell into those markets
> — directly or through a merchant of record — collect that consent at checkout, or
> honour the withdrawal. "No refunds" is your policy for everything else, not a
> override of statutory rights.

## 4. Limited warranty

For **30 days from purchase**, the author warrants that the Software will perform
substantially as documented on supported platforms (Python 3.9+ and a current
Chromium browser). If it does not, the author will **repair or replace** it, and if
neither is practical, refund the purchase price for that copy. That is your exclusive
remedy and the author's whole liability under this warranty.

After 30 days there is **no warranty**, express or implied, including implied
warranties of merchantability, fitness for a purpose, and non-infringement. The
Software is provided "as is". In particular, the author does **not** warrant that
using FillDesk will get you interviews, callbacks, offers, or employment, does not
warrant that any job portal will accept a document or answer, and does not warrant
that every portal field will be recognised — portals change without notice.

## 5. Support

Support is through **public GitHub Issues**: **[issue tracker URL]**.

- Search existing issues first; add steps, the portal name (Workday, Greenhouse,
  Lever, …), the field label, and the version. Never paste your full name, address,
  phone, resume text, or application answers into a public issue — issues are indexed
  by search engines. Attach a screenshot with the personal parts crossed out.
- Issues are answered on a **best-effort basis**, in public, with no response-time
  commitment. There is no phone, DM, or e-mail support line, and no promise that any
  requested feature will be built.
- Reporting an issue does not create an entitlement to a refund.

## 6. Your responsibilities

**You are solely responsible for every answer, document, and application submission
made using FillDesk, and you must review each one before you press Submit.**

FillDesk never clicks Submit, Apply, Finish, or Send — that is enforced in the code,
not in a setting — and it refuses, and will keep refusing, to fill questions about
race, ethnicity, gender, religion, sexual orientation, disability and accommodation,
veteran status, work authorization, citizenship and visa sponsorship, age, criminal
history, health, and any attestation, declaration, or signature.

You agree that you will:

- **verify every autofilled value** against your actual situation before submitting.
  A job application is a representation to a real employer; FillDesk optimises
  wording, it does not know your life;
- answer truthfully, and correct anything wrong — a suggested answer is a draft, not
  a fact about you;
- obey each employer's terms and each job site's terms of use, and obey applicable
  law, including immigration and equal-employment law;
- not use FillDesk to submit applications you did not authorise, to apply to roles
  you are not eligible for, or to file self-identification data you have not reviewed
  and chosen to provide yourself;
- keep your own `data/` folder and API key safe. Anyone with that folder has your
  resume and your profile.

## 7. Limitation of liability

To the maximum extent permitted by law, the author is not liable for any indirect,
incidental, special, consequential, or exemplary damages — including lost income,
lost employment opportunities, rejected applications, reputational harm, or data
loss — and total liability for any claim is limited to **the amount you paid for the
copy of the Software giving rise to the claim**. Nothing here limits liability for
fraud, wilful misconduct, or anything that cannot lawfully be excluded.

## 8. Privacy

FillDesk is local. It does not send anything to the author, contains no analytics, no
telemetry, and no tracking, and no data is required to obtain a refund or support.
The only outbound network calls are: (a) the loopback API on your own machine, and
(b) the model endpoint **you** configure, which receives the profile text you choose
to include — your provider's own privacy terms apply there. The code is auditable and
`./tests.sh` prints a suite you can read.

## 9. Term, changes, and the rest

These terms run as long as you hold the license. The author may change them for
**future** purchases; your existing license keeps the terms you bought. If a
provision is unenforceable, the rest stands. These terms are the entire agreement
about the purchase and supersede anything said in a chat, a video, or a screenshot.

**Governing law: [jurisdiction].** Small claims excepted, disputes go to the courts
of [jurisdiction].

**Contact: [email]** for licensing questions, team copies, and anything these terms
do not cover.

---

*Drafted as a plain-language starting point, not legal advice. Have it checked
against the law where you actually sell, especially section 3 if you take payment
across borders.*
