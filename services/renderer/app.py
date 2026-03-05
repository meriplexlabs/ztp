"""
ZTP Config Renderer — FastAPI microservice
Renders Jinja2 device configuration templates with provided variables.
Templates are loaded from the filesystem (mounted configs/ dir) or from
the PostgreSQL database (config_templates.content).
"""

import os
import re
import logging
from pathlib import Path
from typing import Any

import psycopg2
import psycopg2.extras
from fastapi import FastAPI, HTTPException, status
from jinja2 import (
    Environment,
    FileSystemLoader,
    StrictUndefined,
    TemplateNotFound,
    TemplateSyntaxError,
    UndefinedError,
)
from pydantic import BaseModel, field_validator

# ─── Logging ──────────────────────────────────────────────────────────────────

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
log = logging.getLogger("renderer")

# ─── Configuration ────────────────────────────────────────────────────────────

TEMPLATE_DIR = os.getenv("TEMPLATE_DIR", "/templates")
POSTGRES_HOST = os.getenv("POSTGRES_HOST", "localhost")
POSTGRES_PORT = int(os.getenv("POSTGRES_PORT", "5432"))
POSTGRES_DB = os.getenv("POSTGRES_DB", "ztp")
POSTGRES_USER = os.getenv("POSTGRES_USER", "ztp")
POSTGRES_PASSWORD = os.getenv("POSTGRES_PASSWORD", "changeme")

# ─── Jinja2 Environment ───────────────────────────────────────────────────────

jinja_env = Environment(
    loader=FileSystemLoader(TEMPLATE_DIR, followlinks=False),
    undefined=StrictUndefined,
    autoescape=False,           # Config files are not HTML
    trim_blocks=True,
    lstrip_blocks=True,
    keep_trailing_newline=True,
)

# ─── DB helper ────────────────────────────────────────────────────────────────

def get_db_conn():
    return psycopg2.connect(
        host=POSTGRES_HOST,
        port=POSTGRES_PORT,
        dbname=POSTGRES_DB,
        user=POSTGRES_USER,
        password=POSTGRES_PASSWORD,
        connect_timeout=5,
    )


def fetch_template_from_db(template_name: str) -> str | None:
    """
    Look up a template in the database by name (or vendor/os_type combo).
    Returns the template content string, or None if not found.
    """
    try:
        conn = get_db_conn()
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                """
                SELECT content, file_path
                FROM config_templates
                WHERE name = %s OR CONCAT(vendor, '/', os_type) = %s
                LIMIT 1
                """,
                (template_name, template_name),
            )
            row = cur.fetchone()
        conn.close()
        if row:
            return row["content"]  # may be None if file-backed
    except Exception as exc:
        log.warning("DB lookup failed for template %r: %s", template_name, exc)
    return None

# ─── FastAPI App ──────────────────────────────────────────────────────────────

app = FastAPI(
    title="ZTP Renderer",
    description="Renders Jinja2 network device config templates",
    version="1.0.0",
)

# ─── Models ───────────────────────────────────────────────────────────────────

SAFE_TEMPLATE_NAME = re.compile(r"^[\w\-/]+$")


class RenderRequest(BaseModel):
    template_name: str
    variables: dict[str, Any] = {}

    @field_validator("template_name")
    @classmethod
    def validate_template_name(cls, v: str) -> str:
        if not SAFE_TEMPLATE_NAME.match(v):
            raise ValueError(
                "template_name may only contain alphanumerics, hyphens, underscores, and forward slashes"
            )
        # Prevent directory traversal
        if ".." in v:
            raise ValueError("template_name must not contain '..'")
        return v


class RenderResponse(BaseModel):
    config: str
    template_name: str


class ValidateRequest(BaseModel):
    content: str
    variables: dict[str, Any] = {}


class ValidateResponse(BaseModel):
    valid: bool
    error: str | None = None
    missing_variables: list[str] = []


class TemplateListItem(BaseModel):
    name: str
    path: str


# ─── Routes ───────────────────────────────────────────────────────────────────

@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/templates", response_model=list[TemplateListItem])
def list_templates():
    """List all .cfg template files available in the template directory."""
    root = Path(TEMPLATE_DIR)
    templates = []
    for path in sorted(root.rglob("*.cfg")):
        rel = path.relative_to(root).as_posix()
        templates.append(TemplateListItem(name=rel.replace(".cfg", ""), path=rel))
    return templates


@app.post("/render", response_model=RenderResponse)
def render_template(req: RenderRequest):
    """
    Render a named template with the provided variables.

    Template resolution order:
    1. File system: <TEMPLATE_DIR>/<template_name>.cfg
    2. Database: config_templates.content where name matches
    """
    # 1. Try filesystem first
    template_path = req.template_name + ".cfg"
    try:
        tmpl = jinja_env.get_template(template_path)
        log.info("Rendering file-backed template: %s", template_path)
    except TemplateNotFound:
        # 2. Fall back to DB
        db_content = fetch_template_from_db(req.template_name)
        if db_content is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Template '{req.template_name}' not found on filesystem or in database",
            )
        try:
            tmpl = jinja_env.from_string(db_content)
            log.info("Rendering DB-backed template: %s", req.template_name)
        except TemplateSyntaxError as exc:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=f"Template syntax error: {exc.message}",
            )

    # Render
    try:
        rendered = tmpl.render(**req.variables)
    except UndefinedError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Template variable error: {exc.message}",
        )
    except Exception as exc:
        log.exception("Unexpected render error for template %s", req.template_name)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Render failed: {exc}",
        )

    return RenderResponse(config=rendered, template_name=req.template_name)


@app.post("/validate", response_model=ValidateResponse)
def validate_template(req: ValidateRequest):
    """
    Validate a template string for syntax errors and identify missing variables.
    """
    try:
        tmpl = jinja_env.from_string(req.content)
    except TemplateSyntaxError as exc:
        return ValidateResponse(valid=False, error=f"Syntax error at line {exc.lineno}: {exc.message}")

    # Try rendering — collect undefined vars
    missing = []
    try:
        tmpl.render(**req.variables)
    except UndefinedError as exc:
        # Extract variable name from error message
        missing.append(str(exc.message))
        return ValidateResponse(valid=False, error=str(exc.message), missing_variables=missing)
    except Exception as exc:
        return ValidateResponse(valid=False, error=str(exc))

    return ValidateResponse(valid=True)
