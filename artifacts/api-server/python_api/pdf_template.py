"""ReportLab template matching the user's CBRE Lognes reference report."""
from __future__ import annotations

import io
import re
from collections import OrderedDict
from datetime import datetime
from pathlib import Path
from typing import Any, Callable
from xml.sax.saxutils import escape

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas
from reportlab.platypus import (
    BaseDocTemplate, Flowable, Frame, Image, PageBreak, PageTemplate,
    Paragraph, Spacer, Table, TableStyle,
)

ASSETS = Path(__file__).resolve().parent / "assets"
RED = colors.HexColor("#B23D4F")
NAVY = colors.HexColor("#1F1B4D")
PINK = colors.HexColor("#FBE9EC")
GREY = colors.HexColor("#6B6B6B")
WIDTH = A4[0] - 112


class SectionBand(Flowable):
    def __init__(self, title: str):
        super().__init__()
        self.title, self.width, self.height = title, WIDTH, 26
        self.keepWithNext = True
        self.spaceAfter = 8

    def draw(self):
        c = self.canv
        c.setFillColor(PINK)
        c.rect(0, 0, self.width, self.height, fill=1, stroke=0)
        c.setStrokeColor(RED)
        c.setLineWidth(2.5)
        c.line(0, 0, 0, self.height)
        c.setFillColor(RED)
        c.setFont("Helvetica-Bold", 11)
        c.drawString(10, 9, self.title)


class StatusBand(Flowable):
    def __init__(self, state: str):
        super().__init__()
        self.state, self.width, self.height = state, WIDTH, 30

    def draw(self):
        c = self.canv
        c.setFillColor(PINK)
        c.setStrokeColor(RED)
        c.setLineWidth(1)
        c.rect(0, 0, self.width, self.height, fill=1, stroke=1)
        c.setFillColor(RED)
        c.setFont("MSBStatusBold", 11)
        c.drawString(10, 10, "✓ INTERVENTION RÉALISÉE" if self.state == "realisee" else "EN COURS")


class InformationTable(Table):
    def draw(self):
        super().draw()
        self.canv.setStrokeColor(colors.HexColor("#CCCCCC"))
        self.canv.setLineWidth(0.5)
        y = self._height
        for height in self._rowHeights[:-1]:
            y -= height
            self.canv.line(0, y + 6, self._width, y + 6)


class NumberedCanvas(canvas.Canvas):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.pages = []

    def showPage(self):
        self.pages.append(dict(self.__dict__))
        self._startPage()

    def save(self):
        count = len(self.pages)
        for state in self.pages:
            self.__dict__.update(state)
            self.setStrokeColor(colors.HexColor("#CCCCCC"))
            self.setLineWidth(0.5)
            self.line(56, 44, A4[0] - 56, 44)
            self.setFont("Helvetica", 8)
            self.setFillColor(GREY)
            self.drawString(56, 36, f"MSB BAT  •  Document confidentiel — © {datetime.now().year}")
            self.drawRightString(A4[0] - 56, 36, f"Page {self._pageNumber} / {count}")
            super().showPage()
        super().save()


