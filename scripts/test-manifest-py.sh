#!/usr/bin/env bash
# Behavioural tests for resources/remote-terminal/naught_manifest.py.
#
# Builds throwaway fixtures (a git repo with a linked worktree, a plain
# directory with node_modules/venvs/symlinks) and asserts each documented
# behaviour of the manifest tool. Prints `ok <name>` / `FAIL <name>` per
# check and exits non-zero when any check fails.
#
#   bash scripts/test-manifest-py.sh

set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOOL="$HERE/../resources/remote-terminal/naught_manifest.py"
TOOL="$(cd "$(dirname "$TOOL")" && pwd)/$(basename "$TOOL")"

if [ ! -f "$TOOL" ]; then
  echo "FAIL tool-missing: $TOOL" >&2
  exit 1
fi

# Keep git deterministic and independent of the developer's global config.
export GIT_CONFIG_NOSYSTEM=1
export GIT_CONFIG_GLOBAL=/dev/null
export GIT_AUTHOR_NAME=naught GIT_AUTHOR_EMAIL=naught@example.invalid
export GIT_COMMITTER_NAME=naught GIT_COMMITTER_EMAIL=naught@example.invalid
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_COMMON_DIR

TMP="$(mktemp -d "${TMPDIR:-/tmp}/naught-manifest-test.XXXXXX")"
# macOS TMPDIR ends in "/", which mktemp keeps; the tool normalizes paths, so compare against a normalized root.
TMP="$(python3 -c 'import os, sys; print(os.path.normpath(sys.argv[1]))' "$TMP")"
trap 'chmod -R u+rwX "$TMP" 2>/dev/null; rm -rf "$TMP"' EXIT

PASS=0
FAILED=0

ok() { echo "ok $1"; PASS=$((PASS + 1)); }
fail() { echo "FAIL $1${2:+: $2}"; FAILED=$((FAILED + 1)); }

run_tool() { python3 "$TOOL" "$@"; }

# assert_py NAME OUTFILE CODE
# CODE runs with: E (entries), S (summary dict), P (list of paths), by(p)
# (entry lookup). Any exception or failed assert fails the check.
assert_py() {
  local name="$1" out="$2" msg
  if msg=$(PYCODE="$3" python3 - "$out" <<'PYEOF' 2>&1
import json, os, sys
lines = [json.loads(l) for l in open(sys.argv[1], encoding="utf-8") if l.strip()]
assert lines and "summary" in lines[-1], "last line is not a summary"
S = lines[-1]["summary"]
E = lines[:-1]
assert all("p" in e for e in E), "an entry has no p"
assert all("summary" not in e for e in E), "a summary appeared before the last line"
P = [e["p"] for e in E]
def by(p):
    for e in E:
        if e["p"] == p:
            return e
    return None
exec(os.environ["PYCODE"])
PYEOF
  ); then ok "$name"; else fail "$name" "$msg"; fi
}

# assert_exit NAME EXPECTED CMD...
assert_exit() {
  local name="$1" want="$2"; shift 2
  local got
  "$@" >/dev/null 2>&1
  got=$?
  if [ "$got" = "$want" ]; then ok "$name"; else fail "$name" "exit $got, want $want"; fi
}

sha() { python3 -c 'import hashlib,sys; print(hashlib.sha256(open(sys.argv[1],"rb").read()).hexdigest())' "$1"; }

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

REPO="$TMP/repo"
WT="$TMP/wt"
WT2="$TMP/wt2"
PLAIN="$TMP/plain"
ORPHAN="$TMP/orphan"

mkdir -p "$REPO/sub" "$REPO/node_modules" "$REPO/empty-dir"
git -c init.defaultBranch=main init -q "$REPO"
printf 'tracked content\n' >"$REPO/tracked.txt"
printf 'deep content, a bit longer\n' >"$REPO/sub/deep.txt"
printf 'going away\n' >"$REPO/gone.txt"
printf 'ignored.txt\nnode_modules/\n' >"$REPO/.gitignore"
ln -s tracked.txt "$REPO/link.txt"
git -C "$REPO" add -A
git -C "$REPO" commit -q -m init
printf 'untracked content\n' >"$REPO/untracked.txt"
printf 'ignored content\n' >"$REPO/ignored.txt"
printf 'module.exports = 1;\n' >"$REPO/node_modules/x.js"
rm "$REPO/gone.txt"
chmod 644 "$REPO/tracked.txt"
chmod 755 "$REPO/sub/deep.txt"

git -C "$REPO" worktree add -q "$WT" -b wt
git -C "$REPO" worktree add -q "$WT2" -b wt2
printf 'new in worktree\n' >"$WT/newfile.txt"

