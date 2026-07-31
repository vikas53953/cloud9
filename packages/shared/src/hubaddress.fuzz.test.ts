import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyHost,
  formatHubAddress,
  hubWebSocketUrl,
  parseHubAddress,
  reachInWords,
  type HubAddressResult,
  type HubReach,
} from "./hubaddress.js";

const HOSTILE_TEXT = [
  "",
  " ",
  "\u200b",
  "\u200f127.0.0.1",
  "127.0.0.1\u202e",
  "ⅼocalhost",
  "lοcalhost",
  "__proto__",
  "constructor",
  "cloud9://user:pass@100.64.0.1",
  "cloud9://100.64.0.1:0",
  "cloud9://100.64.0.1:-1",
  "cloud9://100.64.0.1:9007199254740992",
  "cloud9://100.64.0.1:NaN",
  "cloud9://100.64.0.1:Infinity",
  "a".repeat(100_000),
] as const;

const IP_BOUNDARIES: ReadonlyArray<readonly [string, HubReach | null]> = [
  ["0.0.0.0", "thisPc"],
  ["0.0.0.1", "public"],
  ["9.255.255.255", "public"],
  ["10.0.0.0", "localNetwork"],
  ["10.255.255.255", "localNetwork"],
  ["11.0.0.0", "public"],
  ["100.63.255.255", "public"],
  ["100.64.0.0", "privateNetwork"],
  ["100.127.255.255", "privateNetwork"],
  ["100.128.0.0", "public"],
  ["126.255.255.255", "public"],
  ["127.0.0.0", "thisPc"],
  ["127.255.255.255", "thisPc"],
  ["128.0.0.0", "public"],
  ["169.253.255.255", "public"],
  ["169.254.0.0", "localNetwork"],
  ["169.254.255.255", "localNetwork"],
  ["169.255.0.0", "public"],
  ["172.15.255.255", "public"],
  ["172.16.0.0", "localNetwork"],
  ["172.31.255.255", "localNetwork"],
  ["172.32.0.0", "public"],
  ["192.167.255.255", "public"],
  ["192.168.0.0", "localNetwork"],
  ["192.168.255.255", "localNetwork"],
  ["192.169.0.0", "public"],
  ["255.255.255.255", "public"],
  ["256.0.0.0", null],
  ["fd7a:115c:a1e0::", "privateNetwork"],
  ["fd7a:115c:a1e0:ffff:ffff:ffff:ffff:ffff", "privateNetwork"],
  ["::1", "thisPc"],
  ["2001:4860:4860::8888", "public"],
];

function assertPlainResult(result: HubAddressResult): void {
  assert.equal(Object.getPrototypeOf(result), Object.prototype);
  if (result.ok) {
    assert.equal(Object.getPrototypeOf(result.address), Object.prototype);
    assert.match(result.address.host, /^[^\u200b\u200e\u200f\u202a-\u202e\u2066-\u2069]+$/u);
    assert.ok(Number.isInteger(result.address.port));
    assert.ok(result.address.port >= 1 && result.address.port <= 65_535);
    assert.notEqual(result.address.reach, "public");
  } else {
    assert.equal(typeof result.reason, "string");
    assert.ok(result.reason.length > 0);
  }
  assert.equal((Object.prototype as { polluted?: unknown }).polluted, undefined);
}

test("parseHubAddress totally refuses hostile values without prototype leakage", () => {
  const protoPayload = Object.create(null) as Record<string, unknown>;
  protoPayload.__proto__ = { polluted: true };
  protoPayload["constructor"] = { prototype: { polluted: true } };
  const malformed: unknown[] = [
    undefined,
    null,
    false,
    true,
    0,
    -1,
    Number.MAX_SAFE_INTEGER,
    NaN,
    Infinity,
    -Infinity,
    0n,
    Symbol("hub"),
    [],
    [1, 2, 3],
    {},
    protoPayload,
    ...HOSTILE_TEXT,
  ];

  for (const input of malformed) {
    let result: HubAddressResult | undefined;
    assert.doesNotThrow(() => {
      result = parseHubAddress(input);
    }, `threw for ${typeof input}`);
    assertPlainResult(result as HubAddressResult);
  }
});

test("classifyHost covers every private and loopback IPv4 boundary", () => {
  for (const [host, expected] of IP_BOUNDARIES) {
    assert.doesNotThrow(() => classifyHost(host), host);
    assert.equal(classifyHost(host), expected, host);
  }
  for (const host of HOSTILE_TEXT) {
    const result = classifyHost(host);
    assert.ok(result === null || ["thisPc", "privateNetwork", "localNetwork", "public"].includes(result));
  }
});

test("checked addresses format, dial, and round-trip as safe strings", () => {
  const accepted = [
    "localhost:1",
    "127.255.255.255:65535",
    "10.0.0.0:8787",
    "100.64.0.0:8787",
    "100.127.255.255:8787",
    "[fd7a:115c:a1e0::1]:8787",
    "node.tail123.ts.net:8787#inv_0123456789abcdef",
  ];

  for (const input of accepted) {
    const parsed = parseHubAddress(input);
    assert.equal(parsed.ok, true, input);
    if (!parsed.ok) continue;
    const formatted = formatHubAddress(parsed.address);
    const socket = hubWebSocketUrl(parsed.address);
    assert.match(formatted, /^cloud9:\/\//);
    assert.match(socket, /^ws:\/\//);
    assert.ok(!formatted.includes("@"));
    assert.ok(!socket.includes("@"));
    assert.deepEqual(parseHubAddress(formatted), parsed);
  }
});

test("reachInWords returns a bounded plain sentence for every reach", () => {
  for (const reach of ["thisPc", "privateNetwork", "localNetwork", "public"] as const) {
    const words = reachInWords(reach);
    assert.equal(typeof words, "string");
    assert.ok(words.length >= 10 && words.length <= 100);
  }
});
