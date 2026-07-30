// Minimal dependency-free scheduler for agent schedules.
// Supported `when` forms: "daily HH:MM" (host-local time) and "every Nm".
import { AgentSchedule } from "@cloud9/shared";

export interface FiredSchedule {
  schedule: AgentSchedule;
}

/**
 * THE ONE OWNER OF "WHEN IS A SCHEDULE DUE" — the grammar itself.
 *
 * `due()` below reads these, and so does the engine when it loads schedules
 * back off the disk. A second spelling of the same two patterns is how a
 * `when` gets saved that nothing will ever fire: it looks fine to whoever wrote
 * it and matches nothing here, so the schedule simply never happens and nobody
 * is told. There is one spelling.
 */
export const SCHEDULE_WHEN = {
  daily: /^daily (\d{1,2}):(\d{2})$/,
  every: /^every (\d+)m$/,
} as const;

/** Is this something this scheduler could actually act on? */
export function isScheduleWhen(when: unknown): when is string {
  if (typeof when !== "string") return false;
  const daily = SCHEDULE_WHEN.daily.exec(when);
  if (daily) return Number(daily[1]) <= 23 && Number(daily[2]) <= 59;
  const every = SCHEDULE_WHEN.every.exec(when);
  // "every 0m" is not a schedule, it is a spin
  return !!every && Number(every[1]) >= 1;
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
    if (this.timer) clearInterval(this.timer); // reconnects must not leak intervals
    this.timer = setInterval(() => this.tick(new Date()), this.tickMs);
  }
  /**
   * Put the clock down. The handle is FORGOTTEN as well as cleared: a scheduler
   * that has been stopped must not still be holding something that looks
   * startable, because "stopped" and "stopped but still has a handle" are the
   * difference between the packaged app closing and a process Vikas has to kill.
   */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
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
    const daily = SCHEDULE_WHEN.daily.exec(s.when);
    if (daily) {
      const [, hh, mm] = daily;
      const hit = now.getHours() === Number(hh) && now.getMinutes() === Number(mm);
      const firedThisMinute = now.getTime() - last < 60_000;
      return hit && !firedThisMinute;
    }
    const every = SCHEDULE_WHEN.every.exec(s.when);
    if (every) {
      return now.getTime() - last >= Number(every[1]) * 60_000;
    }
    return false;
  }
}