mkdir -p "$PLAIN/sub" "$PLAIN/node_modules" "$PLAIN/.venv" "$PLAIN/venv" "$PLAIN/__pycache__" \
  "$PLAIN/.cache" "$PLAIN/.git" "$PLAIN/deep/node_modules" "$PLAIN/emptydir"
printf 'plain a\n' >"$PLAIN/a.txt"
printf 'plain b\n' >"$PLAIN/sub/b.txt"
printf 'nm\n' >"$PLAIN/node_modules/x.js"
printf 'venv\n' >"$PLAIN/.venv/v"
printf 'venv\n' >"$PLAIN/venv/v"
printf 'pyc\n' >"$PLAIN/__pycache__/c.pyc"
printf 'cache\n' >"$PLAIN/.cache/c"
printf 'not a repo\n' >"$PLAIN/.git/config"
printf 'deep nm\n' >"$PLAIN/deep/node_modules/y.js"
printf 'keep\n' >"$PLAIN/deep/keep.txt"
printf 'unicode\n' >"$PLAIN/ünïcode.txt"
printf 'secret\n' >"$PLAIN/secret.txt"
ln -s a.txt "$PLAIN/link"
ln -s sub "$PLAIN/dirlink"
ln -s nowhere "$PLAIN/broken"

mkdir -p "$ORPHAN"
printf 'gitdir: /nonexistent/mother/.git/worktrees/orphan\n' >"$ORPHAN/.git"
printf 'orphan file\n' >"$ORPHAN/file.txt"

# ---------------------------------------------------------------------------
# Git mode
# ---------------------------------------------------------------------------

OUT_REPO="$TMP/out-repo.jsonl"
run_tool --root "$REPO" >"$OUT_REPO" || fail "git-run" "non-zero exit"
OUT_REPO_INC="$TMP/out-repo-inc.jsonl"
run_tool --root "$REPO" --include-ignored >"$OUT_REPO_INC" || fail "git-run-include-ignored" "non-zero exit"

assert_py git-tracked-and-untracked-listed "$OUT_REPO" "
for rel in ('tracked.txt', 'sub/deep.txt', 'untracked.txt', '.gitignore'):
    assert by('$REPO/' + rel) is not None, 'missing ' + rel
"
assert_py git-ignored-excluded-by-default "$OUT_REPO" "
assert by('$REPO/ignored.txt') is None, 'ignored.txt listed'
assert by('$REPO/node_modules/x.js') is None, 'node_modules/x.js listed'
"
assert_py git-ignored-included-with-flag "$OUT_REPO_INC" "
assert by('$REPO/ignored.txt') is not None, 'ignored.txt missing'
assert by('$REPO/node_modules/x.js') is not None, 'node_modules/x.js missing'
assert by('$REPO/tracked.txt') is not None, 'tracked.txt missing'
"
assert_py git-deleted-tracked-file-skipped "$OUT_REPO" "
assert by('$REPO/gone.txt') is None, 'gone.txt listed though absent on disk'
"
assert_py git-deleted-tracked-file-skipped-include-ignored "$OUT_REPO_INC" "
assert by('$REPO/gone.txt') is None, 'gone.txt listed though absent on disk'
"
assert_py git-dotgit-dir-never-descended "$OUT_REPO_INC" "
assert not any(p.startswith('$REPO/.git/') for p in P), '.git contents listed'
assert by('$REPO/.git') is None, '.git directory listed as an entry'
"
assert_py git-symlink-recorded-not-followed "$OUT_REPO" "
e = by('$REPO/link.txt')
assert e == {'p': '$REPO/link.txt', 'l': 'tracked.txt'}, e
"
assert_py git-empty-dir-ignored "$OUT_REPO_INC" "
assert not any(p.startswith('$REPO/empty-dir') for p in P)
"
assert_py git-entry-sha-size-mode "$OUT_REPO" "
e = by('$REPO/tracked.txt')
assert e['h'] == '$(sha "$REPO/tracked.txt")', e['h']
assert e['s'] == $(wc -c <"$REPO/tracked.txt" | tr -d ' '), e['s']
assert e['m'] == 0o644, oct(e['m'])
d = by('$REPO/sub/deep.txt')
assert d['h'] == '$(sha "$REPO/sub/deep.txt")', d['h']
assert d['m'] == 0o755, oct(d['m'])
assert set(e) == {'p', 's', 'h', 'm'}, set(e)
"

