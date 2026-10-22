# Distribution and updates

The [release workflow](../.github/workflows/release.yml) defines build targets,
native smoke tests, checksums, SBOM generation, and provenance attestation.
It is the authoritative packaging recipe. Cross-compilation does not establish
native runtime acceptance on the target platform.

## Install

Select a published version from [GitHub Releases](https://github.com/JarenKempton/interlock/releases).
Replace `<version-without-v>` below with that version. Prereleases require an
explicit version because GitHub's latest-release route excludes them.

```sh
curl --proto '=https' --tlsv1.2 -fsSL \
  https://raw.githubusercontent.com/JarenKempton/interlock/main/scripts/install.sh | \
  INTERLOCK_VERSION='<version-without-v>' sh
```

```powershell
$env:INTERLOCK_VERSION = '<version-without-v>'
irm https://raw.githubusercontent.com/JarenKempton/interlock/main/scripts/install.ps1 | iex
```

The [POSIX](../scripts/install.sh) and [PowerShell](../scripts/install.ps1)
installers select the platform asset and verify its SHA-256 checksum before
replacement. Set `INTERLOCK_INSTALL_DIR` to choose the destination.
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
