"""PDF import orchestration; the original and all derivative files stay private."""
from __future__ import annotations

import json
import logging
import re
import uuid
import pymupdf
from datetime import date
from pathlib import Path
from typing import Any, Literal

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Response
from pydantic import BaseModel, Field
from sqlalchemy import text
from anthropic import APIStatusError
from pdf_import_processing import MARKER, MAX_BYTES, extract_pdf, draft_with_claude, text_issues

logger = logging.getLogger("msb.imports")


class Grant(BaseModel):
    userId: str
    objectPath: str
    fileName: str
    size: int


class Permission(BaseModel):
    userId: str
    reportId: str


class Start(BaseModel):
    importId: uuid.UUID
    siteId: uuid.UUID


class Name(BaseModel):
    name: str = Field(min_length=2, max_length=100)


class ReviewPhoto(BaseModel):
    id: uuid.UUID
    groupTitle: str
    caption: str | None = None
    order: int = Field(ge=0)
    deleted: bool


class Review(BaseModel):
    siteId: uuid.UUID
    dates: list[date]
    object: str
    tenant: str | None = None
    interventionState: Literal["realisee", "en_cours"]
    context: str
    findings: list[str]
    workDone: list[str]
    conclusion: list[str]
    photos: list[ReviewPhoto]
    reviewed: bool


