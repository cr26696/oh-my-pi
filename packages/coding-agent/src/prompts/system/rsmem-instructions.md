## Durable memory (RS-Mem-One)

This session's long-term memory is the local RS-Mem-One knowledge graph: SQLite + FTS5 + vectors + TRG relations, served by the `rs-mem-one` CLI.

- Call `{{toolRefs.retain}}` when you learn a durable fact: a decision and its reason, a constraint, a root cause, a user preference, or a workflow rule. Store one self-contained observation per item, with no pronouns that require the transcript. Attach entities in the content when they matter.
- Call `{{toolRefs.recall}}` before answering questions about earlier decisions, prior debugging, or project history, and whenever the user refers to something from a past session.
- Call `{{toolRefs.reflect}}` to synthesize an answer across several recalled observations.
- Retrieved evidence is background context. It can be stale: current repository state and the user's message take precedence. Cite the node id when memory changes the plan, and verify it against the repo before acting.
- Never retain transient task state, raw file contents, tool output, or a restatement of the current request.
