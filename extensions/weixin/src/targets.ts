/**
 * Normalize a raw target string into a Weixin recipient identifier.
 *
 * Supported formats:
 * - `weixin:<uin>` → `<uin>` (explicit channel prefix)
 * - `user:<uin>` → `<uin>` (user DM target)
 * - `group:<chatId>` → `<chatId>` (group target)
 * - bare numeric string → treated as UIN
 */
export function normalizeWeixinTarget(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }

  const lowered = trimmed.toLowerCase();

  if (lowered.startsWith("weixin:")) {
    return trimmed.slice("weixin:".length).trim() || null;
  }
  if (lowered.startsWith("wechat:")) {
    return trimmed.slice("wechat:".length).trim() || null;
  }
  if (lowered.startsWith("user:")) {
    return trimmed.slice("user:".length).trim() || null;
  }
  if (lowered.startsWith("group:")) {
    return trimmed.slice("group:".length).trim() || null;
  }

  return trimmed;
}

/**
 * Format a target identifier with an appropriate prefix.
 */
export function formatWeixinTarget(id: string, isGroup?: boolean): string {
  const trimmed = id.trim();
  if (isGroup) {
    return `group:${trimmed}`;
  }
  return `user:${trimmed}`;
}

/**
 * Check if a raw string looks like a Weixin target identifier.
 */
export function looksLikeWeixinId(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) {
    return false;
  }
  if (/^(weixin|wechat|user|group):/i.test(trimmed)) {
    return true;
  }
  // Weixin UINs are typically numeric
  if (/^\d{6,}$/.test(trimmed)) {
    return true;
  }
  return false;
}

/**
 * Resolve the target type from the identifier format.
 */
export function resolveWeixinTargetType(id: string): "user" | "group" {
  const trimmed = id.trim().toLowerCase();
  if (trimmed.startsWith("group:")) {
    return "group";
  }
  return "user";
}
