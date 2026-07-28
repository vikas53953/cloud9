// Shared test plumbing: a WS client that talks the real protocol over a real
// socket, and a throwaway database path. Not a test file itself — the runner
// only picks up `*.test.js`.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { ClientFrame, ServerFrame } from "@cloud9/shared";

/**
 * A fresh database for every single test (feedback round 1, his 15 — the class
 * fix for the junk data). No test ever inherits another one's people.
 */
export function tmp(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "c9-"));
  return path.join(dir, name);
}

export class TestClient {
  ws: WebSocket;
  frames: ServerFrame[] = [];
  private waiters: { pred: (f: ServerFrame) => boolean; resolve: (f: ServerFrame) => void }[] = [];

  constructor(url: string, token: string, client: "desktop" | "mobile" | "engine" = "desktop") {
    this.ws = new WebSocket(url);
    this.ws.on("open", () => this.send({ type: "hello", token, client }));
    this.ws.on("error", () => { /* closed sockets are expected in these tests */ });
    this.ws.on("message", raw => {
      const frame = JSON.parse(String(raw)) as ServerFrame;
      this.frames.push(frame);
      this.waiters = this.waiters.filter(w => {
        if (w.pred(frame)) { w.resolve(frame); return false; }
        return true;
      });
    });
  }

  send(frame: ClientFrame): void {
    const doSend = () => this.ws.send(JSON.stringify(frame));
    if (this.ws.readyState === WebSocket.OPEN) doSend();
    else this.ws.once("open", doSend);
  }

  wait<T extends ServerFrame>(pred: (f: ServerFrame) => boolean, ms = 5000): Promise<T> {
    const hit = this.frames.find(pred);
    if (hit) return Promise.resolve(hit as T);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout waiting for frame")), ms);
      this.waiters.push({ pred, resolve: f => { clearTimeout(timer); resolve(f as T); } });
    });
  }

  close(): void { this.ws.close(); }
}
