#!/usr/bin/env python3
"""
pyIPAM – lightweight IP address management (inspired by phpIPAM)

Flask + SQLite, local users, CSV/Excel export, host map with quick-add.
Development:   python app.py run
Production:    gunicorn -w 2 --threads 4 --preload -b 127.0.0.1:8088 app:app
"""

VERSION = "1.0.0"

import argparse
import bisect
import csv
import datetime
import getpass
import io
import ipaddress
import json
import os
import re
import secrets
import shutil
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor, wait
from functools import wraps

from flask import Flask, Response, g, jsonify, request, send_file, send_from_directory, session
from flask.sessions import SecureCookieSessionInterface
from werkzeug.exceptions import HTTPException
from werkzeug.middleware.proxy_fix import ProxyFix
from werkzeug.security import check_password_hash, generate_password_hash

try:
    import openpyxl
    from openpyxl.styles import Alignment, Font, PatternFill
    from openpyxl.utils import get_column_letter
    from openpyxl.worksheet.table import Table, TableStyleInfo

    HAVE_XLSX = True
except ImportError:  # Excel export is optional
    HAVE_XLSX = False

# --------------------------------------------------------------------------- Configuration

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(BASE_DIR, "static")
DATA_DIR = os.environ.get("IPAM_DATA_DIR", os.path.join(BASE_DIR, "data"))
DB_PATH = os.path.join(DATA_DIR, "ipam.db")
BACKUP_DIR = os.path.join(DATA_DIR, "backups")

# CLI started as root (e.g. "docker exec" or "sudo"): run as the owner of the data directory,
# so files created now stay writable for the service user.
if __name__ == "__main__" and hasattr(os, "geteuid") and os.geteuid() == 0 and os.path.isdir(DATA_DIR):
    _st = os.stat(DATA_DIR)
    if _st.st_uid != 0:
        os.setgroups([])
        os.setgid(_st.st_gid)
        os.setuid(_st.st_uid)
BACKUP_KEEP = int(os.environ.get("IPAM_BACKUP_KEEP", "14"))
SESSION_HOURS = int(os.environ.get("IPAM_SESSION_HOURS", "12"))
COOKIE_SECURE = os.environ.get("IPAM_COOKIE_SECURE", "auto").lower()  # auto | true | false
TRUSTED_PROXIES = int(os.environ.get("IPAM_TRUSTED_PROXIES", "1"))

MAP_MAX = 4096   # host map up to /20 (IPv4)
SCAN_MAX = 1024  # ping scan up to /22 (IPv4)

STATUSES = {"active": "Aktiv", "reserved": "Reserviert", "dhcp": "DHCP", "offline": "Offline"}
STATUS_ALIASES = {
    "active": "active", "aktiv": "active", "used": "active", "belegt": "active", "online": "active", "in use": "active",
    "reserved": "reserved", "reserviert": "reserved",
    "dhcp": "dhcp", "dhcp-pool": "dhcp",
    "offline": "offline", "inaktiv": "offline", "inactive": "offline",
}
ROLES = {"viewer": 1, "editor": 2, "admin": 3}
USERNAME_RE = re.compile(r"^[A-Za-z0-9._@-]{2,64}$")

SCHEMA = """
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'admin',
  session_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT, last_login TEXT
);
CREATE TABLE IF NOT EXISTS sections(
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  sort INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS vlans(
  id INTEGER PRIMARY KEY,
  number INTEGER NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS subnets(
  id INTEGER PRIMARY KEY,
  section_id INTEGER NOT NULL REFERENCES sections(id) ON DELETE RESTRICT,
  cidr TEXT NOT NULL,
  version INTEGER NOT NULL,
  prefix INTEGER NOT NULL,
  start_key TEXT NOT NULL,
  end_key TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  vlan_id INTEGER REFERENCES vlans(id) ON DELETE SET NULL,
  gateway TEXT NOT NULL DEFAULT '',
  dns TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '',
  created_at TEXT, updated_at TEXT
);
CREATE TABLE IF NOT EXISTS addresses(
  id INTEGER PRIMARY KEY,
  subnet_id INTEGER NOT NULL REFERENCES subnets(id) ON DELETE CASCADE,
  ip TEXT NOT NULL,
  ip_key TEXT NOT NULL,
  hostname TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  mac TEXT NOT NULL DEFAULT '',
  owner TEXT NOT NULL DEFAULT '',
  device_type TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  note TEXT NOT NULL DEFAULT '',
  last_seen TEXT,
  created_at TEXT, updated_at TEXT, updated_by TEXT,
  UNIQUE(subnet_id, ip)
);
CREATE INDEX IF NOT EXISTS idx_addresses_key ON addresses(ip_key);
CREATE INDEX IF NOT EXISTS idx_addresses_subnet ON addresses(subnet_id);
CREATE TABLE IF NOT EXISTS scans(
  subnet_id INTEGER PRIMARY KEY REFERENCES subnets(id) ON DELETE CASCADE,
  ts TEXT, alive TEXT
);
CREATE TABLE IF NOT EXISTS changelog(
  id INTEGER PRIMARY KEY, ts TEXT, username TEXT, action TEXT,
  object_type TEXT, object_id INTEGER, summary TEXT
);
CREATE TABLE IF NOT EXISTS login_attempts(
  id INTEGER PRIMARY KEY, ts REAL, remote TEXT, username TEXT, ok INTEGER
);
"""


# --------------------------------------------------------------------------- Database

def connect():
    con = sqlite3.connect(DB_PATH, timeout=15)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys=ON")
    return con


def init_db():
    os.makedirs(DATA_DIR, exist_ok=True)
    con = connect()
    con.execute("PRAGMA journal_mode=WAL")
    con.executescript(SCHEMA)
    if not con.execute("SELECT 1 FROM sections LIMIT 1").fetchone():
        con.execute("INSERT INTO sections(name, description, sort) VALUES('Standard', '', 0)")
    con.commit()
    con.close()


def db():
    if "db" not in g:
        g.db = connect()
    return g.db


def load_secret():
    env = os.environ.get("IPAM_SECRET_KEY")
    if env:
        return env
    os.makedirs(DATA_DIR, exist_ok=True)
    path = os.path.join(DATA_DIR, "secret_key")
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as f:
            f.write(secrets.token_hex(32))
    except FileExistsError:
        pass
    with open(path) as f:
        return f.read().strip()


def make_backup(force_name=None, auto=False):
    """Online SQLite backup into data/backups. Returns the file path."""
    os.makedirs(BACKUP_DIR, exist_ok=True)
    name = force_name or f"ipam-{datetime.date.today().isoformat()}.db"
    dst = os.path.join(BACKUP_DIR, name)
    if auto and os.path.exists(dst):
        return dst
    tmp = f"{dst}.tmp{os.getpid()}"
    src = connect()
    out = sqlite3.connect(tmp)
    src.backup(out)
    out.close()
    src.close()
    os.replace(tmp, dst)
    if auto and BACKUP_KEEP > 0:
        files = sorted(f for f in os.listdir(BACKUP_DIR) if re.match(r"^ipam-\d{4}-\d{2}-\d{2}\.db$", f))
        for old in files[:-BACKUP_KEEP]:
            try:
                os.remove(os.path.join(BACKUP_DIR, old))
            except OSError:
                pass
    return dst


# --------------------------------------------------------------------------- App

class AutoSecureSession(SecureCookieSessionInterface):
    def get_cookie_secure(self, app):
        if COOKIE_SECURE in ("1", "true", "yes"):
            return True
        if COOKIE_SECURE in ("0", "false", "no"):
            return False
        try:
            return request.is_secure
        except RuntimeError:
            return False


app = Flask(__name__, static_folder=STATIC_DIR, static_url_path="/static")
app.session_interface = AutoSecureSession()
app.config.update(
    SESSION_COOKIE_NAME="ipam_session",
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    PERMANENT_SESSION_LIFETIME=datetime.timedelta(hours=SESSION_HOURS),
    MAX_CONTENT_LENGTH=20 * 1024 * 1024,
    JSON_SORT_KEYS=False,
)
if TRUSTED_PROXIES > 0:
    app.wsgi_app = ProxyFix(app.wsgi_app, x_for=TRUSTED_PROXIES, x_proto=TRUSTED_PROXIES,
                            x_host=TRUSTED_PROXIES, x_prefix=TRUSTED_PROXIES)

init_db()
app.secret_key = load_secret()

DUMMY_HASH = generate_password_hash("timing-dummy-password")


class ApiError(Exception):
    def __init__(self, msg, status=400):
        super().__init__(msg)
        self.msg = msg
        self.status = status


@app.errorhandler(ApiError)
def _api_error(e):
    return jsonify(error=e.msg), e.status


@app.errorhandler(HTTPException)
def _http_error(e):
    if request.path.startswith("/api/"):
        return jsonify(error=e.description or e.name), e.code
    return e


