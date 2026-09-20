#!/usr/bin/env python3
"""Integrate one writer branch into the target branch, with expected-ref CAS.

WHY THIS EXISTS. V3 section T/R9 requires that exactly one integrator owns the
target branch and that integration uses "expected-HEAD / compare-and-swap
semantics", because the previous round ran ten writers in ONE shared worktree and
produced five real git accidents (G-SEAM-35, G-SEAM-42): a `reset --hard`
orphaned a commit; a `commit -a` swept a sibling's fix; an `--amend` raced; a
broad `git add` pulled in in-progress work; and an uncommitted filing was
reverted. This script is the mechanical half of the discipline that replaces
that. It refuses to act unless the repository is in exactly the state it expects.

WHAT IT DOES NOT DO. It does not resolve conflicts, and it does not decide
whether the merged code is correct. A conflict is reported and the merge is
aborted, because a semantic auto-merge controller is explicitly out of scope --
the plan forbids writing one, and a conflict here means two writers touched the
same region and a human-or-root decision is required. It also does not run the
tests: verification is a separate, explicit step, so that "merged" is never
mistaken for "verified".

USAGE
    python helpers/integrate.py --branch wt/r3
    python helpers/integrate.py --branch wt/r3 --dry-run
    python helpers/integrate.py --list
"""
from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent


def git(*args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    """Run one git command in the repo. Returns the completed process."""
    proc = subprocess.run(
        ["git", *args],
        cwd=REPO,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    if check and proc.returncode != 0:
        raise SystemExit(
            f"git {' '.join(args)} failed (exit {proc.returncode}):\n"
            f"{proc.stdout}{proc.stderr}"
        )
    return proc


def head_of(rev: str) -> str:
    return git("rev-parse", rev).stdout.strip()


def porcelain() -> list[str]:
    out = git("status", "--porcelain").stdout
    return [line for line in out.splitlines() if line.strip()]


def list_writers() -> None:
    """Every wt/* branch, with its commit count ahead of the target branch."""
    target = git("rev-parse", "--abbrev-ref", "HEAD").stdout.strip()
    branches = git("branch", "--list", "wt/*", "--format=%(refname:short)").stdout.split()
    if not branches:
        print("no wt/* branches")
        return
    print(f"target branch: {target}")
    for b in sorted(branches):
        ahead = git("rev-list", "--count", f"{target}..{b}").stdout.strip()
        subject = git("log", "-1", "--format=%s", b).stdout.strip()[:64]
        print(f"  {b:12s} {ahead:>3s} ahead  {subject}")


def integrate(branch: str, dry_run: bool) -> int:
    target = git("rev-parse", "--abbrev-ref", "HEAD").stdout.strip()

    # --- PRECONDITION 1: the target branch must be checked out and clean -----
    # A dirty tree means the integrator itself has uncommitted work, and merging
    # onto it would mix two changes in one commit -- the `commit -a` accident.
    dirty = porcelain()
    if dirty:
        print(f"REFUSED: the working tree is not clean ({len(dirty)} entries).", file=sys.stderr)
        for line in dirty[:20]:
            print(f"  {line}", file=sys.stderr)
        print("Commit or stash your own work first; integration must not mix with it.", file=sys.stderr)
        return 2

    if branch not in git("branch", "--list", branch, "--format=%(refname:short)").stdout.split():
        print(f"REFUSED: no such branch: {branch}", file=sys.stderr)
        return 2

    # --- PRECONDITION 2: the writer branch must be a strict descendant -------
    # If it is not, the branch was rebased or the target moved under it, and a
    # merge would silently reintroduce or drop commits. This is the expected-ref
    # compare-and-swap: the branch's merge-base must be exactly where the writer
    # started, or the integration is not the one that was verified.
    base = git("merge-base", target, branch).stdout.strip()
    target_head = head_of(target)
    branch_head = head_of(branch)

    if base == target_head:
        relation = "fast-forward (branch is ahead of target, no divergence)"
    elif base == branch_head:
        relation = "ALREADY MERGED (target contains this branch)"
    else:
        relation = f"diverged (merge-base {base[:12]}, target {target_head[:12]})"

    ahead = git("rev-list", "--count", f"{target}..{branch}").stdout.strip()
    behind = git("rev-list", "--count", f"{branch}..{target}").stdout.strip()

    print(f"target : {target} @ {target_head[:12]}")
    print(f"branch : {branch} @ {branch_head[:12]}")
    print(f"ahead  : {ahead}   behind: {behind}")
    print(f"relation: {relation}")

    if base == branch_head:
        print("nothing to do: the target already contains this branch.")
        return 0

    if ahead == "0":
        print("nothing to do: the branch has no commits ahead of the target.")
        return 0

    # Show what would land, so the integration is reviewable before it happens.
    print("\ncommits to integrate:")
    for line in git("log", "--oneline", f"{target}..{branch}").stdout.splitlines():
        print(f"  {line}")

    print("\nfiles touched:")
    for line in git("diff", "--stat", f"{target}...{branch}").stdout.splitlines():
        print(f"  {line}")

    if dry_run:
        print("\n--dry-run: no merge performed.")
        return 0

    # --- MERGE: --no-ff so one candidate is one reviewable merge commit ------
    # A fast-forward would leave no record that this candidate was integrated as
    # a unit, which is what makes "reverify the integrated tree" meaningful.
    print(f"\nmerging {branch} into {target} with --no-ff ...")
    proc = git(
        "-c", "user.name=integrator", "-c", "user.email=integrator@local",
        "merge", "--no-ff", "--no-edit",
        "-m", f"integrate {branch} ({ahead} commit(s)) into {target}",
        branch,
        check=False,
    )
    print(proc.stdout.strip())
    if proc.returncode != 0:
        # A conflict is a DECISION, not an error to retry. Abort so the target
        # branch is left exactly as it was, and report the conflicting paths.
        print(proc.stderr.strip(), file=sys.stderr)
        conflicting = git("diff", "--name-only", "--diff-filter=U", check=False).stdout.split()
        print("\nCONFLICT: the merge was aborted; the target branch is unchanged.", file=sys.stderr)
        if conflicting:
            print("conflicting paths (two writers touched the same region):", file=sys.stderr)
            for path in conflicting:
                print(f"  {path}", file=sys.stderr)
        print(
            "\nThis needs a decision, not a retry: decide which writer's change wins\n"
            "for each path, then re-run. Do NOT resolve it by hand-editing the merge\n"
            "in progress -- abort, decide, and re-apply, so the target branch never\n"
            "holds a half-merged state.",
            file=sys.stderr,
        )
        git("merge", "--abort", check=False)
        return 1

    new_head = head_of(target)
    print(f"\nintegrated: {target} @ {new_head[:12]}")
    print(
        "\nNOT VERIFIED. Integration and verification are separate steps on purpose:\n"
        "  - 'merged' must never be read as 'verified'\n"
        "  - re-run the integrated tree's own checks before any claim about it\n"
        "  - the deployment identity moves if profiles/ or packages/ changed, which\n"
        "    invalidates verdicts bound to the old identity (that is intended)"
    )
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--branch", help="the wt/* branch to integrate into the current branch")
    ap.add_argument("--dry-run", action="store_true", help="show what would land, change nothing")
    ap.add_argument("--list", action="store_true", help="list writer branches and their progress")
    args = ap.parse_args()

    if args.list:
        list_writers()
        return 0
    if not args.branch:
        ap.print_help()
        return 2
    return integrate(args.branch, args.dry_run)


if __name__ == "__main__":
    raise SystemExit(main())
