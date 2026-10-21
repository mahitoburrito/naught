import { useEffect, useState } from "react";
import { FolderOpen, Sparkles } from "lucide-react";
import type { Devbox } from "../../types/compute";
import { SectionHeader, SettingRow, Toggle } from "./primitives";
import { useStore } from "../../stores/useStore";
import { canUseNativeDirectoryPicker, pickDirectoryNative } from "../../utils/nativeDirectoryPicker";

export function SessionsTab({
  defaultStartingDirectory,
  setDefaultStartingDirectory,
  rememberLastDirectory,
  setRememberLastDirectory,
  defaultAgentId,
  setDefaultAgentId,
  defaultDevboxId,
  setDefaultDevboxId,
  defaultInitialPrompt,
  setDefaultInitialPrompt,
  defaultBaseBranch,
  setDefaultBaseBranch,
  createWorktree,
  setCreateWorktree,
  autoCareful,
  setAutoCareful,
}: {
  defaultStartingDirectory: string;
  setDefaultStartingDirectory: (v: string) => void;
  rememberLastDirectory: boolean;
  setRememberLastDirectory: (v: boolean) => void;
  defaultAgentId: string;
  setDefaultAgentId: (v: string) => void;
  defaultDevboxId: string;
  setDefaultDevboxId: (v: string) => void;
  defaultInitialPrompt: string;
  setDefaultInitialPrompt: (v: string) => void;
  defaultBaseBranch: string;
  setDefaultBaseBranch: (v: string) => void;
  createWorktree: boolean;
  setCreateWorktree: (v: boolean) => void;
  autoCareful: boolean;
  setAutoCareful: (v: boolean) => void;
}) {
  const { agents, launchCwd } = useStore();
  const [devboxes, setDevboxes] = useState<Devbox[]>([]);
  useEffect(() => {
    fetch("/api/devboxes")
      .then((res) => res.json())
      .then((data) => setDevboxes(data.devboxes || []))
      .catch(() => setDevboxes([]));
  }, []);
  // Cloud nodes come and go; only boxes that outlive a session make sense as a default.
  const defaultableDevboxes = devboxes.filter((box) => box.source !== "provisioned");
  const defaultMissing = !!defaultDevboxId && devboxes.length > 0 && !devboxes.some((box) => box.id === defaultDevboxId);

  const browseForDefaultDirectory = async () => {
    const picked = await pickDirectoryNative(defaultStartingDirectory || launchCwd);
    if (picked) setDefaultStartingDirectory(picked);
  };

  return (
    <>
      <SectionHeader title="Defaults" />
      <div className="rounded-lg border border-border bg-canvas/40">
        <div className="px-4">
          <SettingRow
            title="Default starting directory"
            description="Where a new session opens. Empty means the directory the app was launched from."
          >
            <div className="flex w-[260px] gap-2">
              <input
                type="text"
                value={defaultStartingDirectory}
                onChange={(e) => setDefaultStartingDirectory(e.target.value)}
                placeholder={launchCwd || "~/"}
                className="min-w-0 flex-1 px-2.5 py-1.5 rounded-md bg-canvas border border-border text-white text-sm placeholder-zinc-600 focus:outline-none focus:border-zinc-500 transition-colors font-mono"
              />
              {canUseNativeDirectoryPicker() && (
                <button
                  type="button"
                  onClick={browseForDefaultDirectory}
                  className="flex-shrink-0 px-2.5 py-1.5 rounded-md bg-canvas border border-border text-zinc-400 hover:text-white hover:bg-surface-active transition-colors"
                  title="Choose a folder"
                  aria-label="Choose a folder"
                >
                  <FolderOpen className="w-4 h-4" />
                </button>
              )}
            </div>
          </SettingRow>

          <SettingRow
            title="Remember last-used directory"
            description="Reopen at the directory you last picked instead of the default above"
          >
            <Toggle checked={rememberLastDirectory} onChange={setRememberLastDirectory} />
          </SettingRow>

          <SettingRow
            title="Default run on"
            description={defaultMissing
              ? "The saved default devbox no longer exists; new sessions run on this Mac"
              : "Where new sessions start; you can still change it per session"}
          >
            <select
              value={defaultMissing ? "" : defaultDevboxId}
              onChange={(e) => setDefaultDevboxId(e.target.value)}
              aria-label="Default run on"
              className="w-[180px] px-2.5 py-1.5 rounded-md bg-canvas border border-border text-white text-sm focus:outline-none focus:border-zinc-500 transition-colors"
            >
              <option value="">This Mac</option>
              {defaultableDevboxes.map((box) => (
                <option key={box.id} value={box.id}>{box.name}</option>
              ))}
            </select>
          </SettingRow>

          <SettingRow
            title="Default agent"
            description="Preselected when the new-session dialog opens"
            last
          >
            <select
              value={defaultAgentId}
              onChange={(e) => setDefaultAgentId(e.target.value)}
              className="w-[180px] px-2.5 py-1.5 rounded-md bg-canvas border border-border text-white text-sm focus:outline-none focus:border-zinc-500 transition-colors"
            >
              <option value="">No preselection</option>
              {agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}
                </option>
              ))}
            </select>
          </SettingRow>
        </div>
      </div>

      <SectionHeader title="Initial prompt" />
      <div className="rounded-lg border border-border bg-canvas/40">
        <div className="p-4">
          <div className="mb-3 flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-zinc-500" />
            <div>
              <div className="text-sm text-zinc-200">Default initial prompt</div>
              <div className="text-xs text-zinc-500">
                Sent to every new session on launch. A prompt typed into the dialog replaces it.
              </div>
            </div>
          </div>
          <textarea
            value={defaultInitialPrompt}
            onChange={(e) => setDefaultInitialPrompt(e.target.value)}
            maxLength={4000}
            rows={4}
            placeholder={"Read the repo's CLAUDE.md before starting."}
            className="w-full px-3 py-2 rounded-md bg-canvas border border-border text-white text-sm placeholder-zinc-600 focus:outline-none focus:border-zinc-500 transition-colors resize-y min-h-[88px] font-mono leading-relaxed"
          />
          <div className="mt-2 flex items-center justify-between text-[11px] text-zinc-600">
            <span>Leave empty to launch sessions with no prompt.</span>
            <span>{defaultInitialPrompt.length}/4000</span>
          </div>
        </div>
      </div>

      <SectionHeader title="Git" />
      <div className="rounded-lg border border-border bg-canvas/40">
        <div className="px-4">
          <SettingRow title="Default base branch" description="Branch used when creating ticket branches">
            <input
              type="text"
              value={defaultBaseBranch}
              onChange={(e) => setDefaultBaseBranch(e.target.value)}
              placeholder="main"
              className="w-[120px] px-2.5 py-1.5 rounded-md bg-canvas border border-border text-white text-sm placeholder-zinc-600 focus:outline-none focus:border-zinc-500 transition-colors text-right"
            />
          </SettingRow>
          <SettingRow title="Git worktree" description="Create an isolated working directory for each session branch">
            <Toggle checked={createWorktree} onChange={setCreateWorktree} />
          </SettingRow>
          <SettingRow
            title="Auto /careful mode"
            description="Send /careful to new Claude Code sessions, warning before destructive commands"
            last
          >
            <Toggle checked={autoCareful} onChange={setAutoCareful} />
          </SettingRow>
        </div>
      </div>
    </>
  );
}