@app.errorhandler(Exception)
def _any_error(e):
    app.logger.exception("Unerwarteter Fehler")
    return jsonify(error="Interner Fehler – siehe Server-Log"), 500


@app.teardown_appcontext
def _close_db(exc):
    con = g.pop("db", None)
    if con is not None:
        con.close()


_last_backup_check = 0.0


@app.before_request
def _before():
    global _last_backup_check
    if request.path.startswith("/api/") and request.method not in ("GET", "HEAD", "OPTIONS"):
        token = request.headers.get("X-CSRF-Token", "")
        if not token or not secrets.compare_digest(token, session.get("csrf", "")):
            raise ApiError("Sitzung abgelaufen oder CSRF-Token ungültig – bitte Seite neu laden.", 403)
    if BACKUP_KEEP > 0 and time.time() - _last_backup_check > 3600:
        _last_backup_check = time.time()
        try:
            make_backup(auto=True)
        except Exception as ex:  # a failed backup must never block requests
            app.logger.warning("Automatisches Backup fehlgeschlagen: %s", ex)


@app.after_request
def _headers(resp):
    resp.headers.setdefault("X-Content-Type-Options", "nosniff")
    resp.headers.setdefault("X-Frame-Options", "DENY")
    resp.headers.setdefault("Referrer-Policy", "same-origin")
    resp.headers.setdefault(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
        "img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    )
    if request.path.startswith("/api/"):
        resp.headers["Cache-Control"] = "no-store"
    return resp


# --------------------------------------------------------------------------- Helpers

def now():
    return datetime.datetime.now().astimezone().isoformat(timespec="seconds")


def ip_key(ip):
    return f"{ip.version}:{int(ip):032x}"


def body():
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        raise ApiError("Ungültige Anfrage (JSON erwartet)")
    return data


def field(data, key, maxlen=255, label=None):
    v = data.get(key, "")
    v = "" if v is None else str(v).strip()
    if len(v) > maxlen:
        raise ApiError(f"Feld „{label or key}“ ist zu lang (max. {maxlen} Zeichen)")
    return v


def int_or_none(v):
    if v in (None, "", "null"):
        return None
    try:
        return int(v)
    except (TypeError, ValueError):
        raise ApiError("Ungültige Zahl")


def parse_ip(v):
    try:
        return ipaddress.ip_address(str(v or "").strip())
    except ValueError:
        raise ApiError(f"„{v}“ ist keine gültige IP-Adresse")


def norm_mac(v):
    v = (v or "").strip()
    if not v:
        return ""
    hexs = re.sub(r"[^0-9a-fA-F]", "", v)
    if len(hexs) != 12 or re.search(r"[^0-9a-fA-F:\-.\s]", v):
        raise ApiError(f"MAC-Adresse „{v}“ ist ungültig")
    return ":".join(hexs[i:i + 2] for i in range(0, 12, 2)).upper()


def capacity(net):
    n = net.num_addresses
    if net.version == 4 and net.prefixlen <= 30:
        return n - 2
    return n


def is_system_addr(ip, net):
    """Network or broadcast address (IPv4 up to /30)."""
    return net.version == 4 and net.prefixlen <= 30 and ip in (net.network_address, net.broadcast_address)


def log(action, otype, oid, summary):
    u = current_user()
    db().execute(
        "INSERT INTO changelog(ts, username, action, object_type, object_id, summary) VALUES(?,?,?,?,?,?)",
        (now(), u["username"] if u else "system", action, otype, oid, summary[:500]),
    )


def rdns(ip, timeout=3.0):
    ex = ThreadPoolExecutor(1)
    fut = ex.submit(lambda: socket.gethostbyaddr(str(ip))[0])
    ex.shutdown(wait=False)
    try:
        return fut.result(timeout=timeout)
    except Exception:
        return ""


# --------------------------------------------------------------------------- Auth

def current_user():
    if "user" in g:
        return g.user
    g.user = None
    uid = session.get("uid")
    if uid:
        row = db().execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
        if row and row["session_version"] == session.get("sv"):
            g.user = dict(row)
        else:
            session.pop("uid", None)
    return g.user


def public_user(u):
    return {k: u[k] for k in ("id", "username", "role", "created_at", "last_login")}


def require(role="viewer"):
    def deco(fn):
        @wraps(fn)
        def wrapper(*a, **kw):
            u = current_user()
            if not u:
                raise ApiError("Nicht angemeldet", 401)
            if ROLES.get(u["role"], 0) < ROLES[role]:
                raise ApiError("Dafür fehlt dir die Berechtigung", 403)
            return fn(*a, **kw)
        return wrapper
    return deco


def check_password_policy(pw):
    if len(pw) < 8:
        raise ApiError("Passwort muss mindestens 8 Zeichen lang sein")
    if len(pw) > 256:
        raise ApiError("Passwort ist zu lang")


@app.get("/api/session")
def api_session():
    if "csrf" not in session:
        session["csrf"] = secrets.token_urlsafe(32)
    u = current_user()
    setup = db().execute("SELECT COUNT(*) FROM users").fetchone()[0] == 0
    return jsonify(
        user=public_user(u) if u else None,
        csrf=session["csrf"],
        setup_required=setup,
        version=VERSION,
        xlsx=HAVE_XLSX,
        statuses=STATUSES,
        map_max=MAP_MAX,
        scan_max=SCAN_MAX,
    )


def _start_session(row):
    session.clear()
    session.permanent = True
    session["uid"] = row["id"]
    session["sv"] = row["session_version"]
    session["csrf"] = secrets.token_urlsafe(32)
    g.pop("user", None)


@app.post("/api/setup")
def api_setup():
    con = db()
    if con.execute("SELECT COUNT(*) FROM users").fetchone()[0] > 0:
        raise ApiError("Einrichtung wurde bereits abgeschlossen", 409)
    d = body()
    username = field(d, "username", 64)
    pw = str(d.get("password", ""))
    if not USERNAME_RE.match(username):
        raise ApiError("Benutzername: 2–64 Zeichen, erlaubt sind A–Z, 0–9 und . _ @ -")
    check_password_policy(pw)
    con.execute(
        "INSERT INTO users(username, password_hash, role, created_at, last_login) VALUES(?,?,?,?,?)",
        (username, generate_password_hash(pw), "admin", now(), now()),
    )
    row = con.execute("SELECT * FROM users WHERE username=?", (username,)).fetchone()
    _start_session(row)
    log("create", "user", row["id"], f"Erster Admin „{username}“ angelegt")
    con.commit()
    return api_session()


@app.post("/api/login")
def api_login():
    con = db()
    d = body()
    username = field(d, "username", 64)
    pw = str(d.get("password", ""))[:256]
    remote = request.remote_addr or "?"
    fails = con.execute(
        "SELECT COUNT(*) FROM login_attempts WHERE remote=? AND ok=0 AND ts>?", (remote, time.time() - 900)
    ).fetchone()[0]
    if fails >= 10:
        raise ApiError("Zu viele Fehlversuche – bitte 15 Minuten warten.", 429)
    row = con.execute("SELECT * FROM users WHERE username=?", (username,)).fetchone()
    ok = bool(row) and check_password_hash(row["password_hash"], pw)
    if not row:
        check_password_hash(DUMMY_HASH, pw)
    con.execute("INSERT INTO login_attempts(ts, remote, username, ok) VALUES(?,?,?,?)",
                (time.time(), remote, username, int(ok)))
    con.execute("DELETE FROM login_attempts WHERE ts<?", (time.time() - 86400,))
    if not ok:
        con.commit()
        time.sleep(0.4)
        raise ApiError("Benutzername oder Passwort falsch", 401)
    _start_session(row)
    con.execute("UPDATE users SET last_login=? WHERE id=?", (now(), row["id"]))
    con.commit()
    return api_session()


@app.post("/api/logout")
def api_logout():
    session.clear()
    session["csrf"] = secrets.token_urlsafe(32)
    return jsonify(ok=True, csrf=session["csrf"])


@app.post("/api/me/password")
@require("viewer")
def api_me_password():
    d = body()
    u = current_user()
    if not check_password_hash(u["password_hash"], str(d.get("current", ""))):
        raise ApiError("Aktuelles Passwort ist falsch")
    new = str(d.get("new", ""))
    check_password_policy(new)
    con = db()
    con.execute("UPDATE users SET password_hash=?, session_version=session_version+1 WHERE id=?",
                (generate_password_hash(new), u["id"]))
    row = con.execute("SELECT * FROM users WHERE id=?", (u["id"],)).fetchone()
    log("update", "user", u["id"], "Eigenes Passwort geändert")
    con.commit()
    _start_session(row)
    return api_session()


# --------------------------------------------------------------------------- Users (admin)

@app.get("/api/users")
@require("admin")
def api_users():
    rows = db().execute("SELECT * FROM users ORDER BY username").fetchall()
    return jsonify([public_user(dict(r)) for r in rows])


@app.post("/api/users")
@require("admin")
def api_user_create():
    d = body()
    username = field(d, "username", 64)
    role = d.get("role", "editor")
    pw = str(d.get("password", ""))
    if not USERNAME_RE.match(username):
        raise ApiError("Benutzername: 2–64 Zeichen, erlaubt sind A–Z, 0–9 und . _ @ -")
    if role not in ROLES:
        raise ApiError("Ungültige Rolle")
    check_password_policy(pw)
    con = db()
    try:
        cur = con.execute("INSERT INTO users(username, password_hash, role, created_at) VALUES(?,?,?,?)",
                          (username, generate_password_hash(pw), role, now()))
    except sqlite3.IntegrityError:
        raise ApiError("Benutzername existiert bereits")
    log("create", "user", cur.lastrowid, f"Benutzer „{username}“ ({role}) angelegt")
    con.commit()
    return jsonify(ok=True, id=cur.lastrowid)


def _admin_count(con):
    return con.execute("SELECT COUNT(*) FROM users WHERE role='admin'").fetchone()[0]


@app.put("/api/users/<int:uid>")
@require("admin")
def api_user_update(uid):
    con = db()
    row = con.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
    if not row:
        raise ApiError("Benutzer nicht gefunden", 404)
    d = body()
    changes = []
    role = d.get("role")
    if role and role != row["role"]:
        if role not in ROLES:
            raise ApiError("Ungültige Rolle")
        if row["role"] == "admin" and _admin_count(con) <= 1:
            raise ApiError("Der letzte Admin kann nicht herabgestuft werden")
        con.execute("UPDATE users SET role=? WHERE id=?", (role, uid))
        changes.append(f"Rolle → {role}")
    pw = d.get("password")
    if pw:
        check_password_policy(str(pw))
        con.execute("UPDATE users SET password_hash=?, session_version=session_version+1 WHERE id=?",
                    (generate_password_hash(str(pw)), uid))
        changes.append("Passwort zurückgesetzt")
    if changes:
        log("update", "user", uid, f"Benutzer „{row['username']}“: " + ", ".join(changes))
    con.commit()
    if uid == current_user()["id"] and pw:
        _start_session(con.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone())
    return jsonify(ok=True)


@app.delete("/api/users/<int:uid>")
@require("admin")
def api_user_delete(uid):
    con = db()
    row = con.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
    if not row:
        raise ApiError("Benutzer nicht gefunden", 404)
    if uid == current_user()["id"]:
        raise ApiError("Du kannst dich nicht selbst löschen")
    if row["role"] == "admin" and _admin_count(con) <= 1:
        raise ApiError("Der letzte Admin kann nicht gelöscht werden")
    con.execute("DELETE FROM users WHERE id=?", (uid,))
    log("delete", "user", uid, f"Benutzer „{row['username']}“ gelöscht")
    con.commit()
    return jsonify(ok=True)


# --------------------------------------------------------------------------- Sections

@app.get("/api/sections")
@require("viewer")
def api_sections():
    rows = db().execute(
        "SELECT s.*, (SELECT COUNT(*) FROM subnets WHERE section_id=s.id) AS subnet_count "
        "FROM sections s ORDER BY sort, name"
    ).fetchall()
    return jsonify([dict(r) for r in rows])


@app.post("/api/sections")
@require("editor")
def api_section_create():
    d = body()
    name = field(d, "name", 100, "Name")
    if not name:
        raise ApiError("Name fehlt")
    con = db()
    cur = con.execute("INSERT INTO sections(name, description, sort) VALUES(?,?,?)",
                      (name, field(d, "description", 1000), int_or_none(d.get("sort")) or 0))
    log("create", "section", cur.lastrowid, f"Bereich „{name}“ angelegt")
    con.commit()
    return jsonify(ok=True, id=cur.lastrowid)


@app.put("/api/sections/<int:sid>")
@require("editor")
def api_section_update(sid):
    d = body()
    name = field(d, "name", 100, "Name")
    if not name:
        raise ApiError("Name fehlt")
    con = db()
    if not con.execute("SELECT 1 FROM sections WHERE id=?", (sid,)).fetchone():
        raise ApiError("Bereich nicht gefunden", 404)
    con.execute("UPDATE sections SET name=?, description=?, sort=? WHERE id=?",
                (name, field(d, "description", 1000), int_or_none(d.get("sort")) or 0, sid))
    log("update", "section", sid, f"Bereich „{name}“ geändert")
    con.commit()
    return jsonify(ok=True)


@app.delete("/api/sections/<int:sid>")
@require("editor")
def api_section_delete(sid):
    con = db()
    row = con.execute("SELECT * FROM sections WHERE id=?", (sid,)).fetchone()
    if not row:
        raise ApiError("Bereich nicht gefunden", 404)
    if con.execute("SELECT COUNT(*) FROM subnets WHERE section_id=?", (sid,)).fetchone()[0]:
        raise ApiError("Bereich enthält noch Subnetze – bitte zuerst verschieben oder löschen")
    if con.execute("SELECT COUNT(*) FROM sections").fetchone()[0] <= 1:
        raise ApiError("Der letzte Bereich kann nicht gelöscht werden")
    con.execute("DELETE FROM sections WHERE id=?", (sid,))
    log("delete", "section", sid, f"Bereich „{row['name']}“ gelöscht")
    con.commit()
    return jsonify(ok=True)


# --------------------------------------------------------------------------- VLANs

@app.get("/api/vlans")
@require("viewer")
def api_vlans():
    con = db()
    vlans = [dict(r) for r in con.execute("SELECT * FROM vlans ORDER BY number, name")]
    subs = con.execute("SELECT id, cidr, name, vlan_id FROM subnets WHERE vlan_id IS NOT NULL").fetchall()
    for v in vlans:
        v["subnets"] = [{"id": s["id"], "cidr": s["cidr"], "name": s["name"]} for s in subs if s["vlan_id"] == v["id"]]
    return jsonify(vlans)


def _vlan_payload(d):
    number = int_or_none(d.get("number"))
    if number is None or not 1 <= number <= 4094:
        raise ApiError("VLAN-ID muss zwischen 1 und 4094 liegen")
    return number, field(d, "name", 100, "Name"), field(d, "description", 1000, "Beschreibung")


@app.post("/api/vlans")
@require("editor")
def api_vlan_create():
    number, name, desc = _vlan_payload(body())
    con = db()
    cur = con.execute("INSERT INTO vlans(number, name, description) VALUES(?,?,?)", (number, name, desc))
    log("create", "vlan", cur.lastrowid, f"VLAN {number} „{name}“ angelegt")
    con.commit()
    return jsonify(ok=True, id=cur.lastrowid)


@app.put("/api/vlans/<int:vid>")
@require("editor")
def api_vlan_update(vid):
    number, name, desc = _vlan_payload(body())
    con = db()
    if not con.execute("SELECT 1 FROM vlans WHERE id=?", (vid,)).fetchone():
        raise ApiError("VLAN nicht gefunden", 404)
    con.execute("UPDATE vlans SET number=?, name=?, description=? WHERE id=?", (number, name, desc, vid))
    log("update", "vlan", vid, f"VLAN {number} „{name}“ geändert")
    con.commit()
    return jsonify(ok=True)


@app.delete("/api/vlans/<int:vid>")
@require("editor")
def api_vlan_delete(vid):
    con = db()
    row = con.execute("SELECT * FROM vlans WHERE id=?", (vid,)).fetchone()
    if not row:
        raise ApiError("VLAN nicht gefunden", 404)
    con.execute("DELETE FROM vlans WHERE id=?", (vid,))
    log("delete", "vlan", vid, f"VLAN {row['number']} „{row['name']}“ gelöscht")
    con.commit()
    return jsonify(ok=True)


# --------------------------------------------------------------------------- Subnets

def all_subnets(con=None):
    con = con or db()
    rows = [dict(r) for r in con.execute(
        "SELECT s.*, v.number AS vlan_number, v.name AS vlan_name, sec.name AS section_name, sec.sort AS section_sort "
        "FROM subnets s JOIN sections sec ON sec.id=s.section_id LEFT JOIN vlans v ON v.id=s.vlan_id"
    )]
    keys = {}
    for r in con.execute("SELECT s.section_id, a.ip_key FROM addresses a JOIN subnets s ON s.id=a.subnet_id"):
        keys.setdefault(r[0], []).append(r[1])
    for k in keys.values():
        k.sort()
    for s in rows:
        ks = keys.get(s["section_id"], [])
        s["used"] = bisect.bisect_right(ks, s["end_key"]) - bisect.bisect_left(ks, s["start_key"])
        net = ipaddress.ip_network(s["cidr"])
        cap = capacity(net)
        s["capacity"] = str(cap)
        s["usage"] = round(min(100.0, s["used"] * 100.0 / cap), 1) if cap else 0.0
        best = None
        for o in rows:
            if (o["id"] != s["id"] and o["section_id"] == s["section_id"] and o["prefix"] < s["prefix"]
                    and o["start_key"] <= s["start_key"] and o["end_key"] >= s["end_key"]):
                if best is None or o["prefix"] > best["prefix"]:
                    best = o
        s["parent_id"] = best["id"] if best else None
    rows.sort(key=lambda s: (s["section_sort"], s["section_name"].lower(), s["section_id"], s["start_key"], s["prefix"]))
    return rows


def get_subnet(sid, con=None):
    con = con or db()
    row = con.execute(
        "SELECT s.*, v.number AS vlan_number, v.name AS vlan_name, sec.name AS section_name "
        "FROM subnets s JOIN sections sec ON sec.id=s.section_id LEFT JOIN vlans v ON v.id=s.vlan_id WHERE s.id=?",
        (sid,),
    ).fetchone()
    if not row:
        raise ApiError("Subnetz nicht gefunden", 404)
    return dict(row)


def most_specific_subnet(con, section_id, ip):
    k = ip_key(ip)
    row = con.execute(
        "SELECT id FROM subnets WHERE section_id=? AND start_key<=? AND end_key>=? ORDER BY prefix DESC LIMIT 1",
        (section_id, k, k),
    ).fetchone()
    return row["id"] if row else None


def rebalance(con, section_id):
    """Assign every address of a section to its most specific containing subnet."""
    subs = con.execute("SELECT id, start_key, end_key, prefix FROM subnets WHERE section_id=?", (section_id,)).fetchall()
    addrs = con.execute(
        "SELECT a.id, a.ip_key, a.subnet_id FROM addresses a JOIN subnets s ON s.id=a.subnet_id WHERE s.section_id=?",
        (section_id,),
    ).fetchall()
    for a in addrs:
        best = None
        for s in subs:
            if s["start_key"] <= a["ip_key"] <= s["end_key"] and (best is None or s["prefix"] > best["prefix"]):
                best = s
        if best and best["id"] != a["subnet_id"]:
            try:
                con.execute("UPDATE addresses SET subnet_id=? WHERE id=?", (best["id"], a["id"]))
            except sqlite3.IntegrityError:
                pass


def _subnet_payload(con, d, sid=None):
    cidr_in = field(d, "cidr", 64, "Netz")
    try:
        net = ipaddress.ip_network(cidr_in, strict=False)
    except ValueError:
        raise ApiError("Ungültiges Netz – Beispiel: 192.168.10.0/24 oder 2001:db8::/64")
    section_id = int_or_none(d.get("section_id"))
    if not section_id or not con.execute("SELECT 1 FROM sections WHERE id=?", (section_id,)).fetchone():
        raise ApiError("Bitte einen gültigen Bereich wählen")
    vlan_id = int_or_none(d.get("vlan_id"))
    if vlan_id and not con.execute("SELECT 1 FROM vlans WHERE id=?", (vlan_id,)).fetchone():
        raise ApiError("VLAN existiert nicht")
    gateway = field(d, "gateway", 64, "Gateway")
    if gateway:
        gw = parse_ip(gateway)
        if gw not in net or is_system_addr(gw, net):
            raise ApiError(f"Gateway {gw} ist keine nutzbare Adresse in {net}")
        gateway = str(gw)
    dup = con.execute("SELECT id FROM subnets WHERE section_id=? AND cidr=? AND id IS NOT ?",
                      (section_id, str(net), sid)).fetchone()
    if dup:
        raise ApiError(f"{net} existiert in diesem Bereich bereits")
    return {
        "section_id": section_id, "cidr": str(net), "version": net.version, "prefix": net.prefixlen,
        "start_key": ip_key(net.network_address), "end_key": ip_key(net.broadcast_address),
        "name": field(d, "name", 100, "Name"), "description": field(d, "description", 2000, "Beschreibung"),
        "vlan_id": vlan_id, "gateway": gateway, "dns": field(d, "dns", 255, "DNS"),
        "location": field(d, "location", 255, "Standort"),
    }


@app.get("/api/subnets")
@require("viewer")
def api_subnets():
    return jsonify(all_subnets())


@app.post("/api/subnets")
@require("editor")
def api_subnet_create():
    con = db()
    p = _subnet_payload(con, body())
    p["created_at"] = p["updated_at"] = now()
    cols = ", ".join(p)
    cur = con.execute(f"INSERT INTO subnets({cols}) VALUES({', '.join('?' * len(p))})", tuple(p.values()))
    rebalance(con, p["section_id"])
    log("create", "subnet", cur.lastrowid, f"Subnetz {p['cidr']} „{p['name']}“ angelegt")
    con.commit()
    return jsonify(ok=True, id=cur.lastrowid)


@app.put("/api/subnets/<int:sid>")
@require("editor")
def api_subnet_update(sid):
    con = db()
    old = get_subnet(sid, con)
    p = _subnet_payload(con, body(), sid)
    net = ipaddress.ip_network(p["cidr"])
    outside = [r["ip"] for r in con.execute("SELECT ip FROM addresses WHERE subnet_id=?", (sid,))
               if ipaddress.ip_address(r["ip"]) not in net]
    if outside:
        raise ApiError(f"{len(outside)} Adresse(n) lägen außerhalb des neuen Netzes (z. B. {outside[0]})")
    p["updated_at"] = now()
    con.execute(f"UPDATE subnets SET {', '.join(k + '=?' for k in p)} WHERE id=?", (*p.values(), sid))
    rebalance(con, p["section_id"])
    if old["section_id"] != p["section_id"]:
        rebalance(con, old["section_id"])
    log("update", "subnet", sid, f"Subnetz {p['cidr']} „{p['name']}“ geändert")
    con.commit()
    return jsonify(ok=True)


@app.delete("/api/subnets/<int:sid>")
@require("editor")
def api_subnet_delete(sid):
    con = db()
    s = get_subnet(sid, con)
    parent = con.execute(
        "SELECT id FROM subnets WHERE section_id=? AND id<>? AND start_key<=? AND end_key>=? AND prefix<? "
        "ORDER BY prefix DESC LIMIT 1",
        (s["section_id"], sid, s["start_key"], s["end_key"], s["prefix"]),
    ).fetchone()
    count = con.execute("SELECT COUNT(*) FROM addresses WHERE subnet_id=?", (sid,)).fetchone()[0]
    moved = 0
    if parent and count:
        cur = con.execute("UPDATE OR IGNORE addresses SET subnet_id=? WHERE subnet_id=?", (parent["id"], sid))
        moved = cur.rowcount
    con.execute("DELETE FROM subnets WHERE id=?", (sid,))
    msg = f"Subnetz {s['cidr']} „{s['name']}“ gelöscht"
    msg += f" ({moved} Adressen ins übergeordnete Netz verschoben)" if moved else (f" ({count} Adressen gelöscht)" if count else "")
    log("delete", "subnet", sid, msg)
    con.commit()
    return jsonify(ok=True, moved=moved, deleted=count - moved)


def subnet_calc(net):
    info = {
        "network": str(net.network_address),
        "prefix": net.prefixlen,
        "version": net.version,
        "size": str(net.num_addresses),
        "usable": str(capacity(net)),
    }
    if net.version == 4:
        hosts = list(net.hosts()) if net.num_addresses <= 2 else None
        first = hosts[0] if hosts else (net.network_address + (1 if net.prefixlen <= 30 else 0))
        last = hosts[-1] if hosts else (net.broadcast_address - (1 if net.prefixlen <= 30 else 0))
        info.update(
            netmask=str(net.netmask), wildcard=str(net.hostmask),
            broadcast=str(net.broadcast_address) if net.prefixlen <= 30 else "–",
            first=str(first), last=str(last), network_int=int(net.network_address),
        )
    else:
        info.update(first=str(net.network_address + 1), last=str(net.broadcast_address),
                    netmask=f"/{net.prefixlen}", wildcard="–", broadcast="–")
    return info


def addresses_in_range(con, sub):
    return [dict(r) for r in con.execute(
        "SELECT a.*, s.cidr AS subnet_cidr FROM addresses a JOIN subnets s ON s.id=a.subnet_id "
        "WHERE s.section_id=? AND a.ip_key BETWEEN ? AND ? ORDER BY a.ip_key",
        (sub["section_id"], sub["start_key"], sub["end_key"]),
    )]


@app.get("/api/subnets/<int:sid>")
@require("viewer")
def api_subnet_detail(sid):
    con = db()
    subs = all_subnets(con)
    sub = next((s for s in subs if s["id"] == sid), None)
    if not sub:
        raise ApiError("Subnetz nicht gefunden", 404)
    net = ipaddress.ip_network(sub["cidr"])
    scan = con.execute("SELECT ts, alive FROM scans WHERE subnet_id=?", (sid,)).fetchone()
    chain, p = [], sub["parent_id"]
    while p:
        ps = next(s for s in subs if s["id"] == p)
        chain.insert(0, {"id": ps["id"], "cidr": ps["cidr"], "name": ps["name"]})
        p = ps["parent_id"]
    return jsonify(
        subnet=sub,
        calc=subnet_calc(net),
        addresses=addresses_in_range(con, sub),
        children=[s for s in subs if s["parent_id"] == sid],
        parents=chain,
        map_enabled=net.version == 4 and net.num_addresses <= MAP_MAX,
        scan={"ts": scan["ts"], "alive": json.loads(scan["alive"] or "[]")} if scan else None,
        device_types=[r[0] for r in con.execute(
            "SELECT DISTINCT device_type FROM addresses WHERE device_type<>'' ORDER BY device_type LIMIT 200")],
    )


@app.get("/api/subnets/<int:sid>/next-free")
@require("viewer")
def api_next_free(sid):
    con = db()
    sub = get_subnet(sid, con)
    net = ipaddress.ip_network(sub["cidr"])
    used = {r["ip_key"] for r in addresses_in_range(con, sub)}
    gw = sub["gateway"]
    limit = 200000
    for i, h in enumerate(net.hosts()):
        if i > limit:
            break
        if ip_key(h) not in used and str(h) != gw:
            return jsonify(ip=str(h))
    raise ApiError("Keine freie Adresse mehr in diesem Netz", 404)


@app.post("/api/subnets/<int:sid>/scan")
@require("editor")
def api_scan(sid):
    con = db()
    sub = get_subnet(sid, con)
    net = ipaddress.ip_network(sub["cidr"])
    if net.version != 4:
        raise ApiError("Ping-Scan ist nur für IPv4 verfügbar")
    hosts = list(net.hosts())
    if len(hosts) > SCAN_MAX:
        raise ApiError(f"Netz zu groß für einen Scan (max. {SCAN_MAX} Hosts, also /22)")
    ping = shutil.which("ping")
    if not ping:
        raise ApiError("Das Programm „ping“ ist auf dem Server nicht installiert")

    def probe(ip):
        try:
            r = subprocess.run([ping, "-c", "1", "-W", "1", "-n", str(ip)],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=4)
            return r.returncode == 0
        except Exception:
            return False

    with ThreadPoolExecutor(64) as ex:
        results = list(ex.map(probe, hosts))
    alive = [str(ip) for ip, ok in zip(hosts, results) if ok]
    known = {a["ip"]: a for a in addresses_in_range(con, sub)}
    ts = now()
    for ip in alive:
        if ip in known:
            con.execute("UPDATE addresses SET last_seen=? WHERE id=?", (ts, known[ip]["id"]))
    unknown = [ip for ip in alive if ip not in known]
    names = {}
    if unknown:
        ex = ThreadPoolExecutor(32)
        futs = {ex.submit(lambda x: socket.gethostbyaddr(x)[0], ip): ip for ip in unknown[:256]}
        done, _ = wait(futs, timeout=5)
        ex.shutdown(wait=False, cancel_futures=True)
        for f in done:
            try:
                names[futs[f]] = f.result()
            except Exception:
                pass
    payload = [{"ip": ip, "dns": names.get(ip, "")} for ip in alive]
    con.execute("INSERT OR REPLACE INTO scans(subnet_id, ts, alive) VALUES(?,?,?)", (sid, ts, json.dumps(payload)))
    log("scan", "subnet", sid, f"Scan {sub['cidr']}: {len(alive)} online, {len(unknown)} unbekannt")
    con.commit()
    return jsonify(ts=ts, alive=len(alive), unknown=len(unknown), scanned=len(hosts))


@app.get("/api/dns")
@require("viewer")
def api_dns():
    ip = parse_ip(request.args.get("ip"))
    return jsonify(hostname=rdns(ip))


# --------------------------------------------------------------------------- Addresses

def _address_fields(d):
    status = d.get("status") or "active"
    if status not in STATUSES:
        raise ApiError("Ungültiger Status")
    return {
        "hostname": field(d, "hostname", 253, "Hostname"),
        "description": field(d, "description", 1000, "Beschreibung"),
        "mac": norm_mac(field(d, "mac", 64, "MAC")),
        "owner": field(d, "owner", 255, "Besitzer"),
        "device_type": field(d, "device_type", 100, "Gerätetyp"),
        "status": status,
        "note": field(d, "note", 4000, "Notiz"),
    }


def _check_ip_free(con, section_id, ip, exclude_id=None):
    row = con.execute(
        "SELECT a.id, s.cidr FROM addresses a JOIN subnets s ON s.id=a.subnet_id "
        "WHERE s.section_id=? AND a.ip_key=? AND a.id IS NOT ?",
        (section_id, ip_key(ip), exclude_id),
    ).fetchone()
    if row:
        raise ApiError(f"{ip} ist bereits vergeben (Subnetz {row['cidr']})", 409)


def _validate_ip_for_subnet(sub, ip):
    net = ipaddress.ip_network(sub["cidr"])
    if ip.version != net.version or ip not in net:
        raise ApiError(f"{ip} liegt nicht in {net}")
    if is_system_addr(ip, net):
        raise ApiError(f"{ip} ist die {'Netz' if ip == net.network_address else 'Broadcast'}adresse von {net}")


@app.post("/api/addresses")
@require("editor")
def api_address_create():
    con = db()
    d = body()
    sub = get_subnet(int_or_none(d.get("subnet_id")) or 0, con)
    ip = parse_ip(d.get("ip"))
    _validate_ip_for_subnet(sub, ip)
    _check_ip_free(con, sub["section_id"], ip)
    target = most_specific_subnet(con, sub["section_id"], ip) or sub["id"]
    f = _address_fields(d)
    ts = now()
    cur = con.execute(
        "INSERT INTO addresses(subnet_id, ip, ip_key, hostname, description, mac, owner, device_type, status, note, "
        "created_at, updated_at, updated_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (target, str(ip), ip_key(ip), f["hostname"], f["description"], f["mac"], f["owner"], f["device_type"],
         f["status"], f["note"], ts, ts, current_user()["username"]),
    )
    log("create", "address", cur.lastrowid, f"{ip} {f['hostname']}".strip() + " angelegt")
    con.commit()
    return jsonify(ok=True, id=cur.lastrowid, subnet_id=target)


