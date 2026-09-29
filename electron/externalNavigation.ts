export const MAX_WEB_NAVIGATION_URL_CHARS = 8192;

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u;
const EXPLICIT_SCHEME = /^[a-z][a-z0-9+.-]*:/iu;
const LOCALHOST_INPUT = /^localhost(?::\d+)?(?:[/?#]|$)/iu;
const IPV4_INPUT = /^\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?(?:[/?#]|$)/u;
const IPV6_INPUT = /^\[[0-9a-f:.]+\](?::\d+)?(?:[/?#]|$)/iu;

function boundedNavigationInput(input: unknown): string | null {
  if (typeof input !== "string") return null;
  if (
    input.length > MAX_WEB_NAVIGATION_URL_CHARS ||
    CONTROL_CHARACTERS.test(input) ||
    input.includes("\\")
  ) {
    return null;
  }
  const value = input.trim();
  if (!value) return null;
  return value;
}

/**
 * Validate a fully-qualified URL before it reaches an Electron navigation or
 * shell.openExternal boundary. Keep this stricter than Chromium's parser:
 * terminal output and embedded web pages are untrusted inputs.
 */
export function safeWebNavigationUrl(input: unknown): string | null {
  const value = boundedNavigationInput(input);
  if (!value) return null;

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }

  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    !parsed.hostname ||
    parsed.username ||
    parsed.password ||
    parsed.href.length > MAX_WEB_NAVIGATION_URL_CHARS
  ) {
    return null;
  }
  return parsed.href;
}

/**
 * The UA Chrome itself sends, built from the runtime Chrome version. Chrome
 * froze its platform tokens (UA reduction), so these literals are exactly what
 * real Chrome reports per platform. Constructed rather than scrubbed from
 * Electron's fallback so an app rename can never leak a token back into the
 * UA — identity providers (Google especially) refuse sign-in to anything
 * whose UA advertises an embedded app view.
 */
export function chromeUserAgentFor(platform: string, chromeVersion: string): string {
  const os =
    platform === "darwin"
      ? "Macintosh; Intel Mac OS X 10_15_7"
      : platform === "win32"
        ? "Windows NT 10.0; Win64; x64"
        : "X11; Linux x86_64";
  return `Mozilla/5.0 (${os}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`;
}

export type WindowOpenDecision =
  | { action: "popup" }
  | { action: "navigate"; url: string }
  | { action: "deny" };

/**
 * Policy for window.open / target=_blank inside the embedded browser. OAuth
 * popups open about:blank first and are scripted by their opener, so they must
 * become REAL windows or the window.opener handshake sign-in flows depend on
 * is severed. Plain target=_blank links (foreground/background-tab
 * dispositions) stay in the single-pane browser.
 */
export function decideWindowOpen(url: unknown, disposition: unknown): WindowOpenDecision {
  const isPopup = disposition === "new-window";
  const raw = typeof url === "string" ? url : "";
  if (isPopup && (raw === "" || raw === "about:blank")) return { action: "popup" };
  const target = safeWebNavigationUrl(raw);
  if (!target) return { action: "deny" };
  return isPopup ? { action: "popup" } : { action: "navigate", url: target };
}

/** Normalize user-entered browser locations, then apply the same boundary. */
export function normalizeWebNavigationInput(input: unknown): string | null {
  const value = boundedNavigationInput(input);
  if (!value || /^[/?#]/u.test(value)) return null;

  if (/^https?:\/\//iu.test(value)) {
    return safeWebNavigationUrl(value);
  }
  if (LOCALHOST_INPUT.test(value) || IPV4_INPUT.test(value) || IPV6_INPUT.test(value)) {
    return safeWebNavigationUrl(`http://${value}`);
  }
  if (EXPLICIT_SCHEME.test(value)) return null;
  return safeWebNavigationUrl(`https://${value}`);
}
