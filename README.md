# base-images

Hardened, minimal base images built with [apko](https://github.com/chainguard-dev/apko) from
[Wolfi](https://github.com/wolfi-dev) packages, plus a small [melange](https://github.com/chainguard-dev/melange)
workshop for the few packages Wolfi does not provide the way we need them. Published to the public GHCR under
`ghcr.io/rhanka/base/*`: anonymous pull, no pull secret. Every published digest is signed with cosign
(keyless, GitHub OIDC), carries SPDX SBOM attestations, and has a GitHub (SLSA) provenance attestation.

## Images

| image | tag (moving) | kind | content |
|---|---|---|---|
| `ghcr.io/rhanka/base/node` | `26` | runtime | glibc + the official nodejs.org Node.js 26 binary, CA, tzdata; entrypoint `/usr/bin/node`, workdir `/app` |
| `ghcr.io/rhanka/base/node-poppler` | `26` | runtime | `node` + `poppler-utils` |
| `ghcr.io/rhanka/base/web` | `mainline` | runtime | nginx mainline on port 8080, pid and temp files under `/tmp`, logs to stdout/stderr |
| `ghcr.io/rhanka/base/cc` | `glibc` | runtime | glibc, libgcc, libstdc++, libatomic, CA, tzdata (Rust, C, C++ binaries) |
| `ghcr.io/rhanka/base/toolbox` | `1` | jobs | busybox, s5cmd, `postgresql-18-client`, curl, jq (Jobs, init containers, `kubectl debug`) |
| `ghcr.io/rhanka/base/node-dev` | `26` | dev | `node` + npm, busybox, bash, git, apk-tools (build stages, CI, dev containers) |
| `ghcr.io/rhanka/base/e2e` | `trial` | dev, trial | `node-dev` + the shared libraries and fonts Chromium headless needs; the browser comes from your Playwright version |

Common contract: uid/gid 65532, no setuid/setgid file, read-only root filesystem compatible (write under
`/tmp`), `/etc/os-release` and the apk database kept so scanners match the Wolfi feed, `linux/amd64` and
`linux/arm64`. Runtime images contain no shell and no package manager; `toolbox` has busybox only; dev images
are never long-running services. No image contains a Python interpreter, `libpython` or a `*.py` file
outside a short allowlist of inert files (gdb helpers; npm's `node-gyp/gyp` in dev images only, so a native
addon without a prebuilt binary fails to build instead of pulling Python in).

Consume by digest; the tag is for humans:

```dockerfile
FROM ghcr.io/rhanka/base/node-dev:26@sha256:<digest> AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM ghcr.io/rhanka/base/node:26@sha256:<digest>
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
CMD ["dist/index.js"]
```

The digest that tenants should use for each image is in [`rollout.json`](rollout.json)
(`current.<image>.digest`).

## Verify an image from a clean machine

You need [cosign](https://github.com/sigstore/cosign/releases) v2.4 or later, `jq`, and for the GitHub
attestation the [GitHub CLI](https://cli.github.com/). No registry login: the images are public.

```bash
IMAGE=ghcr.io/rhanka/base/node
DIGEST=$(curl -sSfL https://raw.githubusercontent.com/rhanka/base-images/main/rollout.json | jq -r '.current.node.digest')
IDENTITY=https://github.com/rhanka/base-images/.github/workflows/build.yml@refs/heads/main
ISSUER=https://token.actions.githubusercontent.com

# 1. Signature: made by this repository's build workflow on main, logged in the public Rekor log.
cosign verify "$IMAGE@$DIGEST" --certificate-identity "$IDENTITY" --certificate-oidc-issuer "$ISSUER"

# 2. SBOM attestation (SPDX), same identity. Prints the package count of the SBOM.
cosign verify-attestation --type spdxjson "$IMAGE@$DIGEST" \
  --certificate-identity "$IDENTITY" --certificate-oidc-issuer "$ISSUER" \
  | jq -r '.payload' | base64 -d | jq '.predicate.packages | length'

# 3. Provenance: GitHub artifact attestation (SLSA build provenance) issued to this repository's workflow.
#    gh calls the GitHub API, so it needs a GitHub login (any account): gh auth login.
gh attestation verify "oci://$IMAGE@$DIGEST" --repo rhanka/base-images \
  --signer-workflow rhanka/base-images/.github/workflows/build.yml
```

Each architecture manifest (`crane digest --platform linux/arm64 "$IMAGE@$DIGEST"`) is signed and carries its
own SBOM attestation too. To avoid the GitHub login for step 3, download the attestation bundle once
(`gh attestation download oci://$IMAGE@$DIGEST --repo rhanka/base-images`) and verify it anywhere with
`gh attestation verify ... --bundle <file>`.

### Rebuild it and compare the digest

The image is reproducible from the committed lock: same lock, same digest, on any amd64 or arm64 Linux
machine with Node.js and the GitHub CLI.

```bash
git clone https://github.com/rhanka/base-images && cd base-images
git checkout <commit>                         # the commit in the provenance attestation
scripts/install-tools.sh                      # pinned apko, melange, cosign, grype, crane, sha256-checked, into .bin/
export PATH=$PWD/.bin:$PATH
node scripts/apks.mjs fetch --lock images/node/apko.lock.json   # workshop apks from this repository's releases
node scripts/image.mjs build node            # prints the index digest: compare with $DIGEST
```

## How it is built

```
melange/*.yaml ──(once per version)──► release apk-<name>-<version>-r<epoch>   (the workshop apk mirror)
                                                │
images/<name>/apko.yaml + apko.lock.json ───────┴► apko build, both archs, twice (digests must match)
  ► gates: Python, shell, package manager, setuid, apk dependencies, user, size
  ► smoke run (amd64, read-only rootfs, no capabilities) ► grype --only-fixed --fail-on high (both archs)
  ► apko publish (fails unless the pushed digest equals the gated one) ► cosign sign + SBOM attestations
  ► GitHub provenance attestation ► verify ► copy every locked Wolfi apk to release wolfi-mirror-<month>
```

- **Locks.** `apko.lock.json` pins every apk by its signature, control and data checksums.
  `SOURCE_DATE_EPOCH` is the commit time of the lock, and no VCS annotation is written into the image (the
  commit is in the provenance attestation), so the digest depends on the lock only. Same lock, same digest:
  nothing is published.
- **melange workshop.** Each package version is built once, on native amd64 and arm64 runners, and stored as
  an immutable release holding its apks, its per-arch `APKINDEX` and the public halves of the per-arch
  signing keys. The private keys are generated in the build job and destroyed at its end. Image builds never
  rebuild a workshop package: a re-signed apk would not match the lock.
  - `nodejs-26-official`: the official nodejs.org Node.js 26 binary (bundled OpenSSL 3.5 and ICU, the
    upstream-tested build). `scripts/verify-node-release.sh` verifies `SHASUMS256.txt.sig` with gpg against
    the committed [nodejs/release-keys](https://github.com/nodejs/release-keys) keyring (`keys/nodejs/`),
    requires a `VALIDSIG` from a listed primary fingerprint (an expired or revoked key fails even though gpg
    exits 0), and requires the recipe's sha256 values to equal the signed ones. It blocks the melange build.
    The subpackage `nodejs-26-official-npm` ships npm from the npm registry (sha512-pinned, same major as
    bundled): the npm bundled in Node 26.13.0 carries fixable High advisories (`brace-expansion`, `undici`).
  - `gdal-tools-geo`: `ogr2ogr`, `ogrinfo`, `gdalinfo`, `gdal_translate`, `gdalsrsinfo` from the
    sha256-pinned Wolfi `gdal-tools` apk, without its developer `.py` scripts and its `cmd:bash` dependency.
  - `at-spi2-core-libatspi`: `libatspi.so.0` without the Python bindings that make Wolfi's `at-spi2-core`
    depend on `python-3.13-base` (Chromium needs the library, through `libatk-bridge`).
  - `nginx-unprivileged-config`: the nginx configuration of `web` (files only).
- **Tools.** apko, melange, cosign, grype, crane: Go binaries pinned by version and sha256
  (`scripts/install-tools.sh`). Scripts are Node.js (standard library only) and bash. No Python anywhere.

## Vulnerability supervision and rollout

Owner rule: « Supervision faille daily. En fonction des failles. Max 1/j min 1/mois ».

- **Daily** (`.github/workflows/daily.yml`). grype `--only-fixed` on every published digest. Fresh locks are
  resolved and compared with the committed ones against the Wolfi security feed (`security.json`
  `secfixes`): a fix is *available* when a version that the fresh lock reaches is listed as fixing an
  advisory for what the committed lock ships. This gate uses no CPE matching, so the NVD-CPE-only matches
  that never get a Wolfi fix (the `glibc` and `sqlite` ones in every image) trigger nothing. The job also
  reports Node.js 26 releases newer than the recipe (`security: true` flagged) and newer Wolfi builds of the
  apks the workshop repackages, and keeps one issue open while a published base has a fixable High/Critical.
- **Rollout** (`scripts/rollout.mjs`). An image rolls out when a fix is available, when it is new, or when
  its committed lock was published but not rolled out; at most one rollout per day; an image whose lock
  changed rolls out at least every 28 days even without a fix. The lane is `security` (72 h target) when a
  published digest has a High/Critical with a fix, else `routine`. Production: each rollout that is green in
  preprod gets its own owner GO.
- **Dispatcher** (`.github/workflows/dispatch.yml`, reusable). A tenant repository calls it on a schedule
  with its own `GITHUB_TOKEN`. It reads `rollout.json`, finds every `ghcr.io/rhanka/base/*@sha256:` reference
  in the tenant checkout and plans one pull request per repository, with the fixed advisory ids.
  **P1: dry-run only**: it prints the PR and opens none. This repository never lists tenant repositories.

## Status (phase P1)

In place: the images above, the melange workshop and its mirror, the build gates, cosign signatures, SBOM
and provenance attestations, the daily supervision with the fix-available gate and the rollout policy, the
dispatcher in dry-run, the copy of locked Wolfi apks. Later phases: the dispatcher opening PRs and the
Dependabot preset for third-party images (P3), cluster admission (P2), tenant variants (`geo-gdal` is P3;
`test/geo-gdal` only checks that the reduced GDAL resolves, passes the runtime gates and runs), an automated
Node.js bump PR (the daily job reports new releases).

`e2e` is a trial: Playwright's own Chromium headless shell renders a page on it (`test/e2e-trial`, run by
the build workflow on amd64 and arm64). Firefox and WebKit are not covered; there are no CJK fonts.
