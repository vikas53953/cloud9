import fs from "node:fs";

const file = "C:/Users/vikasmit/cloud9/apps/desktop/src/App.tsx";
let src = fs.readFileSync(file, "utf8");
const nl = src.includes("\r\n") ? "\r\n" : "\n";

function once(label, needle, repl) {
  const n = src.split(needle).length - 1;
  if (n !== 1) {
    console.error(`${label}: found ${n}`);
    process.exit(1);
  }
  src = src.replace(needle, repl);
}

if (!src.includes("function ActivityTrailRow")) {
  const needle = `${nl}const blankPulseDraft = (): EngineeringPulseDraft => ({`;
  const idx = src.indexOf(needle);
  if (idx < 0) {
    console.error("blankPulseDraft not found");
    process.exit(1);
  }
  const trail = [
    "",
    "const ACTIVITY_STEP_PREVIEW = 140;",
    "const ACTIVITY_STEPS_SHOWN = 12;",
    "",
    "/** One trail row: who, what, where, and what happened. Commands stay closed. */",
    "function ActivityTrailRow({ row, world }: {",
    "  row: ActivityRecord; world: World;",
    "}): React.JSX.Element {",
    "  const linked = linkActivityRow(row, {",
    "    channels: world.channels,",
    "    tasks: world.tasks,",
    "    approvals: world.approvals,",
    "    runs: world.runs,",
    "    messages: world.messages,",
    "  });",
    "  const run = linked.run ?? (row.refId ? world.runs[row.refId] : undefined);",
    "  const facts = run && !linked.run ? { ...linked, run } : linked;",
    "  const gone = !!(row.refId && world.runsGone[row.refId]);",
    "  const chips = activityOutcomeChips(facts);",
    "  const inspectable = activityInspectableSteps(run?.steps);",
    "  const needsFetch = row.kind === \"run_recorded\" && !!row.refId && !run && !gone;",
    "  const canExpand = activityHasDetails(facts, row.kind) || needsFetch",
    "    || !!(run?.pullRequest || run?.branch || run?.commit);",
    "  const shownSteps = inspectable.slice(0, ACTIVITY_STEPS_SHOWN).map(step => ({",
    "    ...step,",
    "    detail: step.detail ? quoteOf(step.detail, ACTIVITY_STEP_PREVIEW) : undefined,",
    "  }));",
    "  const whoClass = row.actorKind === \"agent\" ? \"by-agent\"",
    "    : row.actorKind === \"human\" ? \"by-human\" : \"by-system\";",
    "",
    "  return (",
    "    <div className={`actrow ${whoClass}`} data-kind={row.kind} data-actor={row.actorKind}>",
    "      <span className=\"actwho\">",
    "        {row.actorKind === \"agent\"",
    "          ? <AgentFace name={row.actorName} size={28} />",
    "          : <PersonFace name={row.actorName} size={28} />}",
    "      </span>",
    "      <div className=\"actdetail\">",
    "        <b>{row.actorName}</b>",
    "        <span className=\"actwhat\">",
    "          <span className=\"actkind\">{activityKindWords(row.kind)}</span>",
    "          {row.detail}",
    "        </span>",
    "        {(facts.channelName || chips.length > 0) && (",
    "          <span className=\"actmeta\">",
    "            {facts.channelName && <span className=\"actwhere\">{facts.channelName}</span>}",
    "            {chips.map(chip => <span key={chip.key} className=\"acthappened\">{chip.label}</span>)}",
    "          </span>",
    "        )}",
    "        {canExpand && (",
    "          <details className=\"act-disclose\" onToggle={event => {",
    "            if ((event.currentTarget as HTMLDetailsElement).open && row.kind === \"run_recorded\" && row.refId) {",
    "              client.askRun(row.refId);",
    "            }",
    "          }}>",
    "            <summary>Commands, logs, and files</summary>",
    "            {needsFetch && <p className=\"act-wait\">Fetching what it did…</p>}",
    "            {gone && <p className=\"act-wait\">That record isn't there any more.</p>}",
    "            {run?.files && run.files.length > 0 && (",
    "              <p className=\"act-fact\" data-act-files={run.files.length}>Files changed: {run.files.join(\", \")}</p>",
    "            )}",
    "            {run?.tests && run.tests.length > 0 && (",
    "              <ul className=\"act-tests\">",
    "                {run.tests.map((test, i) => (",
    "                  <li key={`${test.command}-${i}`}>",
    "                    {test.command}{test.ok === true ? \" · passed\" : test.ok === false ? \" · failed\" : \" · outcome not reported\"}",
    "                  </li>",
    "                ))}",
    "              </ul>",
    "            )}",
    "            {run?.pullRequest && (",
    "              <p className=\"act-fact\">{isLink(run.pullRequest)",
    "                ? <a href={run.pullRequest} target=\"_blank\" rel=\"noreferrer noopener\">{run.pullRequest}</a>",
    "                : run.pullRequest}</p>",
    "            )}",
    "            {run?.branch && <p className=\"act-fact\">Branch {run.branch}</p>}",
    "            {run?.commit && <p className=\"act-fact\">Commit {run.commit}</p>}",
    "            {shownSteps.length > 0 && (",
    "              <RunSteps steps={shownSteps} truncated={!!run?.truncated || inspectable.length > ACTIVITY_STEPS_SHOWN} />",
    "            )}",
    "          </details>",
    "        )}",
    "      </div>",
    "      <span className=\"actwhen\">{clock(row.ts)}</span>",
    "    </div>",
    "  );",
    "}",
    "",
  ].join(nl);
  src = src.slice(0, idx) + nl + trail + src.slice(idx);
}

