# Helm Build Cache

`Helm-Development/Build-Cache` saves and restores build caches (Gradle and
SwiftPM dependencies, CocoaPods, Xcode DerivedData, Ruby gems, and anything
else) for jobs that run on Helm build machines. It stores them in the Helm
build cache service (`helm-cache`) at the build machine's own site, so a
restore is a download over the local network instead of from GitHub.

It takes the same inputs as `actions/cache`, so switching is a one-line
change:

```diff
-      - uses: actions/cache@v4
+      - uses: Helm-Development/Build-Cache@v1
         with:
           path: ~/.gradle/caches
           key: gradle-${{ runner.os }}-${{ hashFiles('**/*.gradle*') }}
           restore-keys: gradle-${{ runner.os }}-
```

Workflows need no secret. On a Helm build machine, every job receives the
address of the cache service and a short-lived token for that one job in the
environment variables `HELM_CACHE_URL` and `HELM_CACHE_TOKEN`. When either
is missing or empty, for example on a GitHub-hosted runner or in a job from a
forked pull request, each step logs a notice and does nothing, and the job
builds without a cache. The same workflow therefore runs anywhere.

## Inputs

| Input | Required | Default | Meaning |
|---|---|---|---|
| `path` | yes | | Files, directories and wildcard patterns to cache, one per line. `~` is the home directory. A line starting with `!` excludes what it matches. Relative paths are relative to the workspace. |
| `key` | yes | | The key the cache is saved under, and the first key looked up. 1 to 512 bytes, with no control characters such as tabs or line breaks. |
| `restore-keys` | no | | Prefixes to try in order when nothing is saved under the exact key, one per line. For each prefix, the newest entry whose key starts with it is restored. At most 20. |
| `fail-on-cache-miss` | no | `false` | Fail the step when no entry is found for the key or any restore key. |
| `lookup-only` | no | `false` | Only check whether an entry exists; do not download it. |

## Outputs

| Output | Meaning |
|---|---|
| `cache-hit` | `true` when an entry was found for the exact key, otherwise `false`. |
| `cache-primary-key` | The `key` input. |
| `cache-matched-key` | The key of the entry that was restored (or found, with `lookup-only`). Empty on a miss. |

## How it works

The main step looks the key up, downloads the entry, checks its SHA-256
digest, and unpacks it. A post step at the end of the job (only when the job
succeeded) saves the paths under `key`, unless the main step restored an
entry with exactly that key.

Entries are `tar` archives compressed with `zstd` when the `zstd` program is
installed, and with gzip otherwise. Paths are stored relative to the
workspace, as `actions/cache` stores them.

### Which entries a job can see

The token the job receives names its repository and branch, and the cache
service enforces it:

- A job saves only to its own repository and branch. For a pull request,
  that is the pull request's head branch (`GITHUB_HEAD_REF`); otherwise it is
  `GITHUB_REF_NAME`.
- A job restores from its own branch first and then from the repository's
  default branch, never from another branch or repository. This is the same
  rule as `actions/cache`, so a pull request can use what `main` saved but
  cannot change what `main` restores.
- An entry is never replaced. Saving a key that already exists on the branch
  is skipped with a message, not an error, so put something that changes in
  the key (usually a hash of the lock files).

### Size limits

Each project has a cache limit (20 GiB unless Helm has set another). When a
save would go over it, the service deletes the project's least recently used
entries first. A single archive larger than the whole limit is refused, and
the step logs a warning. Entries nobody has used for seven days, and the least
recently used entries when the cache disk is nearly full, are also deleted.
Project members can delete a repository's caches from the Caching tab under
Builds in the Helm Dashboard.

### When something goes wrong

A problem with the cache never fails the job: the step logs a warning that
says what happened, and the job continues without the cache. The warnings
cover a refused or expired token (HTTP 401), a token for another branch or
repository, or a machine the service does not accept (403), an archive over
the size limit (413), server errors (5xx, retried for 502, 503 and 504), an
unreachable service, and a download whose digest does not match (the
download is discarded). The step fails only when an input is invalid or when
`fail-on-cache-miss` is set and nothing was restored.

The token is masked in the job log and is never printed.

## Examples

Put `runner.os` in every key: entries made on macOS and on Linux are not
interchangeable.

### Gradle

```yaml
- uses: Helm-Development/Build-Cache@v1
  with:
    path: |
      ~/.gradle/caches
      ~/.gradle/wrapper
    key: gradle-${{ runner.os }}-${{ hashFiles('**/*.gradle*', '**/gradle-wrapper.properties', 'gradle/libs.versions.toml') }}
    restore-keys: gradle-${{ runner.os }}-
```

Stop the Gradle daemon before the job ends (`./gradlew --stop`) so that no
file changes while the post step archives it.

