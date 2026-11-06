# Distribution and updates

The [release workflow](../.github/workflows/release.yml) defines build targets,
native smoke tests, checksums, SBOM generation, and provenance attestation.
It is the authoritative packaging recipe. Cross-compilation does not establish
native runtime acceptance on the target platform.

## Install

The installers select the newest stable release, or the newest tagged prerelease
when no stable release exists. Nightly is installed only when explicitly requested.
Prerelease installation prints a warning to stderr.
Set `INTERLOCK_VERSION` explicitly to install a particular published version.
If the GitHub releases API cannot resolve a version, installation stops.

```sh
curl -fsSL https://interlock.build/install.sh | sh
```

```powershell
irm https://interlock.build/install.ps1 | iex
```

To try the rolling **nightly prerelease** built from `main`:

```sh
curl -fsSL https://interlock.build/install.sh | INTERLOCK_VERSION=nightly sh
```

```powershell
$env:INTERLOCK_VERSION = 'nightly'; irm https://interlock.build/install.ps1 | iex
Remove-Item Env:INTERLOCK_VERSION
```

The default command prefers stable, even when a newer nightly exists. Until a
stable release exists, it selects the newest tagged prerelease and announces
this before downloading. It skips nightly; if nightly is the only release,
installation stops. API errors never silently select another channel.
Clear `INTERLOCK_VERSION` to return to automatic stable-first selection.

The [POSIX](../scripts/install.sh) and [PowerShell](../scripts/install.ps1)
installers select the platform asset and verify its SHA-256 checksum before
replacement. The site build copies these source scripts into its static assets;
there is no separate maintained installer copy. Set `INTERLOCK_INSTALL_DIR` to choose the destination.

The landing page shows the newest stable tag, or the newest prerelease tag when
no stable exists, read from Git tags at build time. After a release publishes,
deploy the site from `main` with tags fetched: `vp run deploy` inside `site/`.
Unsupported platforms, missing checksums, and digest mismatches leave an
existing executable intact.

## Shell integration

Generate completion definitions from the executable:

```sh
interlock completions bash > ~/.local/share/bash-completion/completions/interlock
interlock completions zsh > "${fpath[1]}/_interlock"
interlock completions fish > ~/.config/fish/completions/interlock.fish
```

View the manual with `interlock man | man -l -`. Help, completion, and manual
content derive from the action registrations.

## Updates and publishing

Build metadata identifies the release source. Interactive update checks write
notices to stderr and never replace the executable. Set
`INTERLOCK_NO_UPDATE_CHECK=1` to disable them. An unconfigured source build
does not make an implicit release lookup; network failure never fails the
requested command.

To publish, run the repository checks and push an explicitly authorized SemVer
prerelease tag. The release workflow validates the tag, embeds its version,
and gates publication on its checks. Verify downloaded artifacts against
`checksums.txt` and their GitHub provenance attestation. Local builds do not
publish a release.

The same workflow checks `main` daily at 04:23 UTC. It skips all build and
publication jobs when the last published nightly already names that commit.
Otherwise it pins every job to the resolved main SHA, runs the same checks,
native smoke tests, checksums, SBOM, and attestation as tagged releases, and
advances the rolling `nightly` prerelease. Lookup failures stop publication.
The nightly tag advances only by fast-forward; rewritten main history needs
maintainer attention rather than an automatic forced update.

`interlock --version` prints `0.0.0-nightly.g<full-main-SHA>` for nightly builds.
Nightly builds skip tagged-release update notices; reinstall with the nightly
command to get the next main build.
The first scheduled run is required to establish hosted build, native-platform,
and published provenance acceptance; local fixtures do not prove publication.
