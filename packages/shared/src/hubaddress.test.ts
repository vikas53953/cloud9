import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseHubAddress, classifyHost, hubWebSocketUrl, formatHubAddress,
  reachInWords, DEFAULT_HUB_PORT,
} from "./hubaddress.js";

function ok(input: string) {
  const r = parseHubAddress(input);
  assert.equal(r.ok, true, `expected ${input} to parse, got: ${r.ok ? "" : r.reason}`);
  return r.ok ? r.address : (undefined as never);
}
function no(input: unknown) {
  const r = parseHubAddress(input);
  assert.equal(r.ok, false, `expected ${String(input)} to be refused`);
  return r.ok ? "" : r.reason;
}

test("a full Tailscale link with an invite parses whole", () => {
  const a = ok("cloud9://100.101.102.103:9001#inv_AbCdEf0123456789xyz");
  assert.equal(a.host, "100.101.102.103");
  assert.equal(a.port, 9001);
  assert.equal(a.invite, "inv_AbCdEf0123456789xyz");
  assert.equal(a.reach, "privateNetwork");
});

test("a bare host takes the default port and no invite", () => {
  const a = ok("100.90.80.70");
  assert.equal(a.port, DEFAULT_HUB_PORT);
  assert.equal(a.invite, undefined);
  assert.equal(a.reach, "privateNetwork");
});

test("a tailnet MagicDNS name is private", () => {
  const a = ok("vikas-pc.tail9b2c.ts.net:8787");
  assert.equal(a.host, "vikas-pc.tail9b2c.ts.net");
  assert.equal(a.reach, "privateNetwork");
});

test("localhost is this-PC", () => {
  assert.equal(ok("localhost:8787").reach, "thisPc");
  assert.equal(ok("127.0.0.1").reach, "thisPc");
});

test("LAN ranges are local-network", () => {
  assert.equal(ok("192.168.1.50").reach, "localNetwork");
  assert.equal(ok("10.0.0.9").reach, "localNetwork");
  assert.equal(ok("172.16.4.4").reach, "localNetwork");
  assert.equal(ok("172.31.255.1").reach, "localNetwork");
});

test("172.32 is NOT private — it is public and refused", () => {
  // 172.16–172.31 is the private block; 172.32 is outside it.
  const reason = no("172.32.0.1");
  assert.match(reason, /private network/i);
});

test("a public IP is refused with the private-network sentence", () => {
  const reason = no("8.8.8.8:8787");
  assert.match(reason, /open internet|private network/i);
});

test("a public hostname is refused", () => {
  assert.match(no("cloud9.example.com"), /private network/i);
});

test("the invite may be attached three ways, all folded", () => {
  const code = "inv_ZzYyXx9988776655aa";
  assert.equal(ok(`100.64.0.1#${code}`).invite, code);
  assert.equal(ok(`100.64.0.1?invite=${code}`).invite, code);
  assert.equal(ok(`100.64.0.1/${code}`).invite, code);
});

test("a malformed invite is refused, not silently dropped", () => {
  assert.match(no("100.64.0.1#inv_short"), /invite/i);
});

test("Tailscale 100.64/10 boundaries", () => {
  assert.equal(classifyHost("100.64.0.0"), "privateNetwork");
  assert.equal(classifyHost("100.127.255.255"), "privateNetwork");
  // 100.63 and 100.128 are outside the CGNAT block → public.
  assert.equal(classifyHost("100.63.0.1"), "public");
  assert.equal(classifyHost("100.128.0.1"), "public");
});

test("octets over 255 are not an address at all", () => {
  assert.equal(classifyHost("300.1.1.1"), null);
  assert.match(no("999.1.1.1"), /isn't a computer name/i);
});

test("empty and junk are refused in plain words", () => {
  assert.match(no(""), /paste the address/i);
  assert.match(no("   "), /paste the address/i);
  assert.match(no(42), /paste the address/i);
  assert.match(no("cloud9://"), /no computer name/i);
});

test("a non-numeric port is caught", () => {
  assert.match(no("100.64.0.1:abc"), /port number/i);
  assert.match(no("100.64.0.1:70000"), /out of range/i);
});

test("IPv6 loopback and Tailscale v6", () => {
  assert.equal(ok("[::1]:8787").reach, "thisPc");
  assert.equal(classifyHost("fd7a:115c:a1e0::1"), "privateNetwork");
});

test("the WebSocket URL brackets a bare IPv6", () => {
  assert.equal(hubWebSocketUrl({ host: "100.64.0.1", port: 8787, reach: "privateNetwork" }),
    "ws://100.64.0.1:8787");
  assert.equal(hubWebSocketUrl({ host: "fd7a:115c:a1e0::1", port: 8787, reach: "privateNetwork" }),
    "ws://[fd7a:115c:a1e0::1]:8787");
});

test("format is the inverse of parse for a checked address", () => {
  const link = "cloud9://100.101.102.103:9001#inv_AbCdEf0123456789xyz";
  const a = ok(link);
  assert.equal(formatHubAddress(a), link);
  // and round-trips back
  const again = ok(formatHubAddress(a));
  assert.deepEqual(again, a);
});

test("every reach has a plain-words sentence", () => {
  for (const r of ["thisPc", "privateNetwork", "localNetwork", "public"] as const) {
    assert.equal(typeof reachInWords(r), "string");
    assert.ok(reachInWords(r).length > 10);
  }
});
