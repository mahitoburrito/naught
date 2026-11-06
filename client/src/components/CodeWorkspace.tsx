import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Editor, { type BeforeMount, type OnMount } from "@monaco-editor/react";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  FileCode2,
  Folder,
  FolderOpen,
  Loader2,
  RefreshCw,
  RotateCcw,
  Search,
  X,
} from "lucide-react";
import { monaco } from "../monacoSetup";

interface CodeWorkspaceProps {
  sessionId: string;
  sessionName: string;
  cwd: string;
  onDirtyChange: (dirty: boolean) => void;
}

interface WorkspaceFile {
  path: string;
  name: string;
  size: number;
  modified: number;
  editable: boolean;
}

interface OpenDocument {
  path: string;
  content: string;
  savedContent: string;
  modified: number;
  loading: boolean;
  error?: string;
}

interface DirectoryNode {
  name: string;
  path: string;
  directories: DirectoryNode[];
  files: WorkspaceFile[];
}

function languageForPath(path: string): string {
  const name = path.split("/").pop()?.toLowerCase() || "";
  const extension = name.includes(".") ? name.split(".").pop() || "" : "";
  const languages: Record<string, string> = {
    bash: "shell", c: "c", cc: "cpp", cpp: "cpp", cs: "csharp", css: "css",
    dockerfile: "dockerfile", go: "go", h: "cpp", hbs: "handlebars", html: "html",
    java: "java", js: "javascript", json: "json", jsonc: "json", jsx: "javascript",
    less: "less", lua: "lua", md: "markdown", mdx: "markdown", php: "php", ps1: "powershell",
    py: "python", rb: "ruby", rs: "rust", scss: "scss", sh: "shell", sql: "sql",
    swift: "swift", toml: "ini", ts: "typescript", tsx: "typescript", vue: "html",
    xml: "xml", yaml: "yaml", yml: "yaml", zsh: "shell",
  };
  if (name === "dockerfile") return "dockerfile";
  return languages[extension] || "plaintext";
}

function buildTree(files: WorkspaceFile[]): DirectoryNode {
  const root: DirectoryNode = { name: "", path: "", directories: [], files: [] };
  for (const file of files) {
    const parts = file.path.split("/");
    let current = root;
    for (const part of parts.slice(0, -1)) {
      let directory = current.directories.find((item) => item.name === part);
      if (!directory) {
        directory = {
          name: part,
          path: current.path ? `${current.path}/${part}` : part,
          directories: [],
          files: [],
        };
        current.directories.push(directory);
      }
      current = directory;
    }
    current.files.push(file);
  }
  const sort = (node: DirectoryNode) => {
    node.directories.sort((a, b) => a.name.localeCompare(b.name));
    node.files.sort((a, b) => a.name.localeCompare(b.name));
    node.directories.forEach(sort);
  };
  sort(root);
  return root;
}

