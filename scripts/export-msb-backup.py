"""Read-only MSB export. Production input is a CSV from a read-only SQL query.

Run from the workspace root: python scripts/export-msb-backup.py
Never prints credentials or customer records. Does not change the application.
"""
import concurrent.futures
import csv
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import zipfile
from datetime import datetime, timezone
from pathlib import Path

import psycopg

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "generated-artifacts/msb-transfer"
PACKAGE = OUT / "MSB-BAT-transfert"
TABLES = [
    "msb_clients", "msb_erased_names", "msb_pdf_imports",
    "msb_report_photos", "msb_report_status_history", "msb_report_versions",
    "msb_report_zones", "msb_reports", "msb_sites", "msb_user_profiles",
]
EXCLUDED_DIRS = {
    "node_modules", "dist", "__pycache__", ".git", ".cache",
    ".replit-artifact", ".pythonlibs", "generated-artifacts",
}
SECRET_PATTERN = re.compile(
    r"(?:sk-ant-[A-Za-z0-9_-]{20,}|sk_(?:live|test)_[A-Za-z0-9]{20,}"
    r"|gsk_[A-Za-z0-9_-]{24,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)"
)


def save_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")


def export_query(environment):
    names = ",".join("'" + n + "'" for n in TABLES)
    data = ",".join(
        f"'{n}',COALESCE((SELECT jsonb_agg(to_jsonb(t)) FROM public.{n} t),'[]'::jsonb)"
        for n in TABLES
    )
    return f"""
    SELECT jsonb_build_object(
      'schema_version',1,'environment','{environment}','exported_at',now(),
      'tables',jsonb_build_object({data}),
      'columns',(SELECT jsonb_agg(jsonb_build_object(
        'table',c.relname,'name',a.attname,'position',a.attnum,
        'type',format_type(a.atttypid,a.atttypmod),'not_null',a.attnotnull,
        'default',pg_get_expr(d.adbin,d.adrelid)) ORDER BY c.relname,a.attnum)
        FROM pg_class c JOIN pg_namespace ns ON ns.oid=c.relnamespace
        JOIN pg_attribute a ON a.attrelid=c.oid
        LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
        WHERE ns.nspname='public' AND c.relname IN ({names})
        AND a.attnum>0 AND NOT a.attisdropped),
      'constraints',(SELECT jsonb_agg(jsonb_build_object(
        'table',c.relname,'name',co.conname,'type',co.contype,
        'definition',pg_get_constraintdef(co.oid)) ORDER BY co.contype,co.conname)
        FROM pg_constraint co JOIN pg_class c ON c.oid=co.conrelid
        JOIN pg_namespace ns ON ns.oid=c.relnamespace
        WHERE ns.nspname='public' AND c.relname IN ({names})),
      'indexes',(SELECT jsonb_agg(jsonb_build_object(
        'table',t.relname,'name',i.relname,'definition',pg_get_indexdef(i.oid))
        ORDER BY i.relname) FROM pg_index ix
        JOIN pg_class i ON i.oid=ix.indexrelid
        JOIN pg_class t ON t.oid=ix.indrelid
        JOIN pg_namespace ns ON ns.oid=t.relnamespace
        WHERE ns.nspname='public' AND t.relname IN ({names})
        AND NOT EXISTS(SELECT 1 FROM pg_constraint co WHERE co.conindid=i.oid)))
    """


def quote_identifier(value):
    return '"' + value.replace('"', '""') + '"'


def sql_value(value):
    if value is None:
        return "NULL"
    if isinstance(value, bool):
        return "TRUE" if value else "FALSE"
    if isinstance(value, (int, float)):
        return json.dumps(value, allow_nan=False)
    if isinstance(value, (dict, list)):
        value = json.dumps(value, ensure_ascii=False, allow_nan=False)
    return "'" + str(value).replace("'", "''") + "'"


