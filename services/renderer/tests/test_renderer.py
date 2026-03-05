"""
Tests for the ZTP renderer service.
Run with: pytest tests/ -v
"""

import os
import tempfile
import pytest
from fastapi.testclient import TestClient

# Set env before importing app
os.environ["TEMPLATE_DIR"] = tempfile.mkdtemp()
os.environ["POSTGRES_HOST"] = "localhost"

from app import app  # noqa: E402

client = TestClient(app)


def make_template(name: str, content: str):
    """Write a test template file to the temp template directory."""
    template_dir = os.environ["TEMPLATE_DIR"]
    path = os.path.join(template_dir, name + ".cfg")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        f.write(content)


def test_health():
    resp = client.get("/health")
    assert resp.status_code == 200
    assert resp.json()["status"] == "ok"


def test_render_simple_template():
    make_template("test/simple", "hostname {{ hostname }}\ndomain {{ domain }}\n")
    resp = client.post("/render", json={
        "template_name": "test/simple",
        "variables": {"hostname": "sw-core-01", "domain": "lab.local"}
    })
    assert resp.status_code == 200
    data = resp.json()
    assert "hostname sw-core-01" in data["config"]
    assert "domain lab.local" in data["config"]


def test_render_missing_variable():
    make_template("test/missing_var", "hostname {{ hostname }}\n")
    resp = client.post("/render", json={
        "template_name": "test/missing_var",
        "variables": {}
    })
    assert resp.status_code == 422


def test_render_template_not_found():
    resp = client.post("/render", json={
        "template_name": "nonexistent/template",
        "variables": {}
    })
    assert resp.status_code == 404


def test_template_name_traversal_rejected():
    resp = client.post("/render", json={
        "template_name": "../etc/passwd",
        "variables": {}
    })
    assert resp.status_code == 422


def test_validate_valid_template():
    resp = client.post("/validate", json={
        "content": "hostname {{ hostname }}",
        "variables": {"hostname": "sw-01"}
    })
    assert resp.status_code == 200
    assert resp.json()["valid"] is True


def test_validate_syntax_error():
    resp = client.post("/validate", json={
        "content": "hostname {{ hostname }",  # missing closing }}
        "variables": {}
    })
    assert resp.status_code == 200
    assert resp.json()["valid"] is False


def test_list_templates():
    make_template("cisco/ios", "hostname {{ hostname }}\n")
    resp = client.get("/templates")
    assert resp.status_code == 200
    names = [t["name"] for t in resp.json()]
    assert "cisco/ios" in names
