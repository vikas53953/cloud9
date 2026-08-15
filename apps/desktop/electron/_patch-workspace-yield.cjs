const fs = require("fs");
const p = require("path").join(__dirname, "..", "src", "App.tsx");
let s = fs.readFileSync(p, "utf8");
const before = s;
let n = 0;

function once(label, from, to, optional) {
  const i = s.indexOf(from);
  if (i === -1) {
    if (s.includes(to.slice(0, Math.min(80, to.length))) || optional) {
      console.log("skip", label);
      return;
    }
    console.log("MISSING", label);
    process.exitCode = 1;
    return;
  }
  s = s.slice(0, i) + to + s.slice(i + from.length);
  n += 1;
  console.log("ok", label);
}

once(
  "workspaceCol",
  `  const workspaceCol = showWorkspace ? 320 : 0;
  const tooNarrowToSplit = space > 0 && cannotSplit(Math.max(0, space - workspaceCol));
  const takeover = !!threadRoot && (tooNarrowToSplit || p.threadLayout === "focus");`,
  `  const tooNarrowToSplit = space > 0 && cannotSplit(space);
  const takeover = !!threadRoot && (tooNarrowToSplit || p.threadLayout === "focus");
  const workspaceYields = !!(threadRoot || detailsOpen || takeover);`,
  true,
);

once(
  "colComment",
  `  const space = useSpaceToShare(gridRef, \`\${workspaceLayout}:\${studioCollapsed}\`);
  /* Files keep their column while a thread is open, so the room+thread
     arithmetic has to leave that column out of the shared strip. */
  const tooNarrowToSplit`,
  `  const space = useSpaceToShare(gridRef, \`\${workspaceLayout}:\${studioCollapsed}\`);
  const tooNarrowToSplit`,
  true,
);

once(
  "className",
  `active && workspaceAccess && workspaceLayout !== "focus" && !threadRoot && !detailsOpen && !takeover ? " withworkspace" : ""}`,
  `showWorkspace && !workspaceYields ? " withworkspace" : ""}`,
  true,
);

once(
  "classNameOld",
  `active && !threadRoot && !detailsOpen && !takeover && workspaceLayout !== "focus" ? " withworkspace" : ""}`,
  `showWorkspace && !workspaceYields ? " withworkspace" : ""}`,
  true,
);

once(
  "signature",
  `function WorkspaceLayoutPanel({ channel, layout, onClose }: {
  channel: Channel;
  layout: Exclude<WorkspaceLayout, "focus">;
  onClose: () => void;
}): React.JSX.Element {`,
  `function WorkspaceLayoutPanel({ channel, layout, onClose, hidden }: {
  channel: Channel;
  layout: Exclude<WorkspaceLayout, "focus">;
  onClose: () => void;
  hidden?: boolean;
}): React.JSX.Element {`,
);

once(
  "aside",
  `<aside ref={panelRef} className={\`workspace-layout-panel layout-\${layout}\`} aria-label={\`\${title} workspace\`}>`,
  `<aside ref={panelRef} hidden={hidden} className={\`workspace-layout-panel layout-\${layout}\`} aria-label={\`\${title} workspace\`}>`,
);

if (process.exitCode) process.exit(process.exitCode);
if (s !== before) {
  fs.writeFileSync(p, s);
  console.log("wrote", n, "patches", s.length);
} else {
  console.log("no net change", n);
}
