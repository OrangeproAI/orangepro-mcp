---
title: OrangePro docs
---
# OrangePro

Green CI shows which tests passed, not whether they protect the behaviors a change could break.

OrangePro maps affected behaviors from code, requirements and past bugs, ranks the gaps in test protection, and checks existing tests with targeted faults (targeted mutation proof). For a gap, it can help write a focused test, run it against the original code and against a controlled fault, and give you a reviewable test-only patch with the execution evidence.

It runs on the merged base build, after merge and before release. It is not a PR gate or a release gate. It runs on your machine; ranking and proof use no AI model. Model calls happen only if you add your own key, for optional test generation.

```bash
npx -y @orangepro/mcp-server@latest start .
```

- [Getting started](getting-started)
- [Use it with your coding agent](agents)
- [How targeted mutation proof works](how-it-works)
- Source: [github.com/OrangeproAI/orangepro-mcp](https://github.com/OrangeproAI/orangepro-mcp)
