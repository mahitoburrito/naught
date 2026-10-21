import { useState, useEffect } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import type { LucideIcon } from "lucide-react";
import {
  X, Key, Check, AlertCircle, Loader2, ExternalLink, Network,
  SlidersHorizontal, Puzzle, Palette, Type, Monitor, Minus, Plus, Bell, FileText, Sparkles, Terminal, Server,
} from "lucide-react";
import { useCoordinatorAgentStore } from "../stores/useCoordinatorAgentStore";
import type { CoordinatorCredentialSource } from "../types/coordinatorAgent";
import { useStore } from "../stores/useStore";
import { SectionHeader, SettingRow } from "./settings/primitives";
import { SessionsTab } from "./settings/SessionsTab";
import { DevboxesTab } from "./settings/DevboxesTab";
import {
  TERMINAL_FONT_FAMILIES,
  TERMINAL_THEMES,
  WORKSPACE_BACKGROUNDS,
  type TerminalFontFamilyId,
  type TerminalThemeId,
  type WorkspaceBackgroundId,
} from "../theme/appearance";

type SettingsTab = "general" | "sessions" | "devboxes" | "appearance" | "integrations";

interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
}

const TABS: { id: SettingsTab; label: string; icon: LucideIcon }[] = [
  { id: "general", label: "General", icon: SlidersHorizontal },
  { id: "sessions", label: "Sessions", icon: Terminal },
  { id: "devboxes", label: "Devboxes", icon: Server },
  { id: "appearance", label: "Appearance", icon: Palette },
  { id: "integrations", label: "Integrations", icon: Puzzle },
];

