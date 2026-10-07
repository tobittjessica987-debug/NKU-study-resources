import { requestUserJson } from "./user-submissions-controller.js";

const UNCONFIRMED = "尚未确认注销结果。请核对账号状态或联系管理员后再决定是否重新提交；页面不会自动重试。";

/**
 * @typedef {{ phase: string, confirmation: string, message: string, canSubmit: boolean }} AccountDeletionState
 */

/**
 * Only explicit server confirmation authorizes leaving the deletion screen.
 * @param {{ request?: typeof requestUserJson, confirmDeletion?: () => boolean, onState?: (state: AccountDeletionState) => void, onDeleted?: (result: { deleted: true }) => void }} options
 */
export function createAccountDeletionController({
  request = requestUserJson,
  confirmDeletion = () => globalThis.confirm("最后确认：真的要永久注销账号吗？此操作不可撤销。"),
  onState = () => {},
  onDeleted = () => {},
} = {}) {
  let state = { phase: "idle", confirmation: "", message: "", canSubmit: false };
  const emit = (next) => {
    state = { ...state, ...next };
    state.canSubmit = !["submitting", "succeeded"].includes(state.phase) && state.confirmation.trim() === "注销";
    onState({ ...state });
  };

  return {
    state: () => ({ ...state }),
    setConfirmation(value) {
      if (["submitting", "succeeded"].includes(state.phase)) return;
      emit({ confirmation: String(value ?? "") });
    },
    async submit() {
      if (!state.canSubmit || confirmDeletion() !== true || !state.canSubmit) return false;
      emit({ phase: "submitting", message: "正在提交注销，请等待服务端确认…" });
      let result;
      try {
        result = await request("/api/v1/me/delete-account", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        });
        if (result?.code !== 0 || result?.ok === false || result?.data?.deleted !== true) {
          throw new Error("服务端未明确确认注销完成。");
        }
      } catch (error) {
        const reason = typeof error?.message === "string" ? error.message : "请求未取得有效结果。";
        emit({ phase: "unconfirmed", message: `${UNCONFIRMED} ${reason}` });
        return false;
      }
      emit({ phase: "succeeded", message: "服务端已确认账号停用，正在返回首页…" });
      onDeleted(result.data);
      return true;
    },
  };
}
