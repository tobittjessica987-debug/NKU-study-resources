import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { AvatarStore } from '../server/avatar-store.mjs';

const usage = 'Usage: node scripts/confirm-avatar-upload-settled.mjs --offline --confirm-remote-put-terminal --state-db=<ABSOLUTE-PRIVATE-DB> --avatar-id=<ID> --evidence-file=<ABSOLUTE-PRIVATE-EVIDENCE>';
let store;
function privateFile(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || process.platform === 'win32') throw new Error('Private absolute file required');
  const file = path.resolve(value);
  let current = path.parse(file).root;
  for (const part of file.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error('Unsafe path');
  }
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.mode & 0o077) throw new Error('Private regular file required');
  return file;
}
try {
  if (process.argv.slice(2).includes('--help')) { console.log(usage); process.exit(0); }
  const args = new Map();
  for (const raw of process.argv.slice(2)) {
    const match = /^--(offline|confirm-remote-put-terminal|state-db|avatar-id|evidence-file)(?:=(.*))?$/.exec(raw);
    if (!match || args.has(match[1])) throw new Error('Invalid arguments');
    args.set(match[1], match[2] ?? true);
  }
  if (args.get('offline') !== true || args.get('confirm-remote-put-terminal') !== true
    || !/^[A-Za-z0-9_-]{16,64}$/.test(args.get('avatar-id') || '')) throw new Error('Explicit assertions required');
  const dbPath = privateFile(args.get('state-db'));
  const evidenceFile = privateFile(args.get('evidence-file'));
  const evidenceSize = fs.statSync(evidenceFile).size;
  if (evidenceSize < 1 || evidenceSize > 1024 * 1024 || dbPath === evidenceFile) throw new Error('Evidence required');
  const evidenceSha256 = createHash('sha256').update(fs.readFileSync(evidenceFile)).digest('hex');
  store = new AvatarStore({ dbPath });
  store.db.pragma('synchronous = FULL');
  store.db.transaction(() => {
    store.db.exec(`CREATE TABLE IF NOT EXISTS avatar_cleanup_attestations (
      id INTEGER PRIMARY KEY AUTOINCREMENT, avatar_id TEXT NOT NULL, evidence_sha256 TEXT NOT NULL, at INTEGER NOT NULL
    )`);
    store.confirmUploadSettledForCleanup(args.get('avatar-id'));
    store.db.prepare('INSERT INTO avatar_cleanup_attestations(avatar_id,evidence_sha256,at) VALUES(?,?,?)')
      .run(args.get('avatar-id'), evidenceSha256, Date.now());
  }).immediate();
  console.log(JSON.stringify({ accepted: true, operatorAttestationRecorded: true, externalEvidenceAutomaticallyVerified: false,
    offlineAssertionVerified: false, avatarDeletionVerified: false, cleanupRetryRequired: true }));
} catch { console.error('Avatar upload settlement confirmation failed: AVATAR_SETTLEMENT_CONFIRMATION_FAILED'); process.exitCode = 1; }
finally { store?.close(); }
