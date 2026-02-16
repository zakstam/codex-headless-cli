# zz

A lightweight terminal interface for conversational [Codex](https://openai.com/index/openai-codex/) sessions. Single-shot queries or interactive REPL, with streaming output, animated reasoning display, command approval, and configurable sandboxing.

## Prerequisites

- **Node.js** >= 18
- **Codex CLI** binary installed and on your `PATH` ([install instructions](https://github.com/openai/codex))

## Install

```sh
git clone https://github.com/zakstam/codex-headless-cli.git && cd codex-headless-cli && npm install && npm run build && npm link
```

This makes `zz` available globally. On first run it launches a setup wizard.

## Usage

### Interactive REPL

```sh
zz
```

Opens a conversational session. Commands inside the REPL:

| Command      | Action                          |
|--------------|---------------------------------|
| `/help`      | Show available commands         |
| `/interrupt` | Interrupt the current turn      |
| `/exit`      | Exit the REPL                   |
| `i`          | Interrupt current turn          |
| `Ctrl+C`     | Interrupt current turn, or exit |

### Single-shot query

```sh
zz list all TypeScript files in this project
```

Runs the query, streams the response, then exits.

### Re-run setup wizard

```sh
zz --setup
```

## Configuration

Stored at `~/.config/zz/config.json`. Created automatically on first run or with `--setup`.

```jsonc
{
  "model": "o3-mini",              // model name (fetched from codex on setup)
  "approvalMode": "prompt",        // "auto-approve" | "prompt" | "deny"
  "sandbox": "workspace-write",    // "read-only" | "workspace-write" | "full-access"
  "reasoningOnly": false,          // true = show thinking, omit response text
  "codexBin": ""                   // custom path to codex binary (optional)
}
```

### Options

| Field           | Values                                              | Description                                                        |
|-----------------|-----------------------------------------------------|--------------------------------------------------------------------|
| `model`         | Any model returned by `codex model/list`            | Which model to use. The wizard fetches the list from codex.        |
| `approvalMode`  | `prompt`, `auto-approve`, `deny`                    | How to handle command/file-change approval requests.               |
| `sandbox`       | `read-only`, `workspace-write`, `full-access`       | Sandbox restrictions. Use `full-access` for GUI apps or system commands. |
| `reasoningOnly` | `true`, `false`                                     | Show only the model's reasoning, suppress the response text.       |
| `codexBin`      | file path                                           | Override the path to the `codex` binary.                           |

## Development

```sh
npm run dev          # run with tsx --watch (auto-reload)
npm run start        # run once via tsx
npm run build        # compile to dist/
```

## How it works

zz wraps `CodexLocalBridge` from [`@zakstam/codex-local-component`](https://www.npmjs.com/package/@zakstam/codex-local-component), which spawns `codex app-server` as a child process and communicates over JSON-RPC on stdin/stdout. The CLI handles the protocol lifecycle (initialize, thread start, turn management) and renders events to the terminal:

- **Reasoning** is displayed as an animated single-line status that replaces itself as new thoughts arrive
- **Response text** streams directly to stdout
- **Command output** (stdout/stderr from executed commands) streams in dim text
- **Approval requests** show the command/file details and prompt for confirmation (or auto-approve/deny per config)
