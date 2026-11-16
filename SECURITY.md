# Security policy

## Supported versions

Only the latest 0.2.x release of this project is supported (`@orangepro/mcp-server` and `@orangepro/orangepro-mcp` on npm). Older 0.2.x versions, and any pre-0.2 releases, are not supported.

## Reporting a vulnerability

Please report security vulnerabilities privately, using GitHub private vulnerability reporting / security advisories on this repository:

https://github.com/OrangeproAI/orangepro-mcp/security/advisories/new

Do not open a public issue or pull request for a vulnerability.

If that form is not available, an OrangeproAI organization owner needs to enable **Private vulnerability reporting** for this repository in GitHub (Settings → Code security).

## What data stays local

These claims are for the local MCP and CLI in this repository. They match the [Privacy and network use](README.md#privacy-and-network-use) section of the README:

- Nothing about your code or your runs is sent to OrangePro. There is no usage telemetry.
- Source is read in-process and is never stored or uploaded. Reports and the evidence graph contain metadata, not your source.
- Your source files are never edited. Proofs run in an isolated copy.
- Model calls happen only if you configure a key, and they go directly from your machine to the provider you chose. Keys, the provider, its endpoint and the model are read only from your shell environment, or from the `env` block of your MCP client's config. OrangePro reads no `.env` file, so a repository you scan cannot choose where your key is sent, and OrangePro never writes keys anywhere. `opro setup` saves only the provider and model name.
- With a key, the reports and `tests.csv` include the tests your model drafted, and the prompts include the function names, files and evidence they're based on.
- Reports load nothing from the network. The only outbound links are ones you click.
