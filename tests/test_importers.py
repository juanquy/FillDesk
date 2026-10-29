#!/usr/bin/env python3
"""Tests for the profile importers: skill lists and LinkedIn data exports.

These exercise the extraction and merge decisions only. Nothing here writes to a
profile -- the merge is a pure function -- so a test run cannot damage real data.
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tools"))

import import_linkedin as li  # noqa: E402
import import_skills  # noqa: E402

FIXTURES = Path(__file__).parent / "fixtures"


class SkillsFile(unittest.TestCase):
    def test_one_per_line_with_headings(self):
        text = ("Core Technical Experience\n\nMicrosoft Entra ID (Azure AD)\n"
                "Microsoft Intune\nPowerShell, Group Policy, DNS\n")
        self.assertEqual(import_skills.extract(text),
                         ["Microsoft Entra ID (Azure AD)", "Microsoft Intune",
                          "PowerShell", "Group Policy", "DNS"])

    def test_prose_is_not_a_skill(self):
        text = ("Core Technical Experience\n"
                "Applied AI/ML - hands-on with PyTorch, and you write informed technical\n"
                "content on LLM security, which is a real and underrated professional skill\n"
                "Exchange Online management\n")
        self.assertEqual(import_skills.extract(text), ["Exchange Online management"])

    def test_parenthetical_skill_is_never_cut_in_half(self):
        skills = import_skills.extract("Self-Service Password Reset (SSPR)\n")
        self.assertEqual(skills, ["Self-Service Password Reset (SSPR)"])


class LinkedInExport(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.members = li.read_members(FIXTURES / "linkedin-export")

    def test_skills(self):
        self.assertIn("Microsoft Entra ID (Azure AD)", li.extract_skills(self.members))
        self.assertEqual(len(li.extract_skills(self.members)), 4)

    def test_positions_and_dates(self):
        roles = li.extract_experience(self.members)
        self.assertEqual(len(roles), 2)
        self.assertEqual(roles[0]["company"], "KwiTel Communications")
        self.assertEqual(roles[0]["start"], "2018-01")
        self.assertEqual(roles[0]["end"], "2020-07")
        self.assertTrue(roles[1]["current"], "no end date means current")
        self.assertTrue(roles[0]["bullets"], "job description becomes bullets")

    def test_education_and_summary(self):
        self.assertEqual(li.extract_education(self.members)[0]["school"],
                         "Northgate Technical College")
        self.assertIn("fifteen years", li.extract_summary(self.members))


class MergeDecisions(unittest.TestCase):
    def test_hand_typed_summary_survives(self):
        profile = {"summary": "My own words.", "skills": ["PowerShell"], "experience": [],
                   "education": [{"school": "My school"}]}
        patch = li.plan_import(profile, ["PowerShell", "DNS"], [{"company": "X", "title": "Y"}],
                               [{"school": "LinkedIn School"}], "LinkedIn summary text")
        self.assertNotIn("summary", patch, "your own About text wins")
        self.assertNotIn("education", patch, "your own schooling wins")
        self.assertEqual(len(patch["experience"]), 1, "a role you do not have is new")
        self.assertEqual(patch["skills"], ["PowerShell", "DNS"])

    def test_empty_fields_are_filled(self):
        patch = li.plan_import({}, ["DNS"], [{"company": "X", "title": "Y"}],
                               [{"school": "S"}], "A summary from the export")
        self.assertEqual(patch["skills"], ["DNS"])
        self.assertEqual(len(patch["experience"]), 1)
        self.assertEqual(patch["education"][0]["school"], "S")
        self.assertIn("summary", patch)

    def test_duplicate_roles_are_not_added_twice(self):
        profile = {"experience": [{"company": "KwiTel Communications", "title": "Systems Administrator"}],
                   "skills": [], "education": []}
        patch = li.plan_import(profile, [], [{"company": "kwitel communications", "title": "systems administrator"}],
                               [], "")
        self.assertNotIn("experience", patch)


if __name__ == "__main__":
    unittest.main(verbosity=2)
