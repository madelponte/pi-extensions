# Pi MCP Bridge Extension

This extension discovers tools from one MCP server and registers them as Pi tools.

## Setup

1. Install npm dependencies from the committed lockfile:

   ```bash
   cd ~/.pi/agent/extensions/mcp-bridge
   npm ci
   ```

   Use `npm ci` on cloned/checkouted copies so the exact pinned dependency versions from `package-lock.json` are installed. Use `npm install` only when intentionally updating dependencies.

2. Copy the example config:

   ```bash
   cp config.json.example config.json
   ```

3. Edit `config.json` for your MCP server and make sure required environment variables are set, for example:

   ```bash
   export MCPTOKEN="your-token-here"
   ```

4. Restart Pi or run `/reload`.

## Updating dependencies

Dependencies are intentionally pinned in `package.json` and `package-lock.json` so new package releases do not silently change extension behavior.

To check for updates:

```bash
cd ~/.pi/agent/extensions/mcp-bridge
npm outdated
npm audit --omit=dev
```

To intentionally update a dependency, edit `package.json` or run `npm install <package>@<version>`, test the extension, then commit both `package.json` and `package-lock.json`.

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
