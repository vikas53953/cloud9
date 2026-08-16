/** Durable, user-owned chat presentation and channel notification choices. */

export type ChatFontSize = "small" | "medium" | "large";
export type MessageDensity = "comfortable" | "compact";
export type TimestampStyle = "relative" | "exact";
export type AvatarSize = "small" | "medium" | "large";
export type ChannelNotificationMode = "all" | "mentions" | "off";

export interface ChannelNotificationModeWords {
  markerTitle: string;
  markerAriaLabel: string;
}

/**
 * The three durable avatar choices share one scale table with the room CSS.
 * Components still own their base size (message face, header face, or the
 * tiny thread stack); this helper turns the selected setting into the actual
 * pixel dimension passed to the face component so an inline child cannot
 * overflow a smaller wrapper.
 */
const CHAT_AVATAR_SCALES: Readonly<Record<AvatarSize, number>> = {
  small: 0.8,
  medium: 1,
  large: 1.2,
};

export function chatAvatarScale(size: AvatarSize): number {
  return CHAT_AVATAR_SCALES[size];
}

export function chatAvatarSizePx(size: AvatarSize, base = 34): number {
  return Math.round(base * chatAvatarScale(size));
}

/** Plain words for the compact channel-row marker. */
export function channelNotificationModeWords(mode: ChannelNotificationMode): ChannelNotificationModeWords {
  if (mode === "off") {
    return {
      markerTitle: "Notifications off — no notifications from this channel; mentions do not get through",
      markerAriaLabel: "Notifications off; mentions do not get through",
    };
  }
  return {
    markerTitle: "Muted — only somebody mentioning you by name gets through",
    markerAriaLabel: "Muted; mentions still get through",
  };
}

export interface ChatPersonalization {
  fontSize: ChatFontSize;
  density: MessageDensity;
  timestamp: TimestampStyle;
  avatarSize: AvatarSize;
}

export const DEFAULT_CHAT_PERSONALIZATION: ChatPersonalization = {
  fontSize: "medium",
  density: "comfortable",
  timestamp: "relative",
  avatarSize: "medium",
};

const FONT_SIZES = new Set<ChatFontSize>(["small", "medium", "large"]);
const DENSITIES = new Set<MessageDensity>(["comfortable", "compact"]);
const TIMESTAMPS = new Set<TimestampStyle>(["relative", "exact"]);
const AVATAR_SIZES = new Set<AvatarSize>(["small", "medium", "large"]);
const NOTIFICATION_MODES = new Set<ChannelNotificationMode>(["all", "mentions", "off"]);
const MAX_CHANNEL_ID = 200;
const MAX_CHANNEL_PREFS = 512;

function objectOf(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function choice<T extends string>(value: unknown, allowed: ReadonlySet<T>, fallback: T): T {
  return typeof value === "string" && allowed.has(value as T) ? value as T : fallback;
}

function validChannelId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_CHANNEL_ID
    && value !== "__proto__" && value !== "constructor" && value !== "prototype";
}

/** Return a short validation reason without echoing untrusted values. */
export function validateChatPersonalization(value: unknown): string | null {
  const raw = objectOf(value);
  if (!FONT_SIZES.has(raw.fontSize as ChatFontSize)) return "fontSize must be small, medium, or large";
  if (!DENSITIES.has(raw.density as MessageDensity)) return "density must be comfortable or compact";
  if (!TIMESTAMPS.has(raw.timestamp as TimestampStyle)) return "timestamp must be relative or exact";
  if (!AVATAR_SIZES.has(raw.avatarSize as AvatarSize)) return "avatarSize must be small, medium, or large";
  return null;
}

/** Read durable settings defensively; malformed local storage gets defaults. */
export function normalizeChatPersonalization(value: unknown): ChatPersonalization {
  const raw = objectOf(value);
  return {
    fontSize: choice(raw.fontSize, FONT_SIZES, DEFAULT_CHAT_PERSONALIZATION.fontSize),
    density: choice(raw.density, DENSITIES, DEFAULT_CHAT_PERSONALIZATION.density),
    timestamp: choice(raw.timestamp, TIMESTAMPS, DEFAULT_CHAT_PERSONALIZATION.timestamp),
    avatarSize: choice(raw.avatarSize, AVATAR_SIZES, DEFAULT_CHAT_PERSONALIZATION.avatarSize),
  };
}

type ChannelPrefs = {
  channelNotificationModes?: unknown;
  mutedChannelIds?: unknown;
};

function normalizedChannelIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const id of value) {
    if (!validChannelId(id) || out.includes(id)) continue;
    out.push(id);
    if (out.length >= MAX_CHANNEL_PREFS) break;
  }
  return out;
}

function normalizedChannelModes(value: unknown): Record<string, ChannelNotificationMode> {
  const raw = objectOf(value);
  const out: Record<string, ChannelNotificationMode> = {};
  for (const [id, mode] of Object.entries(raw)) {
    if (!validChannelId(id) || !NOTIFICATION_MODES.has(mode as ChannelNotificationMode)) continue;
    out[id] = mode as ChannelNotificationMode;
    if (Object.keys(out).length >= MAX_CHANNEL_PREFS) break;
  }
  return out;
}

/** Resolve an explicit rule, retaining compatibility with legacy mute lists. */
export function channelNotificationModeFor(prefs: ChannelPrefs, channelId?: string): ChannelNotificationMode {
  if (!validChannelId(channelId)) return "all";
  const modes = normalizedChannelModes(prefs.channelNotificationModes);
  const explicit = modes[channelId];
  if (explicit) return explicit;
  return normalizedChannelIds(prefs.mutedChannelIds).includes(channelId) ? "mentions" : "all";
}

/** Set one rule while clearing the old legacy representation for that room. */
export function withChannelNotificationMode<P extends ChannelPrefs>(
  prefs: P, channelId: string, mode: ChannelNotificationMode,
): P & { channelNotificationModes: Record<string, ChannelNotificationMode>; mutedChannelIds: string[] } {
  if (!validChannelId(channelId) || !NOTIFICATION_MODES.has(mode)) return {
    ...prefs,
    channelNotificationModes: normalizedChannelModes(prefs.channelNotificationModes),
    mutedChannelIds: normalizedChannelIds(prefs.mutedChannelIds),
  } as P & { channelNotificationModes: Record<string, ChannelNotificationMode>; mutedChannelIds: string[] };
  const modes = normalizedChannelModes(prefs.channelNotificationModes);
  modes[channelId] = mode;
  const mutedChannelIds = normalizedChannelIds(prefs.mutedChannelIds).filter(id => id !== channelId);
  return { ...prefs, channelNotificationModes: modes, mutedChannelIds };
}

/** Remove rules for rooms that are no longer in the server-authorized snapshot. */
export function reconcileChannelNotificationPrefs<P extends ChannelPrefs>(
  prefs: P, accessibleChannelIds: readonly string[],
): P & { channelNotificationModes: Record<string, ChannelNotificationMode>; mutedChannelIds: string[] } {
  const allowed = new Set(accessibleChannelIds.filter(validChannelId).slice(0, MAX_CHANNEL_PREFS));
  const modes = normalizedChannelModes(prefs.channelNotificationModes);
  for (const id of Object.keys(modes)) if (!allowed.has(id)) delete modes[id];
  const mutedChannelIds = normalizedChannelIds(prefs.mutedChannelIds).filter(id => allowed.has(id));
  return { ...prefs, channelNotificationModes: modes, mutedChannelIds };
}
