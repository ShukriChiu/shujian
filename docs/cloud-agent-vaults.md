# Cloud Agent Vaults

Notes on the cloud-agent envVars feature: how it works, the threat model, and the gotchas worth documenting before someone burns a production secret.

## What a vault is

A **vault** is a named bundle of `KEY=value` env pairs, stored in the dashboard's `localStorage` under `shujian.vaults.v1`. When you create a Cursor cloud agent and attach a vault, the dashboard ships those envs to the bridge in the create-agent request body, the bridge forwards them as `CloudAgentOptions.envVars`, and the Cursor SDK injects them into the cloud VM's shell as `process.env.*`.

Properties (per Cursor's docs):

- Encrypted at rest by Cursor.
- Scoped to **one** agent — different agents do not share envVars.
- Deleted automatically when the agent is disposed.
- **Immutable post-create** — there is no SDK call to mutate envVars on a running agent. To change creds, dispose the agent and create a new one.

## Trust model (PoC)

Vaults live in the browser. That means:

- **localStorage is the security boundary** — anyone who can run JS on this dashboard origin can read every vault. Treat it like a `.env` file on your laptop.
- **Don't host the dashboard publicly without auth.** The Cloudflare Pages URL is currently world-readable; gate it with Cloudflare Access (or similar) before storing real production secrets.
- **Don't share vaults between users** — each browser is its own silo. Vault sync = manual export/import for now. Team-shared vaults belong on the bridge once we add auth + persistence.
- **No undo on delete.** Removing a vault from the dashboard nukes it. Already-running agents keep their envVars (Cursor stores them server-side); future agents won't be able to attach this vault.

## Authoring a vault

Top-bar `Vaults` button → `+` to create, then either:

- Type each key and value individually, or
- Click `导入 .env` and paste a `.env` blob — the dialog parses tolerantly: `export` prefix, `#` comments, `'single'` and `"double"` quotes (with `\n \r \t \" \\` escapes inside doubles), and trailing `# inline comments` on unquoted values.

Save merges into the existing vault by key (later imports overwrite earlier values for the same key).

## Wiring a vault to a cloud agent

`Cursor Agents` tab → switch to `cloud` → pick a vault from the dropdown next to the repo selector. Submit. The bridge logs the `agentId` it created; the envs are now live in the agent's VM.

In the agent's prompt or in the repo code, reference them as ordinary process env: `process.env.DATABASE_URL`. **Don't paste secret values into the prompt** — prompts are stored and surface in Cursor logs / model context.

## The dotenv interaction trap

`CloudAgentOptions.envVars` injects into the **shell** before user code runs. But repos that call `dotenv.config()` (or anything that reads a checked-in `.env`) **overwrite** `process.env` from disk on import. This means:

- If your repo has a checked-in `.env` (sometimes done for examples or test data), `dotenv.config()` will silently shadow your injected envVars at runtime.
- If your repo has `.env.example` only and a real `.env` is gitignored (the normal case), there's nothing to overwrite — the injected envVars survive.

Two ways to avoid the trap:

1. Don't commit a real `.env` to the repo. (Recommended.)
2. If you must, in code do `process.env.DATABASE_URL || dotenv.parsed?.DATABASE_URL` — i.e. let injected envs win.

## What about Skills?

Skills (`.cursor/skills/SKILL.md`) for cloud agents come from three places, **none of which is your local machine**:

| Source | Where to put it | Loaded by |
|--------|----------------|-----------|
| Repo skills | `<repo>/.cursor/skills/<name>/SKILL.md` (committed) | `project` settingSource (always on for cloud) |
| Team skills | [cursor.com team settings](https://cursor.com/dashboard) | `team` settingSource (always on for cloud) |
| Plugins skills | Cursor plugins installed in your team | `plugins` settingSource (always on for cloud) |

`~/.cursor/skills-cursor/` on your laptop — i.e. the `user` settingSource — does **not** sync to the cloud VM. The dashboard hides the local-skills picker when `runtime` is `cloud` for this reason.

## Operational checklist

Before flipping a production vault into a cloud agent:

- [ ] Dashboard is behind auth (Cloudflare Access, password, or OIDC).
- [ ] You've reviewed which keys are in the vault — `console.log(process.env)` from the agent will surface all of them. Trim unused keys per agent.
- [ ] The target repo doesn't commit a `.env` that shadows the injected vars.
- [ ] The agent's `autoCreatePR` is set the way you want — accidental PRs to main on a prod-credential agent can be loud.
- [ ] You're tracking `agentId` (visible in the dashboard's Active Agents list) so you can dispose it explicitly when done.

## Roadmap (post-PoC)

These are out of scope for the localStorage-only design above:

- **Bridge-side persistence** — move vaults into the bridge's database, gate by user auth, enforce repo allow-lists per vault.
- **Audit log** — record `(userId, vaultId, agentId, repoUrl, timestamp)` on every cloud-agent create.
- **Approval workflow** — vaults marked `requireApproval` need a second user to confirm before injection.
- **Secret backends** — vault becomes a *pointer* (e.g. `vault://hashicorp/prod/db`) and the bridge dereferences at agent-create time. Rotation handled upstream.
- **Per-key visibility** — flag specific keys as "redact in UI" so even browser previews can't display the value.
