#!/usr/bin/env python3
"""Inventory a directory tree as JSON lines, for session moves.

Usage:
  python3 naught_manifest.py --root <abs dir> [--include-ignored]
      [--git-dir <abs path to a .git directory>] [--exclude-worktree <name>]...

One JSON object per line, sorted by path (byte order), for every regular
file under --root (and under --git-dir when given):

  {"p": "<absolute path>", "s": <size bytes>, "h": "<sha256 hex>", "m": <mode & 0o777>}

Symlinks are recorded as {"p": ..., "l": "<link target>"} and never
followed. Files that cannot be read are recorded as {"p": ..., "err": "..."}.
Directories are never listed (empty directories are ignored). The last
line is {"summary": {"files": N, "bytes": total, "hash": "<sha256 hex>"}}
where the hash covers `p + "\\0" + (h | "l:" + target | "err") + "\\n"` for
every entry in order.

Every "p" is an absolute path (root + "/" + relative), so mirroring the
tree onto another machine at the same absolute path is trivial.

Listing strategy for --root:
  * a git work tree (a `.git` entry in --root, `git` on PATH, and
    `git rev-parse` agreeing that --root is the top level):
      git ls-files -z --cached --others --exclude-standard
    or, with --include-ignored, the same without --exclude-standard.
    A `.git` *file* (a linked worktree pointer) is included as a regular
    file; a `.git` directory is never descended into.
  * anything else: os.walk, skipping directories named node_modules,
    .venv, venv, __pycache__, .cache and .git at any depth; with
    --include-ignored only .git is skipped. Symlinked directories are
    recorded as links and not followed.

--git-dir walks that directory too (a mother repository's `.git`),
skipping `worktrees/<name>` for every --exclude-worktree name, and always
skipping `objects/tmp` and `*.lock` files (including `index.lock`).

Exit codes: 0 success; 2 bad arguments; 3 --root (or --git-dir) does not
exist or is not a directory; 1 unexpected runtime failure.

Python 3.8+, standard library only. Runs on Linux and macOS.
"""

import argparse
import hashlib
import json
import os
import shutil
import stat
import subprocess
import sys

CHUNK_SIZE = 1 << 20  # 1 MiB

WALK_SKIP_DEFAULT = frozenset({"node_modules", ".venv", "venv", "__pycache__", ".cache", ".git"})
WALK_SKIP_INCLUDE_IGNORED = frozenset({".git"})

GIT_DIR_SKIP_DIRS = ("objects/tmp",)
LOCK_SUFFIX = ".lock"


# ---------------------------------------------------------------------------
# Entries
# ---------------------------------------------------------------------------


def _strerror(exc):
    return exc.strerror or str(exc) or exc.__class__.__name__


def hash_file(path):
    """Return (sha256 hex, bytes read) for a regular file."""
    digest = hashlib.sha256()
    size = 0
    with open(path, "rb") as handle:
        while True:
            chunk = handle.read(CHUNK_SIZE)
            if not chunk:
                break
            digest.update(chunk)
            size += len(chunk)
    return digest.hexdigest(), size


def entry_for(path, st=None):
    """Build the manifest entry for an absolute path.

    Returns None when the path should not be listed: it vanished, or it is a
    directory or another non-regular, non-symlink object.
    """
    if st is None:
        try:
            st = os.lstat(path)
        except FileNotFoundError:
            return None
        except OSError as exc:
            return {"p": path, "err": _strerror(exc)}
    mode = st.st_mode
    if stat.S_ISLNK(mode):
        try:
            target = os.readlink(path)
        except OSError as exc:
            return {"p": path, "err": _strerror(exc)}
        return {"p": path, "l": target}
    if not stat.S_ISREG(mode):
        return None
    try:
        digest, size = hash_file(path)
    except FileNotFoundError:
        return None
    except OSError as exc:
        return {"p": path, "err": _strerror(exc)}
    return {"p": path, "s": size, "h": digest, "m": mode & 0o777}


