const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const pkg = require("../package.json");
const nodePath = "../" + pkg.n8n.nodes[0];
const mod = require(nodePath);
const Node = Object.values(mod)[0];
const node = new Node();
const credentialName = node.description.credentials[0].name;
const { decodeRpc, parseArgument } = require(
  path.join(path.dirname(require.resolve(nodePath)), "transport.js"),
);
const operations = require(
  path.join(path.dirname(require.resolve(nodePath)), "operations.json"),
);
const first = operations.find(
  (o) =>
    o.annotations?.readOnlyHint === true &&
    !(o.inputSchema.required || []).length,
);
function context({
  operation = first.name,
  params = {},
  items = [{ json: {} }],
  responses = [],
  continueOnFail = false,
} = {}) {
  const calls = [];
  const ctx = {
    getInputData: () => items,
    getNode: () => ({
      name: "Test",
      type: "test",
      typeVersion: 1,
      position: [0, 0],
      parameters: {},
    }),
    getNodeParameter: (n, i, def) =>
      n === "operation" ? operation : (params[n] ?? def),
    continueOnFail: () => continueOnFail,
    helpers: {
      httpRequestWithAuthentication: async (cred, opts) => {
        calls.push({ cred, opts });
        if (responses.length) {
          const r = responses.shift();
          if (r instanceof Error) throw r;
          return r;
        }
        if (opts.body.method === "initialize")
          return {
            body: {
              jsonrpc: "2.0",
              id: 1,
              result: { protocolVersion: "2025-06-18" },
            },
            headers: { "mcp-session-id": "test-session" },
          };
        if (opts.body.method.startsWith("notifications/"))
          return { body: "", headers: {} };
        return {
          body: {
            jsonrpc: "2.0",
            id: opts.body.id,
            result: { structuredContent: { ok: true }, content: [] },
          },
          headers: {},
        };
      },
    },
  };
  return { ctx, calls };
}
test("negotiates MCP, preserves session and item links, only sends authenticated requests to fixed product endpoint", async () => {
  const { ctx, calls } = context({
    items: [{ json: { a: 1 } }, { json: { a: 2 } }],
  });
  const out = await node.execute.call(ctx);
  assert.deepEqual(
    out[0].map((x) => x.pairedItem),
    [{ item: 0 }, { item: 1 }],
  );
  assert.equal(calls.length, 4);
  assert(calls.every((x) => x.cred === credentialName));
  assert(
    calls.every(
      (x) =>
        x.opts.url.startsWith("https://mcp.") &&
        x.opts.url.endsWith("/mcp") &&
        x.opts.disableFollowRedirect,
    ),
  );
  assert.equal(calls[2].opts.headers["Mcp-Session-Id"], "test-session");
  assert.equal(calls[2].opts.headers["MCP-Protocol-Version"], "2025-06-18");
  assert.deepEqual(calls[2].opts.body.params.arguments, {});
});
test("decodes SSE with keepalives and checks response correlation", () => {
  assert.deepEqual(
    decodeRpc(
      ':keepalive\n\nevent: message\ndata: {"id":4,"result":{"content":[]}}\n\n',
      4,
    ),
    { content: [] },
  );
  assert.throws(() => decodeRpc({ id: 5, result: {} }, 4), /mismatched/);
  assert.throws(
    () => decodeRpc({ id: 4, error: { code: -1, message: "private" } }, 4),
    /rejected/,
  );
});
test("rejects invalid required inputs and preserves false and zero", () => {
  assert.throws(
    () => parseArgument("", { type: "string" }, true, "id"),
    /required/,
  );
  assert.throws(
    () => parseArgument("bad", { type: "array" }, true, "rows"),
    /valid JSON/,
  );
  assert.throws(
    () => parseArgument(3.1, { type: "integer" }, true, "page"),
    /integer/,
  );
  assert.equal(
    parseArgument(false, { type: "boolean" }, false, "enabled"),
    false,
  );
  assert.equal(parseArgument(0, { type: "number" }, false, "count"), 0);
});
test("unknown operations cannot become arbitrary MCP calls", async () => {
  const { ctx, calls } = context({ operation: "not_a_tool" });
  await assert.rejects(() => node.execute.call(ctx), /supported operation/);
  assert.equal(calls.length, 0);
});
test("write operations require explicit confirmation before any network call", async () => {
  const write = operations.find((o) => o.annotations?.readOnlyHint !== true);
  if (!write) return;
  const { ctx, calls } = context({ operation: write.name });
  await assert.rejects(() => node.execute.call(ctx), /confirmation/);
  assert.equal(calls.length, 0);
});
test("MCP tool failures are not returned as success; continue-on-error retains item index", async () => {
  const responses = [
    { body: { id: 1, result: { protocolVersion: "2025-03-26" } }, headers: {} },
    { body: "", headers: {} },
    {
      body: {
        id: 2,
        result: {
          isError: true,
          content: [{ type: "text", text: "raw details" }],
        },
      },
      headers: {},
    },
  ];
  const { ctx } = context({ responses, continueOnFail: true });
  const out = await node.execute.call(ctx);
  assert.match(out[0][0].json.error, /operation failed/i);
  assert.deepEqual(out[0][0].pairedItem, { item: 0 });
  assert(!JSON.stringify(out).includes("raw details"));
});
test("HTTP errors do not leak tokens or headers", async () => {
  const err = new Error("Bearer SECRET_TOKEN");
  err.statusCode = 401;
  err.headers = { authorization: "Bearer SECRET_TOKEN" };
  const { ctx } = context({ responses: [err], continueOnFail: true });
  const out = await node.execute.call(ctx);
  assert.match(out[0][0].json.error, /401/);
  assert(!JSON.stringify(out).includes("SECRET_TOKEN"));
});
test("credentials enable n8n-managed DCR with a fixed resource URL", () => {
  const C = Object.values(require("../" + pkg.n8n.credentials[0]))[0];
  const c = new C();
  assert.deepEqual(c.extends, ["oAuth2Api"]);
  assert.equal(
    c.properties.find((p) => p.name === "useDynamicClientRegistration").default,
    true,
  );
  assert.equal(
    c.properties.find((p) => p.name === "resourceUrl").default,
    c.properties.find((p) => p.name === "serverUrl").default,
  );
  assert(!c.properties.some((p) => p.name === "clientSecret"));
});

test("network errors without status cannot leak request credentials", async () => {
  const { ctx } = context({
    responses: [new Error("request failed Bearer SECRET_TOKEN")],
    continueOnFail: true,
  });
  const out = await node.execute.call(ctx);
  assert.match(out[0][0].json.error, /service request failed/);
  assert(!JSON.stringify(out).includes("SECRET_TOKEN"));
});
