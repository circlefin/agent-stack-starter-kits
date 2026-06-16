# @agent-stack-ecosystem-kits/circle-tools

Shared, framework-agnostic TypeScript wrappers around the [Circle CLI](https://developers.circle.com/agent-stack/circle-cli/command-reference). Each kit imports from this package and adapts the tools to its framework's tool/agent interface.

Wrapped commands:

- `circle wallet create`
- `circle wallet list --chain BASE --type agent --output json`
- `circle wallet balance --address <addr> --chain BASE --output json`
- `circle services search "<keyword>" --output json`
- `circle services inspect "<url>" --output json`
- `circle services pay "<url>" --address <addr> --chain BASE --data '{...}'`
