import fs from "node:fs";

const p = new URL("./App.tsx", import.meta.url);
let s = fs.readFileSync(p, "utf8");
const nl = s.includes("\r\n") ? "\r\n" : "\n";
const lf = (text) => (nl === "\r\n" ? text.replace(/\n/g, "\r\n") : text);
const checks = [];

function repl(oldS, newS, label) {
  oldS = lf(oldS);
  newS = lf(newS);
  const n = s.split(oldS).length - 1;
  if (n === 0) checks.push("MISSING " + label);
  else if (n !== 1) checks.push("AMBIG " + label + " x" + n);
  else {
    s = s.replace(oldS, newS);
    checks.push("OK " + label);
  }
}

if (s.includes("function ActivityTrailRow(")) {
  checks.push("OK trail-exists");
} else {
  repl(
    "                <ActivityTrailRow key={r.id} row={r} world={world} />\n" +
    "              ))}\n" +
    "            </div>\n" +
    "          </React.Fragment>\n" +
    "        ))}\n" +
    "      </div>\n" +
    "    </div>\n" +
    "  );\n" +
    "}\n" +
    "\n" +
    "const blankPulseDraft = (): EngineeringPulseDraft => ({",
    fs.readFileSync(new URL("./_activity-trail-snippet.txt", import.meta.url), "utf8"),
    "insert-trail",
  );
}

if (!s.includes("if (row.kind === \"run_recorded\" && row.refId) client.askRun(row.refId)")) {
  repl(
    "    client.askRun(openAt.runId);\n    onOpened?.();\n  }, [openAt?.at, openAt?.runId, onOpened]);\n\n  const focusRun = focusRunId ? world.runs[focusRunId] : undefined;",
    "    client.askRun(openAt.runId);\n    onOpened?.();\n  }, [openAt?.at, openAt?.runId, onOpened]);\n\n  useEffect(() => {\n    for (const row of world.activity) {\n      if (row.kind === \"run_recorded\" && row.refId) client.askRun(row.refId);\n    }\n  }, [world.activity]);\n\n  const focusRun = focusRunId ? world.runs[focusRunId] : undefined;",
    "prefetch",
  );
} else checks.push("OK prefetch-exists");

console.log(checks.join("\n"));
if (!checks.some((c) => c.startsWith("MISSING") || c.startsWith("AMBIG"))) {
  fs.writeFileSync(p, s);
  console.log("WROTE");
} else {
  console.log("SKIPPED WRITE");
}