# Linked worktree: its .git is a file and must be included.
OUT_WT="$TMP/out-wt.jsonl"
run_tool --root "$WT" >"$OUT_WT" || fail "worktree-run" "non-zero exit"
assert_py worktree-dotgit-file-included "$OUT_WT" "
e = by('$WT/.git')
assert e is not None, '.git file missing'
assert 'h' in e and 's' in e and 'm' in e, e
assert e['h'] == '$(sha "$WT/.git")', e['h']
assert by('$WT/tracked.txt') is not None, 'tracked file missing in worktree'
assert by('$WT/newfile.txt') is not None, 'untracked file missing in worktree'
assert by('$WT/link.txt') == {'p': '$WT/link.txt', 'l': 'tracked.txt'}
assert not any(p.startswith('$WT/.git/') for p in P)
"

# --git-dir: the mother .git comes along, minus excluded worktrees, locks, objects/tmp.
mkdir -p "$REPO/.git/objects/tmp"
printf 'junk\n' >"$REPO/.git/objects/tmp/junk"
printf 'lock\n' >"$REPO/.git/index.lock"
printf 'lock\n' >"$REPO/.git/foo.lock"
printf 'lock\n' >"$REPO/.git/worktrees/wt/index.lock"
OUT_GD="$TMP/out-gitdir.jsonl"
run_tool --root "$WT" --git-dir "$REPO/.git" --exclude-worktree wt2 >"$OUT_GD" || fail "gitdir-run" "non-zero exit"
OUT_GD2="$TMP/out-gitdir-both.jsonl"
run_tool --root "$WT" --git-dir "$REPO/.git" --exclude-worktree wt --exclude-worktree wt2 >"$OUT_GD2" || fail "gitdir-run-2" "non-zero exit"
rm -f "$REPO/.git/index.lock" "$REPO/.git/foo.lock" "$REPO/.git/worktrees/wt/index.lock"
rm -rf "$REPO/.git/objects/tmp"

assert_py gitdir-files-included "$OUT_GD" "
assert by('$REPO/.git/HEAD') is not None, '.git/HEAD missing'
assert by('$REPO/.git/config') is not None, '.git/config missing'
assert any(p.startswith('$REPO/.git/objects/') for p in P), 'no objects listed'
assert any(p.startswith('$REPO/.git/refs/') for p in P), 'no refs listed'
assert by('$WT/tracked.txt') is not None, 'root entries missing alongside git-dir'
assert by('$WT/.git') is not None, 'worktree .git file missing alongside git-dir'
"
assert_py gitdir-exclude-worktree-skipped "$OUT_GD" "
assert not any(p.startswith('$REPO/.git/worktrees/wt2/') for p in P), 'excluded worktree listed'
assert by('$REPO/.git/worktrees/wt/HEAD') is not None, 'non-excluded worktree admin dir missing'
assert by('$REPO/.git/worktrees/wt/gitdir') is not None, 'non-excluded worktree gitdir pointer missing'
"
assert_py gitdir-exclude-worktree-repeatable "$OUT_GD2" "
assert not any(p.startswith('$REPO/.git/worktrees/') for p in P), 'an excluded worktree was listed'
assert by('$REPO/.git/HEAD') is not None
"
assert_py gitdir-locks-and-objects-tmp-skipped "$OUT_GD" "
assert by('$REPO/.git/index.lock') is None, 'index.lock listed'
assert by('$REPO/.git/foo.lock') is None, 'foo.lock listed'
assert by('$REPO/.git/worktrees/wt/index.lock') is None, 'nested index.lock listed'
assert not any(p.endswith('.lock') for p in P), 'a .lock file was listed'
assert not any(p.startswith('$REPO/.git/objects/tmp/') for p in P), 'objects/tmp listed'
"

# Orphaned worktree pointer (mother missing): git refuses, walk mode keeps the .git file.
OUT_ORPHAN="$TMP/out-orphan.jsonl"
run_tool --root "$ORPHAN" >"$OUT_ORPHAN" || fail "orphan-run" "non-zero exit"
assert_py orphan-worktree-pointer-falls-back-to-walk "$OUT_ORPHAN" "
assert by('$ORPHAN/.git') is not None and 'h' in by('$ORPHAN/.git'), '.git pointer file missing'
assert by('$ORPHAN/file.txt') is not None
assert S['files'] == 2, S
"

# ---------------------------------------------------------------------------
# Walk mode (non-git)
# ---------------------------------------------------------------------------

OUT_PLAIN="$TMP/out-plain.jsonl"
run_tool --root "$PLAIN" >"$OUT_PLAIN" || fail "plain-run" "non-zero exit"
OUT_PLAIN_INC="$TMP/out-plain-inc.jsonl"
run_tool --root "$PLAIN" --include-ignored >"$OUT_PLAIN_INC" || fail "plain-run-include-ignored" "non-zero exit"

