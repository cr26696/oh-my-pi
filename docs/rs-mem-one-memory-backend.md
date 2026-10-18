# RS-Mem-One memory backend

omp can use the local `rs-mem-one` CLI (the renamed `jev-mem-cli`) as its long-term memory backend. The CLI owns the SQLite graph, embeddings and relation judging; omp only injects recalls, exposes the native memory tools and routes `/memory` commands.

```yaml
memory:
  backend: rs-mem-one
```

## Settings

| Setting                            | Default      | Description                                                                 |
| ---------------------------------- | ------------ | --------------------------------------------------------------------------- |
| `memory.backend`                   | `off`        | Set to `rs-mem-one` to enable this backend.                                 |
| `rs-mem-one.bin`                   | `rs-mem-one` | Path or name of the CLI.                                                    |
| `rs-mem-one.transport`             | `stdio`      | `stdio` keeps one resident `rs-mem-one serve` process; `cli` starts the one-shot binary per call. |
| `rs-mem-one.dbPath`                | unset        | Passed as `--db`. Empty uses the CLI's own config (`~/.config/jev/config.toml`). |
| `rs-mem-one.configPath`            | unset        | Passed as `--config`.                                                       |
| `rs-mem-one.timeoutSeconds`        | `20`         | Per-invocation CLI timeout.                                                 |
| `rs-mem-one.maxEvidence`           | `6`          | Maximum evidence items for first-turn recall and `recall`.                  |
| `rs-mem-one.injectionTokenLimit`   | `5000`       | Approximate token budget for the injected block.                            |
| `rs-mem-one.autoRecall`            | `true`       | Run a recall on the first turn of a top-level session.                      |
| `rs-mem-one.debug`                 | `false`      | Pass `--verbose` to the CLI.                                                |

## Agent tools

Selecting this backend exposes the native memory tools:

- `recall` — search the graph; results include node ids.
- `retain` — store durable observations.
- `reflect` — synthesize an answer from the recalled evidence.
- `read memory://<node-id>` — read a full node with a YAML frontmatter header.

`memory_edit` is not available because the current CLI has no update/forget verb. `learn` is not wired to this backend yet.

## Behavior

- First-turn recall asks the CLI for evidence, injects it as background context, and persists the block in the transcript so a resume or fork reuses it instead of querying again.
- Compaction asks the backend for a small evidence block and appends it to the summarization context.
- `/memory view`, `stats`, `diagnose`, and `clear` route through the backend. `enqueue` is a no-op because relation judging is synchronous in `record`.
- The backend is global (one CLI database). Project isolation requires a separate `rs-mem-one.dbPath` per project or a project-filtering CLI.
- With `transport: stdio` (default), each session keeps one `rs-mem-one serve` process alive. It owns the SQLite handle, HTTP clients and the Jev decision cache, so first-turn recall, `recall`, `retain`, `stats`, and `memory://` reads do not pay process startup or TLS setup per call. The server exits on `shutdown`, EOF, or session disposal; if it crashes, the backend falls back to the one-shot CLI for that session.
- `/memory clear` stops the resident server before unlinking the database, then recreates the schema.
