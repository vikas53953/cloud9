export type VoiceRecordingStatus = "idle" | "starting" | "recording";

export interface VoiceRecordingSession {
  identity: string;
  channelId: string;
  threadId?: string;
  accessEpoch: string;
  connected: boolean;
  authFailed: boolean;
  archived: boolean;
}

/** Stable identity for a permission request; authorized room switches still differ. */
export function voiceRecordingSessionToken(session: VoiceRecordingSession): string {
  return [
    session.identity, session.channelId, session.threadId ?? "", session.accessEpoch,
    session.connected ? "connected" : "disconnected",
    session.authFailed ? "auth-failed" : "authenticated",
    session.archived ? "archived" : "writable",
  ].join("|");
}

export function voiceRecordingRequestStillCurrent(
  requestToken: string, currentToken: string, gateOpen: boolean,
): boolean {
  return gateOpen && requestToken === currentToken;
}

/** A late old recorder may release only resources it still owns. */
export function voiceRecordingOwnsResources(ownerRequest: number, currentRequest: number): boolean {
  return ownerRequest === currentRequest;
}

/** Recording is allowed only while the composer still owns a live room gate. */
export function voiceRecordingAllowed(input: {
  connected: boolean;
  authFailed: boolean;
  archived: boolean;
  hasAccess: boolean;
}): boolean {
  return input.connected && !input.authFailed && !input.archived && input.hasAccess;
}

/** Keep the clock deliberately boring: a recording's length is a fact, not a
 * promise about how long a user has been waiting for permission. */
export function voiceDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

/** Translate browser/device failures into a next step a person can actually
 * take. The raw DOMException is not useful to someone trying to record. */
export function voiceRecordingFailure(error: unknown): string {
  const name = error && typeof error === "object" && "name" in error
    ? String((error as { name?: unknown }).name ?? "") : "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "Microphone access was blocked. Allow Cloud9 to use your microphone, then try again.";
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") {
    return "No usable microphone was found. Connect a microphone, then try again.";
  }
  if (name === "NotReadableError" || name === "AbortError") {
    return "Cloud9 could not use the microphone. Close other apps using it, then try again.";
  }
  return "Cloud9 could not start audio recording. Check your microphone, then try again.";
}

/** A small, truthful level sample from an AnalyserNode's time-domain data. */
export function microphoneLevel(data: Uint8Array): number {
  if (data.length === 0) return 0;
  let sum = 0;
  for (const sample of data) {
    const centered = (sample - 128) / 128;
    sum += centered * centered;
  }
  return Math.min(1, Math.sqrt(sum / data.length) * 2.8);
}
