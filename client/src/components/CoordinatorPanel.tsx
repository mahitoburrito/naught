import { useState, useRef, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  X,
  Square,
  Loader2,
  ChevronDown,
  ChevronRight,
  Wrench,
  Brain,
  AlertCircle,
  CheckCircle2,
  MessageSquare,
  Send,
  Network,
  ShieldCheck,
  Clock3,
} from "lucide-react";
import { useCoordinatorAgentStore } from "../stores/useCoordinatorAgentStore";
import { useStore } from "../stores/useStore";
import { useCoordinatorStore } from "../stores/useCoordinatorStore";
import type { CoordinatorFeedEvent } from "../types/coordinatorAgent";

const terminalDirectiveStates = new Set([
  "completed_unconfirmed", "acknowledged", "rejected", "failed", "expired", "cancelled",
]);

function CoordinatorOverview() {
  const { snapshot, loading, error, refresh, setMode, acknowledgeDirective, cancelDirective } = useCoordinatorStore();

  if (loading && !snapshot) {
    return <div className="px-4 py-3 text-xs text-zinc-500">Loading workspace state…</div>;
  }
  if (error && !snapshot) {
    return <div className="px-4 py-3 text-xs text-red-400">Coordinator monitor unavailable: {error}</div>;
  }
  if (!snapshot) return null;

  const needsInput = snapshot.sessions.filter((session) => session.status === "waiting_input").length;
  const queued = snapshot.directives.filter((directive) => directive.state === "queued").length;
  const recentDirectives = snapshot.directives.slice(-4).reverse();

  return (
    <div className="flex-shrink-0 border-b border-border bg-surface/20">
      <div className="flex items-center gap-2 px-4 py-2">
        <span className="text-[10px] uppercase tracking-wider text-zinc-500">Authority</span>
        <select
          value={snapshot.mode}
          onChange={(event) => setMode(event.target.value as typeof snapshot.mode)}
          className="rounded border border-border bg-canvas px-1.5 py-1 text-[11px] text-zinc-300 focus:outline-none"
          aria-label="Coordinator authority mode"
        >
          <option value="observe">Observe</option>
          <option value="coordinate">Coordinate</option>
          {/* Accepted and persisted by the server, but no runtime honours it
              yet — selectable only once something does. */}
          <option value="control" disabled>Control (not implemented)</option>
        </select>
        <button onClick={refresh} className="ml-auto text-[10px] text-zinc-500 hover:text-zinc-300">Refresh</button>
      </div>
      <div className="grid grid-cols-4 gap-px border-y border-border bg-border">
        {[
          [snapshot.sessions.length, "sessions"],
          [needsInput, "need input"],
          [snapshot.activeDecisions.length, "decisions"],
          [queued, "queued"],
        ].map(([value, label]) => (
          <div key={label} className="bg-canvas-dark px-2 py-2 text-center">
            <div className="text-sm font-medium text-zinc-200">{value}</div>
            <div className="text-[9px] uppercase tracking-wide text-zinc-600">{label}</div>
          </div>
        ))}
      </div>
      {(snapshot.activeDecisions.length > 0 || recentDirectives.length > 0) && (
        <div className="max-h-36 overflow-y-auto px-4 py-2 space-y-2">
          {snapshot.activeDecisions.slice(-2).reverse().map((decision) => (
            <div key={decision.id} className="flex items-start gap-2 text-[11px]">
              <ShieldCheck className="mt-0.5 h-3 w-3 flex-shrink-0 text-emerald-400" />
              <div className="min-w-0">
                <span className="text-zinc-400">{decision.topic}: </span>
                <span className="text-zinc-200">{decision.choice}</span>
                <span className="ml-1 text-zinc-600">r{decision.revision}</span>
              </div>
            </div>
          ))}
          {recentDirectives.map((directive) => {
            const target = snapshot.sessions.find((session) => session.sessionId === directive.sessionId);
            const canAcknowledge = ["submitted", "observed_working", "completed_unconfirmed"].includes(directive.state);
            return (
              <div key={directive.id} className="flex items-start gap-2 text-[11px]">
                <Clock3 className={`mt-0.5 h-3 w-3 flex-shrink-0 ${terminalDirectiveStates.has(directive.state) ? "text-zinc-500" : "text-amber-400"}`} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-zinc-300" title={directive.text}>{target?.displayName || directive.sessionId}: {directive.text}</div>
                  <div className="flex items-center gap-2 text-[10px] text-zinc-600">
                    <span>{directive.state.replace(/_/g, " ")}</span>
                    {canAcknowledge && (
                      <button onClick={() => acknowledgeDirective(directive.id)} className="hover:text-emerald-400">acknowledge</button>
                    )}
                    {directive.state === "queued" && (
                      <button onClick={() => cancelDirective(directive.id)} className="hover:text-red-400">cancel</button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
      {error && <div className="px-4 pb-2 text-[10px] text-red-400">{error}</div>}
    </div>
  );
}

function EventItem({ event }: { event: CoordinatorFeedEvent }) {
  const [expanded, setExpanded] = useState(event.isExpanded);

  // Tool events are labelled with the snake_case tool name; the rest are "Thinking" / "Cancelled".
  const isThinking = event.label === "Thinking";
  const isToolCall = /^[a-z_]+$/.test(event.label);
  const isComplete = event.isCompleted;

  return (
    <div className="px-4 py-2 border-b border-border/50 last:border-b-0">
      <button
        onClick={() => event.detail && setExpanded(!expanded)}
        className="w-full flex items-center gap-2 text-left"
      >
        <div className="flex-shrink-0">
          {!isComplete && isThinking ? (
            <Loader2 className="w-3.5 h-3.5 text-blue-400 animate-spin" />
          ) : isToolCall ? (
            <Wrench className="w-3.5 h-3.5 text-purple-400" />
          ) : isComplete ? (
            <CheckCircle2 className="w-3.5 h-3.5 text-green-400" />
          ) : (
            <Brain className="w-3.5 h-3.5 text-blue-400" />
          )}
        </div>
        <span className="text-xs text-zinc-300 flex-1 truncate">{event.label}</span>
        {event.detail && (
          <div className="flex-shrink-0">
            {expanded ? (
              <ChevronDown className="w-3 h-3 text-zinc-500" />
            ) : (
              <ChevronRight className="w-3 h-3 text-zinc-500" />
            )}
          </div>
        )}
      </button>
      {expanded && event.detail && (
        <div className="mt-1.5 ml-5.5 text-[11px] text-zinc-500 font-mono whitespace-pre-wrap break-all max-h-32 overflow-y-auto">
          {event.detail}
        </div>
      )}
    </div>
  );
}

export function CoordinatorPanel() {
  const {
    panelOpen,
    setPanelOpen,
    isRunning,
    currentDirective,
    events,
    report,
    error,
    agentMessage,
    completedTurns,
    hasApiKey,
    startTurn,
    cancelTurn,
  } = useCoordinatorAgentStore();
  const { viewMode, browserPanelOpen, browserPanelWidth } = useStore();
  const browserDockOpen = viewMode === "focus" && browserPanelOpen;

  const [query, setQuery] = useState("");
  const [followUpMessage, setFollowUpMessage] = useState("");
  const feedRef = useRef<HTMLDivElement>(null);

  // Auto-scroll feed
  useEffect(() => {
    if (feedRef.current) {
      feedRef.current.scrollTop = feedRef.current.scrollHeight;
    }
  }, [events, agentMessage]);

  useEffect(() => {
    if (!panelOpen) return;
    useCoordinatorStore.getState().refresh();
    const timer = window.setInterval(() => useCoordinatorStore.getState().refresh(), 1_500);
    return () => window.clearInterval(timer);
  }, [panelOpen]);

  const handleSubmit = () => {
    const trimmed = query.trim();
    if (!trimmed || isRunning) return;
    startTurn(trimmed);
    setQuery("");
  };

  const handleSendFollowUp = () => {
    const trimmed = followUpMessage.trim();
    if (!trimmed) return;
    useCoordinatorAgentStore.getState().sendMessage(trimmed);
    setFollowUpMessage("");
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const hasReport = !!report;
  const hasError = !!error;

  return (
    <AnimatePresence>
      {panelOpen && (
        <motion.div
          initial={{ x: "100%", opacity: 0 }}
          animate={{ x: 0, opacity: 1 }}
          exit={{ x: "100%", opacity: 0 }}
          transition={{ type: "spring", stiffness: 400, damping: 40 }}
          className="fixed right-0 top-14 bottom-0 z-40 w-[480px] flex flex-col bg-canvas-dark border-l border-border"
          style={{ right: browserDockOpen ? browserPanelWidth : 0 }}
        >
          {/* Header */}
          <div className="flex-shrink-0 px-4 py-3 border-b border-border flex items-center gap-3">
            <div className="w-6 h-6 rounded bg-orange-500/20 flex items-center justify-center">
              <Network className="w-3.5 h-3.5 text-orange-400" />
            </div>
            <div className="flex-1">
              <h2 className="text-sm font-medium text-white">Workspace Coordinator</h2>
              <span className="text-[10px] text-zinc-500">
                {isRunning ? "Coordinating…" : hasReport ? "Coordinator turn complete" : "Monitor and align agent sessions"}
              </span>
            </div>
            <button
              onClick={() => setPanelOpen(false)}
              className="w-7 h-7 rounded flex items-center justify-center text-zinc-500 hover:text-white hover:bg-surface-active transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Input */}
          <div className="flex-shrink-0 px-4 py-3 border-b border-border">
            <div className="flex gap-2">
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Give the coordinator a directive…"
                disabled={isRunning}
                className="flex-1 px-3 py-2 rounded-md bg-canvas border border-border text-white text-sm placeholder-zinc-600 focus:outline-none focus:border-zinc-500 transition-colors disabled:opacity-50"
              />
              {isRunning ? (
                <button
                  onClick={cancelTurn}
                  className="px-3 py-2 rounded-md bg-red-600 text-white text-sm font-medium hover:bg-red-500 transition-colors flex items-center gap-1.5"
                >
                  <Square className="w-3.5 h-3.5" />
                  Stop
                </button>
              ) : (
                <button
                  onClick={handleSubmit}
                  disabled={!query.trim()}
                  className="px-3 py-2 rounded-md bg-orange-600 text-white text-sm font-medium hover:bg-orange-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center gap-1.5"
                >
                  <Network className="w-3.5 h-3.5" />
                  Coordinate
                </button>
              )}
            </div>
          </div>

          <CoordinatorOverview />

          {/* Content area */}
          <div className="flex-1 min-h-0 flex flex-col">
            {/* Active investigation or report */}
            {(isRunning || hasReport || hasError || events.length > 0) ? (
              <>
                {/* Current query */}
                {currentDirective && (
                  <div className="flex-shrink-0 px-4 py-2 bg-surface/50 border-b border-border">
                    <p className="text-xs text-zinc-400">
                      <span className="text-zinc-500">Directive: </span>
                      {currentDirective}
                    </p>
                  </div>
                )}

                {/* Event feed */}
                <div
                  ref={feedRef}
                  className="flex-1 min-h-0 overflow-y-auto"
                >
                  {events.map((event) => (
                    <EventItem key={event.id} event={event} />
                  ))}

                  {/* Agent message */}
                  {agentMessage && (
                    <div className="px-4 py-2 border-b border-border/50">
                      <div className="flex items-start gap-2">
                        <MessageSquare className="w-3.5 h-3.5 text-orange-400 mt-0.5 flex-shrink-0" />
                        <p className="text-xs text-zinc-300">{agentMessage}</p>
                      </div>
                    </div>
                  )}

                  {/* Error */}
                  {hasError && (
                    <div className="px-4 py-3">
                      <div className="flex items-start gap-2 px-3 py-2 rounded-md bg-red-500/10 border border-red-500/20">
                        <AlertCircle className="w-4 h-4 text-red-400 mt-0.5 flex-shrink-0" />
                        <div>
                          <p className="text-xs font-medium text-red-400">Coordinator Error</p>
                          <p className="text-xs text-red-400/70 mt-0.5">{error}</p>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Report */}
                  {hasReport && (
                    <div className="px-4 py-3">
                      <div className="rounded-md bg-surface border border-border p-3">
                        <div className="flex items-center gap-2 mb-2">
                          <CheckCircle2 className="w-4 h-4 text-green-400" />
                          <span className="text-xs font-medium text-green-400">Coordinator Report</span>
                        </div>
                        <div className="text-xs text-zinc-300 whitespace-pre-wrap font-mono leading-relaxed max-h-[400px] overflow-y-auto">
                          {report}
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Loading indicator */}
                  {isRunning && events.length === 0 && (
                    <div className="px-4 py-6 flex items-center justify-center gap-2">
                      <Loader2 className="w-4 h-4 text-orange-400 animate-spin" />
                      <span className="text-xs text-zinc-500">Starting coordinator turn…</span>
                    </div>
                  )}
                </div>

                {/* Follow-up message input during investigation */}
                {isRunning && (
                  <div className="flex-shrink-0 px-4 py-2 border-t border-border">
                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={followUpMessage}
                        onChange={(e) => setFollowUpMessage(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && !e.shiftKey) {
                            e.preventDefault();
                            handleSendFollowUp();
                          }
                        }}
                        placeholder="Send a follow-up to the coordinator…"
                        className="flex-1 px-3 py-1.5 rounded-md bg-canvas border border-border text-white text-xs placeholder-zinc-600 focus:outline-none focus:border-zinc-500 transition-colors"
                      />
                      <button
                        onClick={handleSendFollowUp}
                        disabled={!followUpMessage.trim()}
                        className="p-1.5 rounded-md text-zinc-400 hover:text-white hover:bg-surface-active disabled:opacity-30 transition-colors"
                      >
                        <Send className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                )}
              </>
            ) : (
              /* Empty / history state */
              <div className="flex-1 flex flex-col">
                {completedTurns.length > 0 ? (
                  <div className="flex-1 overflow-y-auto">
                    <div className="px-4 py-2">
                      <span className="text-[10px] text-zinc-500 uppercase tracking-wider">Recent Coordinator Turns</span>
                    </div>
                    {completedTurns.map((turn) => (
                      <button
                        key={turn.id}
                        onClick={() => {
                          setQuery(turn.directive);
                        }}
                        className="w-full px-4 py-2 text-left hover:bg-surface-active transition-colors border-b border-border/50"
                      >
                        <p className="text-xs text-zinc-300 truncate">{turn.directive}</p>
                        <p className="text-[10px] text-zinc-500 mt-0.5">
                          {new Date(turn.completedAt).toLocaleString()}
                        </p>
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="flex-1 flex items-center justify-center">
                    <div className="text-center px-8">
                      <Network className="w-8 h-8 text-zinc-700 mx-auto mb-3" />
                      {hasApiKey ? (
                        <>
                          <p className="text-sm text-zinc-400 mb-1">Coordinator ready</p>
                          <p className="text-xs text-zinc-600">
                            Ask it to inspect sessions, record a shared decision, or route a directive to an exact agent. Terminal submissions remain unconfirmed until acknowledged.
                          </p>
                        </>
                      ) : (
                        <>
                          <p className="text-sm text-zinc-400 mb-1">Coordinator needs an API key</p>
                          <p className="text-xs text-zinc-600">
                            Add an Anthropic API key in Settings → Integrations → Coordination. The local session monitor above works without one.
                          </p>
                        </>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
