# chatgpt-browser-agent

A persistent browser daemon that routes prompts to **chatgpt.com** — no API key required.
Includes a CLI, an MCP server for coding agents (OpenCode, Claude Desktop, etc.), and a
Codex-style agentic loop that can explore and edit your codebase autonomously.

---

> ⚠️ **Disclaimer**
> This project automates a browser session on chatgpt.com and is **not affiliated with or
> endorsed by OpenAI**. Automated access may violate [ChatGPT's Terms of Service](https://openai.com/policies/terms-of-use).
> Your account may be rate-limited or banned. Use at your own risk, for personal/research
> purposes only. Do not use this to build hosted services or to resell ChatGPT access.

---

## How it works

```
┌─────────────────────────────────────────────────────┐
│  chatgpt.js client  ──────► HTTP ──────► daemon     │
│                                          (Puppeteer) │
│  mcp-server.js      ──────► spawns ───► chatgpt.js  │
│  (JSON-RPC stdio)                                    │
│                                                      │
│  agent.js           ──────► spawns ───► chatgpt.js  │
│  (agentic loop)      ◄────── ===RUN=== / ===FILE=== │
└─────────────────────────────────────────────────────┘
```

- **Daemon** — Chrome runs once and stays alive. No cold-start per call (~5–25 s response time).
- **CLI** — `chatgpt.js` sends prompts, attaches files, pipes git diffs.
- **MCP server** — `mcp-server.js` exposes `chatgpt_ask`, `chatgpt_status`, `chatgpt_stop` as
  MCP tools so any MCP-compatible coding agent can call ChatGPT as a tool.
- **Agent loop** — `agent.js` lets ChatGPT drive a codebase exploration + edit loop using
  `===RUN===` (shell commands) and `===FILE===` (file writes) blocks.

---

## Features

- ✅ Persistent browser daemon — fast after the first call
- ✅ Full conversation continuity (`--new` to reset)
- ✅ File upload via attachment button (`--upload`)
- ✅ Save response to disk (`--save`)
- ✅ Git diff/status as context (`--git`)
- ✅ Pipe stdin as input
- ✅ Code-only extraction (`--code`)
- ✅ MCP server for OpenCode / Claude Desktop / any MCP client
- ✅ Agentic loop: ChatGPT explores repo with shell commands, proposes file edits
- ✅ 60 s dedup cache to prevent model loop-calling

---

## Prerequisites

| Requirement | Notes |
|---|---|
| **Node.js** ≥ 18 | |
| **Google Chrome** | Stable channel. On Linux: `/usr/bin/google-chrome` |
| **ChatGPT account** | Free or Plus. Plus gives higher rate limits. |

> **Chrome path** — The daemon defaults to `/usr/bin/google-chrome` (Linux).
> Edit the `CHROME_PATH` constant at the top of `chatgpt.js` for macOS
> (`/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`) or Windows.

---

## Installation

```bash
git clone https://github.com/abdallhMoukdad/chatgpt-browser-agent.git
cd chatgpt-browser-agent
npm install
```

---

## First-time setup (login)

The daemon needs a persistent Chrome profile with an active ChatGPT session.
Run this **once**:

```bash
node chatgpt.js --login
```

A Chrome window opens. Log in to chatgpt.com normally. Once the chat interface
is visible, press **Enter** in the terminal. Your session is saved to
`~/.chatgpt-poc-profile/` and reused on every subsequent call.

---

## CLI usage

```bash
# Basic prompt (daemon auto-starts on first call, ~15 s)
node chatgpt.js "explain the difference between a mutex and a semaphore"

# Start a fresh conversation
node chatgpt.js --new "refactor this function to use early returns"

# Extract only code blocks from the response
node chatgpt.js --code "write a binary search in Go"

# Attach a file via the ChatGPT upload button
node chatgpt.js --upload ./schema.sql "generate CRUD queries for this schema"

# Save the response to a file
node chatgpt.js --save /tmp/answer.txt "summarize the SOLID principles"

# Attach git diff as context
node chatgpt.js --git "write a commit message for these changes"

# Inline context
node chatgpt.js --context "project uses Go 1.22 and chi router" "add rate limiting middleware"

# Pipe stdin
cat error.log | node chatgpt.js "what is causing this error?"

# Daemon management
node chatgpt.js --status
node chatgpt.js --stop
```

---

## MCP server (OpenCode / Claude Desktop)

The MCP server wraps the CLI as a JSON-RPC 2.0 stdio server, exposing three tools:

| Tool | Description |
|---|---|
| `chatgpt_ask` | Send a prompt; optional `file`, `context`, `git`, `newChat`, `codeOnly`, `savePath` |
| `chatgpt_status` | Check if the daemon is running |
| `chatgpt_stop` | Shut down the daemon |

### Register with OpenCode

Add to `~/.config/opencode/opencode.json`:

```json
{
  "mcp": {
    "chatgpt": {
      "type": "local",
      "command": "node",
      "args": ["/absolute/path/to/chatgpt-browser-agent/mcp-server.js"]
    }
  }
}
```

### Register with Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS):

```json
{
  "mcpServers": {
    "chatgpt": {
      "command": "node",
      "args": ["/absolute/path/to/chatgpt-browser-agent/mcp-server.js"]
    }
  }
}
```

Once registered, your coding agent can call `chatgpt_ask` as a tool — useful for:
- Getting a second opinion from a different model
- Research / knowledge questions that don't need codebase context
- Offloading heavy tasks to preserve your primary model's token budget

---

## Agentic loop (`agent.js`)

`agent.js` gives ChatGPT autonomous access to your codebase. It reads
`===RUN===` and `===FILE===` blocks from ChatGPT's responses and acts on them:

- `===RUN: <command>===` — runs the shell command and feeds output back automatically
- `===FILE: path/to/file===` … `===ENDFILE===` — writes the file (with approval prompt unless `--auto`)

### Usage

```bash
node agent.js [--files f1,f2] [--check "cmd"] [--cwd /path] [--auto] "task"
```

| Flag | Description |
|---|---|
| `--files f1,f2` | Seed files to include upfront (optional — ChatGPT can discover files itself) |
| `--check "cmd"` | Run this command after each file write (e.g. `go build ./...`). On failure, output is sent back to ChatGPT for self-correction. |
| `--cwd /path` | Working directory for commands and file paths |
| `--auto` | Skip y/n approval prompts for file writes |

### Example

```bash
node agent.js \
  --check "go build ./..." \
  --cwd ~/myproject \
  "add input validation to the createUserHandler in cmd/api/handlers_users.go"
```

ChatGPT will autonomously:
1. Run `find . -name '*.go'` to discover files
2. Run `cat cmd/api/handlers_users.go` to read the relevant file
3. Propose the edited file using `===FILE===` blocks
4. The agent writes the file and runs `go build ./...`
5. If the build fails, the error is sent back and ChatGPT self-corrects

Maximum 20 autonomous turns (configurable via `MAX_TURNS`).

### ⚠️ Safety notes

- Shell commands from `===RUN===` blocks are executed **automatically** without confirmation.
  Review what ChatGPT is doing — do not run on sensitive systems unattended.
- File writes outside `--cwd` are possible if ChatGPT uses absolute paths. Review before using `--auto`.
- Do not pass files containing secrets or credentials as context.

---

## Architecture notes

- The daemon uses a **random OS-assigned port** written to `~/.chatgpt-poc-daemon.json`
- Session URL is persisted to `~/.chatgpt-poc-session` for conversation continuity
- Daemon logs go to `~/.chatgpt-poc-daemon.log`
- Requests are serialized — ChatGPT is one-at-a-time; concurrent calls get a 503
- `puppeteer-extra-plugin-stealth` is required to pass Cloudflare's bot detection
- File upload uses **CDP `uploadFile()`** directly on `#upload-files` input — no native file picker needed
- Submit uses `page.keyboard.press('Enter')` — more reliable than clicking the send button when files are attached

---

## Limitations

- **Not an official API** — may break when ChatGPT's UI changes
- **One request at a time** — the browser is single-threaded
- **Response time** — 5–25 s depending on ChatGPT's load
- **Rate limits** — ChatGPT Plus limits GPT-4o usage; free tier is more restricted
- **Indentation** — ChatGPT's DOM renders code blocks without leading whitespace; run a formatter (e.g. `gofmt`, `prettier`) after `agent.js` writes files
- **Headless mode** — not supported yet; Chrome runs visibly (required for Cloudflare bypass)

---

## License

MIT — see [LICENSE](LICENSE).

Not affiliated with OpenAI. "ChatGPT" is a trademark of OpenAI.
