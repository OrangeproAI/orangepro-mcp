# OrangePro — Quickstart

Map behavior coverage and generate grounded tests for your repo — locally, with your own
model key when generation is needed. No account, no sign-up, nothing leaves your machine.

---

## 1. Install the `opro` command (one time)

```bash
npm install -g @orangepro/orangepro-mcp
opro help
```

> Developing from source instead?
> ```bash
> git clone https://github.com/OrangeproAI/orangepro-mcp.git
> cd orangepro-mcp && npm ci && npm run build && npm link
> ```

## 2. Point it at your repo

```bash
cd /path/to/your/repo
opro
```

`opro` builds the deterministic graph, writes `.orangepro/behavior-coverage.html`,
writes `.orangepro/rtm.md`, checks the current branch diff when possible, and prints next
actions for your coding agent. If it finds no behavior anchors, add a requirements
file or run on a repo path with tests/code that OrangePro can parse.

## 3. Optional: add your model key

```bash
export OPENAI_API_KEY=<your local key>        # or ANTHROPIC_API_KEY, or run a local Ollama
```

Or just run `opro setup` once to pick a provider + model interactively. Your key stays
in your environment — it's never saved. No key is required to prove existing tests.
A key is required to generate new tests or AI candidate flows. Dynamically Proven
coverage still comes only from deterministic proof.

## 4. Generate tests

```bash
opro                            # refresh graph + RTM + weak AI grounding when configured
opro generate                  # for the most test-worthy behavior in the repo
opro generate --base main      # only for what your branch/PR changed (vs main)
```

`--base <ref>` is the useful one on a real branch — it generates tests for the code
**you actually changed**, not the whole repo.

## 5. See the results

```bash
open .orangepro/behavior-coverage.html
open .orangepro/rtm.md           # traceability matrix
```

The generated test cases include run hints. With an AI coding agent (Cursor, Claude
Code, Codex, OpenCode) the agent can write each runnable test, run the command, and
call `orangepro_prove` with the returned `prove_run` args so OrangePro dynamically
checks whether the gap became Dynamically Proven.

---

That's the whole loop: **install → `opro` → agent writes/runs tests → `orangepro_prove`.** Full reference
in [README.md](README.md).