@app.put("/api/addresses/<int:aid>")
@require("editor")
def api_address_update(aid):
    con = db()
    old = con.execute("SELECT * FROM addresses WHERE id=?", (aid,)).fetchone()
    if not old:
        raise ApiError("Adresse nicht gefunden", 404)
    sub = get_subnet(old["subnet_id"], con)
    d = body()
    ip = parse_ip(d.get("ip") or old["ip"])
    target = old["subnet_id"]
    if str(ip) != old["ip"]:
        target = most_specific_subnet(con, sub["section_id"], ip)
        if not target:
            raise ApiError(f"{ip} liegt in keinem Subnetz dieses Bereichs")
        _validate_ip_for_subnet(get_subnet(target, con), ip)
        _check_ip_free(con, sub["section_id"], ip, aid)
    f = _address_fields(d)
    con.execute(
        "UPDATE addresses SET subnet_id=?, ip=?, ip_key=?, hostname=?, description=?, mac=?, owner=?, device_type=?, "
        "status=?, note=?, updated_at=?, updated_by=? WHERE id=?",
        (target, str(ip), ip_key(ip), f["hostname"], f["description"], f["mac"], f["owner"], f["device_type"],
         f["status"], f["note"], now(), current_user()["username"], aid),
    )
    log("update", "address", aid, f"{ip} {f['hostname']}".strip() + " geändert")
    con.commit()
    return jsonify(ok=True)


