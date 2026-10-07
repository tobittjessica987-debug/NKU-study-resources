import { DeletionLedger, deletionLedgerHead, validateDeletionLedgerHead } from './deletion-ledger.mjs';

const equalHead = (first, second) => first.lineage === second.lineage && first.sequence === second.sequence && first.hash === second.hash;

/**
 * Read-only prerequisite check, not deletion replay or activation approval.
 * freshHead must come from an independent current source asserted by the caller.
 * Matching it checks consistency only: hashes/signatures cannot prove freshness,
 * and this function neither accesses nor verifies that external source.
 * It reads the caller-selected private ledger, whose production/test origin is
 * unknown here; it never opens restored SQLite, runtime JSON or a destination.
 */
export function verifyRestoreReconciliation({ ledger, freshHead, backupHead } = {}) {
  const report = {
    verified: false,
    evidenceBoundary: 'ledger_chain_and_caller_asserted_head_only',
    ledgerVerified: false,
    freshHeadMatched: false,
    backupPrefixVerified: false,
    externalFreshnessVerified: false,
    replayVerified: false,
    restoredDataVerified: false,
    quarantineReleased: false,
    restoreDestinationRead: false,
    restoreDestinationModified: false,
    onlyLedgerRead: true,
    failures: [],
  };
  const fail = code => report.failures.push({ code });
  let fresh;
  let backup;
  let snapshot;
  if (freshHead === undefined || freshHead === null) fail('FRESH_LEDGER_HEAD_REQUIRED');
  else {
    try { fresh = validateDeletionLedgerHead(freshHead); }
    catch { fail('FRESH_LEDGER_HEAD_INVALID'); }
  }
  // Legacy snapshots with no checkpoint have unknown coverage. No automatic pass.
  if (backupHead === undefined || backupHead === null) fail('BACKUP_LEDGER_HEAD_REQUIRED');
  else {
    try { backup = validateDeletionLedgerHead(backupHead); }
    catch { fail('BACKUP_LEDGER_HEAD_INVALID'); }
  }
  try {
    if (!(ledger instanceof DeletionLedger)) throw new Error('Dedicated ledger required');
    snapshot = ledger.snapshot();
    report.currentHead = deletionLedgerHead(snapshot);
    report.ledgerVerified = true;
  } catch { fail('DELETION_LEDGER_UNAVAILABLE'); }

  if (snapshot && fresh) {
    if (fresh.lineage !== snapshot.lineage) fail('FRESH_LEDGER_LINEAGE_MISMATCH');
    else if (!equalHead(fresh, report.currentHead)) fail('FRESH_LEDGER_HEAD_MISMATCH');
    else report.freshHeadMatched = true;
  }
  if (snapshot && backup) {
    if (backup.lineage !== snapshot.lineage) fail('BACKUP_LEDGER_LINEAGE_MISMATCH');
    else if (backup.sequence > report.currentHead.sequence) fail('BACKUP_LEDGER_HEAD_AHEAD');
    else {
      const prefix = backup.sequence === 0
        ? deletionLedgerHead({ ...snapshot, entries: [] })
        : { lineage: snapshot.lineage, sequence: backup.sequence, hash: snapshot.entries[backup.sequence - 1].hash };
      if (!equalHead(backup, prefix)) fail('BACKUP_LEDGER_NOT_PREFIX');
      else {
        report.backupPrefixVerified = true;
        report.entriesAfterBackup = report.currentHead.sequence - backup.sequence;
      }
    }
  }
  report.verified = report.ledgerVerified && report.freshHeadMatched && report.backupPrefixVerified && report.failures.length === 0;
  return report;
}
