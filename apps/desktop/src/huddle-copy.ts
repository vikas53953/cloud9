import type { HuddleLink, HuddleNoteKind, HuddleState } from "@cloud9/shared";

export function huddleStateWords(state: HuddleState): string {
  return state === "active" ? "In session" : "Ended";
}

export function huddleNoteKindWords(kind: HuddleNoteKind): string {
  if (kind === "decision") return "Decision";
  if (kind === "action") return "Action item";
  return "Note";
}

export function huddleLinkWords(link: HuddleLink): string {
  const fallback = link.kind === "projectItem"
    ? `${link.projectItemKind === "pull" ? "PR" : "Issue"} #${link.projectItemNumber ?? "?"}`
    : link.kind === "artifact" ? "File" : link.kind === "run" ? "Run" : "Task";
  const label = link.label ?? fallback;
  return link.available === false ? `${label} (unavailable)` : label;
}