def production_sql(data):
    lines = [
        r"\set ON_ERROR_STOP on", "BEGIN;",
        "SET standard_conforming_strings = on;",
        "SET search_path = public, pg_catalog;",
        "-- Restore only into a NEW EMPTY PostgreSQL database.",
    ]
    for table in TABLES:
        columns = sorted(
            (c for c in data["columns"] if c["table"] == table),
            key=lambda c: c["position"],
        )
        definitions = []
        for column in columns:
            definition = quote_identifier(column["name"]) + " " + column["type"]
            if column["default"] is not None:
                definition += " DEFAULT " + column["default"]
            if column["not_null"]:
                definition += " NOT NULL"
            definitions.append(definition)
        lines.append(
            f"CREATE TABLE public.{quote_identifier(table)} "
            + "(\n  " + ",\n  ".join(definitions) + "\n);"
        )
        keys = [c["name"] for c in columns]
        for row in data["tables"][table]:
            lines.append(
                f"INSERT INTO public.{quote_identifier(table)} "
                + "(" + ",".join(quote_identifier(k) for k in keys) + ") VALUES ("
                + ",".join(sql_value(row[k]) for k in keys) + ");"
            )
    # Add primary/unique keys before foreign keys, after inserting all records.
    for constraint in sorted(data["constraints"] or [], key=lambda c: c["type"] == "f"):
        lines.append(
            f"ALTER TABLE public.{quote_identifier(constraint['table'])} "
            f"ADD CONSTRAINT {quote_identifier(constraint['name'])} "
            + constraint["definition"] + ";"
        )
    for index in data["indexes"] or []:
        lines.append(index["definition"] + ";")
    lines.append("COMMIT;")
    return "\n".join(lines) + "\n"


def copy_sources():
    source = PACKAGE / "code"
    source.mkdir(parents=True, exist_ok=True)
    root_names = [
        "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml",
        "pyproject.toml", "uv.lock", "tsconfig.json", "tsconfig.base.json",
        ".npmrc", ".gitignore", ".replitignore", "replit.md", "main.py",
    ]
    files = [ROOT / name for name in root_names]
    for folder in ("artifacts", "lib", "scripts", "attached_assets"):
        files.extend(p for p in (ROOT / folder).rglob("*") if p.is_file())
    excluded = []
    for path in files:
        rel = path.relative_to(ROOT)
        if path.is_symlink() or any(p in EXCLUDED_DIRS for p in rel.parts):
            continue
        if (
            path.name.startswith(".env") or path.suffix in {".pyc", ".tsbuildinfo"}
            or path.name.casefold().startswith("capture")
        ):
            excluded.append(str(rel))
            continue
        if path.suffix in {".ts", ".tsx", ".js", ".mjs", ".py", ".json", ".txt", ".md", ".yaml"}:
            if SECRET_PATTERN.search(path.read_text(errors="replace")):
                raise RuntimeError(f"Potential embedded credential in {rel}; export stopped.")
        target = source / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(path, target)
    return excluded


def database_exports():
    csv.field_size_limit(20_000_000)
    with (OUT / "staging/production.csv").open(newline="") as f:
        rows = list(csv.reader(f))
    if len(rows) != 2 or len(rows[1]) != 1:
        raise RuntimeError("Invalid production SQL export; refusing incomplete backup.")
    production = json.loads(rows[1][0])
    if set(production["tables"]) != set(TABLES):
        raise RuntimeError("Unexpected production tables.")
    database_dir = PACKAGE / "donnees"
    database_dir.mkdir(parents=True, exist_ok=True)
    save_json(database_dir / "production.json", production)
    (database_dir / "production.sql").write_text(production_sql(production))
    with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
        conn.isolation_level = psycopg.IsolationLevel.REPEATABLE_READ
        conn.read_only = True
        development = conn.execute(export_query("development")).fetchone()[0]
        snapshot = conn.execute("SELECT pg_export_snapshot()").fetchone()[0]
        # PGDATABASE is a database name, not a connection URI. Expand the URI
        # into libpq environment parameters without putting credentials in argv.
        parameters = psycopg.conninfo.conninfo_to_dict(os.environ["DATABASE_URL"])
        env = {**os.environ}
        for parameter, variable in {
            "dbname": "PGDATABASE", "host": "PGHOST", "port": "PGPORT",
            "user": "PGUSER", "password": "PGPASSWORD", "sslmode": "PGSSLMODE",
            "channel_binding": "PGCHANNELBINDING", "options": "PGOPTIONS",
        }.items():
            if parameter in parameters:
                env[variable] = parameters[parameter]
        result = subprocess.run(
            [
                "pg_dump", "--format=plain", "--no-owner", "--no-privileges",
                "--table=public.msb_*", "--snapshot=" + snapshot,
                "--file=" + str(database_dir / "development.sql"),
            ],
            env=env, capture_output=True,
        )
        if result.returncode:
            raise RuntimeError("Development database dump failed (credentials not logged).")
    save_json(database_dir / "development.json", development)
    return {"production": production, "development": development}


