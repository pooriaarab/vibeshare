# Setup

How to install vibeshare-live and wire up its MCP server on macOS, Windows, and Linux.

## What you need

- Node.js 18 or newer (`node --version` to check).
- An agentic coding CLI or Claude Desktop, if you want the MCP server.

vibeshare-live lets you share a live coding session by URL.

## Install

You don't have to install anything. `npx` runs the latest published version:

```
npx vibeshare-live --help
```

To get a persistent `vibeshare` command, install it globally:

```
npm install -g vibeshare-live
```

## MCP setup

The MCP server lets an agent drive vibeshare through tool calls instead of a terminal.
The server has a dedicated `vibeshare-mcp` binary. (`vibeshare mcp` also works if you prefer the subcommand.)

### Claude Code (all platforms)

One command, no file editing:

```
# macOS and Linux
claude mcp add vibeshare -- npx -y -p vibeshare-live@latest vibeshare-mcp

# Windows
claude mcp add vibeshare -- cmd /c npx -y -p vibeshare-live@latest vibeshare-mcp
```

### Claude Desktop (editing the config file)

Open the config file, add the `vibeshare` block, then fully quit and reopen Claude.

**macOS** — `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "vibeshare": { "command": "npx", "args": ["-y", "-p", "vibeshare-live@latest", "vibeshare-mcp"] }
  }
}
```

**Linux** — `~/.config/Claude/claude_desktop_config.json`: same as macOS.

**Windows** — `%APPDATA%\Claude\claude_desktop_config.json` (paste that into the
Explorer address bar, open with Notepad):

```json
{
  "mcpServers": {
    "vibeshare": {
      "command": "cmd",
      "args": ["/c", "npx", "-y", "-p", "vibeshare-live@latest", "vibeshare-mcp"]
    }
  }
}
```

### Two things that break MCP on Windows

Most "MCP failed" or "not connected" reports on Windows come down to one of these.

1. **`"command": "npx"` on its own doesn't work.** Windows can't run `npx`
   directly, so the server never starts. Wrap it: `"command": "cmd"` with
   `"args": ["/c", "npx", ...]`. macOS and Linux don't need this.
2. **A stale cached version.** `npx` caches packages, so it can keep serving an
   old build. `vibeshare-live@latest` forces the current release.

## Check it works

```
vibeshare --version
```

If the MCP server won't connect, run `npx -y -p vibeshare-live@latest vibeshare-mcp` in a terminal on its own.
It should start and wait for input rather than exiting straight away.
