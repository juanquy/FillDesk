"""Seed ./data with a realistic demo profile and two saved jobs.

  python3 tools/seed_demo.py          # only if you have no profile yet
  python3 tools/seed_demo.py --force  # overwrite

The demo persona is a product manager. It exists so the tool is not an empty form
on first run, and so you can watch a packet get built in ten seconds. Replace it
with your own profile in the dashboard as soon as it is useful.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from server import config, store  # noqa: E402

PROFILE = {
    "name": "Alex Rivera",
    "pronouns": "they/them",
    "email": "alex.rivera@example.com",
    "phone": "+1 (415) 555-0100",
    "location": "San Francisco, CA",
    "timezone": "PT",
    "headline": "Senior Product Manager — growth & product-led motion",
    "target_title": "Senior Product Manager",
    "links": {
        "linkedin": "https://linkedin.com/in/alex-rivera-example",
        "github": "",
        "portfolio": "https://alexrivera.example.com",
        "twitter": "",
        "other": "",
    },
    "salary_expectation": "$180,000 base, negotiable with equity",
    "relocation": "Remote; open to SF hybrid a few days a month",
    "start_date": "Four weeks after offer",
    "notice_period": "Four weeks",
    "work_authorization_note": "Demo placeholder — FillDesk never answers this on a real form.",
    "summary": "Product manager with seven years in growth and platform products at design and storage SaaS companies. I own activation and expansion revenue, run weekly experiments, and ship with a small squad.",
    "skills": ["SQL", "A/B testing", "product-led growth", "roadmapping", "Python", "Figma", "Amplitude", "Jira", "stakeholder management", "pricing"],
    "certifications": ["Pragmatic Institute PMC III"],
    "awards": [],
    "languages": ["English (native)", "Spanish (professional)"],
    "experience": [
        {
            "id": "exp_demo_1",
            "company": "Figma",
            "title": "Senior Product Manager",
            "location": "San Francisco, CA",
            "start": "2021-06",
            "end": "",
            "current": True,
            "context": "Collaborative design platform, B2B2C with a product-led motion.",
            "bullets": [
                "Rebuilt the payment checkout with Stripe: +23% paid conversion, -31% cart abandonment",
                "Launched the PLG onboarding loop from zero to 40,000 MAU in 18 months",
                "Led a 12-person squad across engineering, design and data through three annual releases",
                "Introduced an experiment review process that took average time-to-readout from 19 to 6 days",
            ],
            "tech": ["SQL", "Python", "Amplitude", "Figma", "LaunchDarkly"],
            "keywords": ["PLG", "activation", "experimentation"],
        },
        {
            "id": "exp_demo_2",
            "company": "Dropbox",
            "title": "Product Manager",
            "location": "San Francisco, CA",
            "start": "2018-07",
            "end": "2021-05",
            "current": False,
            "context": "File sharing and collaboration for consumers and small business.",
            "bullets": [
                "Cut support tickets 40% by redesigning the sharing permissions flow as self-serve",
                "Owned the file-sharing surface used by 8M+ weekly actives",
                "Shipped remote-first collaboration features two quarters ahead of plan",
            ],
            "tech": ["SQL", "Tableau", "Jira"],
            "keywords": ["support cost", "self-serve", "sharing"],
        },
    ],
    "education": [
        {"id": "edu_demo_1", "school": "UC Berkeley", "degree": "BS", "field": "Electrical Engineering & Computer Science", "start": "2014", "end": "2018", "location": "Berkeley, CA", "notes": "TA for data structures, two years."}
    ],
    "projects": [
        {"id": "prj_demo_1", "name": "Activation Playbook (internal)", "description": "A reusable onboarding experiment framework now used by four teams.", "link": "", "bullets": ["Framework adopted by 4 teams", "Median time-to-first-value down 22%"]}
    ],
    "boilerplate": [
        {"id": "ans_1", "label": "Why this company?", "text": "I have used the product daily for two years to run my own roadmap, so I know where the friction is from the inside rather than from an interview answer."},
        {"id": "ans_2", "label": "Tell me about a challenge or conflict", "text": "Engineering wanted to rebuild our billing service; I wanted to ship a checkout fix that quarter. I proposed a one-page tradeoff doc, we agreed to the fix plus a two-week spike, and the rebuild landed a quarter later without losing the revenue work."},
        {"id": "ans_3", "label": "Why are you leaving?", "text": "I have been on the same surface for four years and want to own growth end to end at a company earlier in its curve, where the work reaches further than one funnel."},
        {"id": "ans_4", "label": "Greatest weakness", "text": "I over-invest in alignment before shipping. I now timebox it: one written proposal, two reviews, then a decision."},
        {"id": "ans_5", "label": "Tell me about a project you shipped end to end", "text": "I took the checkout from a 61% completion rate to 84% over two quarters: instrumented the funnel in SQL, ran five experiments, killed two of them, and the surviving change added roughly $1.9M in annual recurring revenue."},
    ],
    "master_resume_markdown": """# Alex Rivera

