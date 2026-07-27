// Minimal dependency-free scheduler for agent schedules.
// Supported `when` forms: "daily HH:MM" (host-local time) and "every Nm".
import { AgentSchedule } from "@cloud9/shared";

export interface FiredSchedule {
  schedule: AgentSchedule;
}

export class Scheduler {
  private lastFired = new Map<string, number>();
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    private getSchedules: () => AgentSchedule[],
    private onFire: (fired: FiredSchedule) => void,
    private tickMs = 30_000,
  ) {}

  start(): void {
    this.timer = setInterval(() => this.tick(new Date()), this.tickMs);
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** exposed for tests */
  tick(now: Date): void {
    for (const s of this.getSchedules()) {
      if (!s.enabled) continue;
      if (this.due(s, now)) {
        this.lastFired.set(s.id, now.getTime());
        this.onFire({ schedule: s });
      }
    }
  }

  private due(s: AgentSchedule, now: Date): boolean {
    const last = this.lastFired.get(s.id) ?? 0;
    const daily = /^daily (\d{1,2}):(\d{2})$/.exec(s.when);
    if (daily) {
      const [, hh, mm] = daily;
      const hit = now.getHours() === Number(hh) && now.getMinutes() === Number(mm);
      const firedThisMinute = now.getTime() - last < 60_000;
      return hit && !firedThisMinute;
    }
    const every = /^every (\d+)m$/.exec(s.when);
    if (every) {
      return now.getTime() - last >= Number(every[1]) * 60_000;
    }
    return false;
  }
}
