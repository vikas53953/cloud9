// Where is the hub I am connecting to? — the ONE owner of that question.
//
// Why this file exists: today the packaged app always starts its own hub and
// always dials `127.0.0.1`, so there is no way to join a friend's Cloud9 at all
// (HANDOFF.md §6, "the next big feature"). Before any of the wiring — the hub
// binding beyond loopback, the desktop's "join a friend" screen, Tailscale —
// something has to answer, in one place and honestly: *is this string a place I
// may connect to, and what kind of place is it?*
//
// This module is that place. It is pure: no sockets, no disk, no clock. It
// turns a thing a friend shared ("here is my Cloud9") into either a checked
// address with an honest reachability class, or a plain-words refusal. Everyone
// else — the client that dials, the screen that shows "on your private network",
// the guard that refuses to expose the hub to the open internet — reads its
// answer instead of re-deciding.
//
// The product law it encodes (RESUME.md, decided by Vikas): private network
// FIRST (Tailscale), the public internet NEVER, until a real web GUI exists. So
// a public address is not merely unusual here — it is refused, in words.

/** The default port a Cloud9 hub listens on — must match the relay's own. */
export const DEFAULT_HUB_PORT = 8787;

/**
 * Who can actually reach an address — decided from the host alone, so the
 * screen can tell the truth instead of showing a hopeful green dot.
 */
export type HubReach =
  | "thisPc" // loopback: only this computer. What the app dials today.
  | "privateNetwork" // Tailscale: this person's invited circle, never the open internet.
  | "localNetwork" // same home/office network (LAN): reachable, but not from afar.
  | "public"; // a public IP or name — REFUSED for now (private-network-first).

export interface HubAddress {
  /** The host, lower-cased and trimmed. Never a scheme, never a port. */
  host: string;
  /** 1–65535. `DEFAULT_HUB_PORT` when the friend's link omitted one. */
  port: number;
  /** An `inv_…` code if the link carried one, so joining can redeem it in one step. */
  invite?: string;
  /** Who can reach `host`. `public` never reaches here — it is refused first. */
  reach: HubReach;
}

export type HubAddressResult =
  | { ok: true; address: HubAddress }
  | { ok: false; reason: string };

/** The shape an invite code takes — `secureId("inv")` mints `inv_<base64url>`. */
const INVITE_CODE = /^inv_[A-Za-z0-9_-]{16,}$/;

/** A tailnet MagicDNS name, e.g. `vikas-pc.tail9b2c.ts.net`. */
const MAGIC_DNS = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.ts\.net$/i;

/** A DNS hostname (letters/digits/hyphens per label), no trailing dot. */
const HOSTNAME = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i;

/**
 * Read what a friend shared and say whether it is a Cloud9 hub you may dial.
 *
 * Accepts, forgivingly, what a person actually pastes:
 *   - `cloud9://100.101.102.103:8787#inv_abc…`  (full, with an invite)
 *   - `100.101.102.103`                          (bare host — default port)
 *   - `vikas-pc.tailnet.ts.net:8787`             (a Tailscale MagicDNS name)
 *   - `localhost:8787`                           (this PC)
 * The `#invite` may also be written `?invite=…` or `/inv_…` — all folded here so
 * no caller has to know the variants.
 */