alex.rivera@example.com | +1 (415) 555-0100 | San Francisco, CA | linkedin.com/in/alex-rivera-example

## Summary
Product manager with seven years in growth and platform products at design and storage SaaS companies. I own activation and expansion revenue, run weekly experiments, and ship with a small squad.

## Experience
### Senior Product Manager — Figma (2021 – Present)
- Rebuilt the payment checkout with Stripe: +23% paid conversion, -31% cart abandonment
- Launched the PLG onboarding loop from zero to 40,000 MAU in 18 months
- Led a 12-person squad across engineering, design and data through three annual releases
- Introduced an experiment review process that cut average time-to-readout from 19 to 6 days

### Product Manager — Dropbox (2018 – 2021)
- Cut support tickets 40% by redesigning sharing permissions as a self-serve flow
- Owned the file-sharing surface used by 8M+ weekly actives
- Shipped remote-first collaboration features two quarters ahead of plan

## Skills
SQL, A/B testing, product-led growth, roadmapping, Python, Amplitude, Figma, pricing, stakeholder management

## Education
- BS Electrical Engineering & Computer Science, UC Berkeley (2014 – 2018)
""",
    "extras": {},
}

JOBS = [
    {
        "title": "Senior Product Manager, Growth",
        "company": "Linear",
        "location": "Remote (US)",
        "employment_type": "Full-time",
        "url": "https://boards.greenhouse.io/linear/jobs/demo-growth-pm",
        "source": "seed",
        "description": """Linear is hiring a Senior Product Manager to own growth: activation, activation-to-paid conversion, and expansion revenue across a product-led motion.

You will:
- Own the activation funnel end to end, from signup through first project to first paid seat.
- Design and run experiments; read the data yourself in SQL rather than filing a request.
- Work with a small design and engineering squad, shipping weekly.

Requirements:
- 5+ years of product management on a product-led SaaS product.
- Comfort writing SQL and reading cohort data yourself.
- Experience with A/B testing, onboarding, and pricing or packaging experiments.
- Excellent written communication; we work async and write things down.

Nice to have: experience with developer or design tooling, PLG onboarding from zero, and Python.

What is your experience with product-led growth?
Why Linear?
Are you legally authorized to work in the United States without sponsorship?
What is your salary expectation?
How did you hear about this position?""",
        "questions": ["How do you approach prioritization?"],
    },
    {
        "title": "Product Manager, Platform",
        "company": "Notion",
        "location": "New York, NY or Remote",
        "employment_type": "Full-time",
        "url": "https://boards.greenhouse.io/notion/jobs/demo-platform-pm",
        "source": "seed",
        "description": """Notion is looking for a Product Manager for the platform surface: permissions, sharing, admin controls and the API that customers build on.

You will:
- Own the permissions model and admin experience for enterprise customers.
- Define the roadmap with engineering and support, and write the spec yourself.
- Reduce support tickets and time-to-resolution through product changes.

Requirements:
- 4+ years product management, ideally on B2B infrastructure or admin surfaces.
- Experience reducing support cost with product work.
- Strong written communication.

Tell me about a project you shipped end to end.
Why are you leaving your current role?
Do you require a reasonable accommodation to complete the application process?""",
    },
]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--force", action="store_true", help="overwrite an existing profile")
    args = ap.parse_args()

    config.ensure_dirs()
    existing = store.load_profile()
    if existing.get("name") and not args.force:
        print(f"A profile already exists ({existing['name']}). Use --force to overwrite. Jobs still get seeded.")
    else:
        store.save_profile(PROFILE)
        print(f"seeded demo profile: {PROFILE['name']}")

    for job in JOBS:
        record = store.save_job(dict(job))
        print(f"seeded job: {record['company']} — {record['title']}  ({record['id']})")

    print(f"\nnext: python3 -m server --open   →  Jobs tab → Build packet")
    print(f"data dir: {config.DATA_DIR}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
