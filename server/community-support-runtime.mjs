import { PublicApiError } from './public-api-errors.mjs';
import { publicResourceDto } from './public-api-dto.mjs';
import { CommunitySupportService, hasCommunitySupportLedger, scrubCommunitySupportAccount } from './community-support-service.mjs';

const unavailable = () => new PublicApiError(503, '贡献统计暂不可用。', 'SUPPORT_UNAVAILABLE');
const disabled = () => ({ version: 1, enabled: false });

export function communitySupportLevel(flowers, coins) {
  if (![flowers, coins].every(value => Number.isSafeInteger(value) && value >= 0)) throw unavailable();
  return 1 + Math.floor(Math.min(flowers, coins) / 10);
}

function publicFile(url, { guide = false } = {}) {
  try {
    const value = new URL(url);
    return value.protocol === 'https:' && value.hostname === 'resources.nkustudy.top'
      && !value.port && !value.username && !value.password && !value.search && !value.hash
      && (!guide || value.pathname.startsWith('/guide-sources/'));
  } catch { return false; }
}

/** Resolve current public catalogue IDs; never accept a client supplied address. */
export function createSupportResourceValidator({ readManifest, learningCompass, publicResourceOrigin = 'https://resources.nkustudy.top' }) {
  return body => {
    if (body.kind === 'guide_source') {
      const source = learningCompass?.publicDownloadSourceById(body.resource_id);
      return !!source && publicFile(source.file_url, { guide: true });
    }
    const manifest = readManifest();
    const course = manifest.courses?.find(item => item.uid === body.course_id);
    if (!course) return false;
    for (const section of course.sections || []) {
      for (const file of section.files || []) {
        if (String(file.path || '').split('/').at(-1)?.toLowerCase() === '.openlist') continue;
        const resource = publicResourceDto({ manifest, course, section, file, configuredOrigin: publicResourceOrigin });
        if (resource.id === body.resource_id && publicFile(resource.download_url)) return true;
      }
    }
    return false;
  };
}

/** Default-off lifecycle. An add-on failure disables statistics, not the website. */
export function createCommunitySupportRuntime({ db, store, reviewsPath, readReviews, assertActiveUser,
  readManifest, learningCompass, publicResourceOrigin, env = process.env, onError = () => {} }) {
  let service = null;
  let ready = false;
  let reported = false;
  const enabled = env.COMMUNITY_SUPPORT_ENABLED === '1';
  const downloadReporting = env.COMMUNITY_SUPPORT_DOWNLOAD_REPORTING === '1';
  const personalStats = env.COMMUNITY_SUPPORT_PERSONAL_STATS === '1';
  const requirePublicBaseline = env.COMMUNITY_SUPPORT_BASELINE_REQUIRED === '1';
  function report() { if (!reported) { reported = true; onError('SUPPORT_UNAVAILABLE'); } }
  function requireReady() { if (!ready || !service) throw unavailable(); return service; }
  return {
    async initialize() {
      try {
        const installed = hasCommunitySupportLedger(db);
        // Deployment sets this only for the explicit historical-public migration.
        // Restoring a pre-migration backup must not silently initialize a new base.
        if (requirePublicBaseline && !installed) throw unavailable();
        if (!enabled && !installed) return { configured: false, ready: false };
        const previous = readReviews();
        // Losing the source marker must never silently establish a new baseline.
        if (installed && !previous.community_support_ledger) throw unavailable();
        // Likewise, an existing marker with a missing database is a restore or
        // interrupted installation, never permission to zero the download ledger.
        if (!installed && previous.community_support_ledger) throw unavailable();
        if (installed && !db.prepare('SELECT singleton FROM community_support_meta WHERE singleton=1').get()) throw unavailable();
        await store.initializeCommunitySupport(reviewsPath);
        service = new CommunitySupportService({ db, readReviews: () => { store.assertProjectionReadable(); return readReviews(); }, assertActiveUser, enabled, downloadReporting, personalStats, requirePublicBaseline,
          validateResource: createSupportResourceValidator({ readManifest, learningCompass, publicResourceOrigin }) });
        service.initializeReviews(readReviews());
        store.afterReviewsWrite = () => service.reconcileReviews(readReviews());
        store.onProjectionError = report;
        ready = true;
        return { configured: true, ready: true };
      } catch {
        ready = false;
        report();
        return { configured: true, ready: false };
      }
    },
    snapshot() {
      if (!ready) return disabled();
      try { const value = service.snapshot(); reported = false; return value; }
      catch { report(); return disabled(); }
    },
    recordDownload(body, context) { return requireReady().recordDownload(body, context); },
    myStats(userId) { return requireReady().myStats(userId); },
    clearAccount(userId) { return scrubCommunitySupportAccount(db, userId); },
  };
}