export function parseHubAddress(input: unknown): HubAddressResult {
  if (typeof input !== "string" || input.trim() === "") {
    return { ok: false, reason: "paste the address your friend shared" };
  }
  let text = input.trim();

  // Pull an invite code off the end however it was attached, before we touch host/port.
  let invite: string | undefined;
  const inviteMatch = text.match(/[#?/](?:invite=)?(inv_[A-Za-z0-9_-]+)$/);
  if (inviteMatch) {
    invite = inviteMatch[1];
    text = text.slice(0, inviteMatch.index).trim();
  }
  if (invite && !INVITE_CODE.test(invite)) {
    return { ok: false, reason: "that invite code doesn't look right — ask for a fresh link" };
  }

  // Drop a leading scheme (cloud9:// or ws://), and any leftover path.
  text = text.replace(/^[a-z0-9]+:\/\//i, "").replace(/\/+$/, "");
  if (text === "") return { ok: false, reason: "that address has no computer name in it" };

  // Split host and optional port. Bracketed IPv6 (`[::1]:8787`) is handled first.
  let host: string;
  let portText: string | undefined;
  const v6 = text.match(/^\[(.+)\](?::(\d+))?$/);
  if (v6) {
    host = v6[1];
    portText = v6[2];
  } else {
    const parts = text.split(":");
    if (parts.length > 2) {
      // More than one colon and no brackets — a bare IPv6, no port possible.
      host = text;
    } else {
      host = parts[0];
      portText = parts[1];
    }
  }
  host = host.trim().toLowerCase();
  if (host === "") return { ok: false, reason: "that address has no computer name in it" };

  let port = DEFAULT_HUB_PORT;
  if (portText !== undefined) {
    if (!/^\d+$/.test(portText)) {
      return { ok: false, reason: "the part after the colon should be a port number" };
    }
    port = Number(portText);
    if (port < 1 || port > 65535) {
      return { ok: false, reason: "that port number is out of range (1–65535)" };
    }
  }

  const reach = classifyHost(host);
  if (reach === null) {
    return { ok: false, reason: `"${host}" isn't a computer name Cloud9 recognises` };
  }
  if (reach === "public") {
    return {
      ok: false,
      reason:
        "that address is on the open internet — Cloud9 only joins over your private " +
        "network (Tailscale) for now, never the public internet",
    };
  }

  return { ok: true, address: { host, port, invite, reach } };
}

/**
 * Decide who can reach a host from its shape alone. `null` means "not an address
 * we understand"; `"public"` means understood but not allowed (the caller turns
 * that into the refusal above).
 */
export function classifyHost(hostRaw: string): HubReach | null {
  const host = hostRaw.trim().toLowerCase();

  if (host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "0.0.0.0") {
    return "thisPc";
  }
  if (MAGIC_DNS.test(host)) return "privateNetwork";

  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const oct = v4.slice(1).map(Number);
    if (oct.some(n => n > 255)) return null;
    const [a, b] = oct;
    // Tailscale hands out 100.64.0.0/10 (CGNAT): 100.64.x – 100.127.x.
    if (a === 100 && b >= 64 && b <= 127) return "privateNetwork";
    // Private LAN ranges (RFC 1918) + link-local.
    if (a === 10) return "localNetwork";
    if (a === 172 && b >= 16 && b <= 31) return "localNetwork";
    if (a === 192 && b === 168) return "localNetwork";
    if (a === 169 && b === 254) return "localNetwork";
    if (a === 127) return "thisPc";
    // Any other IPv4 is routable on the public internet.
    return "public";
  }

  // Tailscale IPv6 (fd7a:115c:a1e0::/48) is private; other global IPv6 is public.
  if (host.includes(":")) {
    return host.startsWith("fd7a:115c:a1e0") ? "privateNetwork" : "public";
  }

  // A plain hostname that is not a tailnet name resolves on public DNS.
  if (HOSTNAME.test(host)) return "public";

  return null;
}

/** The WebSocket URL a client dials for a checked address. */
export function hubWebSocketUrl(address: HubAddress): string {
  const host = address.host.includes(":") && !address.host.startsWith("[")
    ? `[${address.host}]` // bare IPv6 needs brackets in a URL
    : address.host;
  return `ws://${host}:${address.port}`;
}

/** A short, pasteable link a friend can share — the inverse of `parseHubAddress`. */
export function formatHubAddress(address: HubAddress): string {
  const host = address.host.includes(":") ? `[${address.host}]` : address.host;
  const base = `cloud9://${host}:${address.port}`;
  return address.invite ? `${base}#${address.invite}` : base;
}

/** One plain sentence for the screen: who can actually reach this address. */
export function reachInWords(reach: HubReach): string {
  switch (reach) {
    case "thisPc":
      return "only this computer — this is the address the app uses for itself";
    case "privateNetwork":
      return "you and the people you invited, over your private network";
    case "localNetwork":
      return "computers on the same home or office network";
    case "public":
      return "anyone on the internet — Cloud9 will not connect to this";
  }
}