assert_py nongit-default-skips "$OUT_PLAIN" "
assert by('$PLAIN/a.txt') is not None
assert by('$PLAIN/sub/b.txt') is not None
assert by('$PLAIN/deep/keep.txt') is not None
for rel in ('node_modules/x.js', '.venv/v', 'venv/v', '__pycache__/c.pyc', '.cache/c', '.git/config', 'deep/node_modules/y.js'):
    assert by('$PLAIN/' + rel) is None, rel + ' listed'
"
assert_py nongit-include-ignored-keeps-only-dotgit-skip "$OUT_PLAIN_INC" "
for rel in ('node_modules/x.js', '.venv/v', 'venv/v', '__pycache__/c.pyc', '.cache/c', 'deep/node_modules/y.js'):
    assert by('$PLAIN/' + rel) is not None, rel + ' missing'
assert by('$PLAIN/.git/config') is None, '.git/config listed'
assert not any(p.startswith('$PLAIN/.git/') for p in P)
"
assert_py nongit-symlinks-recorded-not-followed "$OUT_PLAIN" "
assert by('$PLAIN/link') == {'p': '$PLAIN/link', 'l': 'a.txt'}, by('$PLAIN/link')
assert by('$PLAIN/dirlink') == {'p': '$PLAIN/dirlink', 'l': 'sub'}, by('$PLAIN/dirlink')
assert by('$PLAIN/broken') == {'p': '$PLAIN/broken', 'l': 'nowhere'}, by('$PLAIN/broken')
assert not any(p.startswith('$PLAIN/dirlink/') for p in P), 'symlinked directory was followed'
"
assert_py nongit-empty-dir-ignored "$OUT_PLAIN" "
assert not any(p.startswith('$PLAIN/emptydir') for p in P)
"
assert_py nongit-unicode-name-roundtrips "$OUT_PLAIN" "
e = by('$PLAIN/ünïcode.txt')
assert e is not None, 'unicode filename missing'
assert e['h'] == '$(sha "$PLAIN/ünïcode.txt")'
"

# ---------------------------------------------------------------------------
# Output invariants (checked on every produced manifest)
# ---------------------------------------------------------------------------

for pair in "repo:$OUT_REPO:$REPO" "repo-inc:$OUT_REPO_INC:$REPO" "wt:$OUT_WT:$WT" "plain:$OUT_PLAIN:$PLAIN" "plain-inc:$OUT_PLAIN_INC:$PLAIN"; do
  label="${pair%%:*}"; rest="${pair#*:}"; outf="${rest%%:*}"; rootp="${rest#*:}"
  assert_py "absolute-paths-$label" "$outf" "
assert all(os.path.isabs(p) for p in P), 'relative p'
assert all(p.startswith('$rootp/') for p in P), 'p outside root'
"
  assert_py "sorted-unique-byte-order-$label" "$outf" "
assert P == sorted(P, key=lambda p: p.encode('utf-8', 'surrogateescape')), 'not sorted'
assert len(set(P)) == len(P), 'duplicate p'
"
  assert_py "summary-counts-$label" "$outf" "
assert S['files'] == len(E), (S['files'], len(E))
assert S['bytes'] == sum(e.get('s', 0) for e in E), S
assert set(S) == {'files', 'bytes', 'hash'}, set(S)
"
  assert_py "summary-hash-formula-$label" "$outf" "
import hashlib
h = hashlib.sha256()
for e in E:
    tok = e['h'] if 'h' in e else ('l:' + e['l'] if 'l' in e else 'err')
    h.update((e['p'] + chr(0) + tok + chr(10)).encode('utf-8', 'surrogateescape'))
assert h.hexdigest() == S['hash'], (h.hexdigest(), S['hash'])
"
done

# --git-dir paths are absolute under the git dir and sorted globally with root entries.
assert_py absolute-paths-gitdir "$OUT_GD" "
assert all(os.path.isabs(p) for p in P)
assert all(p.startswith('$WT/') or p.startswith('$REPO/.git/') for p in P), 'p outside root and git-dir'
assert any(p.startswith('$REPO/.git/') for p in P) and any(p.startswith('$WT/') for p in P)
assert P == sorted(P, key=lambda p: p.encode('utf-8', 'surrogateescape')), 'not globally sorted'
"

