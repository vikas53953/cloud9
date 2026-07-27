import test from "node:test";
import assert from "node:assert/strict";
import { AgentSchedule } from "@cloud9/shared";
import { Scheduler } from "./scheduler.js";

const sched = (when: string, id = "s1"): AgentSchedule => ({
  id, agentId: "a1", channelId: "c1", when, prompt: "check in", enabled: true,
});

test("daily fires at the right minute, once", () => {
  const fired: string[] = [];
  const s = new Scheduler(() => [sched("daily 06:30")], f => fired.push(f.schedule.id));
  const at = new Date(); at.setHours(6, 30, 5, 0);
  s.tick(at);
  s.tick(new Date(at.getTime() + 20_000)); // same minute — no double fire
  assert.equal(fired.length, 1);
  const wrong = new Date(); wrong.setHours(7, 0, 0, 0);
  s.tick(wrong);
  assert.equal(fired.length, 1);
});

test("every Nm fires on interval", () => {
  const fired: string[] = [];
  const s = new Scheduler(() => [sched("every 15m", "s2")], f => fired.push(f.schedule.id));
  const t0 = new Date();
  s.tick(t0);                                    // first fire (never fired before)
  s.tick(new Date(t0.getTime() + 5 * 60_000));   // too soon
  s.tick(new Date(t0.getTime() + 16 * 60_000));  // fires
  assert.equal(fired.length, 2);
});

test("disabled schedules never fire", () => {
  const fired: string[] = [];
  const s = new Scheduler(() => [{ ...sched("every 1m"), enabled: false }], f => fired.push(f.schedule.id));
  s.tick(new Date());
  assert.equal(fired.length, 0);
});
