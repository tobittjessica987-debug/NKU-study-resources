import type { Course, ResourceFile, ResourceSection } from "./resources";

// The editor accepts newly-created courses before the server assigns their UID.
export type AdminFile = ResourceFile & { updatedAt?: string };
export type AdminSection = Omit<ResourceSection, "files"> & { files: AdminFile[] };
export type AdminCourse = Omit<Course, "uid" | "sections" | "updated"> & {
  uid?: string;
  updated?: string;
  shortName?: string;
  aliases?: string[];
  sections: AdminSection[];
};
export type AdminManifest = {
  version: number;
  updated: string;
  repository: string;
  resourceRoot: string;
  hiddenMetaTags?: string[];
  courses: AdminCourse[];
};
export type ContentPage = { title?: string; content?: string; announcement?: string };
export type LinkInfo = { name?: string; url?: string; description?: string };
export type LinksDocument = {
  title?: string; intro?: string; mutualTitle?: string; recommendedTitle?: string;
  siteInfoTitle?: string; siteInfo?: LinkInfo;
  links?: (LinkInfo & { id?: string; type?: string; hidden?: boolean })[];
};
export type FooterDocument = {
  enabled?: boolean; showVisitCount?: boolean; useRealVisitCount?: boolean;
  visitCount?: string | number; startedAt?: string; copyrightText?: string;
  maintainers?: { label: string; url: string }[];
};
export type DonationRecord = { date: string; nickname: string; usage: string; order_key?: string };
export type DonateDocument = ContentPage & { amounts?: number[]; records?: DonationRecord[] };
export type DonatePayDocument = {
  enabled?: boolean; mchid?: string; appid?: string; serialNo?: string;
  privateKey?: string; apiV3Key?: string; publicKey?: string;
};
export type DonationOrder = {
  created_at: number; amount_total: number; out_trade_no: string;
  transaction_id?: string; nickname?: string; remark?: string; status: string; source: string;
};
export type DonationSummary = {
  paid_count: number; paid_total_fen: number; pending_count: number;
  by_source: Record<string, { count: number; total_fen: number }>;
};
export type EditorSettingsDocument = {
  user?: { toolbar?: string[] }; admin?: { toolbar?: string[] };
};
export type WebdavDestination = {
  id: string; name?: string; url?: string; username?: string; enabled?: boolean;
  passwordConfigured?: boolean; password?: string;
};
export type BackupDocument = {
  autoEnabled?: boolean; dailyTime?: string; r2DataBackup?: boolean; webdavEnabled?: boolean;
  includeSiteData?: boolean; includeServerConfig?: boolean;
  includeCourseFiles?: boolean; encryptionPasswordConfigured?: boolean; encryptionPassword?: string;
  destinations?: WebdavDestination[];
};
export type AdminAccount = {
  id: number; username: string; permissions: string[]; enabled: boolean;
  mustChangePassword: boolean; lastLoginAt?: number | null;
};
export type AccountsDocument = {
  accounts: AdminAccount[]; rolePresets?: Record<string, string[]>; permissionPoints?: string[];
};
export type MpUser = {
  id: number; nickname?: string; avatar_url?: string; openid_masked: string;
  blocked?: boolean; login_count?: number; created_at: number; last_login_at?: number;
};
export type MpUsersDocument = { total: number; logins_since: number; users: MpUser[] };
export type AuditRecord = {
  at: string | number; username: string; action: string; status: number;
  ip?: string; target?: string; detail?: string;
};
export type AuditDocument = { items: AuditRecord[]; total: number; page_size: number; page: number };
export type SessionDocument = {
  username?: string; permissions?: string[]; mustChangePassword?: boolean;
  pendingReviews?: number; openFeedback?: number;
};
export type ServiceKey = {
  id: string; name: string; key_prefix: string; enabled: boolean; note?: string;
  created_at?: string; limits: { daily_quota: number };
};
export type ServiceSettings = { max_limit: number; max_window_ms: number; default_daily_quota: number };
export type ServiceKeysDocument = { settings: ServiceSettings; services: ServiceKey[] };
export type AiSettings = {
  enabled: boolean; has_api_key: boolean; api_key_masked: string; seeded_from_env: boolean;
  base_url: string; model: string; max_tokens: number; daily_limit_per_user: number;
  minute_limit_per_user: number; daily_limit_global: number;
};
export type AiSettingsWrite = {
  settings: Omit<AiSettings, "has_api_key" | "api_key_masked" | "seeded_from_env">;
  api_key?: string; clear_api_key?: boolean;
};
export type StatsPage = { total?: number; days?: Record<string, number> };
export type VisitStatsResponse = {
  summary?: { total?: number; today?: number };
  stats?: {
    days?: Record<string, number>; pages?: Record<string, StatsPage>;
    visitors?: Record<string, { lastSeen?: number; ip?: string; actorHash?: string }>;
    updatedAt?: string;
  };
};
export type AdminActionResponse = {
  ok?: boolean; error?: string; errors?: string[]; message?: string;
  warnings?: string[];
};
export type DataResponse<T> = AdminActionResponse & { data: T };
export type ContentResponse<T> = DataResponse<T> & { revision: string };
export type ManifestResponse = AdminActionResponse & { manifest: AdminManifest; revision: string };
export type DirectoryMove = { courseUid: string; oldBasePath: string; newBasePath: string };
export type ManifestWriteExtra = { moves?: DirectoryMove[]; fileDeletes?: { courseUid: string; paths: string[] }[] };
export type MarkdownFieldOptions = { height?: number; placeholder?: string; mode?: "sv" | "ir" | "wysiwyg"; owner?: string };
export type MarkdownToolbarRoot = HTMLElement & { __nkustudyToolbarObserver?: MutationObserver };
export type UploadFile = File & { relativePath?: string };

type ElementConstructor<T extends Element> = { new (...args: never[]): T };

/** Required nodes come from this page's markup or the caller's freshly-rendered subtree. */
export function requireAdminElement<T extends Element>(selector: string, constructor: ElementConstructor<T>, root: ParentNode = document): T {
  const element = root.querySelector(selector);
  if (!(element instanceof constructor)) throw new Error(`管理页面缺少预期元素：${selector}`);
  return element;
}

/** Optional/dynamic nodes preserve absence rather than throwing. */
export function findAdminElement<T extends Element>(selector: string, constructor: ElementConstructor<T>, root: ParentNode = document): T | null {
  const element = root.querySelector(selector);
  return element instanceof constructor ? element : null;
}

export function adminElements<T extends Element>(selector: string, constructor: ElementConstructor<T>, root: ParentNode = document): T[] {
  return Array.from(root.querySelectorAll(selector)).filter((element): element is T => element instanceof constructor);
}

export function adminErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
