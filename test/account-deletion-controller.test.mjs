import assert from "node:assert/strict";
import test from "node:test";
import { createAccountDeletionController } from "../src/lib/account-deletion-controller.js";
import { requestUserJson } from "../src/lib/user-submissions-controller.js";

const success = { code: 0, data: { deleted: true } };
const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

function harness({ fetch = async () => response(success), confirmation = true, timeoutMs = 20000 } = {}) {
  const calls = [], states = [], deleted = [];
  let confirmations = 0;
  const controller = createAccountDeletionController({
    request: (url, options) => requestUserJson(url, options, { timeoutMs, fetch: (endpoint, init) => {
      calls.push({ endpoint, init });
      return fetch(endpoint, init);
    } }),
    confirmDeletion: () => { confirmations++; return confirmation; },
    onState: (state) => states.push(state),
    onDeleted: (result) => deleted.push(result),
  });
  return { controller, calls, states, deleted, confirmations: () => confirmations };
}

test("deletion requires the typed phrase and an affirmative final confirmation", async () => {
  const h = harness();
  for (const value of ["", "确认", "注销账号", "注销!", null]) {
    h.controller.setConfirmation(value);
    assert.equal(await h.controller.submit(), false);
  }
  assert.equal(h.calls.length, 0);
  assert.equal(h.confirmations(), 0);
  const cancelled = harness({ confirmation: false });
  cancelled.controller.setConfirmation("注销");
  assert.equal(await cancelled.controller.submit(), false);
  assert.equal(cancelled.calls.length, 0);
  assert.equal(cancelled.controller.state().phase, "idle");
});

test("one explicit deleted:true response completes once and keeps same-origin cookies", async () => {
  const h = harness();
  h.controller.setConfirmation(" 注销 ");
  assert.equal(await h.controller.submit(), true);
  assert.deepEqual(h.deleted, [{ deleted: true }]);
  assert.equal(h.controller.state().phase, "succeeded");
  assert.equal(await h.controller.submit(), false);
  h.controller.setConfirmation("注销");
  assert.equal(h.controller.state().canSubmit, false);
  assert.equal(h.calls.length, 1);
  const { endpoint, init } = h.calls[0];
  assert.equal(endpoint, "/api/v1/me/delete-account");
  assert.equal(init.method, "POST");
  assert.equal(init.body, "{}");
  assert.equal(init.headers["content-type"], "application/json");
  assert.equal(init.credentials, "same-origin");
  assert.equal(init.cache, "no-store");
  assert.equal(init.headers.authorization, undefined);
});

test("slow deletion locks input and rejects duplicate requests while pending", async () => {
  const pending = deferred();
  const h = harness({ fetch: () => pending.promise });
  h.controller.setConfirmation("注销");
  const submitting = h.controller.submit();
  assert.equal(h.controller.state().phase, "submitting");
  assert.equal(h.controller.state().canSubmit, false);
  h.controller.setConfirmation("changed during request");
  assert.equal(h.controller.state().confirmation, "注销");
  assert.equal(await h.controller.submit(), false);
  assert.equal(h.calls.length, 1);
  assert.equal(h.confirmations(), 1);
  pending.resolve(response(success));
  assert.equal(await submitting, true);
  assert.equal(h.deleted.length, 1);
});

test("empty or ambiguous success envelopes never authorize navigation", async () => {
  for (const body of [null, {}, { code: 0 }, { code: 0, data: {} },
    ...[false, null, 1, "true"].map((deleted) => ({ code: 0, data: { deleted } })),
    { code: "0", data: { deleted: true } }, { code: 0, ok: false, data: { deleted: true } },
  ]) {
    const h = harness({ fetch: async () => response(body) });
    h.controller.setConfirmation("注销");
    assert.equal(await h.controller.submit(), false);
    assert.equal(h.controller.state().phase, "unconfirmed");
    assert.match(h.controller.state().message, /尚未确认注销结果/);
    assert.match(h.controller.state().message, /不会自动重试/);
    assert.equal(h.deleted.length, 0);
    assert.equal(h.calls.length, 1);
  }
});

test("401, 5xx, bad JSON and disconnection remain unconfirmed without another POST", async () => {
  const failures = [
    ...[401, 403, 500, 503].map((status) => async () => response(success, status)),
    async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError("synthetic bad JSON"); } }),
    async () => { throw new Error("synthetic offline"); },
  ];
  for (const fetch of failures) {
    const h = harness({ fetch });
    h.controller.setConfirmation("注销");
    assert.equal(await h.controller.submit(), false);
    assert.equal(h.controller.state().phase, "unconfirmed");
    assert.match(h.controller.state().message, /尚未确认注销结果/);
    assert.doesNotMatch(h.controller.state().message, /已确认注销完成/);
    assert.equal(h.deleted.length, 0);
    await Promise.resolve();
    assert.equal(h.calls.length, 1);
  }
});

test("timeout aborts a stalled request and preserves an uncertain result", async () => {
  const h = harness({ timeoutMs: 5, fetch: async (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(new Error("synthetic aborted")));
  }) });
  h.controller.setConfirmation("注销");
  assert.equal(await h.controller.submit(), false);
  assert.equal(h.controller.state().phase, "unconfirmed");
  assert.match(h.controller.state().message, /尚未确认注销结果/);
  assert.match(h.controller.state().message, /请求超时/);
  assert.equal(h.calls[0].init.signal.aborted, true);
  assert.equal(h.calls.length, 1);
  assert.equal(h.deleted.length, 0);
});

test("a manual new submission needs a new confirmation after an uncertain result", async () => {
  let attempt = 0;
  const h = harness({ fetch: async () => response(++attempt === 1 ? {} : success) });
  h.controller.setConfirmation("注销");
  assert.equal(await h.controller.submit(), false);
  h.controller.setConfirmation("");
  assert.equal(await h.controller.submit(), false);
  assert.equal(h.calls.length, 1);
  h.controller.setConfirmation("注销");
  assert.equal(await h.controller.submit(), true);
  assert.equal(h.confirmations(), 2);
  assert.equal(h.calls.length, 2);
});
