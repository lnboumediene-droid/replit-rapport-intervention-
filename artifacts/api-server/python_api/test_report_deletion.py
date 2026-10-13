"""Deletion checks use isolated synthetic dossiers; file deletion is a test double."""
import tempfile
import unittest
import uuid
from unittest.mock import MagicMock, patch

from fastapi.testclient import TestClient

import main


class ReportDeletionTests(unittest.TestCase):
    def setUp(self):
        self.user = "report-deletion-test-" + str(uuid.uuid4())
        with main.database().begin() as conn:
            conn.execute(main.text("INSERT INTO msb_user_profiles(user_id,name,role) VALUES (:id,'Deletion test','direction')"), {"id": self.user})
            self.site = str(conn.execute(main.text("SELECT id FROM msb_sites WHERE active=true LIMIT 1")).scalar_one())
        self.actor = main.Actor(user_id=self.user, name="Deletion test", role="direction")
        main.app.dependency_overrides[main.actor_dependency] = lambda: self.actor
        self.client = TestClient(main.app)
        self.paths = []

    def tearDown(self):
        main.app.dependency_overrides.clear()
        with main.database().begin() as conn:
            conn.execute(main.text("DELETE FROM msb_reports WHERE created_by=:id"), {"id": self.user})
            conn.execute(main.text("DELETE FROM msb_user_profiles WHERE user_id=:id"), {"id": self.user})

    def seed(self, status="ready"):
        created = self.client.post("/reports", json={"siteId": self.site, "date": "2026-10-12", "object": "Synthetic deletion test"})
        self.assertEqual(created.status_code, 201, created.text)
        report = created.json()["id"]
        self.paths = [f"/objects/uploads/deletion-test-{uuid.uuid4()}" for _ in range(3)]
        with main.database().begin() as conn:
            zone = conn.execute(main.text("INSERT INTO msb_report_zones(report_id,name) VALUES (:id,'Test zone') RETURNING id"), {"id": report}).scalar_one()
            conn.execute(main.text("INSERT INTO msb_report_photos(zone_id,object_path) VALUES (:id,:path)"), {"id": zone, "path": self.paths[0]})
            conn.execute(main.text("INSERT INTO msb_report_versions(report_id,version,object_path,compliant,created_by) VALUES (:id,1,:path,true,:user)"), {"id": report, "path": self.paths[1], "user": self.user})
            conn.execute(main.text("INSERT INTO msb_pdf_imports(report_id,created_by,file_name,object_path,size,status) VALUES (:id,:user,'test.pdf',:path,10,:status)"), {"id": report, "user": self.user, "path": self.paths[2], "status": status})
            conn.execute(main.text("INSERT INTO msb_report_status_history(report_id,to_status,changed_by) VALUES (:id,'brouillon',:user)"), {"id": report, "user": self.user})
        return report, zone

    def delete(self, report):
        return self.client.delete(f"/reports/{report}")

    def test_manager_deletes_all_children_and_revokes_file_access(self):
        for role in main.MANAGER_ROLES:
            with self.subTest(role=role):
                self.actor.role = role
                report, zone = self.seed()
                with patch.object(main, "delete_private_object") as remove_file:
                    response = self.delete(report)
                    self.assertEqual(response.status_code, 200, response.text)
                    self.assertEqual(response.json(), {"deleted": True, "cleanupPending": False})
                    self.assertEqual({call.args[0] for call in remove_file.call_args_list}, set(self.paths))
                    self.assertEqual(self.delete(report).status_code, 404)
                    self.assertEqual(remove_file.call_count, 3)
                self.assertEqual(self.client.get(f"/reports/{report}").status_code, 404)
                with main.connection() as conn:
                    for table, column, value in [
                        ("msb_reports", "id", report), ("msb_report_zones", "report_id", report),
                        ("msb_report_photos", "zone_id", zone), ("msb_report_versions", "report_id", report),
                        ("msb_report_status_history", "report_id", report), ("msb_pdf_imports", "report_id", report),
                    ]:
                        self.assertEqual(conn.execute(main.text(f"SELECT count(*) FROM {table} WHERE {column}=:id"), {"id": value}).scalar_one(), 0)
                    self.assertIsNotNone(conn.execute(main.text("SELECT id FROM msb_sites WHERE id=:id"), {"id": self.site}).first())
                for path in self.paths:
                    self.assertFalse(self.client.post("/internal/storage-access", json={"userId": self.user, "objectPath": path}).json()["allowed"])

    def test_intervenant_cannot_delete_even_own_report(self):
        report, _ = self.seed()
        self.actor.role = "intervenant"
        with patch.object(main, "delete_private_object") as remove_file:
            self.assertEqual(self.delete(report).status_code, 403)
            remove_file.assert_not_called()
        self.assertEqual(self.client.get(f"/reports/{report}").status_code, 200)

    def test_processing_import_cannot_be_deleted(self):
        report, _ = self.seed(status="processing")
        with patch.object(main, "delete_private_object") as remove_file:
            self.assertEqual(self.delete(report).status_code, 409)
            remove_file.assert_not_called()
        self.assertEqual(self.client.get(f"/reports/{report}").status_code, 200)

    def test_storage_failure_is_explicit_and_does_not_restore_access(self):
        report, _ = self.seed()
        with patch.object(main, "delete_private_object", side_effect=RuntimeError("test-only storage failure")) as remove_file, \
             self.assertLogs("main", level="ERROR"):
            response = self.delete(report)
            self.assertEqual(response.status_code, 200, response.text)
            self.assertTrue(response.json()["cleanupPending"])
            self.assertEqual(remove_file.call_count, 3)
        for path in self.paths:
            self.assertFalse(self.client.post("/internal/storage-access", json={"userId": self.user, "objectPath": path}).json()["allowed"])

    def test_sent_report_can_be_deleted_by_manager(self):
        report, _ = self.seed()
        with main.database().begin() as conn:
            conn.execute(main.text("UPDATE msb_reports SET status='envoye' WHERE id=:id"), {"id": report})
        with patch.object(main, "delete_private_object"):
            self.assertEqual(self.delete(report).status_code, 200)

    def test_missing_and_invalid_id(self):
        self.assertEqual(self.delete(uuid.uuid4()).status_code, 404)
        self.assertEqual(self.delete("invalid").status_code, 422)

    def test_already_missing_file_cleanup_is_success(self):
        backend = MagicMock()
        backend.delete.return_value = None
        with patch.object(main, "storage", return_value=backend):
            main.delete_private_object("/objects/test")
        backend.delete.assert_called_once_with("/objects/test")

    def test_local_backend_missing_file_cleanup_is_success(self):
        from private_storage import LocalBackend, ObjectNotFound

        backend = LocalBackend(tempfile.mkdtemp())
        with self.assertRaises(ObjectNotFound):
            backend.download("/objects/absent")
        # Deleting an object that is not present is a successful cleanup.
        backend.delete("/objects/absent")
