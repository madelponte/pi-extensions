# Pi MCP Bridge Extension

This extension discovers tools from one MCP server and registers them as Pi tools.

## Setup

1. Copy the example config:

   ```bash
   cp ~/.pi/agent/extensions/mcp-bridge/config.json.example ~/.pi/agent/extensions/mcp-bridge/config.json
   ```

2. Edit `config.json` for your MCP server.

3. Restart Pi or run `/reload`.

## Tool prefix

Set `prefix` to match the prefix used in your existing tool docs. For example:

```json
"prefix": "mcp"
```

A server tool named `web_search` will be exposed to the model as `mcp_web_search`.

## Disabling or allowing tools

Disable specific tools by server name or exposed name:

```json
"disabledTools": ["stock_data", "mcp_stock_data"]
```

Alternatively, expose only an explicit allow-list:

```json
"allowedTools": ["web_search", "page_fetch"]
```

If `allowedTools` is non-empty, all other tools are hidden. `disabledTools` still wins.

## Commands

- `/mcp-tools` lists discovered tools and whether they are enabled.
- `/mcp-reload` reloads Pi extensions after editing `config.json`.

## Supported transports

- `stdio`:

  ```json
  {
    "server": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/server.js"],
      "env": { "API_KEY": "$API_KEY" }
    }
  }
  ```

- `http` / `sse`:

  ```json
  {
    "server": {
      "type": "http",
      "url": "http://localhost:3000/mcp",
      "headers": { "Authorization": "Bearer $MCP_TOKEN" }
    }
  }
  ```