if (!src.includes("const where = activityRoomName(")) {
  once(
    "where",
    `    });${nl}    return { agent, line };`,
    [
      "    });",
      "    let messageChannel: ID | undefined;",
      "    if (work?.messageId) {",
      "      for (const [channelId, list] of Object.entries(world.messages)) {",
      "        if (list.some(message => message.id === work.messageId)) {",
      "          messageChannel = channelId;",
      "          break;",
      "        }",
      "      }",
      "    }",
      "    const where = activityRoomName(",
      "      asking?.channelId ?? queued?.channelId ?? messageChannel,",
      "      world.channels,",
      "    );",
      "    return { agent, line, ...(where ? { where } : {}) };",
    ].join(nl),
  );
}

once(
  "deps",
  `  }), [mine, world.presence, world.agentStatus, world.tasks, world.runLists,${nl}    liveApprovals, liveWork, askOf]);`,
  `  }), [mine, world.presence, world.agentStatus, world.tasks, world.runLists,${nl}    world.channels, world.messages, world.approvals, liveApprovals, liveWork, askOf]);`,
);

if (!src.includes(".filter(row => row.kind === \"run_recorded\"")) {
  once(
    "prefetch",
    `  }, [openAt?.at, openAt?.runId, onOpened]);${nl}${nl}  const focusRun = focusRunId ? world.runs[focusRunId] : undefined;`,
    [
      "  }, [openAt?.at, openAt?.runId, onOpened]);",
      "",
      "  useEffect(() => {",
      "    const newest = [...world.activity].reverse()",
      "      .filter(row => row.kind === \"run_recorded\" && row.refId)",
      "      .slice(0, RUN_HISTORY_LIMIT);",
      "    for (const row of newest) if (row.refId) client.askRun(row.refId);",
      "  }, [world.activity]);",
      "",
      "  const focusRun = focusRunId ? world.runs[focusRunId] : undefined;",
    ].join(nl),
  );
}

fs.writeFileSync(file, src);
console.log("ok", {
  trail: src.includes("function ActivityTrailRow"),
  where: src.includes("const where = activityRoomName("),
  prefetch: src.includes(".filter(row => row.kind === \"run_recorded\""),
  deps: src.includes("world.channels, world.messages, world.approvals"),
});
