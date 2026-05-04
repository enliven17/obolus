# obolus agent examples

Three working integrations showing how to use obolus from different
environments. Each example is self-contained with its own dependencies.

## Quick start (all examples)

1. Create an agent in the obolus dashboard (Agents tab → Create Agent) and copy the claim code
2. Run `npx -y obolus@latest onboard --claim <code>` to exchange the claim for credentials
3. Fund your wallet (MCP: run `setup_wallet`; manual: send at least 2 SOL to the address)

## Examples

### `node-agent/` — Node.js + obolus SDK

The recommended path for TypeScript/JavaScript agents. Uses the `obolus`
npm package with the all-in-one `purchaseCardOWS()` helper.

```bash
cd node-agent
npm install
OBOLUS_API_KEY=obolus_... OWS_WALLET_NAME=my-agent node index.mjs
```

### `python-agent/` — Python + REST API

Uses the REST API directly via `httpx`. Shows the full create → poll → read
flow. Payment must be completed externally (Solana SDK or MCP server).

```bash
cd python-agent
pip install -r requirements.txt
OBOLUS_API_KEY=obolus_... python main.py
```

### `langchain-tool/` — LangChain custom tools

Three LangChain `BaseTool` subclasses that any LangChain agent can use:

- `ObolusOrderTool` — create a card order
- `ObolusCheckOrderTool` — poll order status / get card details
- `ObolusBudgetTool` — check spend vs limit

```python
from obolus_tool import ObolusOrderTool, ObolusCheckOrderTool, ObolusBudgetTool

tools = [ObolusOrderTool(), ObolusCheckOrderTool(), ObolusBudgetTool()]
agent = initialize_agent(tools, llm, agent=AgentType.OPENAI_FUNCTIONS)
agent.run("Buy me a $5 virtual Visa card")
```

## MCP server (Claude Code / Claude Desktop)

The fastest path for Claude-based agents. No code needed — just configure:

```json
{
  "mcpServers": {
    "obolus": {
      "command": "npx",
      "args": ["-y", "obolus@latest"],
      "env": {
        "OBOLUS_API_KEY": "obolus_...",
        "OWS_WALLET_NAME": "my-agent"
      }
    }
  }
}
```

The `obolus` CLI defaults to the `mcp` subcommand when no other subcommand
is passed, so `npx obolus@latest` with no args runs the MCP server. `-y`
auto-accepts the one-time install prompt. **Always pin `@latest`** — without
it, `npx` serves whatever version it first resolved from its local cache
indefinitely, so SDK patch releases (particularly the ones touching on-chain
payment paths) don't reach the agent until the operator manually clears the
npx cache. With `@latest`, every invocation re-resolves against the registry.

Then ask Claude: "Buy me a $10 virtual Visa card."

## API reference

See [`contract/api/agent-api.openapi.yaml`](../contract/api/agent-api.openapi.yaml)
for the full OpenAPI spec of the agent-facing API.
