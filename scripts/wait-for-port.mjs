// Exits 0 once the port accepts a connection, 1 if it never does.
// Used by "Start Cloud9.cmd" so each part starts only after the one it needs.
import net from "node:net";

const port = Number(process.argv[2] ?? 8787);
const seconds = Number(process.argv[3] ?? 30);
const deadline = Date.now() + seconds * 1000;

function tryOnce() {
  return new Promise((resolve) => {
    const s = net.connect({ port, host: "127.0.0.1" });
    s.once("connect", () => { s.destroy(); resolve(true); });
    s.once("error", () => { s.destroy(); resolve(false); });
    setTimeout(() => { s.destroy(); resolve(false); }, 900);
  });
}

while (Date.now() < deadline) {
  if (await tryOnce()) process.exit(0);
  await new Promise((r) => setTimeout(r, 700));
}
process.exit(1);
