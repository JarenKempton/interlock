# Interlock

A CLI for selecting work from tracker maps and coordinating agent sessions.
Built with TypeScript and Bun.

**In development:** project configuration and offline work selection are usable.
Live ticket pickup and setup execution are not wired into the CLI yet.

## Try it

From this checkout, with [Bun](https://bun.sh) installed:

```sh
bun install
bun run src/cli.ts --help
bun run src/cli.ts init
bun run src/cli.ts config show
```

`init` creates a commented `interlock.toml` without replacing an existing file.
Edit its placeholder tracker and add your repository and map. Keep credentials
out of this file.

For commands and options, use `--help`, including `config edit --help`.
Help and shell completion derive from registered actions and their supplied services.

## Configuration

Project defaults and requirements live in `interlock.toml`. Explicit personal
choices live in local SQLite. Requirements reject conflicting personal choices.

```sh
bun run src/cli.ts config edit --set model your-model
bun run src/cli.ts config edit --follow model
```

`--follow` removes that personal choice so future executions use the project
setting. Use `--follow all` to clear every personal choice. `config show` displays resolved values and their sources without writing
configuration or initializing the database.

## Work on the code

| Task | Start here |
| --- | --- |
| Add an action | [Configuration commands](src/configuration/commands.ts) show the pattern; register new groups in [application.ts](src/application.ts) |
| Change configuration | [Schemas](src/configuration/schema.ts) and [starter TOML](src/configuration/default.toml) |
| Add a tracker, harness or host | [Adapters](src/adapters/) — implementations are grouped by responsibility and named by provider |
| Understand execution | [Execution](src/execution/) and [portable contracts](src/domain/contracts.ts) |
| Understand boundaries and contracts | [Architecture](docs/architecture.md) |
| Install releases or configure shell integration | [Distribution](docs/distribution.md) |

```sh
bun test
bun run typecheck
bun run check
bun run build
```

The build writes a standalone executable to `dist/interlock`.
[Release packaging](.github/workflows/release.yml) supplies version and update metadata.

[MIT license](LICENSE) · [Attribution](NOTICE.md)