def sort_key(entry):
    # Byte order of the original filesystem name (surrogateescape round-trips).
    return os.fsencode(entry["p"])


# ---------------------------------------------------------------------------
# Git mode
# ---------------------------------------------------------------------------


def git_env():
    env = dict(os.environ)
    # Make the repository discovery depend on --root only, not on the caller's
    # environment (hooks export GIT_DIR / GIT_WORK_TREE), and never take locks.
    for name in ("GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR"):
        env.pop(name, None)
    env["GIT_OPTIONAL_LOCKS"] = "0"
    return env


def git_top_level(root):
    """Return True when `root` is the top level of a git work tree."""
    if not os.path.lexists(os.path.join(root, ".git")):
        return False
    if shutil.which("git") is None:
        return False
    try:
        result = subprocess.run(
            ["git", "-C", root, "rev-parse", "--is-inside-work-tree", "--show-toplevel"],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            env=git_env(),
        )
    except OSError:
        return False
    if result.returncode != 0:
        return False
    lines = result.stdout.split(b"\n")
    if len(lines) < 2 or lines[0].strip() != b"true":
        return False
    top = os.fsdecode(lines[1].strip())
    try:
        return os.path.realpath(top) == os.path.realpath(root)
    except OSError:
        return False


def git_list(root, include_ignored):
    """Relative paths reported by `git ls-files`, deduplicated, `.git` excluded."""
    cmd = ["git", "-C", root, "ls-files", "-z", "--cached", "--others"]
    if not include_ignored:
        cmd.append("--exclude-standard")
    result = subprocess.run(
        cmd,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=git_env(),
    )
    if result.returncode != 0:
        message = result.stderr.decode("utf-8", "replace").strip()
        raise RuntimeError("git ls-files failed (%d): %s" % (result.returncode, message))
    rels = set()
    for raw in result.stdout.split(b"\0"):
        if not raw:
            continue
        rel = os.fsdecode(raw).rstrip("/")
        if not rel:
            continue
        # git never emits paths inside a .git directory, but be explicit:
        # nothing under any `.git` component is ever listed in git mode.
        if ".git" in rel.split("/"):
            continue
        rels.add(rel)
    return rels


def collect_git(root, include_ignored):
    entries = []
    for rel in git_list(root, include_ignored):
        entry = entry_for(os.path.join(root, rel))
        if entry is not None:
            entries.append(entry)
    dotgit = os.path.join(root, ".git")
    try:
        st = os.lstat(dotgit)
    except OSError:
        st = None
    if st is not None and stat.S_ISREG(st.st_mode):
        entry = entry_for(dotgit, st)
        if entry is not None:
            entries.append(entry)
    return entries


# ---------------------------------------------------------------------------
# Walk mode
# ---------------------------------------------------------------------------


def walk_tree(top, skip_names=frozenset(), prune_rel=None, skip_file=None):
    """Walk `top` without following symlinks.

    skip_names: directory basenames pruned at any depth.
    prune_rel:  callable(rel_dir) -> True to prune that directory (rel to top).
    skip_file:  callable(basename) -> True to leave a file out.
    """
    entries = []

    def on_error(exc):
        # An unreadable directory is reported rather than silently dropped.
        entries.append({"p": exc.filename or top, "err": _strerror(exc)})

    for dirpath, dirnames, filenames in os.walk(top, topdown=True, onerror=on_error, followlinks=False):
        kept = []
        for name in sorted(dirnames):
            full = os.path.join(dirpath, name)
            if os.path.islink(full):
                # A symlink to a directory: record the link, never descend.
                entry = entry_for(full)
                if entry is not None:
                    entries.append(entry)
                continue
            if name in skip_names:
                continue
            if prune_rel is not None and prune_rel(os.path.relpath(full, top)):
                continue
            kept.append(name)
        dirnames[:] = kept
        for name in filenames:
            if skip_file is not None and skip_file(name):
                continue
            entry = entry_for(os.path.join(dirpath, name))
            if entry is not None:
                entries.append(entry)
    return entries