# A sloppy --root (trailing or doubled slash) still yields normalized absolute paths.
OUT_SLOPPY="$TMP/out-sloppy.jsonl"
run_tool --root "$TMP//plain/" >"$OUT_SLOPPY" || fail "sloppy-root-run" "non-zero exit"
if cmp -s "$OUT_PLAIN" "$OUT_SLOPPY"; then ok "root-arg-normalized"; else fail "root-arg-normalized" "outputs differ"; fi

# Determinism: byte-identical across runs, hash moves when a file changes.
OUT_PLAIN_AGAIN="$TMP/out-plain-again.jsonl"
run_tool --root "$PLAIN" >"$OUT_PLAIN_AGAIN"
if cmp -s "$OUT_PLAIN" "$OUT_PLAIN_AGAIN"; then ok "output-stable-across-runs"; else fail "output-stable-across-runs" "outputs differ"; fi

HASH_BEFORE=$(python3 -c 'import json,sys; print(json.loads(open(sys.argv[1]).read().strip().splitlines()[-1])["summary"]["hash"])' "$OUT_PLAIN")
printf 'plain a CHANGED\n' >"$PLAIN/a.txt"
OUT_PLAIN_CHANGED="$TMP/out-plain-changed.jsonl"
run_tool --root "$PLAIN" >"$OUT_PLAIN_CHANGED"
HASH_AFTER=$(python3 -c 'import json,sys; print(json.loads(open(sys.argv[1]).read().strip().splitlines()[-1])["summary"]["hash"])' "$OUT_PLAIN_CHANGED")
if [ "$HASH_BEFORE" != "$HASH_AFTER" ]; then ok "summary-hash-changes-on-content-change"; else fail "summary-hash-changes-on-content-change" "hash unchanged"; fi
printf 'plain a\n' >"$PLAIN/a.txt"
run_tool --root "$PLAIN" >"$OUT_PLAIN_AGAIN"
if cmp -s "$OUT_PLAIN" "$OUT_PLAIN_AGAIN"; then ok "summary-hash-restored-after-revert"; else fail "summary-hash-restored-after-revert" "outputs differ"; fi

# A path change alone changes the hash (absolute paths are part of it).
cp -R "$PLAIN" "$TMP/plain-copy"
OUT_PLAIN_COPY="$TMP/out-plain-copy.jsonl"
run_tool --root "$TMP/plain-copy" >"$OUT_PLAIN_COPY"
HASH_COPY=$(python3 -c 'import json,sys; print(json.loads(open(sys.argv[1]).read().strip().splitlines()[-1])["summary"]["hash"])' "$OUT_PLAIN_COPY")
if [ "$HASH_BEFORE" != "$HASH_COPY" ]; then ok "summary-hash-depends-on-absolute-path"; else fail "summary-hash-depends-on-absolute-path"; fi

# Unreadable file: err entry, counted in files but not bytes (root can read anything, so skip then).
if [ "$(id -u)" != "0" ]; then
  chmod 000 "$PLAIN/secret.txt"
  OUT_ERR="$TMP/out-err.jsonl"
  run_tool --root "$PLAIN" >"$OUT_ERR"
  ERR_EXIT=$?
  chmod 644 "$PLAIN/secret.txt"
  if [ "$ERR_EXIT" = "0" ]; then ok "unreadable-file-exit-zero"; else fail "unreadable-file-exit-zero" "exit $ERR_EXIT"; fi
  assert_py unreadable-file-err-entry "$OUT_ERR" "
e = by('$PLAIN/secret.txt')
assert e is not None and 'err' in e and 'h' not in e and 's' not in e, e
assert S['files'] == len(E)
assert S['bytes'] == sum(x.get('s', 0) for x in E)
assert by('$PLAIN/a.txt') is not None, 'other files still listed'
"
else
  echo "skip unreadable-file-err-entry (running as root)"
fi

# ---------------------------------------------------------------------------
# Exit codes
# ---------------------------------------------------------------------------

assert_exit exit-0-on-success 0 run_tool --root "$PLAIN"
assert_exit exit-2-no-args 2 run_tool
assert_exit exit-2-unknown-flag 2 run_tool --root "$PLAIN" --bogus
assert_exit exit-2-relative-root 2 run_tool --root relative/dir
assert_exit exit-2-relative-gitdir 2 run_tool --root "$WT" --git-dir repo/.git
assert_exit exit-3-missing-root 3 run_tool --root "$TMP/does-not-exist"
assert_exit exit-3-root-is-a-file 3 run_tool --root "$PLAIN/a.txt"
assert_exit exit-3-missing-gitdir 3 run_tool --root "$WT" --git-dir "$TMP/no-such/.git"

# ---------------------------------------------------------------------------

echo
echo "passed $PASS, failed $FAILED"
[ "$FAILED" -eq 0 ]
