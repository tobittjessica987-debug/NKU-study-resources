/** Use for controls rendered by the current page; optional controls should keep
 * a nullable query and an explicit guard. A missing/wrong control must not be
 * silently treated as a successful action. */
export function requireElement<T extends Element>(
  selector: string,
  kind: { new(): T },
  root: ParentNode = document,
): T {
  const element = root.querySelector(selector);
  if (!(element instanceof kind)) throw new Error(`页面控件不可用：${selector}`);
  return element;
}

export function errorMessage(error: unknown, fallback = "操作未完成，请重试。") {
  return error instanceof Error && error.message ? error.message : fallback;
}

const htmlEntities: Record<string, string> = {
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
};
export function escapeHtml(value: unknown) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => htmlEntities[character] ?? character);
}
