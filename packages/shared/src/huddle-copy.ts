export function huddleStateWords(state: "active" | "ended"): string {
  return state === "active" ? "In session" : "Ended";
}

export function huddleNoteKindWords(kind: "note" | "decision" | "action"): string {
  if (kind === "decision") return "Decision";
  if (kind === "action") return "Action item";
  return "Note";
}

export function huddleLinkWords(link: {
  kind: "task" | "run" | "artifact" | "projectItem";
  label?: string;
  available?: boolean;
  projectItemKind?: "pull" | "issue";
  projectItemNumber?: number;
}): string {
  const fallback = link.kind === "projectItem"
    ? `${link.projectItemKind === "pull" ? "PR" : "Issue"} #${link.projectItemNumber ?? "?"}`
    : link.kind === "artifact" ? "File" : link.kind === "run" ? "Run" : "Task";
  const label = link.label ?? fallback;
  return link.available === false ? `${label} (unavailable)` : label;
}
