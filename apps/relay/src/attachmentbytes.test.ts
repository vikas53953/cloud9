// THE ONE FILE ON THIS LIST HE CANNOT GET BACK.
//
// The hub writes an attachment's bytes and then writes a database row saying
// the file is there. A plain write is not one action: it empties the file and
// then fills it. Lose power, close the app, or fill the disk in between and the
// row promises a whole file while the file is half there — and nothing anywhere
// says it is damaged, because the row looks perfectly healthy. He opens his PDF
// months later and gets a truncated one.
//
// A run record can be re-derived. HIS UPLOAD CANNOT. So the bytes go through
// the same whole-file rule as everything else, and a write that did not land
// refuses the upload instead of quietly writing the row anyway.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "./store.js";

function store(): { s: Store; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cloud9-att-"));
  return { s: new Store(path.join(dir, "hub.db")), dir };
}

/** Bytes no UTF-8 decoder can carry — the start of a real PNG, and worse. */
function realFileBytes(): Buffer {
  const b = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), // a PNG header
    Buffer.from([0xff, 0xfe, 0x80, 0xc0, 0xed, 0xa0, 0x80, 0x00, 0xf5]),
    Buffer.alloc(3000, 0xde),
  ]);
  assert.notEqual(Buffer.from(b.toString("utf8"), "utf8").compare(b), 0,
    "these bytes survive being turned into text, so they prove nothing");
  return b;
}

test("an uploaded file comes back byte for byte, however un-text-like it is", () => {
  const { s } = store();
  const bytes = realFileBytes();
  const storedAs = s.writeAttachmentBytes("at_1", "holiday.png", bytes);

  const back = fs.readFileSync(path.join(s.attachmentsDir, storedAs));
  assert.equal(Buffer.compare(back, bytes), 0,
    "the bytes were mangled on the way to disk — this is what stringifying a Buffer does");
  assert.deepEqual(fs.readdirSync(s.attachmentsDir), [storedAs], "and no litter beside it");
});

test("the bytes land next door and are renamed in — never straight onto the real name", () => {
  const { s } = store();
  const written: string[] = [];
  const real = fs.writeFileSync;
  (fs as { writeFileSync: typeof fs.writeFileSync }).writeFileSync =
    ((p: fs.PathOrFileDescriptor, d: string | NodeJS.ArrayBufferView, o?: unknown) => {
      if (typeof p === "string") written.push(p);
      return real(p as string, d as string, o as never);
    }) as typeof fs.writeFileSync;
  let storedAs: string;
  try {
    storedAs = s.writeAttachmentBytes("at_2", "report.pdf", realFileBytes());
  } finally {
    (fs as { writeFileSync: typeof fs.writeFileSync }).writeFileSync = real;
  }

  assert.equal(written.length, 1, "written exactly once");
  assert.notEqual(path.basename(written[0]), storedAs!,
    "his file went straight to the real name, so an interrupted upload tears it");
  assert.ok(written[0].includes(".tmp-"), "and under a plainly temporary name");
  assert.equal(path.dirname(written[0]), s.attachmentsDir,
    "the temporary file must be in the SAME folder or the rename is a copy, not atomic");
});

test("an upload whose bytes did not land is REFUSED, never recorded as saved", () => {
  // Returning the stored name after a failed write is the "⏰ Scheduled!" bug in
  // another costume: the row gets written, the upload is reported done, and the
  // file is not there.
  const { s } = store();
  const real = fs.renameSync;
  (fs as { renameSync: typeof fs.renameSync }).renameSync = (() => {
    throw new Error("the disk is full");
  }) as typeof fs.renameSync;
  const said: string[] = [];
  const realErr = console.error;
  console.error = (...a: unknown[]) => { said.push(a.join(" ")); };
  try {
    assert.throws(
      () => s.writeAttachmentBytes("at_3", "invoice.pdf", realFileBytes()),
      /could not be saved on this computer/,
      "a file that never reached the disk was reported to him as stored");
  } finally {
    (fs as { renameSync: typeof fs.renameSync }).renameSync = real;
    console.error = realErr;
  }

  assert.equal(said.length, 1, `and the hub's own log says why: ${JSON.stringify(said)}`);
  assert.match(said[0], /could not store an attachment/);
  assert.deepEqual(fs.readdirSync(s.attachmentsDir), [],
    "no half a file, and no litter either — the folder is exactly as it was");
});

test("an existing file is never half-replaced by a failed write", () => {
  const { s } = store();
  const good = realFileBytes();
  const storedAs = s.writeAttachmentBytes("at_4", "keep.png", good);

  const real = fs.renameSync;
  (fs as { renameSync: typeof fs.renameSync }).renameSync = (() => {
    throw new Error("antivirus has it");
  }) as typeof fs.renameSync;
  const realErr = console.error;
  console.error = () => {};
  try {
    assert.throws(() => s.writeAttachmentBytes("at_4", "keep.png", Buffer.alloc(99, 0x11)));
  } finally {
    (fs as { renameSync: typeof fs.renameSync }).renameSync = real;
    console.error = realErr;
  }

  assert.equal(Buffer.compare(fs.readFileSync(path.join(s.attachmentsDir, storedAs)), good), 0,
    "the file he already had was damaged by a write that failed");
  assert.deepEqual(fs.readdirSync(s.attachmentsDir), [storedAs]);
});

test("litter from an upload the hub was killed during is swept when it opens", () => {
  // Nothing swept this folder before today, so every interrupted upload left
  // bytes behind for ever under a name nothing reads.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cloud9-att-"));
  const dbPath = path.join(dir, "hub.db");
  const attDir = path.join(dir, "cloud9-attachments");
  fs.mkdirSync(attDir, { recursive: true });
  fs.writeFileSync(path.join(attDir, "at_9-holiday.png.tmp-999999-1-1"), Buffer.alloc(64, 0xde));
  fs.writeFileSync(path.join(attDir, "at_8-report.pdf"), Buffer.alloc(8, 0xab));

  const s = new Store(dbPath);
  assert.deepEqual(fs.readdirSync(s.attachmentsDir), ["at_8-report.pdf"],
    "the half-written upload is still there, or a real file was swept away with it");
});