def build_report_pdf(
    report: dict[str, Any],
    zones: list[dict[str, Any]],
    load_photo: Callable[[str], bytes],
) -> bytes:
    if "MSBStatusBold" not in pdfmetrics.getRegisteredFontNames():
        pdfmetrics.registerFont(TTFont("MSBStatusBold", str(ASSETS / "DejaVuSans-Bold.ttf")))
    buffer = io.BytesIO()
    doc = BaseDocTemplate(
        buffer, pagesize=A4, leftMargin=56, rightMargin=56,
        topMargin=40, bottomMargin=60,
        title=f"Rapport d’intervention — {report['object']}", author="MSB BAT",
    )

    def first_page(c, _doc):
        c.drawImage(str(ASSETS / "msb-logo.png"), 65.4757, A4[1] - 108, width=43.0486, height=66, mask="auto")
        c.setFillColor(RED)
        c.setFont("Helvetica-Bold", 22)
        c.drawString(132, A4[1] - 64, "RAPPORT D'INTERVENTION")

    first_frame = Frame(56, 60, WIDTH, A4[1] - 205, leftPadding=0, rightPadding=0, topPadding=0, bottomPadding=0)
    later_frame = Frame(56, 60, WIDTH, A4[1] - 100, leftPadding=0, rightPadding=0, topPadding=0, bottomPadding=0)
    doc.addPageTemplates([
        PageTemplate(id="First", frames=[first_frame], onPage=first_page, autoNextPageTemplate="Later"),
        PageTemplate(id="Later", frames=[later_frame]),
    ])
    body = ParagraphStyle("MSBBody", fontName="Helvetica", fontSize=9.5, leading=13.6, textColor=colors.HexColor("#222222"), leftIndent=6, spaceAfter=6)
    label = ParagraphStyle("MSBLabel", parent=body, fontName="Helvetica-Bold", textColor=NAVY, leftIndent=0, leading=14.6, spaceAfter=4)
    sub = ParagraphStyle("MSBSubheading", parent=label, fontSize=10.5, leading=14, leftIndent=6, spaceBefore=12, spaceAfter=6, keepWithNext=True)
    context_heading = ParagraphStyle("MSBContextHeading", parent=sub, spaceBefore=16)
    photo_heading = ParagraphStyle("MSBPhotoHeading", parent=sub, spaceBefore=20)
    bullet = ParagraphStyle("MSBBullet", parent=body, leftIndent=20, rightIndent=14, firstLineIndent=0, spaceAfter=4)
    caption_style = ParagraphStyle("MSBPhotoCaption", parent=body, fontSize=8, leading=11, leftIndent=0)

    def paragraph(value, style=body):
        return Paragraph(escape(clean(value)).replace("\n", "<br/>"), style)

    def clean(value):
        # Missing information remains missing; never print extraction markers
        # or substitute a made-up observation.
        return re.sub(r"\[\s*À COMPLÉTER\s*\]", "", str(value or ""), flags=re.IGNORECASE).strip()

    def bullets(values):
        return [Paragraph("•&#160;&#160;" + escape(clean(item)), bullet) for item in values if clean(item)]

    story: list[Any] = [SectionBand("1. INFORMATIONS GÉNÉRALES")]
    dates = (report.get("fiche") or {}).get("interventionDates", [])
    date_label = ", ".join(datetime.strptime(d, "%Y-%m-%d").strftime("%d/%m/%Y") for d in dates) if dates else report["intervention_date"].strftime("%d/%m/%Y")
    if (report.get("fiche") or {}).get("importDateMissing") and not dates:
        date_label = "Non renseignée"
    info = [
        ["Client", report["client_name"]],
        ["Site / Adresse", report["address"]],
        ["Date(s) d’intervention", date_label],
        ["Objet de l’intervention", clean(report["object"]) or "Non renseigné"],
    ]
    if report.get("tenant") or report.get("site_tenant"):
        info.append(["Locataire", report.get("tenant") or report["site_tenant"]])
    if report.get("work_order"):
        info.append(["N° OT", report["work_order"]])
    table = InformationTable(
        [[paragraph(key, label), paragraph(value, ParagraphStyle("MSBInfoValue", parent=body, leftIndent=0, leading=14.6, spaceAfter=4))] for key, value in info],
        colWidths=[141, WIDTH - 141], minRowHeights=[27] * len(info),
    )
    table.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 0),
        ("TOPPADDING", (0, 0), (-1, -1), 0),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 9.4),
    ]))
    story.extend([
        table, Spacer(1, 10), SectionBand("2. STATUT DE L’INTERVENTION"),
        StatusBand(report.get("intervention_state", "en_cours")),
        Spacer(1, 16), SectionBand("3. DESCRIPTION DE L’INTERVENTION"),
    ])
    many_zones = len(zones) > 1
    if not zones:
        story.extend([
            paragraph("Contexte", context_heading), paragraph("Non renseigné"),
            paragraph("Constats effectués sur place", sub), paragraph("Non renseignés"),
            paragraph("Intervention réalisée", sub), paragraph("Non renseignée"),
        ])
    for zone in zones:
        if many_zones:
            story.append(paragraph(zone["name"], sub))
        story.extend([paragraph("Contexte", context_heading), paragraph(zone.get("context") or "")])
        story.extend([paragraph("Constats effectués sur place", sub), *bullets(zone.get("findings", []))])
        story.extend([paragraph("Intervention réalisée", sub), *bullets(zone.get("workDone", []))])
    story.extend([
        PageBreak(), SectionBand("4. CONCLUSION"),
        *bullets(report.get("conclusion", [])),
        Spacer(1, 12), SectionBand("5. REPORTAGE PHOTOGRAPHIQUE"),
    ])
    groups: OrderedDict[str, list[dict[str, Any]]] = OrderedDict()
    for zone in zones:
        for photo in zone.get("photos", []):
            group = (photo.get("group_title") or zone["name"]).strip()
            groups.setdefault(group, []).append(photo)
    if not groups:
        story.append(paragraph("Aucune photo renseignée."))
    for group_name, photos in groups.items():
        story.append(paragraph(group_name, photo_heading))
        cells = []
        for photo in photos:
            image = Image(io.BytesIO(load_photo(photo["object_path"])), width=150, height=200, kind="proportional")
            image.hAlign = "CENTER"
            cell = [image]
            if photo.get("caption"):
                cell.append(paragraph(photo["caption"], caption_style))
            cells.append(cell)
        rows = [[cells[i], cells[i+1] if i+1 < len(cells) else ""] for i in range(0, len(cells), 2)]
        # Separate rows let the group heading stay with its first two photos,
        # rather than keeping it with an entire multi-page table.
        for row in rows:
            gallery = Table([row], colWidths=[WIDTH / 2 + 4, WIDTH / 2 + 4], hAlign="CENTER")
            gallery.setStyle(TableStyle([
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("ALIGN", (0, 0), (-1, -1), "CENTER"),
                ("LEFTPADDING", (0, 0), (-1, -1), 0),
                ("RIGHTPADDING", (0, 0), (-1, -1), 0),
                ("TOPPADDING", (0, 0), (-1, -1), 0),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 12),
            ]))
            story.append(gallery)
    doc.build(story, canvasmaker=NumberedCanvas)
    return buffer.getvalue()
