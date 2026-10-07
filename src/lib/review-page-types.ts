/** The public projection preserves legacy field values; consumers coerce them. */
export interface PublicReview {
  id?: unknown;
  courseTitle?: unknown;
  teacher?: unknown;
  rating?: unknown;
  content?: unknown;
  createdAt?: unknown;
}

export interface ReviewGroup {
  key: string;
  courseTitle: string;
  teacher: string;
  reviews: PublicReview[];
  average: number;
}

interface ReviewRules {
  announcement?: unknown;
  minLength?: unknown;
  moderationRequired?: unknown;
  submission_hint?: unknown;
}

export interface PublicReviewList {
  ok: true;
  reviews: PublicReview[];
  rules?: ReviewRules;
}

export interface ReviewEditorSettings {
  user?: { toolbar: string[] };
  admin?: { toolbar: string[] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPublicReview(value: unknown): value is PublicReview {
  // The legacy public projection does not normalize text, score or date types.
  // Do not add a new field/range gate that can hide an otherwise public list.
  return isRecord(value);
}

export function readPublicReviewList(value: unknown): PublicReviewList {
  if (!isRecord(value) || value.ok !== true || !Array.isArray(value.reviews) || !value.reviews.every(isPublicReview)) {
    throw new Error("评价列表返回结果不完整。请重试。");
  }
  return { ok: true, reviews: value.reviews, rules: isRecord(value.rules) ? value.rules : undefined };
}

export function readReviewEditorSettings(value: unknown): ReviewEditorSettings | null {
  if (!isRecord(value)) return null;
  const settings: ReviewEditorSettings = {};
  for (const mode of ["user", "admin"] as const) {
    const section = value[mode];
    if (isRecord(section) && Array.isArray(section.toolbar) && section.toolbar.every((entry) => typeof entry === "string")) {
      settings[mode] = { toolbar: section.toolbar };
    }
  }
  return settings;
}

/** These nodes are declared unconditionally in the pages that call this. */
export function requiredReviewElement<T extends HTMLElement>(selector: string, elementType: { new(): T }): T {
  const element = document.querySelector(selector);
  if (!(element instanceof elementType)) throw new Error(`评价页面缺少必要元素：${selector}`);
  return element;
}

export function reviewPageErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}
