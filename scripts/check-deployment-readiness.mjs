const args = process.argv.slice(2);
const help = `Usage: node scripts/check-deployment-readiness.mjs [--synthetic-localhost-origin=http://127.0.0.1:<PORT>]
Run with the candidate service identity and its existing production environment. No values are loaded from environment files.
Required check-only environment: S2_ACCESS_LOG (actual existing Caddy log file), ENTRY_LOG_ARCHIVE_DIR (existing archive timer destination), DEPLOYMENT_MIN_FREE_BYTES (operator capacity budget).
Existing runtime, backup and DELETION_LEDGER_DIR configuration must be present. No secrets belong in arguments.
The optional origin is an explicit assertion that the service is isolated and synthetic; only literal 127.0.0.1/[::1] HTTP origins with a port are allowed. It sends two unauthenticated GETs, follows no redirects, and prints no response body.
Default: no HTTP, cloud or notification requests. No files, permissions, tables or logs are created or repaired. SQLite read locks may touch existing SHM metadata; WAL without existing WAL/SHM is pending and is not opened.
Exit 0: requested local static/synthetic checks passed; production still pending. Exit 1: a requested local check failed or remains pending. Exit 2: invalid arguments. No exit code means production acceptance.`;
function failure(code) {
  return { schema: 'nkustudy-deployment-readiness-v1', readOnly: true,
    localStaticReady: false, syntheticRequested: false, syntheticReady: null,
    localChecksPassed: false, productionReady: false, ops20Accepted: false, productionStatus: 'pending',
    checks: [{ id: 'cli.arguments', scope: 'static', status: 'fail', code }] };
}
if (args.length === 1 && args[0] === '--help') console.log(help);
else {
  const match = args.length === 1 && /^--synthetic-localhost-origin=(.+)$/.exec(args[0]);
  if (args.length && !match) {
    console.log(JSON.stringify(failure('UNSUPPORTED_ARGUMENTS')));
    process.exitCode = 2;
  } else {
    try {
      // runtime-config validates production paths while the module is imported.
      // Keep that initialization inside the same redacted exception boundary.
      const { deploymentReadiness } = await import('../server/deployment-readiness.mjs');
      const report = await deploymentReadiness({ ...(match ? { syntheticLocalhostOrigin: match[1] } : {}) });
      console.log(JSON.stringify(report, null, 2));
      if (!report.localChecksPassed) process.exitCode = 1;
    } catch {
      // Exception strings may contain private paths/configuration or SQLite data.
      console.log(JSON.stringify(failure('READINESS_UNAVAILABLE')));
      process.exitCode = 1;
    }
  }
}
