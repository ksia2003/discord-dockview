# Upstream maintenance

DockView keeps its current combined Vencord + DockView runtime bundle. The goal
of this workflow is to prevent that bundle from going stale without blindly
publishing upstream changes to stable users.

## Daily automation

`.github/workflows/upstream-maintenance.yml` runs at 09:17 KST and can also be
started manually. It compares:

- `scripts/lib/vencordRef.mjs` with the newest stable numeric Vencord Git tag and
  its exact 40-character commit (Vencord publishes stable versions as tags rather
  than GitHub Releases, and the commit pin makes a moved tag fail closed);
- `package.json` and `src/shared/dockviewRelease.ts` with the latest stable
  Vesktop release and the head of Vesktop's default branch.

`scripts/lib/vesktopReview.mjs` is the acknowledgement cursor. After reviewing
an upstream Vesktop release or commit, advance the corresponding value even when
the decision is to defer it. This closes the tracking issue without pretending
the reviewed code was bundled; the report shows bundled and reviewed revisions
separately.

A newer Vencord release is compiled together with one recorded DockView source
commit on Linux and Windows. DockView's external viewer dependencies are added
at explicit versions rather than whatever the registry serves that day. Both
runners execute metadata checks, lint, TypeScript, unit tests, and
production/development shell builds. Only after both pass does the workflow open
or refresh an automated **draft** PR containing the tracked core output changes,
source/pin changes, and the small copied `static/vencordDist.provenance.json`
record. The complete candidate artifact's fixed allowlist, per-file hashes, and
exact source/Vencord provenance include every `chunk-*.js` output; they are
verified and retained as a workflow artifact. Chunks remain generated files
ignored by normal repository history. The record preserves the historical
candidate source SHA for auditability but freshness never compares it with the
merged checkout's `HEAD`. `version.txt` carries the stable plugin-tree/build-
helper identity. Scheduled detection hashes every tracked core/version file and
checks the record's complete 16-file key/digest set, ref, full commit, and stable
identity; it does not require ignored chunk bytes in the clean checkout.

The build job has no persisted repository credential. The write-capable PR job
does not execute candidate code: it validates the fixed output allowlist and
hash manifest in the inert workflow artifact, copies the manifest to the
tracked provenance record only after verification, recreates the Vencord pin
with the trusted source script, verifies the complete package tree in the
temporary workspace, and stages only the record and tracked core outputs.
Candidate branches are named and stamped with the exact DockView source SHA. A
check of `master` immediately before
publication is only observational—not an atomic abort guarantee; if it has
moved, the stale candidate is not published, and any older automation PR is
closed when the replacement is ready. A move after that observation remains a
normal Git race, so the next run closes/replaces the stale source-bound PR.
GitHub Actions are pinned to immutable commits.

Vesktop changes only update a tracking issue. They are never rebased or merged
automatically because upstream Electron, voice, screen-share, updater, and window
changes can overlap DockView shell patches. Pending Vencord updates also have a
durable tracking issue, so a failed candidate remains visible instead of existing
only as a failed workflow run. Trackers receive `upstream-overdue` after seven
days, and duplicate automation-owned trackers are closed. Automation mutates or
closes only issues whose body carries its exact managed marker; a human issue
with the same title remains untouched.

Repository settings must allow GitHub Actions to create pull requests. If that
permission is disabled, candidate builds still run but the final PR step fails
visibly instead of silently dropping the update. Depending on repository rules,
a PR created with `GITHUB_TOKEN` may also require maintainer approval before its
normal PR workflow is allowed to run; automation must not assume either
outcome.

The candidate workflow therefore runs the pinned integration matrix before
creating the commit and records the token-trigger limitation in the PR body.
Maintainers should confirm the PR checks and approve the workflow when GitHub's
policy requires it.

## Human gate

An automated Vencord PR is not a release. Before it leaves draft:

1. Reconcile any upstream changes that supersede DockView patches.
2. Install a development build and verify login, restart, and updater behavior.
3. Exercise DockView attachments, Members, Profile, and representative heavy viewers.
4. Verify two-way voice over Tailscale.
5. Verify screen-share audio isolation and 1080p60/1440p60 behavior.
6. Soak the development build in real use for at least three days.

For the first build after removal of DockView's default-on `voiceFixEnabled`,
release notes must tell Tailscale/VPN users to select **Default Public And Private
Interfaces** under Vesktop's WebRTC IP Handling Policy if calls again stop at
`DTLS Connecting`. The legacy boolean is deliberately not migrated because it
was persisted as `true` by default and therefore does not prove user intent.

The existing release and package workflows run `prepareVencord` from the tagged,
merged source and use `verify-generated` to require the complete fixed output
set—including every declared chunk—before packaging or uploading assets. This
generated-tree check intentionally does not require the persisted candidate
record or Linux byte-for-byte digests, so the implementation commit and both
release matrix legs remain packageable before the first candidate record exists.
The first scheduled update that needs a candidate creates the record from its
already verified manifest; scheduled freshness detection then uses that record
as its clean-checkout authority. Candidate-PR bytes are therefore a
compatibility gate rather than a complete runtime bundle in the PR tree; the
workflow artifact is the complete candidate package, and the release rebuild is
the authoritative package path. Verify the actual prerelease assets in the
development channel before
changing that same GitHub release from prerelease to stable; do not create a
second stable rebuild. Security fixes can use an expedited gate, but still
require the relevant real execution-path check.

## Maintenance targets

- Vencord stable release: candidate PR within 48 hours.
- Vesktop change: review decision within three days.
- Any open upstream review: `upstream-overdue` after seven days.

Automation owns complete paginated detection, fixed-output/provenance checks,
pinned candidate generation, duplicate-safe issue enumeration, and durable
failure visibility. A maintainer owns compatibility decisions, actual
prerelease asset verification, and stable promotion.