def storage_export(databases):
    # Reuse the existing read-only storage client, authenticated by the sidecar.
    sys.path.insert(0, str(ROOT / "artifacts/api-server/python_api"))
    import main
    client = main.gcs()
    roots = [("prive", os.environ.get("PRIVATE_OBJECT_DIR", ""))]
    roots += [
        (f"public_{i + 1}", p.strip())
        for i, p in enumerate(os.environ.get("PUBLIC_OBJECT_SEARCH_PATHS", "").split(","))
        if p.strip()
    ]
    tasks = []
    for namespace, root in roots:
        parts = root.strip("/").split("/", 1)
        if len(parts) != 2:
            raise RuntimeError("Storage configuration is incomplete.")
        prefix = parts[1].rstrip("/") + "/"
        for blob in client.list_blobs(parts[0], prefix=prefix, timeout=30):
            relative = blob.name[len(prefix):]
            if not relative or blob.name.endswith("/"):
                continue  # Empty directory marker, not a customer file.
            if any(p in {"", ".", ".."} for p in relative.split("/")):
                raise RuntimeError("Unsafe storage object path.")
            tasks.append((namespace, relative, blob))

    def download(task):
        namespace, relative, blob = task
        target = PACKAGE / "fichiers" / namespace / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        # Match the listed generation to avoid silently exporting a replacement.
        blob.download_to_filename(
            str(target), timeout=60, if_generation_match=int(blob.generation)
        )
        if target.stat().st_size != int(blob.size):
            raise RuntimeError("Downloaded object size does not match storage.")
        return {
            "namespace": namespace, "relative_path": relative,
            "archive_path": str(target.relative_to(PACKAGE)),
            "object_path": "/objects/" + relative if namespace == "prive" else None,
            "content_type": blob.content_type, "bytes": target.stat().st_size,
            "sha256": hashlib.sha256(target.read_bytes()).hexdigest(),
            "metadata": blob.metadata or {},
        }

    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        objects = sorted(pool.map(download, tasks), key=lambda o: o["archive_path"])
    available = {o["object_path"] for o in objects if o["object_path"]}
    references = {
        environment: sorted({
            row["object_path"] for rows in data["tables"].values() for row in rows
            if row.get("object_path")
        })
        for environment, data in databases.items()
    }
    missing = {
        environment: [path for path in paths if path not in available]
        for environment, paths in references.items()
    }
    save_json(PACKAGE / "donnees/fichiers.json", {
        "objects": objects, "references": references, "missing_references": missing,
    })
    return objects, missing


def main_export():
    if PACKAGE.exists():
        raise RuntimeError("Backup directory already exists; refusing to overwrite it.")
    PACKAGE.mkdir(parents=True)
    excluded = copy_sources()
    databases = database_exports()
    objects, missing = storage_export(databases)
    shutil.copyfile(ROOT / "scripts/msb-transfer-guide.md", PACKAGE / "LIRE-MOI.md")
    shutil.copyfile(ROOT / "scripts/msb-genspark-prompt.md", PACKAGE / "PROMPT-GENSPARK.md")
    summary = {
        "created_at": datetime.now(timezone.utc).isoformat(),
        "tables": {
            env: {name: len(rows) for name, rows in data["tables"].items()}
            for env, data in databases.items()
        },
        "storage_objects": len(objects), "storage_bytes": sum(o["bytes"] for o in objects),
        "missing_references": missing, "excluded_source_files": excluded,
        "secrets_included": False, "clerk_credentials_and_sessions_included": False,
        "production_and_development_separate": True,
    }
    save_json(PACKAGE / "MANIFESTE.json", summary)
    hashes = {
        str(p.relative_to(PACKAGE)): hashlib.sha256(p.read_bytes()).hexdigest()
        for p in sorted(PACKAGE.rglob("*")) if p.is_file()
    }
    save_json(PACKAGE / "CONTROLES-SHA256.json", hashes)
    archive = OUT / "MSB-BAT-application-et-donnees.zip"
    with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
        for path in sorted(PACKAGE.rglob("*")):
            if path.is_file():
                z.write(path, str(path.relative_to(OUT)))
    print(json.dumps({
        "archive": str(archive.relative_to(ROOT)), "bytes": archive.stat().st_size,
        "table_counts": summary["tables"], "storage_objects": len(objects),
        "missing_reference_counts": {k: len(v) for k, v in missing.items()},
    }, ensure_ascii=False))


if __name__ == "__main__":
    main_export()