### CocoaPods

```yaml
- id: pods
  uses: Helm-Development/Build-Cache@v1
  with:
    path: Pods
    key: pods-${{ runner.os }}-${{ hashFiles('**/Podfile.lock') }}
    restore-keys: pods-${{ runner.os }}-
- if: steps.pods.outputs.cache-hit != 'true'
  run: pod install
```

### Swift Package Manager

```yaml
- uses: Helm-Development/Build-Cache@v1
  with:
    path: |
      ~/Library/Caches/org.swift.swiftpm
      .build
    key: spm-${{ runner.os }}-${{ hashFiles('**/Package.resolved') }}
    restore-keys: spm-${{ runner.os }}-
```

### Xcode DerivedData

DerivedData changes on every build, so the key includes the commit and the
restore key picks up the newest earlier build:

```yaml
- uses: Helm-Development/Build-Cache@v1
  with:
    path: ~/Library/Developer/Xcode/DerivedData
    key: deriveddata-${{ runner.os }}-${{ hashFiles('**/Package.resolved', '**/Podfile.lock') }}-${{ github.sha }}
    restore-keys: |
      deriveddata-${{ runner.os }}-${{ hashFiles('**/Package.resolved', '**/Podfile.lock') }}-
      deriveddata-${{ runner.os }}-
```

### Ruby gems with Bundler

```yaml
- run: bundle config set --local path vendor/bundle
- uses: Helm-Development/Build-Cache@v1
  with:
    path: vendor/bundle
    key: gems-${{ runner.os }}-${{ hashFiles('**/Gemfile.lock') }}
    restore-keys: gems-${{ runner.os }}-
- run: bundle install
```

### Saving even when the job fails

The post step of the main action runs only when the job succeeded. iOS
workflows often want to keep DerivedData even after a failed test run. Use
the separate `restore` and `save` actions, like `actions/cache/restore` and
`actions/cache/save`:

```yaml
- id: restore-dd
  uses: Helm-Development/Build-Cache/restore@v1
  with:
    path: ~/Library/Developer/Xcode/DerivedData
    key: deriveddata-${{ runner.os }}-${{ github.sha }}
    restore-keys: deriveddata-${{ runner.os }}-

- run: xcodebuild test -scheme App -destination 'platform=iOS Simulator,name=iPhone 17'

- if: always() && steps.restore-dd.outputs.cache-hit != 'true'
  uses: Helm-Development/Build-Cache/save@v1
  with:
    path: ~/Library/Developer/Xcode/DerivedData
    key: ${{ steps.restore-dd.outputs.cache-primary-key }}
```

`Helm-Development/Build-Cache/restore` takes the same inputs and gives the
same outputs as the main action and never saves.
`Helm-Development/Build-Cache/save` takes `path` and `key`.

## Moving from actions/cache

Replace `actions/cache@v4` with `Helm-Development/Build-Cache@v1`,
`actions/cache/restore@v4` with `Helm-Development/Build-Cache/restore@v1`, and
`actions/cache/save@v4` with `Helm-Development/Build-Cache/save@v1`. Inputs
and outputs keep their names. The differences:

- `enableCrossOsArchive` and `upload-chunk-size` do not exist and are
  ignored with a warning from GitHub if left in.
- `cache-hit` is `false` on a miss; `actions/cache` leaves it empty. A test
  such as `steps.x.outputs.cache-hit != 'true'` works the same with both.
- Up to 20 restore keys are allowed (10 in `actions/cache`).
- Entries already saved by `actions/cache` on GitHub are not visible; the
  first run on Helm starts cold.
- Linux and macOS runners only; Windows is not supported.

## Development

```bash
npm ci
npm test
```

`npm test` runs the unit tests with `node:test` against a small in-memory
stand-in for the cache service, using the real `tar` (and `zstd` when it is
installed).

To run the action against a real `helm-cache` binary on your machine
(it is built from `cache/` in the Fleet-Orchestrator repository; the tests
make their own key pair with `helm-cache keygen` and sign their own tokens):

```bash
HELM_CACHE_BIN=/path/to/helm-cache npm run test:integration
```

`dist/` holds the bundled code that GitHub runs and is committed. After
changing anything in `src/` or `package.json`:

```bash
npm run build
```

and commit `dist/` with the change. The `test` workflow fails when `dist/`
does not match the source.

### Releasing

Tag the release, and move the `v1` tag that workflows use to it:

```bash
git tag -a v1.0.1 -m "v1.0.1"
git tag -fa v1 -m "v1 -> v1.0.1"
git push origin v1.0.1
git push origin v1 --force
```

The cache service's HTTP API, token rules and limits are described in
`cache/README.md` in the Fleet-Orchestrator repository.
