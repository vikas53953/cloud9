import fs from "node:fs";
import { PENDING_MARK, IN_FLIGHT_GRACE_MS } from "./wholefile.js";

/**
 * Plant the litter of a KILLED write — for tests only.
 *
 * Three suites used to fabricate litter as `name.tmp-999-1-1` written fresh.
 * That file's mtime is "now", so whenever pid 999 happens to be a live process
 * on the machine running the tests, the sweeper — correctly — treats it as a
 * write still in flight and leaves it. The tests then failed by luck of PID
 * assignment (green one evening, red the next morning).
 *
 * A write that was truly killed stops being touched, so its age is what proves
 * it dead. This helper writes the litter and then backdates it past the
 * sweeper's grace window: sweepable on every machine, whatever pid 999 is
 * doing today. Every test that plants litter goes through here.
 */
export function plantKilledWriteLitter(realName: string, content = "x"): string {
  const litter = `${realName}${PENDING_MARK}999-1-1`;
  fs.writeFileSync(litter, content, "utf8");
  const deadForSure = new Date(Date.now() - IN_FLIGHT_GRACE_MS * 2);
  fs.utimesSync(litter, deadForSure, deadForSure);
  return litter;
}