def collect_walk(root, include_ignored):
    skip = WALK_SKIP_INCLUDE_IGNORED if include_ignored else WALK_SKIP_DEFAULT
    return walk_tree(root, skip_names=skip)


def collect_git_dir(git_dir, exclude_worktrees):
    excluded = {"worktrees/" + name for name in exclude_worktrees if name}
    excluded.update(GIT_DIR_SKIP_DIRS)

    def prune_rel(rel_dir):
        return rel_dir in excluded

    def skip_file(name):
        return name.endswith(LOCK_SUFFIX)

    return walk_tree(git_dir, prune_rel=prune_rel, skip_file=skip_file)


# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------


def hash_token(entry):
    if "h" in entry:
        return entry["h"].encode("ascii")
    if "l" in entry:
        return b"l:" + os.fsencode(entry["l"])
    return b"err"


def summarize(entries):
    digest = hashlib.sha256()
    total = 0
    for entry in entries:
        digest.update(os.fsencode(entry["p"]))
        digest.update(b"\0")
        digest.update(hash_token(entry))
        digest.update(b"\n")
        total += entry.get("s", 0)
    return {"files": len(entries), "bytes": total, "hash": digest.hexdigest()}


def dedupe_sorted(entries):
    entries.sort(key=sort_key)
    out = []
    last = None
    for entry in entries:
        key = sort_key(entry)
        if key == last:
            continue
        last = key
        out.append(entry)
    return out


def emit(entries, stream):
    write = stream.write
    for entry in entries:
        write(json.dumps(entry, separators=(",", ":")))
        write("\n")
    write(json.dumps({"summary": summarize(entries)}, separators=(",", ":")))
    write("\n")
    stream.flush()


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def build_parser():
    parser = argparse.ArgumentParser(
        prog="naught_manifest.py",
        description="Print a JSON-lines manifest (path, size, sha256, mode) of a directory tree.",
        allow_abbrev=False,
    )
    parser.add_argument("--root", required=True, metavar="DIR", help="absolute directory to inventory")
    parser.add_argument(
        "--include-ignored",
        action="store_true",
        help="include git-ignored files (git mode) / node_modules, venvs and caches (walk mode)",
    )
    parser.add_argument(
        "--git-dir",
        metavar="DIR",
        help="absolute path of a mother repository's .git directory to inventory as well",
    )
    parser.add_argument(
        "--exclude-worktree",
        action="append",
        default=[],
        metavar="NAME",
        help="skip worktrees/NAME under --git-dir (repeatable)",
    )
    return parser


def normalize_dir_arg(parser, flag, value):
    if not os.path.isabs(value):
        parser.error("%s must be an absolute path, got %r" % (flag, value))
    return os.path.normpath(value)


def main(argv=None):
    parser = build_parser()
    args = parser.parse_args(argv)

    root = normalize_dir_arg(parser, "--root", args.root)
    git_dir = normalize_dir_arg(parser, "--git-dir", args.git_dir) if args.git_dir is not None else None

    for flag, path in (("--root", root), ("--git-dir", git_dir)):
        if path is None:
            continue
        if not os.path.isdir(path):
            kind = "is not a directory" if os.path.lexists(path) else "does not exist"
            sys.stderr.write("naught_manifest: %s %s: %s\n" % (flag, kind, path))
            return 3

    entries = []
    try:
        if git_top_level(root):
            entries.extend(collect_git(root, args.include_ignored))
        else:
            entries.extend(collect_walk(root, args.include_ignored))
        if git_dir is not None:
            entries.extend(collect_git_dir(git_dir, args.exclude_worktree))
    except (RuntimeError, OSError) as exc:
        sys.stderr.write("naught_manifest: %s\n" % exc)
        return 1

    try:
        emit(dedupe_sorted(entries), sys.stdout)
    except BrokenPipeError:
        try:
            sys.stdout.close()
        except Exception:
            pass
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