@app.delete("/api/addresses/<int:aid>")
@require("editor")
def api_address_delete(aid):
    con = db()
    old = con.execute("SELECT * FROM addresses WHERE id=?", (aid,)).fetchone()
    if not old:
        raise ApiError("Adresse nicht gefunden", 404)
    con.execute("DELETE FROM addresses WHERE id=?", (aid,))
    log("delete", "address", aid, f"{old['ip']} {old['hostname']}".strip() + " gelöscht")
    con.commit()
    return jsonify(ok=True)


@app.post("/api/addresses/bulk")
@require("editor")
def api_address_bulk():
    con = db()
    d = body()
    ids = [int(i) for i in (d.get("ids") or []) if str(i).isdigit()][:5000]
    action = d.get("action")
    if not ids:
        raise ApiError("Keine Adressen ausgewählt")
    marks = ",".join("?" * len(ids))
    if action == "delete":
        n = con.execute(f"DELETE FROM addresses WHERE id IN ({marks})", ids).rowcount
        log("delete", "address", None, f"{n} Adressen gelöscht (Mehrfachauswahl)")
    elif action == "status":
        st = d.get("status")
        if st not in STATUSES:
            raise ApiError("Ungültiger Status")
        n = con.execute(f"UPDATE addresses SET status=?, updated_at=?, updated_by=? WHERE id IN ({marks})",
                        (st, now(), current_user()["username"], *ids)).rowcount
        log("update", "address", None, f"{n} Adressen auf „{STATUSES[st]}“ gesetzt")
    else:
        raise ApiError("Unbekannte Aktion")
    con.commit()
    return jsonify(ok=True, count=n)


