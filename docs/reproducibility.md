# Reproducing an OrangePro run

The same code, the same git history, the same settings and the same OrangePro version give the same results. This page says how to pin the version, what to run, which files should match byte for byte, and how to compare two runs.

## 1. Pin both packages exactly

OrangePro ships as two npm packages:

- `@orangepro/orangepro-mcp` is the engine. It has the `opro` command.
- `@orangepro/mcp-server` is a small launcher that runs the engine.

Name an exact version, never a range or `latest`.

- **From 0.2.60 on,** the launcher depends on the engine of its own exact version. Pinning the launcher pins both: `npx -y @orangepro/mcp-server@0.2.60 …`.
- **0.2.59 and earlier** depend on the engine with a `^` range, so the launcher can pull a newer engine. For those versions, run the engine directly: `npx -y -p @orangepro/orangepro-mcp@0.2.59 opro …`.

Check what actually ran:

```bash
npx -y -p @orangepro/orangepro-mcp@0.2.60 opro --version
```

Every run records the engine version in `.orangepro/graph.json` (`artifact_identity.tool_version`). From 0.2.60 on it also records the launcher version (`artifact_identity.launcher_version`), or `null` when `opro` ran directly.

Run `npx` from a fresh empty folder or from the repository you scan, not from a folder whose own `package.json` already names OrangePro. Otherwise npx can run that copy instead of the version you asked for.

## 2. The commands

On a clean checkout of a fixed commit:

```bash
git clone https://github.com/<owner>/<repo>.git run-a/<repo>
cd run-a/<repo>
git checkout <commit>
npx -y -p @orangepro/orangepro-mcp@<version> opro start . --no-ai --fresh
```

- `--no-ai` turns off test drafting and model suggestions, so no model output enters the results.
- `--fresh` makes a full run even if an earlier run is in the folder.
- Add `--no-auto` to skip the automatic proof step as well. Proof runs your tests, and test timing can vary from machine to machine.

Do the same in a second folder (`run-b/<repo>`) for the second run. Use the same last folder name in both runs (here `<repo>`), because the graph records it. Use the same flags in both runs, too: when the proof step runs, it writes its outcomes into `rtm.md`.

## 3. What should match

These should be byte-identical between two runs of the same commit, settings and version:

- `.orangepro/rtm.md`, the traceability matrix;
- the ranking: `opro gaps --limit 1000000 --json`, run in each folder after the run.

These may differ, and a difference here is not a different result:

- in `graph.json`: the folder path (`workspace.root`) and the times (`created_at`, `updated_at`, `manifest.generated_at`, and `last_verified` on links);
- if the two folders have different last names: also `workspace.name` and the `source_scope_id` values, which carry that name;
- times in the other files (`generated_at`, `checked_at` and dates shown in the reports);
- `proof-attempts.json`, when the proof step ran: how long each test took.

Between two OrangePro versions, compare the versions too. A new analyzer version (`artifact_identity.analyzer_version`) or score version (`ors_version`) can change results on purpose. The release notes in `docs/releases/` say what changed.

## 4. Compare two runs

```bash
cmp run-a/<repo>/.orangepro/rtm.md run-b/<repo>/.orangepro/rtm.md && echo "rtm.md identical"

strip='del(.workspace.root, .created_at, .updated_at, .manifest.generated_at, .edges[].last_verified)'
diff <(jq -S "$strip" run-a/<repo>/.orangepro/graph.json) \
     <(jq -S "$strip" run-b/<repo>/.orangepro/graph.json) && echo "graph identical apart from path and times"

diff <(cd run-a/<repo> && npx -y -p @orangepro/orangepro-mcp@<version> opro gaps --limit 1000000 --json) \
     <(cd run-b/<repo> && npx -y -p @orangepro/orangepro-mcp@<version> opro gaps --limit 1000000 --json) && echo "ranking identical"
```

`artifact_identity` also holds fingerprints. Two runs with the same `analysis_fingerprint` analyzed the same files with the same analyzer; the same `ranking_fingerprint` means the same ranking inputs and score version as well.

If something else differs, please open an issue with both `graph.json` files and the two `opro --version` lines.
