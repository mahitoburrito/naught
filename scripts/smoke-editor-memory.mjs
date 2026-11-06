// Real React + Monaco regression, driven through the gstack browser CLI.
// BROWSE_BIN=/path/to/browse npm run test:editor-memory
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const browser = process.env.BROWSE_BIN;
if (!browser) throw new Error("Set BROWSE_BIN to the gstack browse executable");
const clientRoot = fileURLToPath(new URL("../client/", import.meta.url));
const { createServer } = await import(pathToFileURL(join(clientRoot, "node_modules/vite/dist/node/index.js")));
const exec = promisify(execFile);
const scratch = await mkdtemp(join(tmpdir(), "openui-editor-memory-"));
const files = Array.from({ length: 24 }, (_, index) => {
  const path = `sample-${String(index).padStart(2, "0")}.txt`;
  return { path, name: path, size: 115000, modified: 1, editable: true };
});
const html = `<!doctype html><html><body style="margin:0;height:800px"><div id="root" style="height:800px"></div>
<script type="module">
import React from 'react';
import ReactDOM from 'react-dom/client';
import { CodeWorkspace } from '/src/components/CodeWorkspace.tsx';
import { monaco } from '/src/monacoSetup.ts';
import '/src/index.css';
const root = ReactDOM.createRoot(document.getElementById('root'));
window.editorMemoryTest = {
  monaco,
  mount(sessionId = 'memory-test') {
    root.render(React.createElement(React.StrictMode, null, React.createElement(CodeWorkspace, {
      sessionId, sessionName: sessionId, cwd: '/memory-test', onDirtyChange: () => {},
    })));
  },
  unmount() { root.render(null); },
};
window.editorMemoryTest.mount();
</script></body></html>`;

const originalCwd = process.cwd();
process.chdir(clientRoot);
const server = await createServer({
  root: clientRoot,
  server: { host: "127.0.0.1", port: 0, strictPort: false },
  plugins: [{
    name: "editor-memory-test-fixture",
    configureServer(vite) {
      vite.middlewares.use(async (request, response, next) => {
        if (request.url === "/editor-memory-test") {
          response.setHeader("Content-Type", "text/html");
          response.end(await vite.transformIndexHtml(request.url, html));
        } else if (request.url?.endsWith("/files/tree")) {
          response.setHeader("Content-Type", "application/json");
          response.end(JSON.stringify({ root: "/memory-test", files, truncated: false }));
        } else if (request.url?.endsWith("/files/read")) {
          let body = "";
          for await (const chunk of request) body += chunk;
          const path = JSON.parse(body).files[0].path;
          const content = (path + " " + "text ".repeat(20) + "\n").repeat(1000);
          response.setHeader("Content-Type", "application/json");
          response.end(JSON.stringify({
            files: [{ path, kind: "text", truncated: false, modified: 1, segments: [{ content }] }],
            failedFiles: [],
          }));
        } else if (request.url?.endsWith("/files/write")) {
          for await (const _chunk of request) { /* drain the save request */ }
          response.statusCode = 409;
          response.setHeader("Content-Type", "application/json");
          response.end(JSON.stringify({ error: "File changed on disk" }));
        } else next();
      });
    },
  }],
});

async function browse(...args) {
  const result = await exec(browser, args, {
    cwd: clientRoot,
    env: { ...process.env, BROWSE_STATE_FILE: join(scratch, ".gstack", "browse.json") },
    timeout: 60_000,
    maxBuffer: 1024 * 1024,
  });
  return result.stdout.trim();
}