# --------------------------------------------------------------------------- Import

IMPORT_ALIASES = {
    "ip": {"ip", "ip-adresse", "ipadresse", "ip adresse", "ip address", "ip_addr", "ipaddress", "address", "adresse"},
    "hostname": {"hostname", "host", "dns name", "dns", "fqdn", "name"},
    "description": {"description", "beschreibung", "desc", "bezeichnung"},
    "mac": {"mac", "mac-adresse", "mac address", "macaddress", "mac adresse"},
    "owner": {"owner", "besitzer", "verantwortlich"},
    "device_type": {"device_type", "device", "gerätetyp", "geraetetyp", "device type", "typ", "type"},
    "status": {"status", "state", "tag", "zustand"},
    "note": {"note", "notiz", "notes", "comment", "kommentar", "bemerkung"},
}


@app.post("/api/subnets/<int:sid>/import")
@require("editor")
def api_import(sid):
    con = db()
    sub = get_subnet(sid, con)
    d = body()
    text = str(d.get("csv") or "")
    update = bool(d.get("update"))
    text = text.lstrip("\ufeff")
    lines = text.splitlines()
    if lines and lines[0].lower().startswith("sep="):
        lines = lines[1:]
    if not lines:
        raise ApiError("Die Datei ist leer")
    sample = "\n".join(lines[:5])
    try:
        dialect = csv.Sniffer().sniff(sample, delimiters=";,\t|")
        delim = dialect.delimiter
    except csv.Error:
        delim = ";" if sample.count(";") >= sample.count(",") else ","
    reader = csv.reader(lines, delimiter=delim)
    header = [h.strip().lower() for h in next(reader)]
    colmap = {}
    for idx, h in enumerate(header):
        for key, aliases in IMPORT_ALIASES.items():
            if h in aliases and key not in colmap:
                colmap[key] = idx
    if "ip" not in colmap:
        raise ApiError("Keine IP-Spalte gefunden (erwartet z. B. „IP-Adresse“ oder „ip“)")
    created = updated = skipped = 0
    errors = []
    user = current_user()["username"]
    for lineno, row in enumerate(reader, start=2):
        if not any(c.strip() for c in row):
            continue

        def col(k):
            i = colmap.get(k)
            v = row[i].strip() if i is not None and i < len(row) else ""
            return v[1:] if v.startswith("'") and len(v) > 1 and v[1] in "=+-@" else v
        try:
            raw_status = col("status").lower()
            if raw_status in ("frei", "free"):
                skipped += 1
                continue
            ip = parse_ip(col("ip"))
            _validate_ip_for_subnet(sub, ip)
            payload = {k: col(k) for k in IMPORT_ALIASES if k != "ip"}
            payload["status"] = STATUS_ALIASES.get(raw_status, "active") if raw_status else "active"
            f = _address_fields(payload)
            existing = con.execute(
                "SELECT a.id FROM addresses a JOIN subnets s ON s.id=a.subnet_id WHERE s.section_id=? AND a.ip_key=?",
                (sub["section_id"], ip_key(ip)),
            ).fetchone()
            ts = now()
            if existing:
                if not update:
                    skipped += 1
                    continue
                con.execute(
                    "UPDATE addresses SET hostname=?, description=?, mac=?, owner=?, device_type=?, status=?, note=?, "
                    "updated_at=?, updated_by=? WHERE id=?",
                    (f["hostname"], f["description"], f["mac"], f["owner"], f["device_type"], f["status"], f["note"],
                     ts, user, existing["id"]),
                )
                updated += 1
            else:
                target = most_specific_subnet(con, sub["section_id"], ip) or sid
                con.execute(
                    "INSERT INTO addresses(subnet_id, ip, ip_key, hostname, description, mac, owner, device_type, "
                    "status, note, created_at, updated_at, updated_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    (target, str(ip), ip_key(ip), f["hostname"], f["description"], f["mac"], f["owner"],
                     f["device_type"], f["status"], f["note"], ts, ts, user),
                )
                created += 1
        except ApiError as e:
            if len(errors) < 50:
                errors.append(f"Zeile {lineno}: {e.msg}")
    log("import", "subnet", sid, f"Import {sub['cidr']}: {created} neu, {updated} aktualisiert, {skipped} übersprungen")
    con.commit()
    return jsonify(created=created, updated=updated, skipped=skipped, errors=errors)


