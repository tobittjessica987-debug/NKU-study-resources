import { randomUUID } from 'node:crypto';
import { PublicApiError } from './public-api-errors.mjs';
import { cleanupAccountContent } from './account-content-cleanup.mjs';
import { scrubCommunitySupportAccount } from './community-support-service.mjs';

export const ACCOUNT_DELETION_POLICY = 's5-retain-published-v1';

export function ensureAccountDeletionJobs(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS account_deletion_jobs (
    event_id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, user_created_at INTEGER NOT NULL,
    requested_at INTEGER NOT NULL, status TEXT NOT NULL, order_keys TEXT NOT NULL DEFAULT '[]',
    summary TEXT NOT NULL DEFAULT '{}', last_error TEXT NOT NULL DEFAULT '', completed_at INTEGER
  )`);
}

const fixedCode = error => /^[A-Z][A-Z0-9_]{0,79}$/.test(error?.code || '') ? error.code : 'ACCOUNT_CLEANUP_PENDING';

/** The independent ledger is the authority; SQLite jobs are resumable progress.
 * Single application process only. Intent is durable before any identity clears.
 * Content cleanup uses the same file queues as submissions and publications.
 */
export class AccountDeletionService {
  constructor({ auth, ledger, store, dataDir, tickets, orders, cleanupAvatars, communitySupport = null,
    invalidate = () => {}, audit = () => {}, cleanupContent = cleanupAccountContent,
    now = Date.now, fault = () => {} }) {
    if (!auth || !ledger || !store || !dataDir || !orders || !cleanupAvatars) throw new Error('Account deletion dependencies required');
    Object.assign(this, { auth, ledger, store, dataDir, tickets, orders, cleanupAvatars, communitySupport, invalidate, audit, cleanupContent, now, fault });
    this.running = new Map();
    ensureAccountDeletionJobs(auth.db);
  }

  isDeletionPending(userId) {
    // Fail closed on a missing/corrupt authority, including after process startup.
    return this.ledger.entries().some(entry => entry.userId === Number(userId));
  }

  async request(user) {
    const account = this.auth.assertActiveUser(user.id);
    const { entry } = this.ledger.append({ eventId: randomUUID(), userId: account.id,
      userCreatedAt: account.created_at, requestedAt: Math.max(this.now(), account.created_at),
      policyVersion: ACCOUNT_DELETION_POLICY, mode: 'retain-published' });
    return this.run(entry);
  }

  run(entry) {
    if (this.running.has(entry.eventId)) return this.running.get(entry.eventId);
    const operation = this.#cleanup(entry).finally(() => this.running.delete(entry.eventId));
    this.running.set(entry.eventId, operation);
    return operation;
  }

  async #cleanup(entry) {
    const db = this.auth.db;
    if (entry.policyVersion !== ACCOUNT_DELETION_POLICY || entry.mode !== 'retain-published') {
      throw new PublicApiError(503, '注销策略需要核对。', 'DELETION_POLICY_UNSUPPORTED');
    }
    const row = this.auth.selectUserById.get(entry.userId);
    if (row && row.created_at !== entry.userCreatedAt) {
      throw new PublicApiError(503, '账号恢复状态需要核对。', 'DELETION_ACCOUNT_INSTANCE_MISMATCH');
    }
    db.prepare(`INSERT OR IGNORE INTO account_deletion_jobs
      (event_id,user_id,user_created_at,requested_at,status) VALUES(?,?,?,?,'pending')`)
      .run(entry.eventId, entry.userId, entry.userCreatedAt, entry.requestedAt);
    const job = db.prepare('SELECT * FROM account_deletion_jobs WHERE event_id=?').get(entry.eventId);
    if (job.user_id !== entry.userId || job.user_created_at !== entry.userCreatedAt) throw new Error('Deletion job identity mismatch');
    try {
      const previousKeys = JSON.parse(job.order_keys);
      if (!Array.isArray(previousKeys) || previousKeys.some(key => typeof key !== 'string')) throw new Error('Invalid deletion order keys');
      const orderKeys = [...new Set([...previousKeys, ...this.orders.listUserOrderKeys(entry.userId)])];
      for (const key of orderKeys) {
        const order = this.orders.get(key);
        if (order && order.user_id !== entry.userId && !(order.user_id === 0 && order.identity_cleared_at != null)) {
          throw Object.assign(new Error('Deletion order ownership mismatch'), { code: 'DELETION_ORDER_OWNER_MISMATCH' });
        }
      }
      db.prepare("UPDATE account_deletion_jobs SET status='pending',order_keys=?,last_error='' WHERE event_id=?")
        .run(JSON.stringify(orderKeys), entry.eventId);
      this.fault('afterIntent');
      if (row) this.auth.deleteAccount(entry.userId, { now: entry.requestedAt });
      this.tickets?.revokeForUser(entry.userId);
      this.orders.cleanupOrders(orderKeys);
      if (this.orders.listUserOrderKeys(entry.userId).length) throw Object.assign(new Error('Payment identity cleanup incomplete'), { code: 'DELETION_ORDER_CLEANUP_INCOMPLETE' });
      this.fault('afterIdentity');
      const content = await this.cleanupContent({ store: this.store, dataDir: this.dataDir, userId: entry.userId, donationOrderKeys: orderKeys });
      this.invalidate();
      this.fault('afterContent');
      // The feature may be disabled during rollback, but existing contribution
      // ownership must still be removed before S5 can report completion.
      if (this.communitySupport) await this.communitySupport.clearAccount(entry.userId);
      else scrubCommunitySupportAccount(db, entry.userId);
      this.fault('afterCommunitySupport');
      const avatars = await this.cleanupAvatars(entry.userId);
      if (avatars?.remaining !== 0 || avatars?.sourceDeleted !== true) throw Object.assign(new Error('Avatar cleanup has not been verified'), { code: 'AVATAR_CLEANUP_PENDING' });
      this.fault('afterAvatars');
      const summary = { content, avatars, policyVersion: entry.policyVersion };
      // Completion audit must be attempted before reporting success. A persisted
      // job alone never implies the request's audit response was delivered.
      this.audit({ userId: entry.userId, action: 'account.delete.cleanup', targetId: entry.eventId,
        result: 'ok', detail: 'identity_and_business_cleanup=complete;historical_caches=not_verified' });
      db.prepare("UPDATE account_deletion_jobs SET status='complete',summary=?,last_error='',completed_at=? WHERE event_id=?")
        .run(JSON.stringify(summary), this.now(), entry.eventId);
      return { deleted: true, pending: false, accountDisabled: true, policyVersion: entry.policyVersion,
        note: '账号及业务关联已清理，内容按原状态保留。历史日志、备份及缓存按注销说明处理。' };
    } catch (error) {
      db.prepare("UPDATE account_deletion_jobs SET status='pending',last_error=?,completed_at=NULL WHERE event_id=?")
        .run(fixedCode(error), entry.eventId);
      return { deleted: false, pending: true, accountDisabled: true, policyVersion: entry.policyVersion,
        note: '账号已停用，资料清理尚在处理中，系统会继续重试；请勿重复提交。' };
    }
  }

  async resume({ all = false } = {}) {
    let complete = 0, pending = 0;
    // At startup, reapply all intents after publication recovery; a restored
    // publication snapshot must not bypass previously completed deletions.
    for (const entry of this.ledger.entries()) {
      const job = this.auth.db.prepare('SELECT status FROM account_deletion_jobs WHERE event_id=?').get(entry.eventId);
      if (!all && job?.status === 'complete') continue;
      const result = await this.run(entry);
      if (result.deleted) complete++; else pending++;
    }
    return { complete, pending };
  }

  health() {
    const pending = this.auth.db.prepare("SELECT COUNT(*) count FROM account_deletion_jobs WHERE status<>'complete'").get().count;
    return { configured: true, pending, ledgerSequence: this.ledger.head().sequence };
  }
}
