"""DT cloud snapshots for an internal network. Python 3.10 or newer."""

import argparse
from contextlib import closing
from datetime import datetime, timezone
import gzip
import hashlib
from html import escape
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from ipaddress import ip_address
from itertools import groupby
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import sqlite3
import struct
import tempfile
from urllib.parse import parse_qs, quote, urlsplit
from uuid import uuid4


KEY = re.compile(r"[a-z0-9][a-z0-9_-]{0,63}")
RESERVED = re.compile(r"(con|prn|aux|nul|com[0-9]|lpt[0-9])")
REVISION = re.compile(r"[0-9a-f]{32}")
ENVIRONMENTS = "/api/v2/environments"
ADMIN_BACKUPS = re.compile(r"/admin/keys/(" + KEY.pattern + r")/backups(?:/(" + REVISION.pattern + r"))?/?")
HEADER_LIMIT = 8 * 1024**2
ADMIN_STYLE = """
body{font:16px system-ui;background:#f4f6fb;color:#172340;margin:0}
main{max-width:880px;margin:5vh auto;padding:28px;background:white;border-radius:12px}
label,input,button{font:inherit}input,button{padding:8px}
a{color:#2456a2}summary{cursor:pointer}code,.env-name{overflow-wrap:anywhere}
.table-scroll{overflow:auto}table{width:100%;border-collapse:collapse;margin-top:16px}
td,th{text-align:left;vertical-align:top;border-bottom:1px solid #ddd;padding:9px}
td.action,td.size{white-space:nowrap}.env-info{display:block;color:#4c5970;font-size:.875rem}
ul{margin:.5rem 0;padding-inline-start:1.2rem}li+li{margin-top:.5rem}
@media(max-width:600px){main{margin:0;padding:18px;border-radius:0}td,th{padding:7px}}
"""


class RequestError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


class SyncServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address, root, max_bytes=2 * 1024**3):
        self.root = root.resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self.max_bytes = max_bytes
        self.form_token = secrets.token_urlsafe(32)
        with closing(self.database()) as db, db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS sync_keys (key TEXT PRIMARY KEY);
                CREATE TABLE IF NOT EXISTS snapshots (
                    sequence INTEGER PRIMARY KEY, key TEXT NOT NULL,
                    revision TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL,
                    size INTEGER NOT NULL, sha256 TEXT NOT NULL,
                    environment_count INTEGER NOT NULL, website_data INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS snapshots_owner ON snapshots(key, sequence DESC);
                CREATE TABLE IF NOT EXISTS snapshot_environments (
                    snapshot_sequence INTEGER NOT NULL, name TEXT NOT NULL,
                    environment_id TEXT NOT NULL, group_name TEXT NOT NULL, browser_core TEXT NOT NULL,
                    PRIMARY KEY (snapshot_sequence, environment_id)
                );
            """)
            columns = {row["name"] for row in db.execute("PRAGMA table_info(snapshots)")}
            if "scope" not in columns:
                db.execute("ALTER TABLE snapshots ADD COLUMN scope TEXT NOT NULL DEFAULT 'legacy'")
            if "indexed" not in columns:
                db.execute("ALTER TABLE snapshots ADD COLUMN indexed INTEGER NOT NULL DEFAULT 0")
        super().__init__(address, Handler)

    def database(self):
        db = sqlite3.connect(self.root / "sync.sqlite3", timeout=30)
        db.row_factory = sqlite3.Row
        return db

    def key_dir(self, key):
        folder = self.root / key
        if folder.resolve().parent != self.root or folder.resolve().name != key:
            raise RequestError(400, "密钥目录无效。")
        return folder


def metadata(row):
    return {
        "revision": row["revision"], "createdAt": row["created_at"],
        "size": row["size"], "sha256": row["sha256"],
        "environmentCount": row["environment_count"], "websiteData": bool(row["website_data"]),
    }


def admin_html(title, content):
    return f"""<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>{escape(title)}</title>
<style>{ADMIN_STYLE}</style><main>{content}</main></html>"""


def environment_html(row):
    group = escape(row["group_name"] or "默认分组")
    core = "Chromium" if row["browser_core"] == "chromium" else "Electron"
    return f'<span class="env-name">{escape(row["name"])}</span><span class="env-info">{group} · {core}</span>'


def backup_filename(row):
    name = row["name"] if row["scope"] == "environment" and row["name"] else "整套备份"
    name = re.sub(r'[<>:"/\\|?*\x00-\x1f\x7f]', "_", name).strip(" .")[:80] or "环境备份"
    return f'DT-{name}-{row["created_at"][:10]}-{row["revision"][:8]}.dt-sync.gz'


def read_environments(path, count, website):
    error = RequestError(422, "备份包中的环境列表无效。")
    try:
        with gzip.open(path, "rb") as archive:
            length, = struct.unpack(">I", archive.read(4))
            if not 2 <= length <= HEADER_LIMIT:
                raise error
            manifest = json.loads(archive.read(length))
            if (manifest["schema"] != 1 or manifest["environmentCount"] != count
                    or manifest["websiteData"] is not bool(website)):
                raise error
            offset = 0
            for entry in manifest["files"]:
                size = entry["size"]
                if type(size) is not int or not 0 <= size <= 8 * 1024**3 - offset:
                    raise error
                if entry["name"] == "environments.json":
                    if size > HEADER_LIMIT:
                        raise error
                    archive.seek(4 + length + offset)
                    records = json.loads(archive.read(size))
                    break
                offset += size
            else:
                raise error
        if not isinstance(records, list) or len(records) != count:
            raise error
        environments = []
        ids = set()
        for record in records:
            name, identity = record["name"], record["id"]
            group = record.get("group") or ""
            core = record.get("browserCore") or "electron"
            if (not isinstance(name, str) or not name or not isinstance(identity, str) or not identity
                    or identity in ids or not isinstance(group, str) or core not in ("electron", "chromium")):
                raise error
            ids.add(identity)
            environments.append((name, identity, group, core))
        return environments
    except (OSError, EOFError, ValueError, KeyError, TypeError, AttributeError, struct.error) as cause:
        raise error from cause


def index_environments(db, sequence, environments):
    db.executemany("INSERT OR IGNORE INTO snapshot_environments VALUES (?, ?, ?, ?, ?)",
                   [(sequence, *environment) for environment in environments])
    db.execute("UPDATE snapshots SET indexed = 1 WHERE sequence = ?", (sequence,))


class Handler(BaseHTTPRequestHandler):
    def setup(self):
        super().setup()
        self.connection.settimeout(120)

    def log_message(self, _format, *_args):
        # Request logs need no access keys.
        return

    def reply(self, status, value, content_type="application/json; charset=utf-8"):
        body = value.encode("utf-8") if isinstance(value, str) else json.dumps(value, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Referrer-Policy", "no-referrer")
        self.end_headers()
        self.wfile.write(body)

    def run_action(self, action):
        try:
            action()
        except RequestError as error:
            self.reply(error.status, {"error": str(error)})
        except (ConnectionError, TimeoutError):
            self.close_connection = True
        except (OSError, sqlite3.Error):
            self.reply(500, {"error": "服务端存储操作失败。"})

    def do_GET(self):
        self.run_action(self.get_snapshot_or_admin)

    def do_POST(self):
        self.run_action(self.manage_key)

    def do_PUT(self):
        self.run_action(self.upload)

    def owner(self):
        key = self.headers.get("X-DT-Sync-Key", "")
        if not KEY.fullmatch(key) or RESERVED.fullmatch(key):
            raise RequestError(401, "同步密钥无效。")
        with closing(self.server.database()) as db:
            if not db.execute("SELECT 1 FROM sync_keys WHERE key = ?", (key,)).fetchone():
                raise RequestError(401, "同步密钥无效。")
        return key

    def body_length(self, limit):
        try:
            count = int(self.headers.get("Content-Length", ""))
        except ValueError:
            raise RequestError(400, "请求需要指定文件大小。") from None
        if not 0 < count <= limit:
            raise RequestError(413, "数据大小超过服务端限制。")
        return count

    def local_admin(self):
        if not ip_address(self.client_address[0]).is_loopback:
            raise RequestError(403, "请在部署服务的电脑上打开密钥管理页。")

    def admin_page(self, status=200, message=""):
        self.local_admin()
        with closing(self.server.database()) as db:
            rows = db.execute("""
                SELECT keys.key, count(s.revision) AS versions, max(s.created_at) AS updated
                FROM sync_keys keys LEFT JOIN snapshots s ON keys.key = s.key
                GROUP BY keys.key ORDER BY keys.key
            """).fetchall()
        listing = "".join(
            f'<tr><td><code>{escape(row["key"])}</code></td><td>{row["versions"]}</td>'
            f'<td>{escape(row["updated"] or "尚未上传")}</td>'
            f'<td class="action"><a href="/admin/keys/{quote(row["key"], safe="")}/backups">查看备份</a></td></tr>'
            for row in rows
        )
        content = f"""<h1>DT 云同步密钥</h1><p>给每个人分配自己的密钥。备份保存到同名目录。</p>
<form method="post" action="/admin/keys"><input type="hidden" name="token" value="{self.server.form_token}">
<label for="key">同步密钥</label> <input id="key" name="key" required maxlength="64" autocomplete="off">
<button type="submit">添加密钥</button></form>
<p>支持小写英文字母、数字、短横线和下划线，以字母或数字开头。</p><p role="status">{escape(message)}</p>
<div class="table-scroll"><table><thead><tr><th>密钥</th><th>备份数量</th><th>最后上传</th><th>操作</th></tr></thead>
<tbody>{listing}</tbody></table></div>"""
        self.reply(status, admin_html("DT 云同步密钥", content), "text/html; charset=utf-8")

    def admin_backups(self, key):
        self.local_admin()
        with closing(self.server.database()) as db:
            if not db.execute("SELECT 1 FROM sync_keys WHERE key = ?", (key,)).fetchone():
                raise RequestError(404, "未找到此密钥。")
        rows = []
        path = f'/admin/keys/{quote(key, safe="")}/backups'
        for revision, entries in groupby(self.snapshot_catalog(key), key=lambda row: row["revision"]):
            snapshot = list(entries)
            header = snapshot[0]
            environments = [row for row in snapshot if row["name"] is not None]
            if not header["indexed"]:
                details = "无法读取配置清单"
            elif not environments:
                details = "没有环境"
            elif header["scope"] == "legacy":
                items = "".join(f"<li>{environment_html(row)}</li>" for row in environments)
                details = f"<details><summary>{len(environments)} 个环境</summary><ul>{items}</ul></details>"
            else:
                details = environment_html(environments[0])
            kind = "整套备份" if header["scope"] == "legacy" else "环境备份"
            created = datetime.fromisoformat(header["created_at"]).strftime("%Y-%m-%d %H:%M:%S UTC")
            size = header["size"] / 1024**2
            rows.append(f'<tr><td>{details}</td><td>{kind}</td><td>{created}</td><td class="size">{size:.2f} MiB</td>'
                        f'<td class="action"><a href="{path}/{revision}">下载备份</a></td></tr>')
        listing = ("<div class=\"table-scroll\"><table><thead><tr><th>环境</th><th>备份类型</th><th>上传时间</th>"
                   "<th>大小</th><th>操作</th></tr></thead><tbody>" + "".join(rows) + "</tbody></table></div>"
                   if rows else "<p>这个密钥暂无备份。</p>")
        content = f'<nav><a href="/admin">返回密钥列表</a></nav><h1>备份列表</h1><p>密钥 <code>{escape(key)}</code></p>{listing}'
        self.reply(200, admin_html("DT 云同步备份", content), "text/html; charset=utf-8")

    def manage_key(self):
        if self.path != "/admin/keys":
            raise RequestError(404, "没有此接口。")
        self.local_admin()
        try:
            fields = parse_qs(self.rfile.read(self.body_length(4096)).decode("utf-8"))
        except UnicodeError:
            raise RequestError(400, "表单格式无效。") from None
        if not secrets.compare_digest(fields.get("token", [""])[0].encode("utf-8"), self.server.form_token.encode()):
            raise RequestError(403, "请刷新管理页后重试。")
        key = fields.get("key", [""])[0].strip()
        if not KEY.fullmatch(key) or RESERVED.fullmatch(key):
            self.admin_page(400, "密钥不能用作同步目录，请换一个。")
            return
        with closing(self.server.database()) as db, db:
            if db.execute("SELECT 1 FROM sync_keys WHERE key = ?", (key,)).fetchone():
                self.admin_page(409, "密钥已经存在，已有备份仍可用。")
                return
            self.server.key_dir(key).mkdir(exist_ok=True)
            db.execute("INSERT INTO sync_keys VALUES (?)", (key,))
        self.admin_page(201, "密钥已添加。")

    def get_snapshot_or_admin(self):
        route = urlsplit(self.path).path
        if route in ("/", "/admin"):
            self.admin_page()
            return
        admin = ADMIN_BACKUPS.fullmatch(route)
        if admin:
            key, revision = admin.groups()
            if revision:
                self.local_admin()
                self.send_snapshot(key, revision, attachment=True)
            else:
                self.admin_backups(key)
            return
        if route == "/api/v1/snapshots":
            with closing(self.server.database()) as db:
                rows = db.execute("""SELECT * FROM snapshots WHERE key = ? AND scope = 'legacy'
                                     ORDER BY sequence DESC""", (self.owner(),)).fetchall()
            self.reply(200, {"snapshots": [metadata(row) for row in rows], "maxBytes": self.server.max_bytes})
            return
        if route == ENVIRONMENTS:
            self.get_environments()
            return
        revision = route.removeprefix("/api/v1/snapshots/")
        if not REVISION.fullmatch(revision):
            raise RequestError(404, "没有此接口。")
        self.send_snapshot(self.owner(), revision)

    def send_snapshot(self, key, revision, attachment=False):
        with closing(self.server.database()) as db:
            row = db.execute("""
                SELECT s.*, (SELECT e.name FROM snapshot_environments e WHERE e.snapshot_sequence = s.sequence
                             ORDER BY e.environment_id LIMIT 1) AS name
                FROM snapshots s WHERE s.key = ? AND s.revision = ?
            """, (key, revision)).fetchone()
            if not row:
                raise RequestError(404, "未找到此快照。")
            try:
                source = (self.server.key_dir(key) / (revision + ".dt-sync.gz")).open("rb")
            except FileNotFoundError:
                raise RequestError(404, "此快照已不在服务端。") from None
        with source:
            self.send_response(200)
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("Content-Length", str(row["size"]))
            self.send_header("Cache-Control", "no-store")
            if attachment:
                fallback = f"DT-{revision}.dt-sync.gz"
                filename = quote(backup_filename(row), safe="")
                self.send_header("Content-Disposition", f'attachment; filename="{fallback}"; filename*=UTF-8\'\'{filename}')
                self.send_header("Referrer-Policy", "no-referrer")
            self.end_headers()
            shutil.copyfileobj(source, self.wfile, 1024 * 1024)

    def snapshot_catalog(self, key):
        folder = self.server.key_dir(key)
        with closing(self.server.database()) as db:
            pending = db.execute("SELECT * FROM snapshots WHERE key = ? AND indexed = 0", (key,)).fetchall()
            for row in pending:
                try:
                    environments = read_environments(folder / (row["revision"] + ".dt-sync.gz"),
                                                     row["environment_count"], row["website_data"])
                except RequestError:
                    continue
                with db:
                    db.execute("BEGIN IMMEDIATE")
                    current = db.execute("SELECT sequence FROM snapshots WHERE revision = ?", (row["revision"],)).fetchone()
                    if current:
                        index_environments(db, current["sequence"], environments)
            return db.execute("""
                SELECT s.*, e.name, e.environment_id, e.group_name, e.browser_core
                FROM snapshots s LEFT JOIN snapshot_environments e ON e.snapshot_sequence = s.sequence
                WHERE s.key = ? ORDER BY s.sequence DESC, e.name
            """, (key,)).fetchall()

    def get_environments(self):
        rows = self.snapshot_catalog(self.owner())
        unreadable = sum(not row["indexed"] for row in rows)
        self.reply(200, {"maxBytes": self.server.max_bytes, "unreadableBackups": unreadable,
                         "environments": [{"name": row["name"], "id": row["environment_id"],
                                           "group": row["group_name"], "browserCore": row["browser_core"],
                                           "snapshot": metadata(row)} for row in rows if row["name"] is not None]})

    @staticmethod
    def check_version(db, key, expected):
        newest = db.execute("""SELECT revision FROM snapshots WHERE key = ? AND scope = 'legacy'
                               ORDER BY sequence DESC LIMIT 1""", (key,)).fetchone()
        if (newest["revision"] if newest else "none") != expected:
            raise RequestError(409, "云端版本已改变，请刷新确认信息后重试。")

    def upload(self):
        selective = self.path == ENVIRONMENTS
        if not selective and self.path != "/api/v1/snapshots":
            raise RequestError(404, "没有此接口。")
        key = self.owner()
        expected = self.headers.get("X-DT-Expected-Revision", "")
        checksum = self.headers.get("X-DT-SHA256", "")
        count = self.headers.get("X-DT-Environment-Count", "")
        if ((not selective and expected != "none" and not REVISION.fullmatch(expected))
                or not re.fullmatch(r"[0-9a-f]{64}", checksum)):
            raise RequestError(400, "缺少有效的版本或校验值。")
        if not re.fullmatch(r"[0-9]{1,6}", count):
            raise RequestError(400, "环境数量无效。")
        size = self.body_length(self.server.max_bytes)
        website = int(self.headers.get("X-DT-Website-Data") == "1")
        if selective and (count != "1" or website):
            raise RequestError(400, "按环境上传需要一个环境的备份。")
        folder = self.server.key_dir(key)
        if not selective:
            with closing(self.server.database()) as db:
                self.check_version(db, key, expected)
        revision = uuid4().hex
        destination = folder / (revision + ".dt-sync.gz")
        incoming = None
        published = False
        try:
            with tempfile.NamedTemporaryFile(dir=folder, prefix=".incoming-", delete=False) as output:
                incoming = Path(output.name)
                digest = hashlib.sha256()
                remaining = size
                while remaining:
                    chunk = self.rfile.read(min(remaining, 1024 * 1024))
                    if not chunk:
                        raise RequestError(400, "上传中断。")
                    output.write(chunk)
                    digest.update(chunk)
                    remaining -= len(chunk)
                output.flush()
                os.fsync(output.fileno())
            if digest.hexdigest() != checksum:
                raise RequestError(422, "文件校验失败，云端版本仍可用。")
            environments = read_environments(incoming, 1, website) if selective else []
            with closing(self.server.database()) as db, db:
                db.execute("BEGIN IMMEDIATE")
                if not selective:
                    self.check_version(db, key, expected)
                os.replace(incoming, destination)
                cursor = db.execute("""
                    INSERT INTO snapshots(key, revision, created_at, size, sha256, environment_count, website_data, scope)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """, (key, revision, datetime.now(timezone.utc).isoformat(), size, checksum, int(count), website,
                      "environment" if selective else "legacy"))
                row = db.execute("SELECT * FROM snapshots WHERE sequence = ?", (cursor.lastrowid,)).fetchone()
                if selective:
                    index_environments(db, row["sequence"], environments)
                    old = db.execute("""
                        SELECT s.sequence, s.revision FROM snapshots s JOIN snapshot_environments e
                        ON e.snapshot_sequence = s.sequence WHERE s.key = ? AND s.scope = 'environment' AND e.name = ?
                        ORDER BY s.sequence DESC LIMIT -1 OFFSET 4
                    """, (key, environments[0][0])).fetchall()
                else:
                    old = db.execute("""SELECT sequence, revision FROM snapshots WHERE key = ? AND scope = 'legacy'
                                        ORDER BY sequence DESC LIMIT -1 OFFSET 4""", (key,)).fetchall()
                old_ids = [(item["sequence"],) for item in old]
                db.executemany("DELETE FROM snapshot_environments WHERE snapshot_sequence = ?", old_ids)
                db.executemany("DELETE FROM snapshots WHERE sequence = ?", old_ids)
            published = True
            for item in old:
                try:
                    (folder / (item["revision"] + ".dt-sync.gz")).unlink(missing_ok=True)
                except OSError:
                    pass
            self.reply(201, {"snapshot": metadata(row)})
        finally:
            if incoming:
                incoming.unlink(missing_ok=True)
            if not published:
                destination.unlink(missing_ok=True)


def main():
    arguments = argparse.ArgumentParser(description=__doc__)
    arguments.add_argument("--host", default="0.0.0.0")
    arguments.add_argument("--port", default=55550, type=int)
    arguments.add_argument("--data-dir", type=Path, default=Path("sync-data"))
    options = arguments.parse_args()
    with SyncServer((options.host, options.port), options.data_dir) as server:
        print(f"DT Sync API listening on {options.host}:{server.server_port}", flush=True)
        print(f"Key management: http://127.0.0.1:{server.server_port}/admin", flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
