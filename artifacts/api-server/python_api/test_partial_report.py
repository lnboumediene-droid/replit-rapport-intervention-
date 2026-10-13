"""Regression checks for generation with optional report content."""
import unittest
import uuid
from unittest.mock import patch

import pymupdf
from fastapi.testclient import TestClient

import main


class PartialReportTests(unittest.TestCase):
    def test_optional_object_contract(self):
        report = main.ReportInput(siteId=str(uuid.uuid4()), date="2026-10-12")
        self.assertEqual(report.object, "")
        self.assertEqual(main.ReportUpdate(object="").object, "")

    def test_generate_without_object_description_conclusion_or_photos(self):
        user = "partial-report-test-" + str(uuid.uuid4())
        store = {}
        with main.database().begin() as conn:
            conn.execute(main.text("INSERT INTO msb_user_profiles(user_id,name,role) VALUES (:id,'Partial report test','direction')"), {"id": user})
            site = str(conn.execute(main.text("SELECT id FROM msb_sites WHERE active=true LIMIT 1")).scalar_one())
        actor = main.Actor(user_id=user, email="", name="Partial report test", role="direction")
        main.app.dependency_overrides[main.actor_dependency] = lambda: actor
        client = TestClient(main.app)
        try:
            created = client.post("/reports", json={"siteId": site, "date": "2026-10-12"})
            self.assertEqual(created.status_code, 201, created.text)
            report_id = created.json()["id"]
            self.assertTrue(created.json()["missingFields"])
            with patch.object(main, "upload_private_object", side_effect=lambda p, b, t: store.__setitem__(p, b)):
                generated = client.post(f"/reports/{report_id}/pdf")
                self.assertEqual(generated.status_code, 201, generated.text)
                with pymupdf.open(stream=next(iter(store.values())), filetype="pdf") as pdf:
                    text = "\n".join(p.get_text() for p in pdf)
                    self.assertIn("Constats effectués sur place", text)
                    self.assertIn("Non renseigné", text)
                    self.assertNotIn("[À COMPLÉTER]", text)
        finally:
            main.app.dependency_overrides.clear()
            with main.database().begin() as conn:
                conn.execute(main.text("DELETE FROM msb_reports WHERE created_by=:user"), {"user": user})
                conn.execute(main.text("DELETE FROM msb_user_profiles WHERE user_id=:user"), {"user": user})