def register_import_routes(app, core):
    router = APIRouter()
    actor_dep = Depends(core.actor_dependency)

    def manager(actor):
        if actor.role not in core.MANAGER_ROLES:
            raise HTTPException(403, "L’import est réservé au responsable terrain, à l’administratif et à la direction.")

    def names(conn):
        return list(conn.execute(text("SELECT name FROM msb_erased_names WHERE active=true ORDER BY name")).scalars())

    def get_import(conn, report_id):
        row = conn.execute(text("""SELECT i.*,p.name AS author_name FROM msb_pdf_imports i
            LEFT JOIN msb_user_profiles p ON p.user_id=i.created_by WHERE i.report_id=:id"""),
            {"id": report_id}).mappings().first()
        if not row:
            raise HTTPException(404, "Ce dossier ne provient pas d’un import PDF.")
        return row

    def public(row):
        return {"id": str(row["id"]), "reportId": str(row["report_id"]), "fileName": row["file_name"],
                "sourceUrl": "/api/storage/objects/" + row["object_path"].removeprefix("/objects/"),
                "previewUrl": f"/api/reports/{row['report_id']}/import/pages",
                "pageCount": row["page_count"],
                "status": row["status"], "error": row["error"], "warnings": row["warnings"] or [],
                "missing": row["missing"] or [], "reviewed": row["reviewed"],
                "createdAt": row["created_at"].isoformat(), "createdByName": row["author_name"] or "Compte équipe"}

    @router.post("/internal/import-access")
    def allowed(body: Permission):
        with core.connection() as conn:
            role = conn.execute(text("SELECT role FROM msb_user_profiles WHERE user_id=:id AND active=true"), {"id": body.userId}).scalar()
        return {"allowed": role in core.MANAGER_ROLES}

    @router.post("/internal/import-grant")
    def grant(body: Grant):
        with core.database().begin() as conn:
            role = conn.execute(text("SELECT role FROM msb_user_profiles WHERE user_id=:id AND active=true"), {"id": body.userId}).scalar()
            if role not in core.MANAGER_ROLES:
                raise HTTPException(403, "Import non autorisé")
            if body.size < 1 or body.size > MAX_BYTES or not body.fileName.lower().endswith(".pdf") or not body.objectPath.startswith("/objects/uploads/"):
                raise HTTPException(400, "PDF de 30 Mo maximum requis")
            row = conn.execute(text("""INSERT INTO msb_pdf_imports(created_by,file_name,object_path,size)
                VALUES (:user,:name,:path,:size) RETURNING id"""),
                {"user": body.userId, "name": Path(body.fileName).name[:200], "path": body.objectPath, "size": body.size}).mappings().one()
        return {"importId": str(row["id"])}

    @router.get("/admin/erased-names")
    def list_names(actor=actor_dep):
        manager(actor)
        with core.connection() as conn:
            return [{"id": str(r["id"]), "name": r["name"]} for r in conn.execute(text("SELECT id,name FROM msb_erased_names WHERE active=true ORDER BY name")).mappings()]

    @router.post("/admin/erased-names", status_code=201)
    def add_name(body: Name, actor=actor_dep):
        if actor.role not in {"administratif", "direction"}:
            raise HTTPException(403, "Administration ou direction requise")
        if len(body.name.strip()) < 2:
            raise HTTPException(400, "Le nom doit contenir au moins deux caractères.")
        with core.database().begin() as conn:
            row = conn.execute(text("""INSERT INTO msb_erased_names(name,changed_by) VALUES (:name,:user)
                ON CONFLICT(name) DO UPDATE SET active=true,changed_by=:user RETURNING id,name"""),
                {"name": body.name.strip(), "user": actor.user_id}).mappings().one()
        return {"id": str(row["id"]), "name": row["name"]}

    @router.delete("/admin/erased-names/{name_id}", status_code=204)
    def delete_name(name_id: uuid.UUID, actor=actor_dep):
        if actor.role not in {"administratif", "direction"}:
            raise HTTPException(403, "Administration ou direction requise")
        with core.database().begin() as conn:
            result = conn.execute(text("UPDATE msb_erased_names SET active=false,changed_by=:user WHERE id=:id RETURNING id"),
                                  {"id": name_id, "user": actor.user_id}).first()
            if not result:
                raise HTTPException(404, "Nom introuvable")
        return Response(status_code=204)

    def process(report_id: str):
        try:
            with core.connection() as conn:
                row = get_import(conn, report_id)
                banned = names(conn)
            extracted = extract_pdf(core.download_private_object(row["object_path"]), banned)
            photo_rows = []
            for photo in extracted["photos"]:
                photo_path = f"/objects/imports/{row['id']}/photos/{photo['id']}.jpg"
                core.upload_private_object(photo_path, photo["bytes"], "image/jpeg")
                photo_rows.append((photo, photo_path))
            # Persist extraction before the AI call so a real AI error does not
            # lose the source, usable photos or the option of manual correction.
            with core.database().begin() as conn:
                conn.execute(text("DELETE FROM msb_report_zones WHERE report_id=:id"), {"id": report_id})
                zone_id = conn.execute(text("""INSERT INTO msb_report_zones(report_id,name,context,findings,work_done,"order")
                    VALUES (:id,'Intervention',:marker,CAST(:list AS jsonb),CAST(:list AS jsonb),0) RETURNING id"""),
                    {"id": report_id, "marker": MARKER, "list": json.dumps([MARKER])}).scalar_one()
                for order, (photo, path) in enumerate(photo_rows):
                    conn.execute(text("""INSERT INTO msb_report_photos(zone_id,object_path,group_title,"order",metadata)
                        VALUES (:zone,:path,:marker,:ord,CAST(:meta AS jsonb))"""),
                        {"zone": zone_id, "path": path, "marker": MARKER, "ord": order,
                         "meta": json.dumps({"sourcePhotoId": photo["id"], "sourcePage": photo["page"]})})
                conn.execute(text("""UPDATE msb_pdf_imports SET warnings=CAST(:warnings AS jsonb),
                    missing='["date","objet","contexte","constats","intervention réalisée","conclusion","groupes de photos","statut"]'::jsonb WHERE report_id=:id"""),
                    {"id": report_id, "warnings": json.dumps(extracted["warnings"], ensure_ascii=False)})
            data = draft_with_claude(extracted, banned)
            parsed_dates = [date.fromisoformat(d) for d in data["dates"]]
            missing = data["a_completer"][:]
            for key in ["object", "context", "findings", "workDone", "conclusion", "dates", "interventionState"]:
                if not data.get(key) and key not in missing:
                    missing.append(key)
            mapped = {p["id"]: p for p in data["photos"]}
            warnings = extracted["warnings"][:]
            with core.database().begin() as conn:
                report = conn.execute(text("SELECT r.*,s.address,c.name AS client FROM msb_reports r JOIN msb_sites s ON s.id=r.site_id JOIN msb_clients c ON c.id=s.client_id WHERE r.id=:id"), {"id": report_id}).mappings().one()
                if data.get("address") and data["address"].casefold() not in report["address"].casefold():
                    warnings.append("L’adresse trouvée dans le PDF diffère du site sélectionné : confirmer ou changer le site.")
                if data.get("client") and data["client"].casefold() != report["client"].casefold():
                    warnings.append("Le client trouvé dans le PDF diffère du client sélectionné : vérifier ce choix.")
                fiche = {"interventionDates": [d.isoformat() for d in parsed_dates], "importDateMissing": not parsed_dates,
                         "importStateMissing": not data.get("interventionState")}
                conn.execute(text("""UPDATE msb_reports SET intervention_date=:date,object=:object,tenant=:tenant,
                    intervention_state=:state,conclusion=CAST(:conclusion AS jsonb),fiche=CAST(:fiche AS jsonb),updated_at=now() WHERE id=:id"""),
                    {"id": report_id, "date": parsed_dates[0] if parsed_dates else report["intervention_date"],
                     "object": data.get("object") or MARKER, "tenant": data.get("tenant"),
                     "state": data.get("interventionState") or "en_cours",
                     "conclusion": json.dumps(data["conclusion"] or [MARKER]), "fiche": json.dumps(fiche)})
                conn.execute(text("""UPDATE msb_report_zones SET context=:context,findings=CAST(:findings AS jsonb),
                    work_done=CAST(:work AS jsonb) WHERE id=:id"""),
                    {"id": zone_id, "context": data.get("context") or MARKER, "findings": json.dumps(data["findings"] or [MARKER]),
                     "work": json.dumps(data["workDone"] or [MARKER])})
                for photo, path in photo_rows:
                    info = mapped.get(photo["id"], {})
                    group = info.get("groupTitle") or MARKER
                    if MARKER in group:
                        missing.append(f"Groupe de {photo['id']}")
                    conn.execute(text("UPDATE msb_report_photos SET group_title=:group,caption=:caption WHERE object_path=:path"),
                                 {"group": group, "caption": info.get("caption"), "path": path})
                conn.execute(text("""UPDATE msb_pdf_imports SET status='ready',error=NULL,warnings=CAST(:warnings AS jsonb),
                    missing=CAST(:missing AS jsonb),updated_at=now() WHERE report_id=:id"""),
                    {"id": report_id, "missing": json.dumps(missing), "warnings": json.dumps(warnings, ensure_ascii=False)})
            logger.info("PDF import analysis completed", extra={"report_id": report_id})
        except Exception as exc:
            if isinstance(exc, APIStatusError):
                body = exc.body if isinstance(exc.body, dict) else {}
                message = str(body.get("error", {}).get("message", "Appel Claude refusé"))
                error = f"Claude a refusé l’appel (HTTP {exc.status_code}) : {message}"
            elif isinstance(exc, ValueError):
                error = str(exc)
            else:
                error = "L’analyse n’a pas pu aboutir. Le fichier source reste conservé ; réessayez ou complétez manuellement."
            error = re.sub(r"(?:sk-ant-|sk-)[A-Za-z0-9_-]+", "[secret masqué]", error)[:1200]
            with core.database().begin() as conn:
                conn.execute(text("UPDATE msb_pdf_imports SET status='failed',error=:error,updated_at=now() WHERE report_id=:id"), {"id": report_id, "error": error})
            logger.warning("PDF import failed", extra={"report_id": report_id, "error_class": type(exc).__name__})

    @router.post("/imports", status_code=202)
    def start(body: Start, background: BackgroundTasks, actor=actor_dep):
        manager(actor)
        with core.database().begin() as conn:
            row = conn.execute(text("SELECT * FROM msb_pdf_imports WHERE id=:id AND created_by=:user FOR UPDATE"),
                               {"id": body.importId, "user": actor.user_id}).mappings().first()
            if not row or row["status"] != "uploaded":
                raise HTTPException(409, "Cet import n’est plus disponible ou a déjà été lancé.")
            site = conn.execute(text("SELECT id FROM msb_sites WHERE id=:id AND active=true"), {"id": body.siteId}).first()
            if not site:
                raise HTTPException(400, "Sélectionnez un site actif")
            raw = core.download_private_object(row["object_path"])
            if len(raw) > MAX_BYTES or not raw.lstrip().startswith(b"%PDF-"):
                raise HTTPException(400, "Le fichier doit être un vrai PDF de 30 Mo maximum.")
            try:
                source = pymupdf.open(stream=raw, filetype="pdf")
                if source.needs_pass:
                    raise ValueError("PDF protégé par mot de passe")
                page_count = len(source)
                source.close()
            except Exception as exc:
                raise HTTPException(400, "PDF illisible ou protégé par mot de passe.") from exc
            report_id = str(conn.execute(text("""INSERT INTO msb_reports(site_id,intervention_date,object,created_by,conclusion,fiche)
                VALUES (:site,:date,:marker,:user,CAST(:list AS jsonb),CAST(:fiche AS jsonb)) RETURNING id"""),
                {"site": body.siteId, "date": date.today(), "marker": MARKER, "user": actor.user_id,
                 "fiche": json.dumps({"importDateMissing": True, "importStateMissing": True}), "list": json.dumps([MARKER])}).scalar_one())
            # The original is kept with the dossier and always remains private.
            source_path = f"/objects/rapports/{report_id}/sources/{row['id']}.pdf"
            core.upload_private_object(source_path, raw, "application/pdf")
            conn.execute(text("UPDATE msb_pdf_imports SET report_id=:report,status='processing',object_path=:path,page_count=:pages,size=:size,updated_at=now() WHERE id=:id"),
                         {"report": report_id, "id": body.importId, "path": source_path, "pages": page_count, "size": len(raw)})
        background.add_task(process, report_id)
        return {"reportId": report_id}

    @router.get("/reports/{report_id}/import")
    def get_status(report_id: uuid.UUID, actor=actor_dep):
        manager(actor)
        with core.connection() as conn:
            core.assert_report_access(conn, str(report_id), actor)
            return public(get_import(conn, report_id))

    @router.get("/reports/{report_id}/import/pages/{page_number}")
    def preview_page(report_id: uuid.UUID, page_number: int, actor=actor_dep):
        manager(actor)
        with core.connection() as conn:
            core.assert_report_access(conn, str(report_id), actor)
            row = get_import(conn, report_id)
        if not 1 <= page_number <= row["page_count"]:
            raise HTTPException(404, "Page introuvable")
        with pymupdf.open(stream=core.download_private_object(row["object_path"]), filetype="pdf") as doc:
            page = doc[page_number-1]
            image = page.get_pixmap(matrix=pymupdf.Matrix(1400/page.rect.width, 1400/page.rect.width))
            return Response(image.tobytes("jpeg"), media_type="image/jpeg",
                            headers={"Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff"})

    @router.post("/reports/{report_id}/import/retry", status_code=202)
    def retry(report_id: uuid.UUID, background: BackgroundTasks, actor=actor_dep):
        manager(actor)
        with core.database().begin() as conn:
            report = core.assert_report_access(conn, str(report_id), actor)
            row = get_import(conn, report_id)
            if report["status"] == "envoye" or row["reviewed"] or row["status"] != "failed":
                raise HTTPException(409, "Seule une analyse échouée non validée peut être relancée.")
            conn.execute(text("UPDATE msb_pdf_imports SET status='processing',error=NULL WHERE report_id=:id"), {"id": report_id})
        background.add_task(process, str(report_id))
        with core.connection() as conn:
            return public(get_import(conn, report_id))

    @router.put("/reports/{report_id}/import-review")
    def review(report_id: uuid.UUID, body: Review, actor=actor_dep):
        manager(actor)
        required = [body.object, body.context, *body.findings, *body.workDone, *body.conclusion,
                    *[p.groupTitle for p in body.photos if not p.deleted]]
        with core.database().begin() as conn:
            report = core.assert_report_access(conn, str(report_id), actor)
            row = get_import(conn, report_id)
            if row["status"] == "processing" or report["status"] == "envoye":
                raise HTTPException(409, "Le dossier est en cours d’analyse ou verrouillé.")
            banned = names(conn)
            issues = text_issues("\n".join(required + [body.tenant or "", *[p.caption or "" for p in body.photos if not p.deleted]]), banned)
            if issues:
                raise HTTPException(409, "Contenu à effacer : " + " ; ".join(issues))
            if not conn.execute(text("SELECT 1 FROM msb_sites WHERE id=:id AND active=true"), {"id": body.siteId}).first():
                raise HTTPException(400, "Site actif requis")
            zone = conn.execute(text("SELECT id FROM msb_report_zones WHERE report_id=:id ORDER BY \"order\" LIMIT 1"), {"id": report_id}).scalar()
            if not zone:
                zone = conn.execute(text("INSERT INTO msb_report_zones(report_id,name) VALUES (:id,'Intervention') RETURNING id"), {"id": report_id}).scalar_one()
            existing = set(conn.execute(text("SELECT p.id FROM msb_report_photos p JOIN msb_report_zones z ON z.id=p.zone_id WHERE z.report_id=:id"), {"id": report_id}).scalars())
            submitted = {p.id for p in body.photos}
            if len(submitted) != len(body.photos) or submitted != existing:
                raise HTTPException(409, "La liste des photos a changé : rechargez le contrôle.")
            for photo in body.photos:
                if photo.deleted:
                    conn.execute(text("DELETE FROM msb_report_photos WHERE id=:id"), {"id": photo.id})
                else:
                    conn.execute(text('UPDATE msb_report_photos SET group_title=:group,caption=:caption,"order"=:ord WHERE id=:id'),
                                 {"id": photo.id, "group": photo.groupTitle.strip(), "caption": photo.caption, "ord": photo.order})
            conn.execute(text("""UPDATE msb_reports SET site_id=:site,intervention_date=:date,object=:object,tenant=:tenant,
                intervention_state=:state,conclusion=CAST(:conclusion AS jsonb),fiche=CAST(:fiche AS jsonb),updated_at=now() WHERE id=:id"""),
                {"id": report_id, "site": body.siteId, "date": body.dates[0] if body.dates else report["intervention_date"], "object": body.object.strip(), "tenant": body.tenant,
                 "state": body.interventionState, "conclusion": json.dumps(body.conclusion),
                 "fiche": json.dumps({"interventionDates": [d.isoformat() for d in body.dates], "importDateMissing": not body.dates})})
            conn.execute(text("UPDATE msb_report_zones SET context=:context,findings=CAST(:findings AS jsonb),work_done=CAST(:work AS jsonb) WHERE id=:id"),
                         {"id": zone, "context": body.context, "findings": json.dumps(body.findings), "work": json.dumps(body.workDone)})
            conn.execute(text("UPDATE msb_pdf_imports SET reviewed=:reviewed,missing=CAST(:missing AS jsonb),updated_at=now() WHERE report_id=:id"),
                         {"id": report_id, "reviewed": body.reviewed, "missing": json.dumps([] if body.reviewed else ["Relecture à confirmer"])})
            return public(get_import(conn, report_id))

    app.include_router(router)


def initialize_imports(core):
    with core.database().begin() as conn:
        conn.execute(text("INSERT INTO msb_erased_names(name,changed_by) VALUES ('SRP','initial-settings') ON CONFLICT(name) DO NOTHING"))
        conn.execute(text("""UPDATE msb_pdf_imports SET status='failed',error='Analyse interrompue par un redémarrage. Relancez la lecture.',updated_at=now()
            WHERE status='processing'"""))
