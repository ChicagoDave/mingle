# ADR-0022: The prebuilt image is published to a registry by a tag-driven pipeline that runs the standing gate first

**Status**: ACCEPTED

## Context

Phase 33 delivered the one-command install as `docker compose up`
building the image from a source checkout (`mingle-ts/Dockerfile`,
`compose.yaml`), verified by `test/install.real.test.ts`. It deferred
"a prebuilt image on a registry". Proposal `post-parity-deferrals`
item P-13 asks for it, and the review found three choices hiding in
"published to a registry" that a future session would otherwise
re-litigate:

- **Which registry and namespace.** The image's pull reference is
  operator-facing and permanent once documented in the README.
- **What publishes it.** The repository has no CI configuration at all
  (project profile: "none present"; the 2026-08-28 21:34 session listed
  wiring `npm run verify` into CI as open). Publishing an image means
  adopting a pipeline, and the pipeline is the first place the standing
  gate can run without a human remembering to.
- **What a tag means.** The install's upgrade story is "pull the new
  image; migrations run at boot" (ADR-0002). A `latest` that moves
  under an operator is a different promise from a pinned version.

ADR-0002's founding goal — `docker run` one image with one volume — is
only fully reached when the image exists without a checkout.

## Decision

1. **The image is published to GitHub Container Registry as
   `ghcr.io/chicagodave/mingle`** — the namespace of the fork this work
   lives in (`github.com/ChicagoDave/mingle`, lowercased by GHCR), so the
   pull reference and the source share one identity and the workflow
   publishes with the repository's own `GITHUB_TOKEN`, no second account
   or token. The fork descends from the archived `mingle/mingle` upstream;
   that org is provenance, never a publishing target.
2. **A GitHub Actions workflow publishes it, and only on a version tag**
   (`v<major>.<minor>.<patch>`). The workflow runs `cd mingle-ts && npm
   run verify` — the standing gate — and builds and pushes only if it
   passes. The same workflow runs the gate alone on every push to
   `main`, which closes the open CI item as a side effect. That run is
   **advisory** — it reports, it does not block — because there is
   nothing for it to block: the repository accepts no pull requests
   (Decision 6). The tag-driven publish is the only hard gate, and it
   guards the only thing operators consume.
3. **Every published image carries three tags**: the exact version
   (`1.4.2`), its minor line (`1.4`), and `latest`. `latest` is
   published deliberately, so the bare `docker run
   ghcr.io/chicagodave/mingle` one-liner ADR-0002 aimed at resolves
   without a tag. `compose.yaml` — the documented install path —
   references the minor line, so an operator who follows the README
   gets patch upgrades on `docker compose pull` but never a surprise
   minor; the README states that `latest` moves across minors and is
   for trying the product, not for running it.
4. **Building from source remains supported**, as a documented
   override rather than the default: `compose.yaml` switches from
   `build: .` to `image: ghcr.io/chicagodave/mingle:<minor>`, and a new
   `compose.build.yaml` restores `build: .` for `docker compose -f
   compose.yaml -f compose.build.yaml up`. The Phase 33 real-path test
   (`test/install.real.test.ts`) keeps exercising the build path
   through that override, and the registry path gets its own real-path
   test, `test/image.real.test.ts`: from a clean checkout it runs
   `docker compose up -d --wait` with no build override, asserts the
   running container's image reference is `ghcr.io/chicagodave/mingle`
   at the tag `compose.yaml` names, asserts the container reports
   `healthy` and `/healthz` answers `db: connected`, and asserts the
   pulled image's `org.opencontainers.image.version` label matches the
   tag — so a `compose.yaml` that silently reverted to building, or an
   image published without its labels, fails the test.
5. **Images are multi-architecture** (`linux/amd64`, `linux/arm64`),
   built with `docker buildx`, because the intended audience runs on
   whatever machine is at hand.
6. **The repository is a tribute, not a project seeking maintainers.**
   It exists to honor the original tool by finishing the rewrite;
   it does not accept contributions, triage issues, or promise
   releases on a cadence. Anyone who wants to change it forks it and
   publishes their own image under their own namespace. No branch
   protection, contributor guide, or PR template is added, and no
   session should propose one.

## Consequences

- The repository gains `.github/workflows/`, and with it the first
  place the standing gate runs unattended. A rule-8b break can no
  longer sit undetected across phases even if a session forgets
  `npm run verify`.
- Cutting a release is `git tag v1.4.2 && git push --tags`; there is
  no release branch, no changelog gate, no manual push. Only the
  repository owner has push rights, so only the owner publishes.
- A red gate on `main` is visible on the commit and in the Actions
  tab and nothing more; the next session's `pre-session-audit` is
  the place it gets noticed. If the posture in Decision 6 ever
  changes, requiring the check is one branch-protection setting with
  no code impact.
- Downstream forks inherit the workflow and publish to their own
  `ghcr.io/<fork-owner>/mingle` by changing one image name; nothing in
  the workflow hard-codes this namespace outside that line.
- The registry is an EXTERNAL dependency (rule 13a). The real-path
  test for the pull path must run against a real registry reference,
  which means it needs network and is a `*.real.test.ts`; a local
  `registry:2` container can stand in for the push half only, and
  that is a stub of an external, not an owned, dependency.
- The README's install section changes from "clone and up" to "write
  this compose file and up"; the checkout stops being a prerequisite.
- `ghcr.io/chicagodave/mingle` is permanent once an operator pins it.
  Moving the repository to an organization later means publishing under
  a second name and keeping the first alive, not renaming.
- `SITE_URL`, `SESSION_SECRET`, and the other Phase 33 environment
  variables become the entire operator interface — the image has no
  build-time configuration.

## Session

- Decided during session 952c08 (2026-08-28), while reviewing
  `docs/proposals/post-parity-deferrals.md` item P-13; summary
  `docs/context/session-20260828-*-main.md` for that session.
