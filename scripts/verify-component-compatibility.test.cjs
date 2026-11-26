const assert = require("node:assert/strict");
const { test } = require("node:test");
const { selectPair, verifyBootstrap } = require("./verify-component-compatibility.cjs");

test("the pair uses the candidate and exact recommended peer from the same catalog snapshot", async () => {
  const branchRevision = "a".repeat(40);
  const bamboo = { version: "2026.11.49" };
  const lotus = { version: "2026.11.35" };
  const bambooBaseline = { branchRevision, revision: 1, version: "2026.11.46", sha256: "b".repeat(64) };
  const lotusBaseline = { branchRevision, revision: 3, version: lotus.version, sha256: "c".repeat(64) };
  const candidate = { kind: "bodhi-single-component-candidate/v1", component: "bamboo", release: bamboo, catalog: bambooBaseline };
  const catalogs = {
    bamboo: { baseline: bambooBaseline },
    lotus: { baseline: lotusBaseline, catalog: { recommendedVersion: lotus.version, releases: [
      { release: lotus }, { release: { version: "2026.11.36" } },
    ] } },
  };
  const read = async (component) => catalogs[component];
  assert.deepEqual(await selectPair(candidate, read), { bamboo, lotus, catalogs: { bamboo: bambooBaseline, lotus: lotusBaseline } });
  await assert.rejects(selectPair({ ...candidate, catalog: { ...bambooBaseline, sha256: "d".repeat(64) } }, read), /changed before/);
  catalogs.lotus.baseline = { ...lotusBaseline, branchRevision: "e".repeat(40) };
  await assert.rejects(selectPair(candidate, read), /snapshot changed/);
  catalogs.lotus.baseline = lotusBaseline;
  catalogs.lotus.catalog.recommendedVersion = null;
  await assert.rejects(selectPair(candidate, read), /no recommended release/);
});

function bootstrapFixture() {
  const subprotocol = { name: "bamboo.v2", encoding: "json" };
  const required = {
    schema_version: 1, server: { product: "bamboo" },
    api: { name: "bamboo.agent", canonical_base_path: "/api/v1", version: 1 },
    realtime: { name: "bamboo.v2", path: "/v2/stream", version: 2, subprotocol },
    capabilities: ["realtime.agent_events.v1"], auth: {
      password_enabled: { capability: "auth.password_cookie.v1", verify_path: "/api/v1/bamboo/access/verify" },
      device_auth_enabled: { capability: "auth.device_bearer.v1", pair_path: "/v2/pair" },
    },
  };
  const actual = {
    schema_version: 1, server: { product: "bamboo", version: "2026.11.49" },
    api: { name: "bamboo.agent", canonical_base_path: "/api/v1", min_version: 1, max_version: 1 },
    realtime: { name: "bamboo.v2", path: "/v2/stream", min_version: 2, max_version: 3, subprotocols: [subprotocol] },
    capabilities: ["realtime.agent_events.v1", "auth.password_cookie.v1", "auth.device_bearer.v1"],
    auth: { policy: "open", request_state: "local_bypass", password_enabled: false, device_auth_enabled: false,
      verify_path: "/api/v1/bamboo/access/verify", pair_path: "/v2/pair" },
  };
  return { required, actual };
}

test("published pair probe rejects a different version, protocol, capability or auth route", () => {
  const { required, actual } = bootstrapFixture();
  assert.doesNotThrow(() => verifyBootstrap(required, actual, "2026.11.49"));
  for (const override of [
    { server: { ...actual.server, version: "2026.11.46" } },
    { api: { ...actual.api, canonical_base_path: "/wrong" } },
    { realtime: { ...actual.realtime, min_version: 3 } },
    { realtime: { ...actual.realtime, subprotocols: [{ name: "bamboo.v2", encoding: "wrong" }] } },
    { capabilities: actual.capabilities.slice(1) },
    { capabilities: actual.capabilities.slice(0, -1) },
    { auth: { ...actual.auth, pair_path: "/wrong" } },
    { auth: { ...actual.auth, request_state: "unauthenticated" } },
  ]) {
    assert.throws(() => verifyBootstrap(required, { ...actual, ...override }, "2026.11.49"));
  }
});
