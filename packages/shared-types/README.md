# @shujian/shared-types

TypeScript type definitions shared across `apps/bridge` and `apps/dashboard`,
and (eventually) auto-generated from `apps/agent` Rust structs via [typeshare](https://github.com/1Password/typeshare).

## Usage

In a workspace consumer:

```ts
import type { AgentTaskSummary, CursorAgentRunEvent } from "@shujian/shared-types";
```

## Adding a type

1. Add it to the relevant file in `src/` (or create a new file and re-export from `src/index.ts`).
2. If the type also exists as a Rust struct in `apps/agent/src/`, keep both in sync until typeshare codegen is wired up.
3. Run `bun run typecheck` from the repo root to validate consumers.