# --------------------------------------------------------------------------- Search & dashboard

@app.get("/api/search")
@require("viewer")
def api_search():
    q = (request.args.get("q") or "").strip()[:100]
    if len(q) < 2:
        return jsonify(subnets=[], addresses=[], vlans=[])
    con = db()
    like = f"%{q}%"
    hexq = re.sub(r"[^0-9a-fA-F]", "", q)
    mac_like = f"%{hexq.upper()}%" if len(hexq) >= 4 and re.fullmatch(r"[0-9a-fA-F:\-.]+", q) else None
    addrs = [dict(r) for r in con.execute(
        "SELECT a.*, s.cidr AS subnet_cidr, s.name AS subnet_name FROM addresses a JOIN subnets s ON s.id=a.subnet_id "
        "WHERE a.ip LIKE ? OR a.hostname LIKE ? OR a.description LIKE ? OR a.mac LIKE ? OR a.owner LIKE ? "
        "OR a.note LIKE ? OR a.device_type LIKE ? OR (? IS NOT NULL AND REPLACE(a.mac, ':', '') LIKE ?) "
        "ORDER BY a.ip_key LIMIT 100",
        (like, like, like, like, like, like, like, mac_like, mac_like),
    )]
    subs = all_subnets(con)
    ql = q.lower()
    hits = [s for s in subs if ql in s["cidr"].lower() or ql in (s["name"] or "").lower()
            or ql in (s["description"] or "").lower() or ql in (s["location"] or "").lower()]
    try:  # query is an IP → also list containing subnets
        ip = ipaddress.ip_address(q)
        k = ip_key(ip)
        hits += [s for s in subs if s["start_key"] <= k <= s["end_key"] and s not in hits]
    except ValueError:
        pass
    vlans = [dict(r) for r in con.execute(
        "SELECT * FROM vlans WHERE CAST(number AS TEXT)=? OR name LIKE ? OR description LIKE ? ORDER BY number LIMIT 30",
        (q, like, like),
    )]
    return jsonify(subnets=hits[:50], addresses=addrs, vlans=vlans)


@app.get("/api/dashboard")
@require("viewer")
def api_dashboard():
    con = db()
    subs = all_subnets(con)
    status = {k: 0 for k in STATUSES}
    for r in con.execute("SELECT status, COUNT(*) FROM addresses GROUP BY status"):
        status[r[0]] = r[1]
    v4 = [s for s in subs if s["version"] == 4]
    leaf_v4 = [s for s in v4 if not any(c["parent_id"] == s["id"] for c in subs)]
    total_cap = sum(int(s["capacity"]) for s in leaf_v4)
    total_used = sum(s["used"] for s in leaf_v4)
    recent = [dict(r) for r in con.execute("SELECT * FROM changelog ORDER BY id DESC LIMIT 12")]
    return jsonify(
        subnet_count=len(subs),
        address_count=sum(status.values()),
        vlan_count=con.execute("SELECT COUNT(*) FROM vlans").fetchone()[0],
        section_count=con.execute("SELECT COUNT(*) FROM sections").fetchone()[0],
        status=status,
        v4_capacity=total_cap,
        v4_used=total_used,
        top=sorted(subs, key=lambda s: -s["usage"])[:8],
        recent=recent,
    )


@app.get("/api/log")
@require("viewer")
def api_log():
    limit = min(int_or_none(request.args.get("limit")) or 100, 1000)
    before = int_or_none(request.args.get("before"))
    q = (request.args.get("q") or "").strip()
    sql, args = "SELECT * FROM changelog WHERE 1=1", []
    if before:
        sql += " AND id<?"
        args.append(before)
    if q:
        sql += " AND (summary LIKE ? OR username LIKE ?)"
        args += [f"%{q}%", f"%{q}%"]
    sql += " ORDER BY id DESC LIMIT ?"
    args.append(limit)
    return jsonify([dict(r) for r in db().execute(sql, args)])


# --------------------------------------------------------------------------- Export

