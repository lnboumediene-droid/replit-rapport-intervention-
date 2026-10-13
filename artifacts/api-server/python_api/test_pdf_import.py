"""Run: python -m unittest discover -s artifacts/api-server/python_api -p 'test_pdf_import.py' -v

The Claude response and file store are explicit test doubles. No live response
is simulated in the application, and no real dossier is edited.
"""
import io
import json
import random
import tempfile
import unittest
import uuid
from types import SimpleNamespace
from pathlib import Path
from unittest.mock import patch

import pymupdf
from PIL import Image, ImageDraw, ImageFont
from reportlab.pdfgen import canvas
from reportlab.lib.utils import ImageReader
from fastapi.testclient import TestClient

import main
from pdf_import_processing import extract_pdf, clean_text, text_issues, draft_with_claude, MAX_BYTES

OUT = Path(".agents/outputs/import-tests")


def fixture():
    OUT.mkdir(parents=True, exist_ok=True)
    logo = Image.new("RGB", (600, 600), "white")
    ImageDraw.Draw(logo).text((90, 180), "SRP", fill="#B23D4F",
        font=ImageFont.truetype(str(Path(__file__).parent / "assets/DejaVuSans-Bold.ttf"), 150))
    rng = random.Random(24)
    photo = Image.new("RGB", (600, 400))
    photo.putdata([(rng.randrange(50, 180), rng.randrange(60, 160), rng.randrange(30, 130)) for _ in range(600*400)])
    buffer = io.BytesIO()
    c = canvas.Canvas(buffer)
    c.drawImage(ImageReader(logo), 450, 720, width=70, height=70)
    c.setFont("Helvetica", 11)
    for n, line in enumerate([
        "SRP", "12 Rue Fictive 75000 Paris", "Tel : 01 23 45 67 89",
        "contact@srp.example - www.srp.example", "SIRET 12345678901234",
        "Devis n° DEV-9921 - Prix : 980 EUR HT", "Client : CBRE",
        "Site : chantier de test", "Date d'intervention : 07/10/2026",
        "Objet : Reprise de dalle béton", "Contexte : Fouille ouverte.",
        "Constats : Dalle endommagée.", "Intervention réalisée : Reprise de dalle sur 5 m².",
        "Conclusion : Zone nettoyée.", "Fouille et état avant travaux",
    ]):
        c.drawString(55, 780-n*21, line)
    c.drawImage(ImageReader(photo), 70, 180, width=300, height=200)
    c.drawString(55, 65, "Signature du prestataire : SRP")
    c.save()
    raw = buffer.getvalue()
    (OUT / "rapport-srp-fictif.pdf").write_bytes(raw)
    return raw


