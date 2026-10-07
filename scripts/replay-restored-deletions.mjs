import path from 'node:path';
import { DeletionLedger, readPrivateDeletionHead, assertIndependentLedgerDirectory } from '../server/deletion-ledger.mjs';
import { replayRestoredDeletions, verifyRestoreReplayProof } from '../server/restore-reconciliation.mjs';

const usage = 'Usage: node scripts/replay-restored-deletions.mjs replay|verify --offline --destination=<ABSOLUTE-QUARANTINED-DIR> --ledger-dir=<ABSOLUTE-EXTERNAL-DIR> --fresh-head-file=<ABSOLUTE-0600-INDEPENDENT-HEAD-FILE>';
try {
  const [command, ...raw] = process.argv.slice(2);
  if (command === '--help') { console.log(usage); process.exit(0); }
  if (!['replay', 'verify'].includes(command)) throw new Error(usage);
  const args = new Map();
  for (const arg of raw) {
    const match = /^--(offline|destination|ledger-dir|fresh-head-file)(?:=(.*))?$/.exec(arg);
    if (!match || args.has(match[1]) || match[1] === 'offline' && match[2] !== undefined) throw new Error(usage);
    args.set(match[1], match[2] ?? true);
  }
  if (!args.has('offline')) throw new Error('Stop writes to the restore directory and pass --offline; this assertion is not automatically verified.');
  for (const key of ['destination', 'ledger-dir', 'fresh-head-file']) if (typeof args.get(key) !== 'string' || !path.isAbsolute(args.get(key))) throw new Error(usage);
  const destination = path.resolve(args.get('destination'));
  const freshFile = path.resolve(args.get('fresh-head-file'));
  const relative = path.relative(destination, freshFile);
  if (relative === '' || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) throw new Error('The fresh head cannot come from the restored package or destination.');
  const freshHead = readPrivateDeletionHead(freshFile);
  const directory = assertIndependentLedgerDirectory({ directory: args.get('ledger-dir'), restoreDestination: destination });
  const ledger = DeletionLedger.open({ directory, lineage: freshHead.lineage });
  const report = command === 'replay' ? await replayRestoredDeletions({ destination, ledger, freshHead }) : verifyRestoreReplayProof({ destination, ledger, freshHead });
  console.log(JSON.stringify({ ...report, offlineAssertionVerified: false }, null, 2));
  if (!(command === 'replay' ? report.replayVerified : report.verified)) process.exitCode = 1;
} catch { console.error('Restore deletion reconciliation failed: RESTORE_DELETION_RECONCILIATION_FAILED'); process.exitCode = 1; }
