import { useStore } from "../stores/useStore";

export interface ResumeSessionResult {
  ok: boolean;
  /** True when a Claude conversation was resumed rather than started fresh. */
  resumed?: boolean;
  error?: string;
}

/**
 * Relaunch a disconnected session in place. Claude nodes with a saved
 * conversation resume it; everything else starts fresh in the same directory.
 */
export async function resumeSession(sessionId: string, nodeId?: string): Promise<ResumeSessionResult> {
  try {
    const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/restart`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ resume: true }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: body?.error || `HTTP ${res.status}` };
    // Reflect it right away; the next poll carries the authoritative status.
    if (nodeId) useStore.getState().updateSession(nodeId, { status: "running", isRestored: false, resumable: false });
    return { ok: true, resumed: body?.resumed === true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