function FileRow({
  file,
  depth,
  active,
  dirty,
  showPath = false,
  onOpen,
}: {
  file: WorkspaceFile;
  depth: number;
  active: boolean;
  dirty: boolean;
  showPath?: boolean;
  onOpen: (file: WorkspaceFile) => void;
}) {
  const parentPath = file.path.includes("/")
    ? file.path.slice(0, Math.max(0, file.path.length - file.name.length - 1))
    : "Project root";
  return (
    <button
      type="button"
      onClick={() => onOpen(file)}
      disabled={!file.editable}
      className={`group mx-1 flex ${showPath ? "min-h-10 py-1.5" : "h-7"} w-[calc(100%-0.5rem)] min-w-0 items-center gap-1.5 rounded-md pr-2 text-left text-[11px] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-inset focus-visible:outline-[oklch(72%_0.13_48)] ${
        active
          ? "bg-[oklch(21%_0.018_48)] text-[oklch(90%_0.025_48)]"
          : file.editable
            ? "text-zinc-500 hover:bg-[oklch(16%_0.006_260)] hover:text-zinc-300"
            : "cursor-not-allowed text-zinc-700"
      }`}
      style={{ paddingLeft: 10 + depth * 12 }}
      title={file.editable ? file.path : `${file.path} is binary or larger than 256 KB`}
    >
      <FileCode2 className="h-3 w-3 flex-shrink-0" />
      <span className="min-w-0 flex-1">
        <span className="block truncate">{file.name}</span>
        {showPath && <span className="mt-0.5 block truncate text-[9px] text-zinc-700">{parentPath}</span>}
      </span>
      {dirty && <span className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-[oklch(73%_0.13_48)]" aria-label="Unsaved" />}
    </button>
  );
}

function DirectoryRow({
  node,
  depth,
  activePath,
  dirtyPaths,
  forceOpen,
  onOpenFile,
}: {
  node: DirectoryNode;
  depth: number;
  activePath: string | null;
  dirtyPaths: Set<string>;
  forceOpen: boolean;
  onOpenFile: (file: WorkspaceFile) => void;
}) {
  const [expanded, setExpanded] = useState(depth < 1);
  const open = forceOpen || expanded;
  return (
    <>
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        className="mx-1 flex h-7 w-[calc(100%-0.5rem)] min-w-0 items-center gap-1.5 rounded-md pr-2 text-left text-[10px] font-medium text-zinc-500 transition-colors hover:bg-[oklch(16%_0.006_260)] hover:text-zinc-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-inset focus-visible:outline-[oklch(72%_0.13_48)]"
        style={{ paddingLeft: 8 + depth * 12 }}
        aria-expanded={open}
      >
        {open ? <ChevronDown className="h-3 w-3 flex-shrink-0" /> : <ChevronRight className="h-3 w-3 flex-shrink-0" />}
        {open ? <FolderOpen className="h-3 w-3 flex-shrink-0 text-[oklch(70%_0.08_48)]" /> : <Folder className="h-3 w-3 flex-shrink-0" />}
        <span className="truncate">{node.name}</span>
      </button>
      {open && (
        <>
          {node.directories.map((child) => (
            <DirectoryRow
              key={child.path}
              node={child}
              depth={depth + 1}
              activePath={activePath}
              dirtyPaths={dirtyPaths}
              forceOpen={forceOpen}
              onOpenFile={onOpenFile}
            />
          ))}
          {node.files.map((file) => (
            <FileRow
              key={file.path}
              file={file}
              depth={depth + 1}
              active={activePath === file.path}
              dirty={dirtyPaths.has(file.path)}
              onOpen={onOpenFile}
            />
          ))}
        </>
      )}
    </>
  );
}

const configureTheme: BeforeMount = (editorMonaco) => {
  editorMonaco.editor.defineTheme("openui-dark", {
    base: "vs-dark",
    inherit: true,
    rules: [
      { token: "comment", foreground: "6f747e" },
      { token: "keyword", foreground: "e8a96c" },
      { token: "string", foreground: "a9c47f" },
      { token: "number", foreground: "d7a5d8" },
      { token: "type", foreground: "8fc4c7" },
    ],
    colors: {
      "editor.background": "#121315",
      "editor.foreground": "#d8d9dc",
      "editorLineNumber.foreground": "#4f5259",
      "editorLineNumber.activeForeground": "#a1a4aa",
      "editorCursor.foreground": "#e2a15f",
      "editor.selectionBackground": "#4b38296b",
      "editor.inactiveSelectionBackground": "#34363b80",
      "editor.lineHighlightBackground": "#181a1e",
      "editorIndentGuide.background1": "#26282d",
      "editorIndentGuide.activeBackground1": "#41444b",
      "editorWidget.background": "#17191d",
      "editorWidget.border": "#34363b",
      "editorSuggestWidget.selectedBackground": "#28231f",
    },
  });
};

export function CodeWorkspace({ sessionId, sessionName, cwd, onDirtyChange }: CodeWorkspaceProps) {
  const [files, setFiles] = useState<WorkspaceFile[]>([]);
  const [documents, setDocuments] = useState<Record<string, OpenDocument>>({});
  const [tabs, setTabs] = useState<string[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [root, setRoot] = useState(cwd);
  const [loadingTree, setLoadingTree] = useState(true);
  const [savingPath, setSavingPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [cursor, setCursor] = useState({ lineNumber: 1, column: 1 });
  const saveRef = useRef<(path?: string | null) => void>(() => {});
  const searchRef = useRef<HTMLInputElement>(null);
  const modelsRef = useRef(new Set<monaco.editor.ITextModel>());
  const openModelUris = useMemo(() => new Set(tabs.map(path =>
    monaco.Uri.parse(`file://${root.replace(/\\/g, "/")}/${path}`).toString()
  )), [root, tabs]);
  const openModelUrisRef = useRef(openModelUris);
  openModelUrisRef.current = openModelUris;

  // Monaco's model registry outlives the editor. Keep models (and undo history)
  // while their tabs are open, then release only the models this workspace used.
  useEffect(() => {
    for (const model of modelsRef.current) {
      if (!openModelUris.has(model.uri.toString())) model.dispose();
    }
  }, [openModelUris]);

  useEffect(() => {
    const models = modelsRef.current;
    // Creation precedes the React wrapper's onMount callback. Register here so
    // closing during initialization cannot strand an untracked model.
    const creationListener = monaco.editor.onDidCreateModel(model => {
      if (!openModelUrisRef.current.has(model.uri.toString())) return;
      models.add(model);
      model.onWillDispose(() => models.delete(model));
    });
    return () => {
      creationListener.dispose();
      for (const model of models) model.dispose();
      models.clear();
    };
  }, [sessionId, cwd]);

  const dirtyPaths = useMemo(() => new Set(
    Object.values(documents)
      .filter((document) => document.content !== document.savedContent)
      .map((document) => document.path),
  ), [documents]);
  const dirty = dirtyPaths.size > 0;

  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);

  const loadTree = useCallback(async () => {
    setLoadingTree(true);
    setError(null);
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/files/tree`, { cache: "no-store" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "Workspace files could not be loaded");
      setRoot(body.root || cwd);
      setFiles(Array.isArray(body.files) ? body.files : []);
      setTruncated(body.truncated === true);
    } catch (cause) {
      setFiles([]);
      setError(cause instanceof Error ? cause.message : "Workspace files could not be loaded");
    } finally {
      setLoadingTree(false);
    }
  }, [cwd, sessionId]);

  useEffect(() => {
    setDocuments({});
    setTabs([]);
    setActivePath(null);
    setQuery("");
    void loadTree();
  }, [loadTree]);

  const openFile = useCallback(async (file: WorkspaceFile, force = false) => {
    if (!file.editable) return;
    setTabs((current) => current.includes(file.path) ? current : [...current, file.path]);
    setActivePath(file.path);
    if (documents[file.path] && !force) return;
    setDocuments((current) => ({
      ...current,
      [file.path]: {
        path: file.path,
        content: "",
        savedContent: "",
        modified: file.modified,
        loading: true,
      },
    }));
    setError(null);
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/files/read`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ files: [{ path: file.path }], maxFileBytes: 256 * 1024 }),
      });
      const body = await response.json().catch(() => ({}));
      const result = body.files?.[0];
      const failure = body.failedFiles?.[0];
      if (!response.ok || !result || result.kind !== "text" || result.truncated) {
        throw new Error(failure?.message || body.error || "This file cannot be edited");
      }
      const content = (result.segments || []).map((segment: { content?: string }) => segment.content || "").join("\n");
      setDocuments((current) => ({
        ...current,
        [file.path]: {
          path: file.path,
          content,
          savedContent: content,
          modified: result.modified,
          loading: false,
        },
      }));
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "File could not be opened";
      setDocuments((current) => ({
        ...current,
        [file.path]: { ...current[file.path], loading: false, error: message },
      }));
      setError(message);
    }
  }, [documents, sessionId]);

  const closeTab = useCallback((path: string) => {
    const document = documents[path];
    if (document && document.content !== document.savedContent && !window.confirm(`Discard unsaved changes in ${path}?`)) return;
    setTabs((current) => {
      const index = current.indexOf(path);
      const next = current.filter((item) => item !== path);
      if (activePath === path) setActivePath(next[Math.min(index, next.length - 1)] || null);
      return next;
    });
    setDocuments((current) => {
      const next = { ...current };
      delete next[path];
      return next;
    });
  }, [activePath, documents]);

  const saveDocument = useCallback(async (path = activePath) => {
    if (!path) return;
    const document = documents[path];
    if (!document || document.loading || document.error || document.content === document.savedContent) return;
    const contentToSave = document.content;
    setSavingPath(path);
    setError(null);
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/files/write`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path,
          content: contentToSave,
          expectedModified: document.modified,
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "File could not be saved");
      setDocuments((current) => ({
        ...current,
        [path]: {
          ...current[path],
          savedContent: contentToSave,
          modified: body.modified,
        },
      }));
      setFiles((current) => current.map((file) =>
        file.path === path ? { ...file, modified: body.modified, size: body.size } : file
      ));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "File could not be saved");
    } finally {
      setSavingPath(null);
    }
  }, [activePath, documents, sessionId]);
  saveRef.current = (path) => { void saveDocument(path); };

  const reloadDocument = useCallback(async (path: string) => {
    const file = files.find((item) => item.path === path);
    if (!file) return;
    if (dirtyPaths.has(path) && !window.confirm(`Discard unsaved changes in ${path} and reload it?`)) return;
    // A confirmed reload must replace both the document and its retained model,
    // including discarded undo history, with the freshly read disk contents.
    const uri = monaco.Uri.parse(`file://${root.replace(/\\/g, "/")}/${path}`).toString();
    for (const model of modelsRef.current) {
      if (model.uri.toString() === uri) model.dispose();
    }
    setDocuments((current) => {
      const next = { ...current };
      delete next[path];
      return next;
    });
    setError(null);
    await openFile(file, true);
  }, [dirtyPaths, files, openFile, root]);

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        event.stopPropagation();
        saveRef.current(activePath);
      } else if ((event.metaKey || event.ctrlKey) && !event.shiftKey && event.key.toLowerCase() === "p") {
        event.preventDefault();
        event.stopImmediatePropagation();
        searchRef.current?.focus({ preventScroll: true });
      }
    };
    window.addEventListener("keydown", handleShortcut, true);
    return () => window.removeEventListener("keydown", handleShortcut, true);
  }, [activePath]);

  const visibleFiles = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return files;
    return files
      .filter((file) => file.path.toLowerCase().includes(normalized))
      .sort((a, b) => {
        const aName = a.name.toLowerCase();
        const bName = b.name.toLowerCase();
        const rank = (name: string) => name === normalized ? 0 : name.startsWith(normalized) ? 1 : name.includes(normalized) ? 2 : 3;
        return rank(aName) - rank(bName) || a.path.length - b.path.length || a.path.localeCompare(b.path);
      });
  }, [files, query]);
  const tree = useMemo(() => buildTree(visibleFiles), [visibleFiles]);
  const activeDocument = activePath ? documents[activePath] : undefined;
  const activeFile = activePath ? files.find((file) => file.path === activePath) : undefined;

  const selectFile = useCallback((file: WorkspaceFile) => {
    void openFile(file);
  }, [openFile]);

  const handleEditorMount: OnMount = (editor) => {
    editor.focus();
    editor.onDidChangeCursorPosition((event) => setCursor(event.position));
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => saveRef.current());
  };

  return (
    <section data-code-workspace className="m-2 ml-0 flex h-[calc(100%-1rem)] min-h-0 flex-col overflow-hidden rounded-xl border border-[oklch(23%_0.007_260)] bg-[oklch(9%_0.004_260)] shadow-[0_18px_48px_rgb(0_0_0_/_0.28)]" aria-label={`Code workspace for ${sessionName}`}>
      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        <div className="flex min-w-0 flex-1 flex-col bg-[#121315]">
          <div className="flex h-9 flex-shrink-0 items-end overflow-x-auto border-b border-[oklch(22%_0.007_260)] bg-[oklch(9%_0.004_260)]">
            {tabs.map((path) => {
              const selected = path === activePath;
              const tabDirty = dirtyPaths.has(path);
              return (
                <div
                  key={path}
                  role="tab"
                  aria-selected={selected}
                  className={`group flex h-9 max-w-[220px] flex-shrink-0 items-center border-r border-[oklch(21%_0.007_260)] text-[10px] transition-colors ${
                    selected ? "bg-[#121315] text-zinc-200" : "bg-[oklch(10%_0.004_260)] text-zinc-600 hover:text-zinc-400"
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => setActivePath(path)}
                    className="flex h-full min-w-0 flex-1 items-center gap-1.5 pl-2.5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-inset focus-visible:outline-[oklch(72%_0.13_48)]"
                    title={path}
                  >
                    <FileCode2 className="h-3 w-3 flex-shrink-0" />
                    <span className="min-w-0 flex-1 truncate">{path.split("/").pop()}</span>
                    {tabDirty && <span className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-[oklch(73%_0.13_48)]" aria-label="Unsaved" />}
                  </button>
                  <button
                    type="button"
                    onClick={() => closeTab(path)}
                    className={`mr-1 flex h-5 w-5 flex-shrink-0 items-center justify-center rounded hover:bg-[oklch(24%_0.008_260)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[oklch(72%_0.13_48)] ${
                      tabDirty ? "text-zinc-500" : "opacity-0 group-hover:opacity-100 focus:opacity-100"
                    }`}
                    aria-label={`Close ${path}`}
                    title={tabDirty ? "Close tab; unsaved changes will need confirmation" : "Close tab"}
                  >
                    <X className="h-2.5 w-2.5" />
                  </button>
                </div>
              );
            })}
          </div>

          <div className="relative min-h-0 flex-1">
            {!activePath ? (
              <div className="absolute inset-0 flex items-center justify-center">
                <div className="max-w-xs text-center">
                  <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-lg border border-[oklch(23%_0.007_260)] bg-[oklch(15%_0.006_260)] text-zinc-600">
                    <FileCode2 className="h-5 w-5" />
                  </div>
                  <div className="text-[12px] font-medium text-zinc-400">Pick a file to start coding</div>
                  <div className="mt-1 text-[9px] leading-4 text-zinc-600">Files stay inside this session’s workspace.</div>
                  <button
                    type="button"
                    onClick={() => searchRef.current?.focus({ preventScroll: true })}
                    className="mt-3 rounded-md bg-[oklch(21%_0.02_48)] px-2.5 py-1.5 text-[9px] font-medium text-[oklch(82%_0.08_48)] transition-colors hover:bg-[oklch(25%_0.03_48)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[oklch(72%_0.13_48)]"
                  >
                    Search files
                  </button>
                </div>
              </div>
            ) : activeDocument?.loading ? (
              <div className="absolute inset-0 flex items-center justify-center text-[10px] text-zinc-600">
                <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin motion-reduce:animate-none" /> Loading {activeFile?.name}
              </div>
            ) : activeDocument?.error ? (
              <div className="absolute inset-0 flex items-center justify-center p-8">
                <div className="max-w-sm text-center">
                  <AlertTriangle className="mx-auto mb-3 h-5 w-5 text-[oklch(72%_0.12_28)]" />
                  <div className="text-[11px] text-zinc-300">{activeDocument.error}</div>
                  <button type="button" onClick={() => void reloadDocument(activePath)} className="mt-3 rounded-md bg-[oklch(20%_0.02_48)] px-2.5 py-1.5 text-[9px] text-[oklch(80%_0.10_48)] hover:bg-[oklch(24%_0.03_48)]">
                    Try again
                  </button>
                </div>
              </div>
            ) : activeDocument ? (
              <Editor
                path={`file://${root.replace(/\\/g, "/")}/${activePath}`}
                language={languageForPath(activePath)}
                value={activeDocument.content}
                theme="openui-dark"
                beforeMount={configureTheme}
                onMount={handleEditorMount}
                onChange={(value) => setDocuments((current) => ({
                  ...current,
                  [activePath]: { ...current[activePath], content: value || "" },
                }))}
                loading={<div className="flex h-full items-center justify-center text-[10px] text-zinc-600">Starting editor…</div>}
                saveViewState
                keepCurrentModel
                options={{
                  ariaLabel: `Editable code editor for ${activePath}`,
                  automaticLayout: true,
                  bracketPairColorization: { enabled: true },
                  cursorBlinking: "smooth",
                  domReadOnly: false,
                  // Electron users need Monaco's proven textarea input path.
                  // Native EditContext can render correctly while swallowing edits.
                  editContext: false,
                  fontFamily: '"SF Mono", ui-monospace, Menlo, Monaco, "Cascadia Code", monospace',
                  fontLigatures: true,
                  fontSize: 12,
                  lineHeight: 20,
                  minimap: { enabled: true, maxColumn: 80, renderCharacters: false },
                  padding: { top: 10, bottom: 10 },
                  renderLineHighlight: "gutter",
                  readOnly: false,
                  scrollBeyondLastLine: false,
                  smoothScrolling: true,
                  tabSize: 2,
                  wordWrap: "off",
                }}
              />
            ) : null}
          </div>

          {error && (
            <div className="flex min-h-8 flex-shrink-0 items-center gap-2 border-t border-[oklch(34%_0.05_28)] bg-[oklch(16%_0.025_28)] px-2.5 py-1.5 text-[9px] text-[oklch(76%_0.10_28)]" role="alert">
              <AlertTriangle className="h-3 w-3 flex-shrink-0" />
              <span className="min-w-0 flex-1 truncate">{error}</span>
              {activePath && (
                <button type="button" onClick={() => void reloadDocument(activePath)} className="flex items-center gap-1 rounded px-1.5 py-1 hover:bg-[oklch(22%_0.04_28)]">
                  <RotateCcw className="h-3 w-3" /> Reload
                </button>
              )}
              <button type="button" onClick={() => setError(null)} className="rounded p-1 hover:bg-[oklch(22%_0.04_28)]" aria-label="Dismiss error">
                <X className="h-3 w-3" />
              </button>
            </div>
          )}
          <footer className="flex h-5 flex-shrink-0 items-center justify-between border-t border-[oklch(21%_0.007_260)] bg-[oklch(11%_0.005_260)] px-2.5 text-[8px] text-zinc-600">
            <span className="truncate">
              {savingPath ? "Saving…" : dirty ? "Unsaved · " : ""}{activePath || `${files.length} files`}
            </span>
            <span className="ml-3 flex-shrink-0">Ln {cursor.lineNumber}, Col {cursor.column} · {activePath ? languageForPath(activePath) : "Plain Text"} · UTF-8</span>
          </footer>
        </div>

        <aside
          id="code-file-picker"
          data-code-file-picker
          className="relative flex w-[260px] flex-shrink-0 flex-col overflow-hidden border-l border-[oklch(23%_0.007_260)] bg-[oklch(11%_0.005_260)]"
          aria-label="Workspace files"
        >
            <div className="flex h-9 flex-shrink-0 items-center justify-between border-b border-[oklch(23%_0.007_260)] px-2.5">
              <div className="flex items-center gap-1.5 text-[9px] font-semibold text-zinc-300">
                <FolderOpen className="h-3 w-3 text-[oklch(76%_0.09_48)]" />
                Files
              </div>
              <button
                type="button"
                onClick={() => void loadTree()}
                disabled={loadingTree}
                className="flex h-6 w-6 items-center justify-center rounded text-zinc-600 transition-colors hover:bg-[oklch(18%_0.007_260)] hover:text-zinc-300 disabled:opacity-40"
                title="Refresh files"
                aria-label="Refresh files"
              >
                <RefreshCw className={`h-3 w-3 ${loadingTree ? "animate-spin motion-reduce:animate-none" : ""}`} />
              </button>
            </div>
            <div className="border-b border-[oklch(21%_0.007_260)] p-2">
              <label className="flex h-7 items-center gap-1.5 rounded-lg border border-[oklch(25%_0.009_260)] bg-[oklch(8%_0.004_260)] px-2 text-zinc-600 focus-within:border-[oklch(45%_0.06_48)] focus-within:text-zinc-400">
                <Search className="h-3 w-3 flex-shrink-0" />
                <input
                  ref={searchRef}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Find a file"
                  className="min-w-0 flex-1 bg-transparent text-[10px] text-zinc-300 outline-none placeholder:text-zinc-700"
                  aria-label="Find a file"
                />
                {query && (
                  <button type="button" onClick={() => setQuery("")} className="rounded text-zinc-600 hover:text-zinc-300" aria-label="Clear file search">
                    <X className="h-3 w-3" />
                  </button>
                )}
              </label>
            </div>
            <div className="flex items-center justify-between px-2.5 pb-1 pt-2 text-[8px] font-semibold uppercase tracking-[0.12em] text-zinc-600">
              <span>Explorer</span>
              <span>{visibleFiles.length}</span>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto pb-3">
              {loadingTree ? (
                <div className="space-y-2 px-2.5 py-2" aria-label="Loading files">
                  {[68, 82, 54, 76, 61].map((width) => <div key={width} className="h-2.5 rounded bg-[oklch(16%_0.006_260)]" style={{ width: `${width}%` }} />)}
                </div>
              ) : visibleFiles.length === 0 ? (
                <div className="px-3 py-6 text-center text-[10px] leading-4 text-zinc-600">
                  {query ? "No files match this search." : "No editable project files found."}
                </div>
              ) : (
                query.trim() ? (
                  visibleFiles.map((file) => (
                    <FileRow
                      key={file.path}
                      file={file}
                      depth={0}
                      active={activePath === file.path}
                      dirty={dirtyPaths.has(file.path)}
                      showPath
                      onOpen={selectFile}
                    />
                  ))
                ) : (
                  <>
                    {tree.directories.map((directory) => (
                    <DirectoryRow
                      key={directory.path}
                      node={directory}
                      depth={0}
                      activePath={activePath}
                      dirtyPaths={dirtyPaths}
                      forceOpen={Boolean(query.trim())}
                      onOpenFile={selectFile}
                    />
                  ))}
                    {tree.files.map((file) => (
                      <FileRow
                        key={file.path}
                        file={file}
                        depth={0}
                        active={activePath === file.path}
                        dirty={dirtyPaths.has(file.path)}
                        onOpen={selectFile}
                      />
                    ))}
                  </>
                )
              )}
            </div>
            {truncated && <div className="border-t border-[oklch(21%_0.007_260)] px-2.5 py-2 text-[8px] leading-3 text-zinc-600">Showing the first 3,000 files.</div>}
        </aside>
      </div>
    </section>
  );
}