async function exerciseEditor() {
  const waitFor = async (predicate, message) => {
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline) {
      if (predicate()) return;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error(`Timed out: ${message}`);
  };
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  await waitFor(() => window.editorMemoryTest && document.querySelector('button[title="sample-00.txt"]'), "workspace ready");
  const { monaco } = window.editorMemoryTest;
  const count = () => ({
    models: monaco.editor.getModels().length,
    characters: monaco.editor.getModels().reduce((total, model) => total + model.getValueLength(), 0),
  });
  const editor = () => monaco.editor.getEditors().find(item => item.getModel());
  const open = async path => {
    await waitFor(() => document.querySelector(`button[title="${path}"]`), `file list contains ${path}`);
    document.querySelector(`button[title="${path}"]`).click();
    await waitFor(() => editor()?.getModel()?.uri.path.endsWith("/" + path)
      && !document.querySelector("[data-code-workspace] .animate-spin"), `open ${path}`);
  };
  const close = async path => {
    document.querySelector(`button[aria-label="Close ${path}"]`).click();
    await waitFor(() => !document.querySelector(`button[aria-label="Close ${path}"]`), `close ${path}`);
  };
  const creationListener = monaco.editor.onDidCreateModel(() => {
    creationListener.dispose();
    window.editorMemoryTest.unmount();
  });
  document.querySelector('button[title="sample-00.txt"]').click();
  await waitFor(() => !document.querySelector("[data-code-workspace]"), "close during editor initialization");
  await waitFor(() => count().models === 0, "initializing editor released its model");
  window.editorMemoryTest.mount();
  await waitFor(() => document.querySelector('button[title="sample-00.txt"]'), "workspace ready after initialization cancellation");
  const before = count();
  const samples = [];
  for (let index = 0; index < 12; index++) {
    const a = `sample-${String(index * 2).padStart(2, "0")}.txt`;
    const b = `sample-${String(index * 2 + 1).padStart(2, "0")}.txt`;
    await open(a);
    await open(b);
    await open(a);
    await close(b);
    await close(a);
    samples.push(count());
  }
  const afterTabsClosed = count();
  window.editorMemoryTest.unmount();
  await waitFor(() => !document.querySelector("[data-code-workspace]"), "workspace closed");
  const afterUnmount = count();
  const measurements = { before, samples, afterTabsClosed, afterUnmount };
  if (afterTabsClosed.models !== 0 || afterUnmount.models !== 0) return { ...measurements, pass: false };

  window.editorMemoryTest.mount();
  await waitFor(() => document.querySelector('button[title="sample-00.txt"]'), "workspace reopened");
  await open("sample-00.txt");
  const original = editor().getValue();
  editor().pushUndoStop();
  editor().executeEdits("memory-test", [{ range: new monaco.Range(1, 1, 1, 1), text: "unsaved edit\n" }]);
  editor().pushUndoStop();
  await waitFor(() => document.querySelector('[aria-label="Unsaved"]'), "edit recorded");
  await open("sample-01.txt");
  await open("sample-00.txt");
  check(editor().getValue() === "unsaved edit\n" + original, "switching tabs lost unsaved text");
  const confirm = window.confirm;
  window.confirm = () => false;
  document.querySelector('button[aria-label="Close sample-00.txt"]').click();
  window.confirm = confirm;
  check(document.querySelector('button[aria-label="Close sample-00.txt"]'), "canceling close removed the dirty tab");
  check(editor().getValue() === "unsaved edit\n" + original, "canceling close discarded edits");
  editor().getModel().undo();
  await waitFor(() => editor().getValue() === original, "undo survived opening another file");
  await waitFor(() => !document.querySelector('[aria-label="Unsaved"]'), "undo cleared dirty state");

  editor().executeEdits("memory-test", [{ range: new monaco.Range(1, 1, 1, 1), text: "conflicting edit\n" }]);
  await waitFor(() => document.querySelector('[aria-label="Unsaved"]'), "conflicting edit recorded");
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "s", ctrlKey: true, bubbles: true }));
  const reloadButton = () => [...document.querySelectorAll('[data-code-workspace] [role="alert"] button')]
    .find(button => button.textContent.includes("Reload"));
  await waitFor(reloadButton, "save conflict shown");
  window.confirm = () => true;
  reloadButton().click();
  window.confirm = confirm;
  await waitFor(() => editor()?.getModel() && !reloadButton()
    && !document.querySelector('[aria-label="Unsaved"]')
    && !document.querySelector("[data-code-workspace] .animate-spin"), "reload completed");
  check(editor().getValue() === original, "reload reused the old model instead of disk content");
  check(!editor().getModel().canUndo(), "reload retained discarded edits in undo history");

  const external = monaco.editor.createModel("owned elsewhere", "plaintext", monaco.Uri.parse("inmemory://other-owner.txt"));
  window.editorMemoryTest.unmount();
  await waitFor(() => !document.querySelector("[data-code-workspace]"), "workspace unmounted with open tabs");
  check(monaco.editor.getModels().length === 1 && !external.isDisposed(), "workspace cleanup leaked its models or disposed another owner's model");
  external.dispose();

  window.editorMemoryTest.mount("first-session");
  await waitFor(() => document.querySelector('button[title="sample-00.txt"]'), "first session ready");
  await open("sample-00.txt");
  await open("sample-01.txt");
  window.editorMemoryTest.mount("second-session");
  await waitFor(() => document.querySelector('[aria-label="Code workspace for second-session"]')
    && !document.querySelector('[role="tab"]'), "session switched");
  check(count().models === 0, "switching sessions retained old file models");
  await open("sample-00.txt");
  check(editor().getValue() === original, "reopening a closed file restored stale edits");
  window.editorMemoryTest.unmount();
  await waitFor(() => !document.querySelector("[data-code-workspace]"), "final close");
  check(count().models === 0, "final close left editor models allocated");
  return { ...measurements, pass: true, editingChecks: ["initialization cancellation", "unsaved text", "cancel close", "undo", "conflict reload", "ownership", "session change", "reopen"] };
}

try {
  await server.listen();
  const port = server.httpServer.address().port;
  await browse("goto", `http://127.0.0.1:${port}/editor-memory-test`);
  const result = JSON.parse(await browse("js", `return await (${exerciseEditor.toString()})()`));
  console.log(JSON.stringify(result, null, 2));
  assert.equal(result.pass, true, "Closed editor tabs retained Monaco models");
  const errors = await browse("console", "--errors");
  // The fixture intentionally rejects one save to exercise conflict/reload.
  const messages = errors.split("\n").filter(line => /^\[\d{4}-/.test(line));
  assert.equal(messages.length, 1, errors);
  assert.match(messages[0], /\[error\] Failed to load resource: .*status of 409 \(Conflict\)/, errors);
  console.log("Editor memory and editing regressions passed");
} catch (error) {
  console.error(error.stderr?.trim() || error.message);
  process.exitCode = 1;
} finally {
  await browse("stop").catch(() => undefined);
  await server.close();
  process.chdir(originalCwd);
  await rm(scratch, { recursive: true, force: true });
}
