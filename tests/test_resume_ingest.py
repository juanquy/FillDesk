"""Resume ingestion tests: `python3 tests/test_resume_ingest.py`

These guard the dry-run parser (`tools/dry_run.py`), i.e. the step where a real
resume becomes a profile. Everything here is a bug a real resume produced: a cut-off
bullet, a company name ending in an unclosed bracket, a fake job invented from a
sub-heading, and a school name guessed out of a multi-column PDF block.
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from tools.dry_run import parse_education, parse_resume, lines_of  # noqa: E402

FIXTURE = (ROOT / "tests" / "fixtures" / "example-resume.md").read_text(encoding="utf-8")


class FixtureResume(unittest.TestCase):
    def setUp(self):
        self.parsed = parse_resume(FIXTURE)

    def test_identity(self):
        self.assertEqual(self.parsed["name"], "Sam Okafor")
        self.assertEqual(self.parsed["email"], "sam.okafor@example.com")
        self.assertEqual(self.parsed["phone"], "+1 (206) 555-0148")
        self.assertEqual(self.parsed["location"], "Seattle, WA")
        self.assertEqual(self.parsed["headline"], "Staff Data Engineer")

    def test_links(self):
        links = self.parsed["links"]
        self.assertIn("linkedin.com/in/sam-okafor-example", links["linkedin"])
        self.assertIn("github.com", links["github"])

    def test_roles_and_dates(self):
        roles = self.parsed["experience"]
        self.assertEqual(len(roles), 3)
        self.assertEqual(roles[0]["company"], "Acme Analytics")
        self.assertEqual(roles[0]["title"], "Staff Data Engineer")
        self.assertEqual(roles[0]["location"], "Seattle, WA")
        self.assertEqual(roles[0]["start"], "2022-03")
        self.assertEqual(roles[0]["end"], "Present")
        self.assertTrue(roles[0]["current"])
        self.assertEqual(roles[1]["end"], "2022-02")
        self.assertFalse(roles[1]["current"])

    def test_bullets_are_full_sentences(self):
        for role in self.parsed["experience"]:
            for bullet in role["bullets"]:
                self.assertGreater(len(bullet), 20)
                self.assertFalse(bullet.endswith(" hand-written"), "bullet cut off mid-sentence")

    def test_education(self):
        ed = self.parsed["education"]
        self.assertEqual(len(ed), 1)
        self.assertEqual(ed[0]["school"], "University of Illinois at Urbana-Champaign")
        self.assertEqual(ed[0]["degree"], "BS")
        self.assertEqual(ed[0]["field"], "Computer Science")
        self.assertEqual(ed[0]["end"], "2016")

    def test_skills(self):
        self.assertIn("Kafka", self.parsed["skills"])
        self.assertIn("AWS (S3, Lambda, ECS, Redshift)", self.parsed["skills"],
                      "commas inside parentheses are one skill, not four")


class UglyResumes(unittest.TestCase):
    def test_wrapped_bullet_lines_are_joined(self):
        text = (
            "Jane Doe\njane@example.com | Denver, CO\n\n"
            "Experience\n\n"
            "Acme Corp | Engineer | Mar 2020 - Present\n"
            "- Cut build time from forty minutes to\n"
            "  four minutes by caching the dependency layer\n"
            "- Owned the deploy pipeline\n"
        )
        role = parse_resume(text)["experience"][0]
        self.assertEqual(role["company"], "Acme Corp")
        self.assertTrue(any(b.startswith("Cut build time from forty minutes to four minutes")
                            for b in role["bullets"]), role["bullets"])

    def test_dated_subheadings_are_not_invented_jobs(self):
        text = (
            "Jane Doe\njane@example.com\n\nExperience\n\n"
            "Acme Corp | Engineer | Mar 2020 - Present\n- Built the thing\n\n"
            "Early Technical Leadership (Summary)\n"
            "Supported school computer labs 1993 - 2000 while studying\n"
        )
        roles = parse_resume(text)["experience"]
        self.assertEqual(len(roles), 1)
        self.assertEqual(roles[0]["company"], "Acme Corp")

    def test_company_name_with_a_parenthetical(self):
        text = (
            "Jane Doe\njane@example.com\n\nExperience\n\n"
            "KwiTel Communications (Regional ISP - AS 64512, 14-site WAN) | IT Manager | 2021 - 2023\n"
            "- Ran the NOC\n"
        )
        role = parse_resume(text)["experience"][0]
        self.assertNotIn("AS 64512", role["company"])
        self.assertTrue(role["company"].startswith("KwiTel"))
        self.assertEqual(role["title"], "IT Manager")

    def test_column_education_block_is_refused_not_guessed(self):
        lines = lines_of(
            "EDUCATION & CERTIFICATIONS\n"
            "Bachelor of Science / Bachelor's\n"
            " Technical Support: Highly      Attention to Detail: Maintenance:\n"
            "Degree            Proficient        Proficient\n"
        )
        self.assertEqual(parse_education(lines), [],
                         "a wrong school typed into a real form is not acceptable")

    def test_shouting_headings_and_names(self):
        # Test personas are invented: never paste a real person's resume, name,
        # town or phone number into this file, it is published with the repo.
        text = (
            "DANA K. WHITFIELD\n"
            "SENIOR PLATFORM & OBSERVABILITY ENGINEER\n"
            "dana.whitfield@example.com | +1 (555) 010-0148 | Dayton, OH\n"
        )
        parsed = parse_resume(text)
        self.assertEqual(parsed["name"], "Dana K. Whitfield")
        self.assertEqual(parsed["headline"], "Senior Platform & Observability Engineer")

    def test_two_column_skills_block(self):
        text = (
            "Jane Doe\njane@example.com\n\n"
            "CORE TECHNICAL COMPETENCIES\n\n"
            " MICROSOFT 365 TENANT ADMIN          ENTRA ID (AZURE AD)\n"
            " Intune (MDM/MAM, BYOD)             PowerShell Automation\n\n"
            "Experience\n\nAcme Corp | Engineer | 2020 - Present\n- Did work\n"
        )
        skills = parse_resume(text)["skills"]
        self.assertIn("Intune (MDM/MAM, BYOD)", skills)
        self.assertIn("PowerShell Automation", skills)
        self.assertNotIn(" MICROSOFT 365 TENANT ADMIN", skills)


class HonestGaps(unittest.TestCase):
    def test_a_resume_with_nothing_in_it_says_so(self):
        parsed = parse_resume("just some words about work and servers with no contact details at all "
                              "and nothing else that a form could use, honestly.")
        self.assertEqual(parsed.get("email", ""), "")
        self.assertTrue(any("email" in g for g in parsed["_gaps"]))
        self.assertTrue(any("education" in g for g in parsed["_gaps"]))


if __name__ == "__main__":
    unittest.main(verbosity=2)