class PdfImportTests(unittest.TestCase):
    def test_scanned_pdf_ocr(self):
        source = pymupdf.open(stream=fixture(), filetype="pdf")
        image = source[0].get_pixmap(matrix=pymupdf.Matrix(2, 2)).tobytes("png")
        scan = pymupdf.open()
        page = scan.new_page(width=source[0].rect.width, height=source[0].rect.height)
        page.insert_image(page.rect, stream=image)
        result = extract_pdf(scan.tobytes(), ["SRP"])
        self.assertTrue(any("OCR" in w for w in result["warnings"]))
        self.assertFalse(text_issues(result["text"], ["SRP"]))
        self.assertGreater(len(result["photos"]), 0)

    def test_claude_invented_number_rejected(self):
        data = {"client": None, "address": None, "object": "Dalle béton", "tenant": None,
                "dates": ["2026-10-07"], "interventionState": "realisee", "context": "Fouille ouverte.",
                "findings": ["Dalle endommagée."], "workDone": ["Reprise sur 99 m²."],
                "conclusion": ["Zone nettoyée."], "photos": [], "a_completer": []}
        response = SimpleNamespace(stop_reason="end_turn", content=[SimpleNamespace(type="text", text=json.dumps(data))])
        with patch("ai_client.Anthropic") as sdk:
            sdk.return_value.messages.create.return_value = response
            with self.assertRaisesRegex(ValueError, "Chiffres absents"):
                draft_with_claude({"text": "Date 07/10/2026. Reprise sur 5 m².", "photos": []}, ["SRP"])
            self.assertEqual(set(sdk.call_args.kwargs), {"api_key", "base_url"})
            self.assertEqual(sdk.call_args.kwargs["base_url"], "https://api.anthropic.com")

    def test_cleanup_and_images(self):
        self.assertFalse(text_issues(clean_text("S.R.P.\nS R P\nSRP\nCâble HT 20 kV", ["SRP"]), ["SRP"]))
        self.assertIn("Câble HT 20 kV", clean_text("Câble HT 20 kV", ["SRP"]))
        result = extract_pdf(fixture(), ["SRP"])
        self.assertEqual(text_issues(result["text"], ["SRP"]), [])
        self.assertNotIn("DEV-9921", result["text"])
        self.assertNotIn("12 Rue Fictive", result["text"])
        self.assertEqual(len(result["photos"]), 1, "Logo must not become a chantier photo")
        image = Image.open(io.BytesIO(result["photos"][0]["bytes"]))
        self.assertLessEqual(max(image.size), 1600)
        self.assertFalse(image.getexif())

    def test_invalid_files(self):
        for raw in [b"not a pdf", b"%PDF-" + b"0"*MAX_BYTES]:
            with self.assertRaises(ValueError):
                extract_pdf(raw, ["SRP"])

    def test_full_import_review_pdf_and_permissions(self):
        import import_routes
        user = "pdf-import-test-" + str(uuid.uuid4())
        store = {}
        with main.database().begin() as conn:
            conn.execute(main.text("INSERT INTO msb_user_profiles(user_id,name,role) VALUES (:id,'Import test','direction')"), {"id": user})
            site = str(conn.execute(main.text("SELECT id FROM msb_sites WHERE active=true LIMIT 1")).scalar_one())
        actor = main.Actor(user_id=user, email="", name="Import test", role="direction")
        main.app.dependency_overrides[main.actor_dependency] = lambda: actor
        client = TestClient(main.app)
        try:
            with patch.object(main, "upload_private_object", side_effect=lambda p, b, t: store.__setitem__(p, b)), \
                 patch.object(main, "download_private_object", side_effect=lambda p: store[p]), \
                 patch.object(import_routes, "draft_with_claude") as ai:
                ai.side_effect = lambda extracted, names: {
                    "client": None, "address": None, "dates": ["2026-10-07"],
                    "object": "Reprise de dalle béton", "tenant": None, "interventionState": "realisee",
                    "context": "Fouille ouverte.", "findings": ["Dalle endommagée."],
                    "workDone": ["Reprise de dalle sur 5 m²."], "conclusion": ["Zone nettoyée."],
                    "photos": [{"id": p["id"], "groupTitle": "Fouille et état avant travaux", "caption": None} for p in extracted["photos"]],
                    "a_completer": [],
                }
                path = "/objects/uploads/" + str(uuid.uuid4())
                raw = fixture()
                store[path] = raw
                grant = client.post("/internal/import-grant", json={"userId": user, "fileName": "fixture.pdf", "size": len(raw), "objectPath": path})
                self.assertEqual(grant.status_code, 200, grant.text)
                imported = client.post("/imports", json={"importId": grant.json()["importId"], "siteId": site})
                self.assertEqual(imported.status_code, 202, imported.text)
                report_id = imported.json()["reportId"]
                status = client.get(f"/reports/{report_id}/import").json()
                self.assertEqual(status["status"], "ready", status)
                self.assertEqual(client.post(f"/reports/{report_id}/pdf").status_code, 409)
                report = client.get(f"/reports/{report_id}").json()
                body = {"siteId": site, "dates": ["2026-10-07"], "object": report["object"], "tenant": None,
                        "interventionState": "realisee", "context": "Fouille ouverte.", "findings": ["Dalle endommagée."],
                        "workDone": ["Reprise de dalle sur 5 m²."], "conclusion": ["Zone nettoyée."], "reviewed": True,
                        "photos": [{"id": p["id"], "groupTitle": "Fouille et état avant travaux", "order": n, "deleted": False}
                                   for n, p in enumerate(report["zones"][0]["photos"])]}
                reviewed = client.put(f"/reports/{report_id}/import-review", json=body)
                self.assertEqual(reviewed.status_code, 200, reviewed.text)
                generated = client.post(f"/reports/{report_id}/pdf")
                self.assertEqual(generated.status_code, 201, generated.text)
                final = next(b for p, b in store.items() if p.endswith("rapport_v1.pdf"))
                (OUT / "rapport-msb-nettoye.pdf").write_bytes(final)
                pdf = pymupdf.open(stream=final, filetype="pdf")
                text = "\n".join(p.get_text() for p in pdf)
                self.assertFalse(text_issues(text, ["SRP"]))
                self.assertNotIn("DEV-9921", text)
                self.assertIn("5. REPORTAGE PHOTOGRAPHIQUE", text)
                self.assertIn("Fouille et état avant travaux", text)
                self.assertEqual(sum(len(p.get_images()) for p in pdf), 2)  # MSB logo + chantier photo
                # Missing content is optional even on a reviewed import.
                partial = {**body, "dates": [], "object": "", "context": "[À COMPLÉTER]",
                           "findings": [], "workDone": [], "conclusion": [],
                           "photos": [{**p, "groupTitle": "", "caption": "[À COMPLÉTER]"} for p in body["photos"]]}
                reviewed = client.put(f"/reports/{report_id}/import-review", json=partial)
                self.assertEqual(reviewed.status_code, 200, reviewed.text)
                generated = client.post(f"/reports/{report_id}/pdf")
                self.assertEqual(generated.status_code, 201, generated.text)
                partial_pdf = pymupdf.open(stream=store[next(p for p in store if p.endswith("rapport_v2.pdf"))], filetype="pdf")
                partial_text = "\n".join(p.get_text() for p in partial_pdf)
                self.assertNotIn("[À COMPLÉTER]", partial_text)
                self.assertIn("Non renseignée", partial_text)
                self.assertNotIn("07/10/2026", partial_text)
                partial_pdf.close()
                main.app.dependency_overrides[main.actor_dependency] = lambda: main.Actor(user_id=user, email="", name="Import test", role="intervenant")
                self.assertEqual(client.post("/imports", json={"importId": grant.json()["importId"], "siteId": site}).status_code, 403)
                self.assertEqual(client.get("/admin/erased-names").status_code, 403)
        finally:
            main.app.dependency_overrides.clear()
            with main.database().begin() as conn:
                conn.execute(main.text("DELETE FROM msb_reports WHERE created_by=:user"), {"user": user})
                conn.execute(main.text("DELETE FROM msb_pdf_imports WHERE created_by=:user"), {"user": user})
                conn.execute(main.text("DELETE FROM msb_user_profiles WHERE user_id=:user"), {"user": user})


if __name__ == "__main__":
    unittest.main()
