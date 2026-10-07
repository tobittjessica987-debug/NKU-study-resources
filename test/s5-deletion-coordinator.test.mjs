import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { MpAuthService } from '../server/mp-auth-service.mjs';
import { DonateOrderStore } from '../server/donate-order-store.mjs';
import { createWebLoginService } from '../server/web-login-service.mjs';
import { AtomicJsonStore } from '../server/atomic-json-store.mjs';
import { DeletionLedger } from '../server/deletion-ledger.mjs';
import { AccountDeletionService } from '../server/account-deletion-service.mjs';
import { preserveDonationIdentity } from '../server/donation-identity-policy.mjs';
import { createPublicApiHandler } from '../server/public-api-router.mjs';

async function fixture(t, { fault = () => {}, avatar = async () => ({ remaining: 0, sourceDeleted: true, cacheCleared: false }), ledgerFault } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 's5-coordinator-'));
  const dataDir = path.join(root, 'data'); fs.mkdirSync(dataDir);
  const dbPath = path.join(root, 'state.sqlite');
  const auth = new MpAuthService({ dbPath });
  const ledger = DeletionLedger.create({ directory: path.join(root, 'ledger'), lineage: 'coordinator-synthetic', fault: ledgerFault });
  auth.isDeletionPending = id => ledger.entries().some(row => row.userId === id);
  const a = auth.webRegister({ nickname: 'coordinator A', password: 'Synthetic-valid-password-A' });
  const b = auth.webRegister({ nickname: 'coordinator B', password: 'Synthetic-valid-password-B' });
  const orders = new DonateOrderStore({ dbPath, assertActiveUser: id => auth.assertActiveUser(id) });
  orders.create({ outTradeNo: 'ORDER_A', userId: a.user.id, amountTotal: 100, nickname: 'payer A', remark: 'private A' });
  orders.create({ outTradeNo: 'ORDER_B', userId: b.user.id, amountTotal: 200, nickname: 'payer B' });
  const store = new AtomicJsonStore({ allowedRoot: dataDir });
  await store.write(path.join(dataDir, 'reviews.json'), { reviews: [
    { id: 'review-a', user_id: a.user.id, body: 'retained body', status: 'approved', helpfulBy: [a.user.id,b.user.id], helpfulCount: 2 },
    { id: 'review-b', user_id: b.user.id, body: 'other body', status: 'pending' },
  ] });
  await store.write(path.join(dataDir, 'feedback.json'), { items: [{ id: 'private-a', user_id: a.user.id, private: true, contact: 'synthetic@example.invalid', body: 'private body', reply: 'private reply' }] });
  await store.write(path.join(dataDir, 'donate.json'), { records: [{ date: '2026-10-07', nickname: 'payer A', order_key: 'ORDER_A', usage: 'hosting' }] });
  const tickets = createWebLoginService();
  const audits = [];
  const dependencies = { auth, ledger, store, dataDir, tickets, orders, cleanupAvatars: avatar, audit: event => audits.push(event), fault };
  const coordinator = new AccountDeletionService(dependencies);
  t.after(() => { orders.close(); auth.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { ...dependencies, root, a, b, coordinator, audits, dependencies };
}

function assertClean(f) {
  assert.equal(f.auth.verifyToken(`Bearer ${f.a.token}`), null);
  assert.equal(f.auth.verifyToken(`Bearer ${f.b.token}`).id, f.b.user.id);
  const review = f.store.readSync(path.join(f.dataDir, 'reviews.json')).reviews[0];
  assert.equal(review.user_id, undefined); assert.equal(review.body, 'retained body'); assert.equal(review.status, 'approved');
  assert.deepEqual(review.helpfulBy, [f.b.user.id]); assert.equal(review.helpfulCount, 1);
  const complaint = f.store.readSync(path.join(f.dataDir, 'feedback.json')).items[0];
  assert.equal(complaint.user_id, undefined); assert.equal(complaint.contact, undefined); assert.equal(complaint.private, true);
  assert.equal(complaint.reply, 'private reply');
  assert.equal(f.orders.get('ORDER_A').user_id, 0); assert.equal(f.orders.get('ORDER_A').nickname, '');
  assert.equal(f.orders.get('ORDER_A').amount_total, 100); assert.equal(f.orders.get('ORDER_B').user_id, f.b.user.id);
  assert.equal(f.store.readSync(path.join(f.dataDir, 'donate.json')).records[0].nickname, '好心人');
  assert.equal(f.coordinator.health().pending, 0);
}

test('coordinator completes retained-content cleanup and cannot reissue old identity', async t => {
  const f = await fixture(t);
  const result = await f.coordinator.request(f.a.user);
  assert.equal(result.deleted, true); assert.equal(result.pending, false);
  assertClean(f); assert.equal(f.ledger.entries().length, 1); assert.equal(f.audits[0].action, 'account.delete.cleanup');
  await assert.rejects(f.coordinator.request(f.a.user), { code: 'AUTH_ACCOUNT_DELETED' });
  const restarted = new AccountDeletionService(f.dependencies);
  await restarted.resume({ all: true }); assertClean(f);
  assert.equal(f.ledger.entries().length, 1);
});

for (const phase of ['afterIntent', 'afterIdentity', 'afterContent', 'afterAvatars']) {
  test(`coordinator ${phase} failure remains disabled, keeps order keys and resumes`, async t => {
    const f = await fixture(t, { fault: point => { if (point === phase) throw new Error('synthetic fault'); } });
    const result = await f.coordinator.request(f.a.user);
    assert.deepEqual([result.deleted, result.pending, result.accountDisabled], [false,true,true]);
    assert.equal(f.auth.verifyToken(`Bearer ${f.a.token}`), null);
    assert.throws(() => f.auth.issueSessionForUser(f.a.user.id), { code: 'AUTH_ACCOUNT_DELETED' });
    const job = f.auth.db.prepare('SELECT * FROM account_deletion_jobs').get();
    assert.equal(job.status, 'pending'); assert.deepEqual(JSON.parse(job.order_keys), ['ORDER_A']);
    f.coordinator = new AccountDeletionService({ ...f.dependencies, fault: () => {} });
    assert.deepEqual(await f.coordinator.resume(), { complete: 1, pending: 0 }); assertClean(f);
  });
}

test('ledger write failure before admission leaves account active; after-rename unknown is guarded and replayed', async t => {
  for (const phase of ['beforeRename', 'afterRename']) {
    let enabled = false;
    const f = await fixture(t, { ledgerFault: point => { if (enabled && point === phase) throw new Error('synthetic write fault'); } });
    enabled = true;
    await assert.rejects(f.coordinator.request(f.a.user), /synthetic write fault/);
    enabled = false;
    if (phase === 'beforeRename') {
      assert.equal(f.ledger.entries().length, 0); assert.equal(f.auth.verifyToken(`Bearer ${f.a.token}`).id, f.a.user.id);
    } else {
      assert.equal(f.auth.verifyToken(`Bearer ${f.a.token}`), null);
      assert.deepEqual(await f.coordinator.resume(), { complete: 1, pending: 0 }); assertClean(f);
    }
  }
});

test('avatar cleanup failure cannot become complete and retries from the persistent job', async t => {
  let failed = true;
  const f = await fixture(t, { avatar: async () => {
    if (failed) throw Object.assign(new Error('synthetic remote'), { code: 'AVATAR_CLEANUP_PENDING' });
    return { remaining: 0, sourceDeleted: true, cacheCleared: false };
  } });
  assert.equal((await f.coordinator.request(f.a.user)).deleted, false);
  assert.equal(f.auth.db.prepare('SELECT last_error FROM account_deletion_jobs').get().last_error, 'AVATAR_CLEANUP_PENDING');
  failed = false; await f.coordinator.resume(); assertClean(f);
});

test('startup replay cleans content rolled back by a recovered publication snapshot', async t => {
  const f = await fixture(t);
  const old = f.store.readSync(path.join(f.dataDir, 'reviews.json'));
  await f.coordinator.request(f.a.user); assertClean(f);
  await f.store.write(path.join(f.dataDir, 'reviews.json'), old);
  await f.coordinator.resume({ all: true }); assertClean(f);
});

test('account instance mismatch fails closed without deleting another account', async t => {
  const f = await fixture(t);
  await f.coordinator.request(f.a.user);
  f.auth.db.prepare('UPDATE mp_users SET created_at=created_at+1 WHERE id=?').run(f.a.user.id);
  await assert.rejects(f.coordinator.resume({ all: true }), { code: 'DELETION_ACCOUNT_INSTANCE_MISMATCH' });
  assert.equal(f.auth.verifyToken(`Bearer ${f.b.token}`).id, f.b.user.id);
});

test('corrupt persisted order ownership cannot clear another account', async t => {
  const f = await fixture(t, { fault: () => { throw new Error('pause'); } });
  await f.coordinator.request(f.a.user);
  f.auth.db.prepare('UPDATE account_deletion_jobs SET order_keys=?').run(JSON.stringify(['ORDER_B']));
  const restarted = new AccountDeletionService({ ...f.dependencies, fault: () => {} });
  assert.deepEqual(await restarted.resume(), { complete: 0, pending: 1 });
  assert.equal(f.orders.get('ORDER_B').user_id, f.b.user.id);
  assert.equal(f.orders.get('ORDER_B').nickname, 'payer B');
  assert.equal(f.auth.db.prepare('SELECT last_error FROM account_deletion_jobs').get().last_error, 'DELETION_ORDER_OWNER_MISMATCH');
});

test('donation publication preserves exact keys and cannot recover cleared nicknames', () => {
  const current = { records: [{ order_key: 'ORDER_A', date: '2026-10-07', nickname: '好心人' }] };
  assert.throws(() => preserveDonationIdentity({ records: [{ nickname: 'old identity' }] }, current, () => null), { code: 'DONATION_IDENTITY_CONFLICT' });
  assert.throws(() => preserveDonationIdentity({ records: [{ order_key: 'FOREIGN' }] }, current, () => null), { code: 'DONATION_IDENTITY_CONFLICT' });
  const result = preserveDonationIdentity({ records: [{ order_key: 'ORDER_A', nickname: 'old identity', usage: 'new use' }] }, current, () => ({ identity_cleared_at: 1 }));
  assert.equal(result.records[0].nickname, '好心人'); assert.equal(result.records[0].usage, 'new use');
});

test('router requires coordinator and reports accepted pending instead of false success', async t => {
  const f = await fixture(t);
  for (const ready of [false,true]) {
    const result = {};
    const handler = createPublicApiHandler({ service: {}, mpAuthService: f.auth, readBody: async () => ({}), clientIp: () => '',
      deletionService: ready ? { request: async () => ({ deleted:false, pending:true, accountDisabled:true }) } : null });
    await handler({ method:'POST', headers:{ authorization:`Bearer ${f.a.token}` } }, {
      writeHead(status, headers) { Object.assign(result,{status,headers}); }, end(body) { result.body=JSON.parse(body); },
    }, new URL('http://localhost/api/v1/me/delete-account'));
    assert.equal(result.status, ready ? 202 : 503);
    if (ready) { assert.equal(result.body.data.deleted, false); assert.ok(result.headers['set-cookie']); }
  }
});
