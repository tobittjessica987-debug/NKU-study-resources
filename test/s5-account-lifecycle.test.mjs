import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { MpAuthService } from "../server/mp-auth-service.mjs";
import { MpFavoritesService } from "../server/mp-favorites-service.mjs";
import { createWebLoginService } from "../server/web-login-service.mjs";

const NOW = 1_791_369_600_000;
const password = "synthetic-password-123";
const manifest = () => ({ courses: [{ id: "course-old-id", uid: "course-uid", title: "合成课程", term: "一", group: "合成组", sections: [] }] });
const hash = (token) => createHash("sha256").update(token).digest("hex");
const deleted = (error) => error.statusCode === 401 && error.code === "AUTH_ACCOUNT_DELETED";

function fixture(t, { initialize, pending = new Set(), callback = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nku-s5-lifecycle-"));
  const dbPath = path.join(dir, "state.sqlite");
  if (initialize) {
    const db = new Database(dbPath);
    try { initialize(db); } finally { db.close(); }
  }
  const clock = { value: NOW };
  const options = { dbPath, now: () => clock.value, appid: "synthetic-app", secret: "synthetic-secret",
    isDeletionPending: (id) => pending.has(id),
    fetchImpl: async () => ({ json: async () => ({ openid: "synthetic-wechat-openid" }) }) };
  let auth = new MpAuthService(options);
  const favorites = new MpFavoritesService({ dbPath, readManifest: manifest, now: () => clock.value,
    ...(callback ? { assertActiveUser: (id) => auth.assertActiveUser(id) } : {}) });
  t.after(() => { favorites.close(); auth.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { get auth() { return auth; }, favorites, dir, dbPath, pending, clock,
    reopen() { auth.close(); auth = new MpAuthService(options); return auth; } };
}

function account(f, nickname = "合成账号") {
  return f.auth.webRegister({ nickname, password, email: "synthetic@example.test" });
}

test("S5 identity cleanup is atomic, idempotent and survives restart without restoring credentials", (t) => {
  const f = fixture(t);
  const a = account(f);
  const b = account(f, "另一合成账号");
  f.auth.bindOpenidToUser(a.user.id, "synthetic-bound-openid");
  f.auth.setVerifiedPhone(a.user.id, "13800001234");
  f.auth.updateProfile(a.user, { nickname: "原合成昵称", avatarUrl: "https://example.test/synthetic-avatar.jpg" });
  const staleUser = f.auth.requireUser(`Bearer ${a.token}`);
  const second = f.auth.issueSessionForUser(a.user.id);
  f.favorites.add(staleUser, "course-uid");
  f.favorites.add(b.user, "course-uid");
  f.auth.db.exec("CREATE TABLE lifecycle_untouched_log(user_id INTEGER, detail TEXT); CREATE TABLE lifecycle_untouched_order(user_id INTEGER, detail TEXT)");
  for (const name of ["lifecycle_untouched_log", "lifecycle_untouched_order"]) f.auth.db.prepare(`INSERT INTO ${name} VALUES (?, 'synthetic retained evidence')`).run(a.user.id);
  assert.equal(f.auth.deleteAccount(a.user.id), true);
  const row = f.auth.db.prepare("SELECT * FROM mp_users WHERE id = ?").get(a.user.id);
  assert.equal(row.deleted_at, NOW);
  assert.match(row.nickname, /^已注销用户_[A-Za-z0-9_-]{16}$/);
  for (const key of ["openid", "web_password_hash", "phone_verified_at"]) assert.equal(row[key], null);
  for (const key of ["phone", "avatar_url", "email"]) assert.equal(row[key], "");
  assert.equal(row.created_at, staleUser.created_at);
  assert.equal(f.auth.db.prepare("SELECT COUNT(*) n FROM mp_auth_tokens WHERE user_id = ?").get(a.user.id).n, 0);
  assert.equal(f.auth.db.prepare("SELECT COUNT(*) n FROM mp_favorites WHERE user_id = ?").get(a.user.id).n, 0);
  assert.equal(f.favorites.list(b.user).total, 1);
  for (const token of [a.token, second.token]) {
    assert.equal(f.auth.verifyToken(`Bearer ${token}`), null);
    assert.equal(f.auth.introspectToken(`Bearer ${token}`).active, false);
    assert.throws(() => f.auth.requireUser(`Bearer ${token}`), (error) => error.statusCode === 401);
  }
  assert.equal(f.auth.isPhoneVerified(a.user.id), false);
  assert.equal(f.auth.findByPhone("13800001234"), null);
  assert.deepEqual(f.auth.blacklistStatus([a.user.id]), [{ user_id: a.user.id, exists: false, blocked: false }]);
  for (const name of ["lifecycle_untouched_log", "lifecycle_untouched_order"]) assert.equal(f.auth.db.prepare(`SELECT COUNT(*) n FROM ${name}`).get().n, 1);
  f.clock.value += 5_000;
  assert.equal(f.auth.deleteAccount(a.user.id), true);
  f.reopen();
  assert.equal(f.auth.deleteAccount(a.user.id), true);
  const afterRestart = f.auth.db.prepare("SELECT * FROM mp_users WHERE id = ?").get(a.user.id);
  assert.equal(afterRestart.deleted_at, NOW);
  assert.equal(afterRestart.nickname, row.nickname);
  assert.throws(() => f.auth.issueSessionForUser(a.user.id), deleted);
  assert.equal(f.auth.verifyToken(`Bearer ${b.token}`).id, b.user.id);
});

test("S5 deleted accounts reject direct writes through stale user objects and restored token rows", (t) => {
  const f = fixture(t, { callback: false });
  const a = account(f);
  f.auth.setVerifiedPhone(a.user.id, "13800001234");
  const stale = f.auth.requireUser(`Bearer ${a.token}`);
  f.auth.deleteAccount(a.user.id);
  const writes = [
    () => f.auth.assertActiveUser(a.user.id),
    () => f.auth.issueSessionForUser(a.user.id),
    () => f.auth.updateProfile(stale, { nickname: "不能复活", avatarUrl: "https://example.test/restored.jpg" }),
    () => f.auth.setWebPassword(a.user.id, password),
    () => f.auth.changeWebPassword(a.user.id, { currentPassword: password, newPassword: password }),
    () => f.auth.setVerifiedPhone(a.user.id, "13800005678"),
    () => f.auth.bindOpenidToUser(a.user.id, "must-not-bind"),
    () => f.auth.getOpenid(a.user.id),
    () => f.favorites.add(stale, "course-uid"),
    () => f.favorites.remove(stale, "course-uid"),
    () => f.favorites.list(stale),
  ];
  for (const write of writes) assert.throws(write, deleted);
  f.auth.db.prepare("INSERT INTO mp_auth_tokens VALUES (?, ?, ?, ?, ?)").run(hash(a.token), a.user.id, NOW, NOW, NOW + 60_000);
  assert.equal(f.auth.verifyToken(`Bearer ${a.token}`), null);
  assert.equal(f.auth.introspectToken(`Bearer ${a.token}`).reason, "deleted");
  f.auth.setUserBlocked(a.user.id, false);
  assert.throws(() => f.auth.issueSessionForUser(a.user.id), deleted, "admin unblock cannot reactivate a deleted account");
  assert.equal(f.auth.db.prepare("SELECT web_password_hash FROM mp_users WHERE id=?").get(a.user.id).web_password_hash, null);
  assert.equal(f.auth.db.prepare("SELECT COUNT(*) n FROM mp_favorites").get().n, 0);
});

test("S5 unique nickname indexes permit multiple deletions and stable placeholder retries", (t) => {
  const f = fixture(t);
  const a = account(f, "第一个原昵称");
  const b = account(f, "第二个原昵称");
  f.auth.db.exec("CREATE UNIQUE INDEX legacy_unique_s5_nickname ON mp_users(nickname COLLATE NOCASE)");
  f.auth.deleteAccount(a.user.id);
  f.auth.deleteAccount(b.user.id);
  const rows = f.auth.db.prepare("SELECT id,nickname,deleted_at FROM mp_users ORDER BY id").all();
  assert.equal(rows.length, 2);
  assert.notEqual(rows[0].nickname, rows[1].nickname);
  for (const row of rows) {
    assert.match(row.nickname, /^已注销用户_[A-Za-z0-9_-]{16}$/);
    assert.equal(row.nickname.includes("原昵称"), false);
    assert.equal(row.deleted_at, NOW);
  }
  f.clock.value += 10_000;
  for (const row of rows) f.auth.deleteAccount(row.id);
  f.reopen();
  for (const row of rows) f.auth.deleteAccount(row.id);
  assert.deepEqual(f.auth.db.prepare("SELECT id,nickname,deleted_at FROM mp_users ORDER BY id").all(), rows);
  assert.ok(f.auth.db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='legacy_unique_s5_nickname'").get());
});

test("S5 durable intent rejects still-stored credentials before cleanup and remains closed after a failed transaction", async (t) => {
  const f = fixture(t);
  const a = await f.auth.loginWithCode("synthetic-login-code");
  f.auth.setWebPassword(a.user.id, password);
  f.auth.updateProfile(a.user, { nickname: "待清理账号" });
  f.auth.setVerifiedPhone(a.user.id, "13800001234");
  f.favorites.add(a.user, "course-uid");
  f.pending.add(a.user.id);
  assert.equal(f.auth.verifyToken(`Bearer ${a.token}`), null);
  assert.equal(f.auth.introspectToken(`Bearer ${a.token}`).reason, "deleted");
  assert.equal(f.auth.isPhoneVerified(a.user.id), false);
  assert.equal(f.auth.findByPhone("13800001234"), null);
  assert.throws(() => f.auth.webLogin({ nickname: "待清理账号", password }), deleted);
  await assert.rejects(() => f.auth.loginWithCode("another-synthetic-code"), deleted);
  assert.throws(() => f.favorites.add(a.user, "course-uid"), deleted);
  f.auth.db.exec("CREATE TRIGGER s5_fail_favorites BEFORE DELETE ON mp_favorites BEGIN SELECT RAISE(ABORT, 'synthetic cleanup failure'); END");
  assert.throws(() => f.auth.deleteAccount(a.user.id), /synthetic cleanup failure/);
  assert.equal(f.auth.db.prepare("SELECT deleted_at FROM mp_users WHERE id=?").get(a.user.id).deleted_at, null);
  assert.equal(f.auth.verifyToken(`Bearer ${a.token}`), null, "intent, not a partially written user row, closes access");
  f.reopen();
  assert.throws(() => f.auth.issueSessionForUser(a.user.id), deleted);
  f.auth.db.exec("DROP TRIGGER s5_fail_favorites");
  assert.equal(f.auth.deleteAccount(a.user.id), true);
  f.pending.delete(a.user.id);
  assert.throws(() => f.auth.assertActiveUser(a.user.id), deleted, "committed tombstone protects after the coordinator completes");
});

test("S5 SQLite cleanup failure rolls back identity, tokens and favorites together", (t) => {
  const f = fixture(t);
  const a = account(f);
  f.auth.bindOpenidToUser(a.user.id, "rollback-openid");
  f.auth.setVerifiedPhone(a.user.id, "13800001234");
  f.favorites.add(a.user, "course-uid");
  const before = f.auth.db.prepare("SELECT * FROM mp_users WHERE id=?").get(a.user.id);
  f.auth.db.exec("CREATE TRIGGER s5_abort_token BEFORE DELETE ON mp_auth_tokens BEGIN SELECT RAISE(ABORT, 'synthetic token failure'); END");
  assert.throws(() => f.auth.deleteAccount(a.user.id), /synthetic token failure/);
  assert.deepEqual(f.auth.db.prepare("SELECT * FROM mp_users WHERE id=?").get(a.user.id), before);
  assert.equal(f.auth.verifyToken(`Bearer ${a.token}`).id, a.user.id);
  assert.equal(f.favorites.list(a.user).total, 1);
  f.auth.db.exec("DROP TRIGGER s5_abort_token");
  f.auth.deleteAccount(a.user.id);
  assert.equal(f.auth.verifyToken(`Bearer ${a.token}`), null);
});

for (const notNull of [false, true]) test(`S5 legacy ${notNull ? "NOT NULL" : "nullable"} schema preserves IDs, constraints, index, trigger and sequence through deletion`, (t) => {
  const f = fixture(t, { initialize(db) {
    db.exec(`CREATE TABLE mp_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT, openid TEXT ${notNull ? "NOT NULL" : ""} UNIQUE,
      nickname TEXT NOT NULL DEFAULT '', avatar_url TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL,
      last_login_at INTEGER, login_count INTEGER NOT NULL DEFAULT 0, blocked INTEGER NOT NULL DEFAULT 0
    ); CREATE INDEX legacy_nickname_s5 ON mp_users(nickname);
    CREATE TABLE legacy_s5_probe(count INTEGER); INSERT INTO legacy_s5_probe VALUES(0);
    CREATE TRIGGER legacy_nickname_s5_trigger AFTER UPDATE OF nickname ON mp_users BEGIN UPDATE legacy_s5_probe SET count=count+1; END;
    CREATE TABLE mp_auth_tokens(token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES mp_users(id), created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
    INSERT INTO mp_users(id,openid,nickname,created_at) VALUES(7,'synthetic-legacy-openid','普通昵称_已注销',1700000000000);
    UPDATE sqlite_sequence SET seq=100 WHERE name='mp_users';`);
    db.prepare("INSERT INTO mp_auth_tokens VALUES (?,7,?,?,?)").run(hash("legacy-synthetic-token".padEnd(43, "x")), NOW, NOW, NOW + 60_000);
  } });
  const original = f.auth.assertActiveUser(7);
  assert.equal(original.deleted_at, null, "nickname suffix must not be interpreted as proof of deletion");
  assert.equal(original.phone_verified_at, null, "migration must not certify historical accounts");
  assert.equal(f.auth.issueSessionForUser(7).user.id, 7, "WeChat identity works without a web password");
  f.favorites.add(original, "course-uid");
  f.auth.deleteAccount(7);
  f.reopen();
  assert.throws(() => f.auth.issueSessionForUser(7), deleted);
  assert.equal(f.auth.db.pragma("table_info(mp_users)").find((column) => column.name === "openid").notnull, 0);
  assert.ok(f.auth.db.prepare("SELECT 1 FROM sqlite_master WHERE name='legacy_nickname_s5'").get());
  assert.ok(f.auth.db.prepare("SELECT 1 FROM sqlite_master WHERE name='legacy_nickname_s5_trigger'").get());
  const triggerCount = f.auth.db.prepare("SELECT count FROM legacy_s5_probe").get().count;
  assert.equal(triggerCount, 1);
  f.auth.deleteAccount(7);
  assert.equal(f.auth.db.prepare("SELECT count FROM legacy_s5_probe").get().count, triggerCount, "idempotent cleanup must not rerun user-update triggers");
  assert.deepEqual(f.auth.db.pragma("foreign_key_check"), []);
  assert.ok(account(f, "迁移后合成账号").user.id > 100);
  const snapshots = fs.readdirSync(f.dir).filter((name) => name.includes("before-openid-nullable"));
  assert.equal(snapshots.length, notNull ? 1 : 0);
  if (notNull) assert.equal(fs.statSync(path.join(f.dir, snapshots[0])).mode & 0o777, 0o600);
});

test("S5 credentialless legacy rows cannot receive sessions without guessing their lifecycle", (t) => {
  const f = fixture(t);
  f.auth.db.prepare("INSERT INTO mp_users(openid,nickname,created_at) VALUES(NULL,?,?)").run("旧版清理行", NOW);
  const row = f.auth.db.prepare("SELECT * FROM mp_users").get();
  assert.equal(f.auth.assertActiveUser(row.id).deleted_at, null);
  assert.throws(() => f.auth.issueSessionForUser(row.id), (error) => error.code === "AUTH_ACCOUNT_INACTIVE");
  assert.equal(f.auth.db.prepare("SELECT COUNT(*) n FROM mp_auth_tokens").get().n, 0);
  assert.equal(f.auth.db.prepare("SELECT login_count FROM mp_users").get().login_count, 0, "failed signing rolls login accounting back");
});

test("S5 QR and manual-code confirmations cannot grant a new session after deletion", (t) => {
  const f = fixture(t);
  const a = account(f);
  const b = account(f, "其他扫码账号");
  const tickets = createWebLoginService({ now: () => NOW });
  const qr = tickets.create();
  const manual = tickets.create();
  const other = tickets.create();
  const pending = tickets.create();
  assert.equal(tickets.confirm(qr.id, a.user.id), true);
  assert.equal(tickets.confirm(manual.id, a.user.id), true);
  assert.equal(tickets.confirm(other.id, b.user.id), true);
  f.auth.deleteAccount(a.user.id);
  assert.throws(() => f.auth.issueSessionForUser(tickets.get(qr.id).userId), deleted, "account state prevents revival even if ticket cleanup was interrupted");
  assert.equal(tickets.revokeForUser(a.user.id), 2);
  assert.equal(tickets.revokeForUser(a.user.id), 0);
  assert.equal(tickets.get(qr.id), null);
  assert.equal(tickets.get(manual.id), null);
  assert.equal(tickets.get(other.id).status, "confirmed");
  assert.equal(tickets.get(pending.id).status, "pending");
  assert.equal(f.auth.issueSessionForUser(tickets.get(other.id).userId).user.id, b.user.id);
});

test("S5 a fresh WeChat registration cannot inherit a deleted account or its verified phone and favorites", async (t) => {
  const f = fixture(t);
  const a = await f.auth.loginWithCode("synthetic-first-code");
  f.auth.setVerifiedPhone(a.user.id, "13800001234");
  f.favorites.add(a.user, "course-uid");
  f.auth.deleteAccount(a.user.id);
  const replacement = await f.auth.loginWithCode("synthetic-fresh-code");
  assert.notEqual(replacement.user.id, a.user.id);
  assert.equal(replacement.registered, true);
  assert.equal(replacement.user.phone_verified, false);
  assert.equal(f.favorites.list(replacement.user).total, 0);
  assert.throws(() => f.auth.issueSessionForUser(a.user.id), deleted);
});