EXPORT_COLS = [
    ("Bereich", "section_name", 14), ("Subnetz", "cidr", 18), ("Subnetzname", "subnet_name", 20),
    ("VLAN", "vlan", 14), ("IP-Adresse", "ip", 16), ("Hostname", "hostname", 24),
    ("Beschreibung", "description", 32), ("MAC-Adresse", "mac", 19), ("Besitzer", "owner", 16),
    ("Gerätetyp", "device_type", 14), ("Status", "status_label", 11), ("Notiz", "note", 30),
    ("Zuletzt online", "last_seen", 20), ("Geändert am", "updated_at", 20), ("Geändert von", "updated_by", 14),
]
STATUS_FILLS = {"Aktiv": "D1FAE5", "Reserviert": "FEF3C7", "DHCP": "DBEAFE", "Offline": "E5E7EB", "frei": None}


def _fmt_ts(v):
    if not v:
        return ""
    try:
        return datetime.datetime.fromisoformat(v).strftime("%d.%m.%Y %H:%M")
    except ValueError:
        return v


def _vlan_label(s):
    if s.get("vlan_number") is None:
        return ""
    return f"{s['vlan_number']}" + (f" – {s['vlan_name']}" if s.get("vlan_name") else "")


def export_rows(con, sub, subs_by_id, own_only, include_free):
    """Export rows for one subnet. own_only: only directly assigned addresses (full export, no duplicates)."""
    net = ipaddress.ip_network(sub["cidr"])
    if own_only:
        addrs = [dict(r) for r in con.execute(
            "SELECT a.*, s.cidr AS subnet_cidr FROM addresses a JOIN subnets s ON s.id=a.subnet_id "
            "WHERE a.subnet_id=? ORDER BY a.ip_key", (sub["id"],))]
    else:
        addrs = addresses_in_range(con, sub)
    rows = []
    for a in addrs:
        owner_sub = subs_by_id.get(a["subnet_id"], sub)
        rows.append({
            "_key": a["ip_key"], "section_name": sub["section_name"], "cidr": owner_sub["cidr"],
            "subnet_name": owner_sub["name"], "vlan": _vlan_label(owner_sub), "ip": a["ip"],
            "hostname": a["hostname"], "description": a["description"], "mac": a["mac"], "owner": a["owner"],
            "device_type": a["device_type"], "status_label": STATUSES.get(a["status"], a["status"]),
            "note": a["note"], "last_seen": _fmt_ts(a["last_seen"]), "updated_at": _fmt_ts(a["updated_at"]),
            "updated_by": a["updated_by"] or "",
        })
    if include_free and net.version == 4 and net.num_addresses <= MAP_MAX:
        used = {r["ip"] for r in rows}
        children = []
        if own_only:
            children = [ipaddress.ip_network(s["cidr"]) for s in subs_by_id.values()
                        if s.get("parent_id") == sub["id"]]
        for h in net.hosts():
            hs = str(h)
            if hs in used or any(h in c for c in children):
                continue
            rows.append({
                "_key": ip_key(h), "section_name": sub["section_name"], "cidr": sub["cidr"],
                "subnet_name": sub["name"], "vlan": _vlan_label(sub), "ip": hs,
                "description": "Gateway (nicht erfasst)" if hs == sub["gateway"] else "", "status_label": "frei",
            })
        rows.sort(key=lambda r: r["_key"])
    return rows


def csv_safe(v):
    v = "" if v is None else str(v)
    return "'" + v if v[:1] in ("=", "+", "-", "@", "\t", "\r") else v


def csv_response(rows, filename):
    sep = "," if request.args.get("sep") == "comma" else ";"
    buf = io.StringIO()
    buf.write("\ufeff")  # BOM so Excel detects UTF-8
    w = csv.writer(buf, delimiter=sep, lineterminator="\r\n")
    w.writerow([c[0] for c in EXPORT_COLS])
    for r in rows:
        w.writerow([csv_safe(r.get(c[1], "")) for c in EXPORT_COLS])
    return Response(buf.getvalue().encode("utf-8"), mimetype="text/csv; charset=utf-8",
                    headers={"Content-Disposition": f'attachment; filename="{filename}"'})


def _safe_name(s):
    return re.sub(r"[^A-Za-z0-9._-]+", "_", s).strip("_")


def _xlsx_write_table(ws, headers, rows, widths, tname, status_col=None):
    ws.append(headers)
    for r in rows:
        ws.append(r)
    head_font = Font(bold=True, color="FFFFFF")
    head_fill = PatternFill("solid", fgColor="312E81")
    for c in ws[1]:
        c.font, c.fill = head_font, head_fill
        c.alignment = Alignment(vertical="center")
    ws.row_dimensions[1].height = 22
    for i, w in enumerate(widths, start=1):
        ws.column_dimensions[get_column_letter(i)].width = w
    ws.freeze_panes = "A2"
    last = f"{get_column_letter(len(headers))}{len(rows) + 1}"
    if rows:
        t = Table(displayName=tname, ref=f"A1:{last}")
        t.tableStyleInfo = TableStyleInfo(name="TableStyleLight9", showRowStripes=True)
        ws.add_table(t)
    else:
        ws.auto_filter.ref = f"A1:{last}"
    if status_col is not None:
        grey = Font(color="9CA3AF")
        for row in ws.iter_rows(min_row=2, min_col=1, max_col=len(headers)):
            st = row[status_col].value
            color = STATUS_FILLS.get(st)
            if color:
                row[status_col].fill = PatternFill("solid", fgColor=color)
            elif st == "frei":
                for c in row:
                    c.font = grey


