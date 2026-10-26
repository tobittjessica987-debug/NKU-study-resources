import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { once } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { createPublicApiHandler } from "../server/public-api-router.mjs";
import { PublicApiError } from "../server/public-api-errors.mjs";
import { MAX_BODY_BYTES, readPublicJsonBody } from "../server/read-json-body.mjs";

const AI_PATH = "/api/v1/guide-assistant/answers";
const AUTHORIZATION = "Bearer in-memory-test-user";

async function fixture(t) {
  const calls = { read: 0, answer: [], favorite: [] };
  const identity = {
    verifyToken: (authorization) => authorization === AUTHORIZATION ? { id: 7 } : null,
    requireUser(authorization) {
      const user = this.verifyToken(authorization);
      if (!user) throw new PublicApiError(401, "请先登录。", "AUTH_REQUIRED");
      return user;
    },
  };
  const handler = createPublicApiHandler({
    service: { guideAssistantAnswer: async (userId, body) => {
      calls.answer.push({ userId, body });
      return { answer: "本地传输测试" };
    } },
    mpAuthService: identity,
    mpFavoritesService: { add(user, courseId) {
      calls.favorite.push({ userId: user.id, courseId });
      return { saved: true };
    } },
    readBody(req, options) {
      calls.read += 1;
      return readPublicJsonBody(req, options);
    },
    clientIp: () => "127.0.0.1",
  });
  const server = createServer((req, res) => {
    handler(req, res, new URL(req.url, "http://127.0.0.1")).catch((error) => res.destroy(error));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  async function post(body, { path = AI_PATH, authenticated = true } = {}) {
    const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body);
    return new Promise((resolve, reject) => {
      const req = request({ hostname: "127.0.0.1", port: server.address().port, path,
        method: "POST", agent: false,
        headers: { "content-type": "application/json", "content-length": bytes.length,
          ...(authenticated ? { authorization: AUTHORIZATION } : {}) },
      }, (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("error", reject);
        res.on("end", () => {
          try { resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }); }
          catch (error) { reject(error); }
        });
      });
      req.on("error", reject);
      req.setTimeout(5000, () => req.destroy(new Error("Loopback request timed out")));
      req.end(bytes);
    });
  }
  return { calls, post };
}

function bodyWithBytes(size) {
  const json = JSON.stringify({ question: "课程要求" });
  return json + " ".repeat(size - Buffer.byteLength(json));
}

test("AI transport accepts a full nine-round Chinese history above 57 KB without text loss", async (t) => {
  const { calls, post } = await fixture(t);
  const body = { question: "问".repeat(1000), history: Array.from({ length: 18 }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant", content: "中".repeat(1000),
  })) };
  const bytes = JSON.stringify(body);
  assert.ok(Buffer.byteLength(bytes) > 57000);
  assert.ok(Buffer.byteLength(bytes) < 65536);
  assert.equal((await post(bytes)).status, 200);
  assert.deepEqual(calls.answer, [{ userId: 7, body }]);
});

test("AI transport accepts exactly 65536 bytes", async (t) => {
  const { calls, post } = await fixture(t);
  assert.equal((await post(bodyWithBytes(65536))).status, 200);
  assert.equal(calls.answer.length, 1);
});

test("AI transport returns JSON 413 at 65537 bytes without resetting the socket", async (t) => {
  const { calls, post } = await fixture(t);
  const result = await post(bodyWithBytes(65537));
  assert.equal(result.status, 413);
  assert.equal(result.body.code, "AI_BODY_TOO_LARGE");
  assert.match(result.headers["content-type"], /application\/json/);
  assert.equal(calls.answer.length, 0);
});

for (const [label, bytes] of [
  ["invalid JSON", Buffer.from('{"question":')],
  ["malformed UTF-8", Buffer.concat([Buffer.from('{"question":"'), Buffer.from([0xc3, 0x28]), Buffer.from('"}')])],
  ["encoded replacement character", Buffer.from('{"question":"\\uFFFD"}')],
  ["literal replacement character", Buffer.from(JSON.stringify({ question: "\uFFFD" }))],
]) {
  test(`AI transport rejects ${label} with JSON 400`, async (t) => {
    const { calls, post } = await fixture(t);
    const result = await post(bytes);
    assert.equal(result.status, 400);
    assert.equal(result.body.code, "INVALID_JSON");
    assert.equal(calls.answer.length, 0);
  });
}

test("AI authenticates before reading an oversized body or calling the answer service", async (t) => {
  const { calls, post } = await fixture(t);
  const result = await post(bodyWithBytes(65537), { authenticated: false });
  assert.equal(result.status, 401);
  assert.equal(result.body.code, "AUTH_REQUIRED");
  assert.equal(calls.read, 0);
  assert.equal(calls.answer.length, 0);
});

test("non-AI route keeps its existing default 2000000-byte parser capacity", async (t) => {
  const { calls, post } = await fixture(t);
  const json = JSON.stringify({ course_id: "fixture-course" });
  const result = await post(json + " ".repeat(MAX_BODY_BYTES - Buffer.byteLength(json)), { path: "/api/v1/favorites" });
  assert.equal(result.status, 200);
  assert.deepEqual(calls.favorite, [{ userId: 7, courseId: "fixture-course" }]);
  assert.equal(calls.answer.length, 0);
});

test("public helper cannot disable replacement-character checks through transport options", async () => {
  const req = new PassThrough();
  const pending = readPublicJsonBody(req, { rejectReplacementCharacters: false });
  req.end(JSON.stringify({ question: "\uFFFD" }));
  await assert.rejects(pending, (error) => error.statusCode === 400 && /U\+FFFD/.test(error.message));
});