export function SettingsModal({ open, onClose }: SettingsModalProps) {
  const [tab, setTab] = useState<SettingsTab>("general");
  const [apiKey, setApiKey] = useState("");
  const [hasExistingKey, setHasExistingKey] = useState(false);
  const [isValidating, setIsValidating] = useState(false);
  const [validationResult, setValidationResult] = useState<{
    valid: boolean;
    user?: { name: string; email: string };
    error?: string;
  } | null>(null);
  const [defaultBaseBranch, setDefaultBaseBranch] = useState("main");
  const [createWorktree, setCreateWorktree] = useState(false);
  const [ticketPromptTemplate, setTicketPromptTemplate] = useState("");
  const [autoCareful, setAutoCareful] = useState(false);
  const [resumeSessionsOnLaunch, setResumeSessionsOnLaunch] = useState(false);
  const [defaultStartingDirectory, setDefaultStartingDirectory] = useState("");
  const [rememberLastDirectory, setRememberLastDirectory] = useState(true);
  const [defaultAgentId, setDefaultAgentId] = useState("");
  const [defaultInitialPrompt, setDefaultInitialPrompt] = useState("");
  const [agentRules, setAgentRules] = useState("");
  const [isSaving, setIsSaving] = useState(false);

  const coordinatorStore = useCoordinatorAgentStore();
  const {
    workspaceBackground,
    setWorkspaceBackground,
    terminalTheme,
    setTerminalTheme,
    terminalFontFamily,
    setTerminalFontFamily,
    terminalFontSize,
    setTerminalFontSize,
  } = useStore();
  const [coordinatorApiKey, setCoordinatorApiKey] = useState("");
  const [hasCoordinatorKey, setHasCoordinatorKey] = useState(false);
  const [coordinatorKeySource, setCoordinatorKeySource] = useState<CoordinatorCredentialSource>(null);
  const [isCoordinatorSaving, setIsCoordinatorSaving] = useState(false);
  const [geminiApiKey, setGeminiApiKey] = useState("");
  const [hasGeminiKey, setHasGeminiKey] = useState(false);
  const [geminiModel, setGeminiModel] = useState("gemini-2.5-flash");
  const [isGeminiSaving, setIsGeminiSaving] = useState(false);

  useEffect(() => {
    if (open) {
      fetch("/api/coordinator-agent/config")
        .then((res) => res.json())
        .then((config) => {
          setHasCoordinatorKey(!!config.hasApiKey);
          setCoordinatorKeySource(config.source ?? null);
        })
        .catch(console.error);

      fetch("/api/linear/config")
        .then((res) => res.json())
        .then((config) => {
          setHasExistingKey(config.hasApiKey);
          setDefaultBaseBranch(config.defaultBaseBranch || "main");
          setCreateWorktree(config.createWorktree ?? false);
          setAutoCareful(config.autoCareful ?? false);
          setResumeSessionsOnLaunch(config.resumeSessionsOnLaunch ?? false);
          setTicketPromptTemplate(config.ticketPromptTemplate || "");
          setDefaultStartingDirectory(config.defaultStartingDirectory || "");
          setRememberLastDirectory(config.rememberLastDirectory ?? true);
          setDefaultAgentId(config.defaultAgentId || "");
          setDefaultInitialPrompt(config.initialPrompt || "");
        })
        .catch(console.error);

      fetch("/api/title-generation/config")
        .then((res) => res.json())
        .then((config) => {
          setHasGeminiKey(config.hasApiKey);
          setGeminiModel(config.model || "gemini-2.5-flash");
        })
        .catch(console.error);

      fetch("/api/agent-rules")
        .then((res) => res.json())
        .then((config) => {
          setAgentRules(config.rules || "");
        })
        .catch(console.error);
    }
  }, [open]);

  const handleValidate = async () => {
    if (!apiKey.trim()) return;
    setIsValidating(true);
    setValidationResult(null);
    try {
      const res = await fetch("/api/linear/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: apiKey.trim() }),
      });
      setValidationResult(await res.json());
    } catch {
      setValidationResult({ valid: false, error: "Failed to validate" });
    } finally {
      setIsValidating(false);
    }
  };

  const handleSave = async () => {
    setIsSaving(true);
    try {
      await fetch("/api/linear/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          apiKey: apiKey.trim() || undefined,
          defaultBaseBranch,
          createWorktree,
          autoCareful,
          resumeSessionsOnLaunch,
          ticketPromptTemplate: ticketPromptTemplate || undefined,
          defaultStartingDirectory,
          rememberLastDirectory,
          defaultAgentId,
          initialPrompt: defaultInitialPrompt,
        }),
      });
      await fetch("/api/agent-rules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rules: agentRules }),
      });
      if (apiKey.trim()) setHasExistingKey(true);
      setApiKey("");
      setValidationResult(null);
      onClose();
    } catch (e) {
      console.error("Failed to save settings:", e);
    } finally {
      setIsSaving(false);
    }
  };

  const handleRemoveKey = async () => {
    setIsSaving(true);
    try {
      await fetch("/api/linear/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: "" }),
      });
      setHasExistingKey(false);
      setApiKey("");
      setValidationResult(null);
    } catch (e) {
      console.error("Failed to remove key:", e);
    } finally {
      setIsSaving(false);
    }
  };

  const applyCoordinatorConfig = (config: { hasApiKey?: boolean; source?: CoordinatorCredentialSource }) => {
    setHasCoordinatorKey(!!config.hasApiKey);
    setCoordinatorKeySource(config.source ?? null);
    setCoordinatorApiKey("");
    if (window.electronAPI?.isElectron) coordinatorStore.checkAvailability();
  };

  const handleCoordinatorSave = async () => {
    if (!coordinatorApiKey.trim()) return;
    setIsCoordinatorSaving(true);
    try {
      const res = await fetch("/api/coordinator-agent/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: coordinatorApiKey.trim() }),
      });
      applyCoordinatorConfig(await res.json());
    } catch (e) {
      console.error("Failed to save coordinator config:", e);
    } finally {
      setIsCoordinatorSaving(false);
    }
  };

  const handleCoordinatorRemoveKey = async () => {
    setIsCoordinatorSaving(true);
    try {
      const res = await fetch("/api/coordinator-agent/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: "" }),
      });
      applyCoordinatorConfig(await res.json());
    } catch (e) {
      console.error("Failed to remove coordinator key:", e);
    } finally {
      setIsCoordinatorSaving(false);
    }
  };

  const handleGeminiSave = async () => {
    if (!geminiApiKey.trim()) return;
    setIsGeminiSaving(true);
    try {
      const res = await fetch("/api/title-generation/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: geminiApiKey.trim() }),
      });
      const config = await res.json();
      setHasGeminiKey(config.hasApiKey);
      setGeminiModel(config.model || "gemini-2.5-flash");
      setGeminiApiKey("");
    } catch (e) {
      console.error("Failed to save Gemini config:", e);
    } finally {
      setIsGeminiSaving(false);
    }
  };

  const handleGeminiRemoveKey = async () => {
    setIsGeminiSaving(true);
    try {
      const res = await fetch("/api/title-generation/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: "" }),
      });
      const config = await res.json();
      setHasGeminiKey(config.hasApiKey);
      setGeminiApiKey("");
    } catch (e) {
      console.error("Failed to remove Gemini config:", e);
    } finally {
      setIsGeminiSaving(false);
    }
  };

  return createPortal(
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50"
            onClick={onClose}
          />
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            className="fixed inset-0 z-50 flex items-center justify-center pointer-events-none"
          >
            <div className="pointer-events-auto w-full max-w-[680px] mx-4">
              <div className="bg-surface rounded-xl border border-border shadow-2xl overflow-hidden flex flex-col max-h-[calc(100vh-6rem)]">
                {/* Header */}
                <div className="px-5 py-4 border-b border-border flex items-center justify-between flex-shrink-0">
                  <h2 className="text-lg font-semibold text-white">Settings</h2>
                  <button
                    onClick={onClose}
                    className="p-1.5 rounded-md text-zinc-400 hover:text-white hover:bg-canvas transition-colors"
                  >
                    <X className="w-5 h-5" />
                  </button>
                </div>

                {/* Body: sidebar + content */}
                <div className="flex flex-1 min-h-0">
                  {/* Sidebar */}
                  <nav className="w-[180px] flex-shrink-0 border-r border-border p-3 space-y-0.5">
                    {TABS.map(({ id, label, icon: Icon }) => (
                      <button
                        key={id}
                        onClick={() => setTab(id)}
                        className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm transition-colors ${
                          tab === id
                            ? "bg-zinc-800 text-white font-medium"
                            : "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50"
                        }`}
                      >
                        <Icon className="w-4 h-4" />
                        {label}
                      </button>
                    ))}
                  </nav>

                  {/* Content */}
                  <div className="flex-1 overflow-y-auto p-5">
                    {tab === "general" && <GeneralTab
                      agentRules={agentRules}
                      setAgentRules={setAgentRules}
                    />}
                    {tab === "sessions" && <SessionsTab
                      defaultStartingDirectory={defaultStartingDirectory}
                      setDefaultStartingDirectory={setDefaultStartingDirectory}
                      rememberLastDirectory={rememberLastDirectory}
                      setRememberLastDirectory={setRememberLastDirectory}
                      defaultAgentId={defaultAgentId}
                      setDefaultAgentId={setDefaultAgentId}
                      defaultInitialPrompt={defaultInitialPrompt}
                      setDefaultInitialPrompt={setDefaultInitialPrompt}
                      defaultBaseBranch={defaultBaseBranch}
                      setDefaultBaseBranch={setDefaultBaseBranch}
                      createWorktree={createWorktree}
                      setCreateWorktree={setCreateWorktree}
                      autoCareful={autoCareful}
                      setAutoCareful={setAutoCareful}
                      resumeSessionsOnLaunch={resumeSessionsOnLaunch}
                      setResumeSessionsOnLaunch={setResumeSessionsOnLaunch}
                    />}
                    {tab === "devboxes" && <DevboxesTab />}
                    {tab === "appearance" && <AppearanceTab
                      workspaceBackground={workspaceBackground}
                      setWorkspaceBackground={setWorkspaceBackground}
                      terminalTheme={terminalTheme}
                      setTerminalTheme={setTerminalTheme}
                      terminalFontFamily={terminalFontFamily}
                      setTerminalFontFamily={setTerminalFontFamily}
                      terminalFontSize={terminalFontSize}
                      setTerminalFontSize={setTerminalFontSize}
                    />}
                    {tab === "integrations" && <IntegrationsTab
                      apiKey={apiKey}
                      setApiKey={setApiKey}
                      hasExistingKey={hasExistingKey}
                      isValidating={isValidating}
                      validationResult={validationResult}
                      setValidationResult={setValidationResult}
                      handleValidate={handleValidate}
                      handleRemoveKey={handleRemoveKey}
                      ticketPromptTemplate={ticketPromptTemplate}
                      setTicketPromptTemplate={setTicketPromptTemplate}
                      coordinatorApiKey={coordinatorApiKey}
                      setCoordinatorApiKey={setCoordinatorApiKey}
                      hasCoordinatorKey={hasCoordinatorKey}
                      coordinatorKeySource={coordinatorKeySource}
                      isCoordinatorSaving={isCoordinatorSaving}
                      handleCoordinatorSave={handleCoordinatorSave}
                      handleCoordinatorRemoveKey={handleCoordinatorRemoveKey}
                      geminiApiKey={geminiApiKey}
                      setGeminiApiKey={setGeminiApiKey}
                      hasGeminiKey={hasGeminiKey}
                      geminiModel={geminiModel}
                      isGeminiSaving={isGeminiSaving}
                      handleGeminiSave={handleGeminiSave}
                      handleGeminiRemoveKey={handleGeminiRemoveKey}
                    />}
                  </div>
                </div>

                {/* Footer */}
                <div className="px-5 py-3.5 border-t border-border flex justify-end gap-2 flex-shrink-0">
                  {/* Appearance and Devboxes apply immediately — a Save button
                      there would imply changes are pending when they are not. */}
                  {tab === "appearance" || tab === "devboxes" ? (
                    <button
                      onClick={onClose}
                      className="px-4 py-1.5 rounded-md text-sm font-medium bg-zinc-200 text-zinc-950 hover:bg-zinc-100 transition-colors"
                    >
                      Done
                    </button>
                  ) : (
                    <>
                      <button
                        onClick={onClose}
                        className="px-3 py-1.5 rounded-md text-sm text-zinc-400 hover:text-white hover:bg-canvas transition-colors"
                      >
                        Cancel
                      </button>
                      <button
                        onClick={handleSave}
                        disabled={isSaving || (!!apiKey.trim() && !validationResult?.valid)}
                        className="px-4 py-1.5 rounded-md text-sm font-medium bg-white text-canvas hover:bg-zinc-100 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                      >
                        {isSaving ? "Saving..." : "Save"}
                      </button>
                    </>
                  )}
                </div>
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>,
    document.body
  );
}

/* ─── Tab content components ─── */

function AppearanceTab({
  workspaceBackground,
  setWorkspaceBackground,
  terminalTheme,
  setTerminalTheme,
  terminalFontFamily,
  setTerminalFontFamily,
  terminalFontSize,
  setTerminalFontSize,
}: {
  workspaceBackground: WorkspaceBackgroundId;
  setWorkspaceBackground: (v: WorkspaceBackgroundId) => void;
  terminalTheme: TerminalThemeId;
  setTerminalTheme: (v: TerminalThemeId) => void;
  terminalFontFamily: TerminalFontFamilyId;
  setTerminalFontFamily: (v: TerminalFontFamilyId) => void;
  terminalFontSize: number;
  setTerminalFontSize: (v: number) => void;
}) {
  const selectedTerminalTheme =
    TERMINAL_THEMES.find((theme) => theme.id === terminalTheme) ?? TERMINAL_THEMES[0];
  const selectedFont =
    TERMINAL_FONT_FAMILIES.find((font) => font.id === terminalFontFamily) ??
    TERMINAL_FONT_FAMILIES[0];

  return (
    <>
      <SectionHeader title="Workspace" />
      <div className="rounded-lg border border-border bg-canvas/40">
        <div className="p-4">
          <div className="mb-3 flex items-center gap-2">
            <Monitor className="w-4 h-4 text-zinc-500" />
            <div>
              <div className="text-sm text-zinc-200">Canvas background</div>
              <div className="text-xs text-zinc-500">Used behind agent cards and categories</div>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            {WORKSPACE_BACKGROUNDS.map((background) => {
              const selected = workspaceBackground === background.id;
              return (
                <button
                  key={background.id}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => setWorkspaceBackground(background.id)}
                  className={`rounded-lg border p-3 text-left transition-colors ${
                    selected
                      ? "border-zinc-300 bg-zinc-800"
                      : "border-border bg-canvas/40 hover:border-zinc-600 hover:bg-zinc-800/50"
                  }`}
                >
                  <div className="mb-2 flex h-8 overflow-hidden rounded-md border border-zinc-950/10">
                    {background.preview.map((color) => (
                      <div key={color} className="flex-1" style={{ background: color }} />
                    ))}
                  </div>
                  <div className="text-sm font-medium text-zinc-100">{background.name}</div>
                  <div className="text-xs text-zinc-500">{background.description}</div>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      <SectionHeader title="Terminal" />
      <div className="rounded-lg border border-border bg-canvas/40">
        <div className="p-4 space-y-4">
          <div>
            <div className="mb-3 flex items-center gap-2">
              <Palette className="w-4 h-4 text-zinc-500" />
              <div>
                <div className="text-sm text-zinc-200">Terminal background</div>
                <div className="text-xs text-zinc-500">Applies to sidebar and focus terminals</div>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              {TERMINAL_THEMES.map((theme) => {
                const selected = terminalTheme === theme.id;
                return (
                  <button
                    key={theme.id}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => setTerminalTheme(theme.id)}
                    className={`rounded-lg border p-3 text-left transition-colors ${
                      selected
                        ? "border-zinc-300 bg-zinc-800"
                        : "border-border bg-canvas/40 hover:border-zinc-600 hover:bg-zinc-800/50"
                    }`}
                  >
                    <div className="mb-2 flex h-8 overflow-hidden rounded-md border border-zinc-950/10">
                      {theme.preview.map((color) => (
                        <div key={color} className="flex-1" style={{ backgroundColor: color }} />
                      ))}
                    </div>
                    <div className="text-sm font-medium text-zinc-100">{theme.name}</div>
                    <div className="text-xs text-zinc-500">{theme.description}</div>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="border-t border-border pt-4">
            <div className="mb-3 flex items-center gap-2">
              <Type className="w-4 h-4 text-zinc-500" />
              <div>
                <div className="text-sm text-zinc-200">Terminal type</div>
                <div className="text-xs text-zinc-500">Font family and scale for agent output</div>
              </div>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {TERMINAL_FONT_FAMILIES.map((font) => (
                <button
                  key={font.id}
                  type="button"
                  aria-pressed={terminalFontFamily === font.id}
                  onClick={() => setTerminalFontFamily(font.id)}
                  className={`px-2.5 py-1.5 rounded-md text-xs transition-colors ${
                    terminalFontFamily === font.id
                      ? "bg-zinc-200 text-zinc-950"
                      : "bg-zinc-800 text-zinc-400 hover:text-zinc-100 hover:bg-zinc-700"
                  }`}
                  style={{ fontFamily: font.stack }}
                >
                  {font.name}
                </button>
              ))}
            </div>

            <div className="mt-4 flex items-center gap-3">
              <button
                type="button"
                onClick={() => setTerminalFontSize(terminalFontSize - 1)}
                className="w-7 h-7 rounded-md bg-zinc-800 text-zinc-400 hover:text-zinc-100 hover:bg-zinc-700 transition-colors flex items-center justify-center"
                title="Decrease font size"
              >
                <Minus className="w-3.5 h-3.5" />
              </button>
              <input
                type="range"
                min={11}
                max={18}
                step={1}
                value={terminalFontSize}
                onChange={(e) => setTerminalFontSize(Number(e.target.value))}
                className="flex-1 accent-zinc-200"
                aria-label="Terminal font size"
              />
              <button
                type="button"
                onClick={() => setTerminalFontSize(terminalFontSize + 1)}
                className="w-7 h-7 rounded-md bg-zinc-800 text-zinc-400 hover:text-zinc-100 hover:bg-zinc-700 transition-colors flex items-center justify-center"
                title="Increase font size"
              >
                <Plus className="w-3.5 h-3.5" />
              </button>
              <div className="w-10 text-right text-xs font-mono text-zinc-400">
                {terminalFontSize}px
              </div>
            </div>
          </div>

          <div
            className="rounded-lg border p-3"
            style={{
              backgroundColor: selectedTerminalTheme.background,
              borderColor: selectedTerminalTheme.border,
              color: selectedTerminalTheme.foreground,
              fontFamily: selectedFont.stack,
              fontSize: terminalFontSize,
            }}
          >
            <div className="flex items-center gap-1.5 text-[11px]" style={{ color: selectedTerminalTheme.muted }}>
              <span>codex</span>
              <span>main</span>
              <span>~/openui</span>
            </div>
            <div className="mt-2 leading-relaxed">
              <span style={{ color: selectedTerminalTheme.ansi.green }}>$</span>{" "}
              <span>claude code</span>
            </div>
            <div className="leading-relaxed" style={{ color: selectedTerminalTheme.muted }}>
              polishing terminal pane, theme and font applied
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

function GeneralTab({
  agentRules,
  setAgentRules,
}: {
  agentRules: string;
  setAgentRules: (v: string) => void;
}) {
  return (
    <>
      <SectionHeader title="Agents" />
      <div className="rounded-lg border border-border bg-canvas/40">
        <div className="p-4">
          <div className="mb-3 flex items-center gap-2">
            <FileText className="w-4 h-4 text-zinc-500" />
            <div>
              <div className="text-sm text-zinc-200">Agent rules</div>
              <div className="text-xs text-zinc-500">Prepended to new Codex and Claude sessions</div>
            </div>
          </div>
          <textarea
            value={agentRules}
            onChange={(e) => setAgentRules(e.target.value)}
            maxLength={12000}
            rows={6}
            placeholder={"Always inspect the repo before editing.\nKeep changes scoped.\nRun the relevant tests before finishing."}
            className="w-full px-3 py-2 rounded-md bg-canvas border border-border text-white text-sm placeholder-zinc-600 focus:outline-none focus:border-zinc-500 transition-colors resize-y min-h-[120px] font-mono leading-relaxed"
          />
          <div className="mt-2 flex items-center justify-between text-[11px] text-zinc-600">
            <span>Saved locally in OpenUI settings.</span>
            <span>{agentRules.length}/12000</span>
          </div>
        </div>
      </div>

      <SectionHeader title="Notifications" />
      <div className="rounded-lg border border-border bg-canvas/40">
        <div className="px-4">
          <SettingRow
            title="Activity bell"
            description="Unread agent events show as a red badge in the header. Toast cards stay hidden."
            last
          >
            <div className="relative flex h-7 w-7 items-center justify-center rounded-md border border-border bg-canvas text-zinc-300">
              <Bell className="h-3.5 w-3.5" />
              <span className="absolute -right-1 -top-1 h-2.5 w-2.5 rounded-full bg-red-500 ring-2 ring-canvas" />
            </div>
          </SettingRow>
        </div>
      </div>

    </>
  );
}

function IntegrationsTab({
  apiKey,
  setApiKey,
  hasExistingKey,
  isValidating,
  validationResult,
  setValidationResult,
  handleValidate,
  handleRemoveKey,
  ticketPromptTemplate,
  setTicketPromptTemplate,
  coordinatorApiKey,
  setCoordinatorApiKey,
  hasCoordinatorKey,
  coordinatorKeySource,
  isCoordinatorSaving,
  handleCoordinatorSave,
  handleCoordinatorRemoveKey,
  geminiApiKey,
  setGeminiApiKey,
  hasGeminiKey,
  geminiModel,
  isGeminiSaving,
  handleGeminiSave,
  handleGeminiRemoveKey,
}: {
  apiKey: string;
  setApiKey: (v: string) => void;
  hasExistingKey: boolean;
  isValidating: boolean;
  validationResult: { valid: boolean; user?: { name: string; email: string }; error?: string } | null;
  setValidationResult: (v: null) => void;
  handleValidate: () => void;
  handleRemoveKey: () => void;
  ticketPromptTemplate: string;
  setTicketPromptTemplate: (v: string) => void;
  coordinatorApiKey: string;
  setCoordinatorApiKey: (v: string) => void;
  hasCoordinatorKey: boolean;
  coordinatorKeySource: CoordinatorCredentialSource;
  isCoordinatorSaving: boolean;
  handleCoordinatorSave: () => void;
  handleCoordinatorRemoveKey: () => void;
  geminiApiKey: string;
  setGeminiApiKey: (v: string) => void;
  hasGeminiKey: boolean;
  geminiModel: string;
  isGeminiSaving: boolean;
  handleGeminiSave: () => void;
  handleGeminiRemoveKey: () => void;
}) {
  return (
    <>
      {/* Gemini */}
      <SectionHeader title="Session titles" />
      <div className="rounded-lg border border-border bg-canvas/40">
        <div className="px-4 py-3.5 space-y-3">
          <div className="flex items-center gap-2">
            <div
              className="w-5 h-5 rounded flex items-center justify-center"
              style={{ backgroundColor: "rgba(217, 118, 82, 0.16)" }}
            >
              <Sparkles className="w-3.5 h-3.5" style={{ color: "#E5A264" }} />
            </div>
            <span className="text-sm text-zinc-200">Gemini title generation</span>
          </div>

          {hasGeminiKey ? (
            <>
              <div className="flex items-center gap-2 px-3 py-2 rounded-md bg-green-500/10 border border-green-500/20">
                <Check className="w-4 h-4 text-green-500" />
                <span className="text-sm text-green-400">Gemini key configured</span>
                <span className="ml-auto text-xs text-zinc-500">{geminiModel}</span>
                <button
                  onClick={handleGeminiRemoveKey}
                  disabled={isGeminiSaving}
                  className="text-xs text-zinc-500 hover:text-red-400 transition-colors disabled:opacity-50"
                >
                  Remove
                </button>
              </div>
              <p className="text-xs text-zinc-500">
                Session titles keep updating from submitted prompts while the name is still auto-generated.
                Sort can also use Gemini to cluster titles by blast radius.
              </p>
            </>
          ) : (
            <>
              <p className="text-xs text-zinc-500">
                Add a Gemini API key to generate richer session titles over time and sort title clusters by blast radius.
              </p>
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <Key className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500" />
                  <input
                    type="password"
                    value={geminiApiKey}
                    onChange={(e) => setGeminiApiKey(e.target.value)}
                    placeholder="AIza..."
                    className="w-full pl-9 pr-3 py-2 rounded-md bg-canvas border border-border text-white text-sm placeholder-zinc-600 focus:outline-none focus:border-zinc-500 transition-colors"
                  />
                </div>
                <button
                  onClick={handleGeminiSave}
                  disabled={!geminiApiKey.trim() || isGeminiSaving}
                  className="px-3 py-2 rounded-md text-white text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center gap-1.5"
                  style={{ backgroundColor: "#B85C3D" }}
                >
                  {isGeminiSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : "Save"}
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Linear */}
      <SectionHeader title="Linear" />
      <div className="rounded-lg border border-border bg-canvas/40">
        <div className="px-4 py-3.5 space-y-3">
          <div className="flex items-center gap-2">
            <div className="w-5 h-5 rounded bg-indigo-500/20 flex items-center justify-center">
              <svg className="w-3.5 h-3.5 text-indigo-400" viewBox="0 0 24 24" fill="currentColor">
                <path d="M3 7.5L7.5 3H21v13.5L16.5 21H3V7.5z" />
              </svg>
            </div>
            <span className="text-sm text-zinc-200">Linear Integration</span>
          </div>

          {hasExistingKey ? (
            <>
              <div className="flex items-center gap-2 px-3 py-2 rounded-md bg-green-500/10 border border-green-500/20">
                <Check className="w-4 h-4 text-green-500" />
                <span className="text-sm text-green-400">API key configured</span>
                <button
                  onClick={handleRemoveKey}
                  className="ml-auto text-xs text-zinc-500 hover:text-red-400 transition-colors"
                >
                  Remove
                </button>
              </div>
              <p className="text-xs text-zinc-500">
                You can start sessions from Linear tickets.
              </p>
            </>
          ) : (
            <>
              <p className="text-xs text-zinc-500">
                Connect Linear to start agent sessions from tickets.{" "}
                <a
                  href="https://linear.app/settings/api"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-indigo-400 hover:text-indigo-300 inline-flex items-center gap-0.5"
                >
                  Get your API key
                  <ExternalLink className="w-3 h-3" />
                </a>
              </p>
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <Key className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500" />
                  <input
                    type="password"
                    value={apiKey}
                    onChange={(e) => {
                      setApiKey(e.target.value);
                      setValidationResult(null);
                    }}
                    placeholder="lin_api_..."
                    className="w-full pl-9 pr-3 py-2 rounded-md bg-canvas border border-border text-white text-sm placeholder-zinc-600 focus:outline-none focus:border-zinc-500 transition-colors"
                  />
                </div>
                <button
                  onClick={handleValidate}
                  disabled={!apiKey.trim() || isValidating}
                  className="px-3 py-2 rounded-md bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center gap-1.5"
                >
                  {isValidating ? <Loader2 className="w-4 h-4 animate-spin" /> : "Validate"}
                </button>
              </div>
              {validationResult && (
                <div
                  className={`flex items-center gap-2 px-3 py-2 rounded-md ${
                    validationResult.valid
                      ? "bg-green-500/10 border border-green-500/20"
                      : "bg-red-500/10 border border-red-500/20"
                  }`}
                >
                  {validationResult.valid ? (
                    <>
                      <Check className="w-4 h-4 text-green-500" />
                      <span className="text-sm text-green-400">
                        Connected as {validationResult.user?.name}
                      </span>
                    </>
                  ) : (
                    <>
                      <AlertCircle className="w-4 h-4 text-red-500" />
                      <span className="text-sm text-red-400">
                        {validationResult.error}
                      </span>
                    </>
                  )}
                </div>
              )}
            </>
          )}

          <div className="border-t border-border pt-3">
            <div className="text-sm text-zinc-200 mb-1">Ticket prompt template</div>
            <p className="text-xs text-zinc-500 mb-2.5">
              Message sent to the agent when starting from a ticket. Use{" "}
              <code className="text-indigo-400">{"{{url}}"}</code>,{" "}
              <code className="text-indigo-400">{"{{id}}"}</code>,{" "}
              <code className="text-indigo-400">{"{{title}}"}</code> as placeholders.
            </p>
            <textarea
              value={ticketPromptTemplate}
              onChange={(e) => setTicketPromptTemplate(e.target.value)}
              placeholder={"Here is the ticket for this session: {{url}}\n\nPlease use the Linear MCP tool or fetch the URL to read the full ticket details before starting work."}
              rows={4}
              className="w-full px-3 py-2 rounded-md bg-canvas border border-border text-white text-sm placeholder-zinc-600 focus:outline-none focus:border-zinc-500 transition-colors resize-none font-mono"
            />
          </div>
        </div>
      </div>

      {/* Claude-backed Coordinator */}
      <SectionHeader title="Coordination" />
      <div className="rounded-lg border border-border bg-canvas/40">
        <div className="px-4 py-3.5 space-y-3">
          <div className="flex items-center gap-2">
            <div className="w-5 h-5 rounded bg-orange-500/20 flex items-center justify-center">
              <Network className="w-3.5 h-3.5 text-orange-400" />
            </div>
            <span className="text-sm text-zinc-200">Workspace Coordinator Agent</span>
          </div>

          {!window.electronAPI?.isElectron && (
            <div className="px-3 py-2 rounded-md bg-zinc-800/50 border border-border">
              <p className="text-xs text-zinc-500">
                The AI coordinator requires the OpenUI Desktop app. The local session monitor remains available in the browser.
              </p>
            </div>
          )}

          {window.electronAPI?.isElectron && (
            <>
              {hasCoordinatorKey && coordinatorKeySource === "settings" ? (
                <>
                  <div className="flex items-center gap-2 px-3 py-2 rounded-md bg-green-500/10 border border-green-500/20">
                    <Check className="w-4 h-4 text-green-500" />
                    <span className="text-sm text-green-400">Anthropic API key configured</span>
                    <button
                      onClick={handleCoordinatorRemoveKey}
                      disabled={isCoordinatorSaving}
                      className="ml-auto text-xs text-zinc-500 hover:text-red-400 transition-colors"
                    >
                      Remove
                    </button>
                  </div>
                  <p className="text-xs text-zinc-500">
                    The coordinator runs on Claude (claude-opus-5) with this key. It can inspect sessions, record shared decisions and route guarded directives.
                  </p>
                </>
              ) : (
                <>
                  {hasCoordinatorKey && coordinatorKeySource === "env" ? (
                    <div className="flex items-center gap-2 px-3 py-2 rounded-md bg-green-500/10 border border-green-500/20">
                      <Check className="w-4 h-4 text-green-500" />
                      <span className="text-sm text-green-400">Using ANTHROPIC_API_KEY from the environment</span>
                    </div>
                  ) : null}
                  <p className="text-xs text-zinc-500">
                    {hasCoordinatorKey
                      ? "Save a key here to use it instead of the environment key."
                      : "Add an Anthropic API key to give the coordinator a Claude brain (claude-opus-5). The local session monitor works without one."}
                  </p>
                  <div className="flex gap-2">
                    <div className="relative flex-1">
                      <Key className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500" />
                      <input
                        type="password"
                        value={coordinatorApiKey}
                        onChange={(e) => setCoordinatorApiKey(e.target.value)}
                        placeholder="sk-ant-..."
                        className="w-full pl-9 pr-3 py-2 rounded-md bg-canvas border border-border text-white text-sm placeholder-zinc-600 focus:outline-none focus:border-zinc-500 transition-colors"
                      />
                    </div>
                    <button
                      onClick={handleCoordinatorSave}
                      disabled={!coordinatorApiKey.trim() || isCoordinatorSaving}
                      className="px-3 py-2 rounded-md bg-orange-600 text-white text-sm font-medium hover:bg-orange-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center gap-1.5"
                    >
                      {isCoordinatorSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : "Save"}
                    </button>
                  </div>
                </>
              )}
            </>
          )}
        </div>
      </div>
    </>
  );
}
