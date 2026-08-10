// Structural coverage for the browser-owned microphone lifecycle. The
// Electron test runner does not have a real microphone, so these assertions
// protect the seams that a device/browser test must exercise later: the meter
// must be fed by the stream, actions must be explicit, and cleanup must stop
// both the recorder and the tracks.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

const APP = path.join(__dirname, "..", "src", "App.tsx");
const CSS = path.join(__dirname, "..", "src", "styles.css");
const HELPERS = path.join(__dirname, "..", "src", "voice-recording.ts");
const source = fs.readFileSync(APP, "utf8");
const styles = fs.readFileSync(CSS, "utf8");
const helpersSource = fs.readFileSync(HELPERS, "utf8");

function loadVoiceHelpers() {
  const output = ts.transpileModule(fs.readFileSync(HELPERS, "utf8"), {
    fileName: HELPERS,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(output, { module, exports: module.exports }, { filename: HELPERS });
  return module.exports;
}

const voice = loadVoiceHelpers();

test("voice helper math keeps duration and level facts bounded", () => {
  assert.equal(voice.voiceDuration(0), "0:00");
  assert.equal(voice.voiceDuration(61_900), "1:01");
  assert.equal(voice.microphoneLevel(new Uint8Array()), 0);
  assert.equal(voice.microphoneLevel(new Uint8Array([128, 128, 128])), 0);
  assert.ok(voice.microphoneLevel(new Uint8Array([0, 255, 0, 255])) <= 1);
});

test("recording gate closes on archive, access, auth, or connection transitions", () => {
  assert.equal(voice.voiceRecordingAllowed({ connected: true, authFailed: false, archived: false, hasAccess: true }), true);
  for (const change of [
    { connected: false, authFailed: false, archived: false, hasAccess: true },
    { connected: true, authFailed: true, archived: false, hasAccess: true },
    { connected: true, authFailed: false, archived: true, hasAccess: true },
    { connected: true, authFailed: false, archived: false, hasAccess: false },
  ]) assert.equal(voice.voiceRecordingAllowed(change), false);
});

test("permission and old-recorder races fail closed by immutable session/owner", () => {
  const first = voice.voiceRecordingSessionToken({
    identity: "u1", channelId: "room-a", threadId: "m1", accessEpoch: "u1,a1",
    connected: true, authFailed: false, archived: false,
  });
  const authorizedSwitch = voice.voiceRecordingSessionToken({
    identity: "u1", channelId: "room-b", threadId: "m2", accessEpoch: "u1,a1",
    connected: true, authFailed: false, archived: false,
  });
  assert.notEqual(first, authorizedSwitch);
  assert.equal(voice.voiceRecordingRequestStillCurrent(first, authorizedSwitch, true), false,
    "a late permission result must not create a recorder in another authorized room");
  assert.equal(voice.voiceRecordingOwnsResources(7, 8), false,
    "an old recorder stop must not clear the newer recorder's resources");
});

test("voice helper failures give permission and device next steps", () => {
  assert.match(voice.voiceRecordingFailure({ name: "NotAllowedError" }), /Allow Cloud9/);
  assert.match(voice.voiceRecordingFailure({ name: "NotFoundError" }), /No usable microphone/);
  assert.match(voice.voiceRecordingFailure({ name: "NotReadableError" }), /Close other apps/);
});

test("the live voice meter is derived from the actual microphone stream", () => {
  assert.match(source, /getUserMedia\(\{ audio: true \}\)/);
  assert.match(source, /createMediaStreamSource\(stream\)/);
  assert.match(source, /getByteTimeDomainData\(data\)/);
  assert.match(source, /microphoneLevel\(data\)/);
  assert.match(source, /requestAnimationFrame\(sample\)/);
  assert.match(source, /aria-label=\{`Live microphone level/);
});

test("voice recording exposes elapsed time and separate keep/cancel actions", () => {
  assert.match(source, /recordingStartedAtRef/);
  assert.match(source, /performance\.now\(\)/);
  assert.match(source, /Stop and keep/);
  assert.match(source, /Cancel recording/);
  assert.match(source, /recordingFinishRef\.current = "keep"/);
  assert.match(source, /recordingFinishRef\.current = "cancel"/);
  assert.match(source, /Review the attachment/);
});

test("permission, device, disconnect, and teardown paths stay explicit", () => {
  for (const name of ["NotAllowedError", "SecurityError", "NotFoundError", "NotReadableError"]) {
    assert.match(helpersSource, new RegExp(name));
  }
  assert.match(source, /track\.addEventListener\("ended"/);
  assert.match(source, /recordingStreamRef\.current\?\.getTracks\(\)\.forEach\(track => track\.stop\(\)\)/);
  assert.match(source, /context\.close\(\)/);
  assert.match(source, /recordingRequestRef\.current \+= 1/);
  assert.match(source, /recordingGateRef\.current = recordingAllowed/);
  assert.match(source, /recordingGateRef\.current/);
  assert.match(source, /const requestSessionToken = recordingSessionTokenRef\.current/);
  assert.match(source, /voiceRecordingRequestStillCurrent\(/);
  assert.match(source, /voiceRecordingOwnsResources\(/);
  assert.match(source, /recordingMeterOwnerRef/);
  assert.match(source, /localAudioContext/);
  assert.match(source, /recordingOwnerRef\.current !== request \|\| recorderRef\.current !== recorder/);
  assert.match(source, /sessionChanged \|\| !recordingAllowed\) cancelVoiceRecording/);
  assert.match(source, /recorderRef\.current = null/);
});

test("the recording panel remains usable in narrow composers", () => {
  assert.match(styles, /\.voice-recording-actions\{[^}]*flex-wrap:wrap/);
  assert.match(styles, /@media \(max-width:560px\)/);
  assert.match(styles, /\.voice-waveform\{/);
});

test("no fake transcription promise is attached to the audio control", () => {
  const voiceSurface = source.slice(source.indexOf("type VoiceRecordingStatus"), source.indexOf("function RoomVisibility"));
  assert.doesNotMatch(voiceSurface, /transcrib/i,
    "no configured speech-to-text provider was found; do not invent a transcription result");
});
