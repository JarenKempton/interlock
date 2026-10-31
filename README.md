# Interlock

A CLI that claims a tracker ticket and prepares it for an agent in its own T3
Code lane.
Built with TypeScript and Bun.

**In development:** `pickup KEY` claims a Jira ticket, prepares its Git worktree,
and returns the arguments a T3 Code thread uses to launch the lane.
`claim release` gives the ticket back.

## Try it

From this checkout, with [Bun](https://bun.sh) installed:

```sh
bun install
bun run src/cli.ts --help
bun run src/cli.ts login jira
bun run src/cli.ts doctor
bun run src/cli.ts config show
```

`login jira` keeps your Jira credentials in the OS credential store; `doctor`
names any missing sign-in, Jira permission or claim-lock push access.
Pickup works in the current Git repo (or `--repo PATH`) with no project file.

For commands and options, use `--help`, including `config edit --help`.
Help and shell completion derive from the registered actions.

## Configuration

User settings live in local SQLite: the Jira site from `login jira`, host,
agent, model and modes, the `branch` template (default `task/{key}`), and
pickable and claimed statuses (default `To Do` and `In Progress`). Unset agent
and model follow the calling T3 thread.

```sh
bun run src/cli.ts config edit --set model your-model
bun run src/cli.ts config edit --set pickable_statuses "To Do, Ready"
bun run src/cli.ts config edit --follow model
```

`reviewers` takes a comma-separated list of review lenses (for example
`correctness, security`); each runs as a review subagent in the lane, on the
implementer's model unless `reviewer_agent`, `reviewer_model` or
`reviewer_effort` is set. With no lenses, review goes to a person. `config show`
lists them under `review`; pickup's plan shows the checked reviewers.

`--follow` clears that setting; `--follow all` clears every personal choice.
An optional shared `interlock.toml` (`init` writes a commented one) holds team
tracker facts only: the Jira site, statuses, `claim_home` and instruction paths.
They override user settings. `config show` displays resolved values and their
sources without writing configuration or initializing the database.

## Work on the code

| Task | Start here |
| --- | --- |
| Add an action | [Configuration commands](src/configuration/commands.ts) show the pattern; register new groups in [application.ts](src/application.ts) |
| Change configuration | [Schemas](src/configuration/schema.ts) and [starter TOML](src/configuration/default.toml) |
| Add a tracker or workspace adapter | [Adapters](src/adapters/) — implementations are grouped by responsibility and named by provider |
| Understand execution | [Execution](src/execution/) and [portable contracts](src/domain/contracts.ts) |
| Understand boundaries and contracts | [Architecture](docs/architecture.md) |
| Install releases or configure shell integration | [Distribution](docs/distribution.md) |
| Change the landing page | [site/](site/): Astro, served as Worker static assets; `bun run dev` inside it |

```sh
bun test
bun run typecheck
bun run check
bun run build
```

The build writes a standalone executable to `dist/interlock`.
[Release packaging](.github/workflows/release.yml) supplies version and update metadata.

[MIT license](LICENSE) · [Attribution](NOTICE.md)