def xlsx_response(sheets, overview, filename):
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Übersicht"
    ov_headers = ["Bereich", "Subnetz", "Name", "VLAN", "Gateway", "Standort", "Beschreibung", "Belegt", "Nutzbar", "Auslastung"]
    ov_rows = [[s["section_name"], s["cidr"], s["name"], _vlan_label(s), s["gateway"], s["location"], s["description"],
                s["used"], int(s["capacity"]) if s["version"] == 4 else s["capacity"], s["usage"] / 100] for s in overview]
    _xlsx_write_table(ws, ov_headers, ov_rows, [14, 20, 22, 16, 15, 16, 36, 9, 10, 11], "Uebersicht")
    for row in ws.iter_rows(min_row=2, min_col=10, max_col=10):
        row[0].number_format = "0.0%"
    used_titles = {"Übersicht"}
    status_idx = [c[1] for c in EXPORT_COLS].index("status_label")
    for n, (title, rows) in enumerate(sheets, start=1):
        base = re.sub(r"[\[\]:*?/\\]", "_", title)[:31] or f"Netz{n}"
        t, i = base, 2
        while t in used_titles:
            suffix = f" ({i})"
            t = base[:31 - len(suffix)] + suffix
            i += 1
        used_titles.add(t)
        sh = wb.create_sheet(t)
        data = [[r.get(c[1], "") or "" for c in EXPORT_COLS] for r in rows]
        _xlsx_write_table(sh, [c[0] for c in EXPORT_COLS], data, [c[2] for c in EXPORT_COLS], f"Netz{n}", status_idx)
    bio = io.BytesIO()
    wb.save(bio)
    bio.seek(0)
    return send_file(bio, as_attachment=True, download_name=filename,
                     mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")


@app.get("/api/export/subnet/<int:sid>")
@require("viewer")
def api_export_subnet(sid):
    con = db()
    subs = all_subnets(con)
    by_id = {s["id"]: s for s in subs}
    sub = by_id.get(sid)
    if not sub:
        raise ApiError("Subnetz nicht gefunden", 404)
    fmt = request.args.get("format", "csv")
    free = request.args.get("free") == "1"
    rows = export_rows(con, sub, by_id, own_only=False, include_free=free)
    stamp = datetime.date.today().isoformat()
    fname = f"ipam_{_safe_name(sub['cidr'])}_{stamp}"
    if fmt == "xlsx":
        if not HAVE_XLSX:
            raise ApiError("Excel-Export nicht verfügbar (Python-Paket openpyxl fehlt)")
        title = sub["cidr"].replace("/", "_") + (f" {sub['name']}" if sub["name"] else "")
        return xlsx_response([(title, rows)], [sub], fname + ".xlsx")
    return csv_response(rows, fname + ".csv")


@app.get("/api/export/all")
@require("viewer")
def api_export_all():
    con = db()
    subs = all_subnets(con)
    by_id = {s["id"]: s for s in subs}
    fmt = request.args.get("format", "csv")
    free = request.args.get("free") == "1"
    stamp = datetime.date.today().isoformat()
    per = [(s, export_rows(con, s, by_id, own_only=True, include_free=free)) for s in subs]
    if fmt == "xlsx":
        if not HAVE_XLSX:
            raise ApiError("Excel-Export nicht verfügbar (Python-Paket openpyxl fehlt)")
        sheets = [(s["cidr"].replace("/", "_") + (f" {s['name']}" if s["name"] else ""), rows) for s, rows in per]
        return xlsx_response(sheets, subs, f"ipam_komplett_{stamp}.xlsx")
    allrows = [r for _, rows in per for r in rows]
    return csv_response(allrows, f"ipam_komplett_{stamp}.csv")


# --------------------------------------------------------------------------- Backup / Restore

BACKUP_TABLES = {
    "sections": ["id", "name", "description", "sort"],
    "vlans": ["id", "number", "name", "description"],
    "subnets": ["id", "section_id", "cidr", "name", "description", "vlan_id", "gateway", "dns", "location",
                "created_at", "updated_at"],
    "addresses": ["id", "subnet_id", "ip", "hostname", "description", "mac", "owner", "device_type", "status",
                  "note", "last_seen", "created_at", "updated_at", "updated_by"],
}


@app.get("/api/backup/json")
@require("admin")
def api_backup_json():
    con = db()
    data = {"app": "pyipam", "format": 1, "version": VERSION, "created": now()}
    for t, cols in BACKUP_TABLES.items():
        data[t] = [dict(r) for r in con.execute(f"SELECT {', '.join(cols)} FROM {t} ORDER BY id")]
    payload = json.dumps(data, ensure_ascii=False, indent=1)
    return Response(payload, mimetype="application/json", headers={
        "Content-Disposition": f'attachment; filename="ipam_backup_{datetime.date.today().isoformat()}.json"'})


@app.get("/api/backup/db")
@require("admin")
def api_backup_db():
    fd, tmp = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    src = connect()
    out = sqlite3.connect(tmp)
    src.backup(out)
    out.close()
    src.close()
    with open(tmp, "rb") as f:
        data = f.read()
    os.remove(tmp)
    return send_file(io.BytesIO(data), as_attachment=True, mimetype="application/x-sqlite3",
                     download_name=f"ipam_{datetime.date.today().isoformat()}.db")


@app.post("/api/backup/restore")
@require("admin")
def api_restore():
    d = body()
    if d.get("app") not in ("pyipam", "ipam-lite") or d.get("format") != 1:
        raise ApiError("Das ist keine gültige pyIPAM-Sicherung")
    con = db()
    make_backup(force_name=f"pre-restore-{datetime.datetime.now():%Y%m%d-%H%M%S}.db")
    try:
        con.execute("BEGIN")
        for t in ("addresses", "subnets", "vlans", "sections", "scans"):
            con.execute(f"DELETE FROM {t}")
        for sct in d.get("sections") or []:
            con.execute("INSERT INTO sections(id, name, description, sort) VALUES(?,?,?,?)",
                        (int(sct["id"]), str(sct["name"]), sct.get("description") or "", int(sct.get("sort") or 0)))
        for v in d.get("vlans") or []:
            con.execute("INSERT INTO vlans(id, number, name, description) VALUES(?,?,?,?)",
                        (int(v["id"]), int(v["number"]), v.get("name") or "", v.get("description") or ""))
        for s in d.get("subnets") or []:
            net = ipaddress.ip_network(s["cidr"], strict=False)
            con.execute(
                "INSERT INTO subnets(id, section_id, cidr, version, prefix, start_key, end_key, name, description, "
                "vlan_id, gateway, dns, location, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (int(s["id"]), int(s["section_id"]), str(net), net.version, net.prefixlen,
                 ip_key(net.network_address), ip_key(net.broadcast_address), s.get("name") or "",
                 s.get("description") or "", s.get("vlan_id"), s.get("gateway") or "", s.get("dns") or "",
                 s.get("location") or "", s.get("created_at"), s.get("updated_at")))
        for a in d.get("addresses") or []:
            ip = ipaddress.ip_address(a["ip"])
            con.execute(
                "INSERT INTO addresses(id, subnet_id, ip, ip_key, hostname, description, mac, owner, device_type, "
                "status, note, last_seen, created_at, updated_at, updated_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (int(a["id"]), int(a["subnet_id"]), str(ip), ip_key(ip), a.get("hostname") or "",
                 a.get("description") or "", a.get("mac") or "", a.get("owner") or "", a.get("device_type") or "",
                 a.get("status") if a.get("status") in STATUSES else "active", a.get("note") or "",
                 a.get("last_seen"), a.get("created_at"), a.get("updated_at"), a.get("updated_by")))
        if not con.execute("SELECT 1 FROM sections LIMIT 1").fetchone():
            con.execute("INSERT INTO sections(name) VALUES('Standard')")
        log("restore", "backup", None,
            f"Sicherung vom {d.get('created', '?')} wiederhergestellt: {len(d.get('subnets') or [])} Subnetze, "
            f"{len(d.get('addresses') or [])} Adressen")
        con.commit()
    except (KeyError, TypeError, ValueError, sqlite3.IntegrityError) as e:
        con.rollback()
        raise ApiError(f"Wiederherstellung fehlgeschlagen, nichts wurde geändert: {e}")
    return jsonify(ok=True)


@app.get("/api/backup/list")
@require("admin")
def api_backup_list():
    files = []
    if os.path.isdir(BACKUP_DIR):
        for f in sorted(os.listdir(BACKUP_DIR), reverse=True):
            if f.endswith(".db"):
                st = os.stat(os.path.join(BACKUP_DIR, f))
                files.append({"name": f, "size": st.st_size,
                              "mtime": datetime.datetime.fromtimestamp(st.st_mtime).astimezone().isoformat(timespec="seconds")})
    return jsonify(dir=BACKUP_DIR, keep=BACKUP_KEEP, files=files)


# --------------------------------------------------------------------------- Frontend

@app.get("/")
def index():
    with open(os.path.join(STATIC_DIR, "index.html"), encoding="utf-8") as f:
        html = f.read().replace("__VERSION__", VERSION)
    return Response(html, mimetype="text/html", headers={"Cache-Control": "no-cache"})


@app.get("/healthz")
def healthz():
    db().execute("SELECT 1")
    return jsonify(ok=True, version=VERSION)


# --------------------------------------------------------------------------- CLI

def _ask_password(random_pw):
    if random_pw:
        pw = secrets.token_urlsafe(12)
        print(f"New password: {pw}")
        return pw
    while True:
        pw = getpass.getpass("New password: ")
        if len(pw) < 8:
            print("At least 8 characters.")
            continue
        if getpass.getpass("Repeat: ") != pw:
            print("Passwords do not match.")
            continue
        return pw


def cli():
    ap = argparse.ArgumentParser(description="pyIPAM")
    sp = ap.add_subparsers(dest="cmd", required=True)
    r = sp.add_parser("run", help="start the development server")
    r.add_argument("--host", default="127.0.0.1")
    r.add_argument("--port", type=int, default=8088)
    r.add_argument("--debug", action="store_true")
    c = sp.add_parser("create-user", help="create a user")
    c.add_argument("username")
    c.add_argument("--role", default="admin", choices=list(ROLES))
    c.add_argument("--random", action="store_true", help="generate and print a random password")
    p = sp.add_parser("reset-password", help="reset a password and clear login lockouts (emergency access)")
    p.add_argument("username")
    p.add_argument("--random", action="store_true", help="generate and print a random password")
    sp.add_parser("list-users", help="list users")
    sp.add_parser("backup", help="write an SQLite backup to data/backups now")
    args = ap.parse_args()

    con = connect()
    if args.cmd == "run":
        app.run(host=args.host, port=args.port, debug=args.debug)
    elif args.cmd == "create-user":
        if not USERNAME_RE.match(args.username):
            sys.exit("Invalid username")
        pw = _ask_password(args.random)
        try:
            con.execute("INSERT INTO users(username, password_hash, role, created_at) VALUES(?,?,?,?)",
                        (args.username, generate_password_hash(pw), args.role, now()))
        except sqlite3.IntegrityError:
            sys.exit("User already exists – use reset-password")
        con.commit()
        print(f"User '{args.username}' ({args.role}) created.")
    elif args.cmd == "reset-password":
        row = con.execute("SELECT id FROM users WHERE username=?", (args.username,)).fetchone()
        if not row:
            sys.exit("User not found")
        pw = _ask_password(args.random)
        con.execute("UPDATE users SET password_hash=?, session_version=session_version+1 WHERE id=?",
                    (generate_password_hash(pw), row["id"]))
        con.execute("DELETE FROM login_attempts")
        con.commit()
        print("Password changed, login lockouts cleared.")
    elif args.cmd == "list-users":
        for u in con.execute("SELECT username, role, last_login FROM users ORDER BY username"):
            print(f"{u['username']:<24} {u['role']:<8} last login: {u['last_login'] or '-'}")
    elif args.cmd == "backup":
        print(make_backup(force_name=f"manual-{datetime.datetime.now():%Y%m%d-%H%M%S}.db"))
    con.close()


if __name__ == "__main__":
    cli()
