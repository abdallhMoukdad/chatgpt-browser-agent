#!/usr/bin/env node
/**
 * mcp-server.js — MCP stdio server wrapping the chatgpt daemon
 *
 * Registered in ~/.config/opencode/opencode.json so the chatgpt tools
 * appear in OpenCode's MCP tools panel alongside other MCP servers.
 *
 * Protocol: JSON-RPC 2.0 over stdin/stdout (MCP stdio transport).
 */

'use strict';

const { spawnSync } = require('child_process');
const readline      = require('readline');
const path          = require('path');

const SCRIPT = path.join(__dirname, 'chatgpt.js');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

/**
 * Run chatgpt.js with the given args array.
 * Returns trimmed stdout (+ stderr on error).
 */
function runChatgpt(args) {
  const result = spawnSync('node', [SCRIPT, ...args], {
    encoding:  'utf8',
    timeout:   180_000,
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.error) return `Error: ${result.error.message}`;
  const out = (result.stdout || '').trim();
  const err = (result.stderr || '').trim();
  return out || err || '(no output)';
}

// ─── Tool definitions ─────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'chatgpt_ask',
    description:
      'Ask ChatGPT a question via chatgpt.com using a persistent browser. ' +
      'Useful as a second opinion or when the main model\'s knowledge may be stale. ' +
      'The daemon auto-starts on first use and stays alive between calls.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'The question or task to send to ChatGPT',
        },
        codeOnly: {
          type: 'boolean',
          description: 'If true, extract only code blocks from the response',
        },
        context: {
          type: 'string',
          description: 'Additional context to prepend to the prompt',
        },
        git: {
          type: 'boolean',
          description: 'If true, attach git diff/log from the current working directory as context',
        },
        newChat: {
          type: 'boolean',
          description: 'If true, start a fresh conversation instead of continuing the last one',
        },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'chatgpt_status',
    description: 'Check whether the ChatGPT browser daemon is currently running.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'chatgpt_stop',
    description: 'Shut down the ChatGPT browser daemon and close the browser.',
    inputSchema: { type: 'object', properties: {} },
  },
];

// ─── Request dispatcher ───────────────────────────────────────────────────────

function handleRequest(req) {
  const { id, method, params } = req;

  // ── Lifecycle ──────────────────────────────────────────────────────────────
  if (method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: (params && params.protocolVersion) || '2024-11-05',
        capabilities:   { tools: {} },
        serverInfo:     { name: 'chatgpt', version: '1.0.0' },
      },
    });
    return;
  }

  // Notification — no response required
  if (method === 'notifications/initialized') return;

  // ── Tool discovery ─────────────────────────────────────────────────────────
  if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    return;
  }

  // ── Tool invocation ────────────────────────────────────────────────────────
  if (method === 'tools/call') {
    const name = params && params.name;
    const args = (params && params.arguments) || {};

    if (name === 'chatgpt_status') {
      const text = runChatgpt(['--status']);
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } });
      return;
    }

    if (name === 'chatgpt_stop') {
      const text = runChatgpt(['--stop']);
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } });
      return;
    }

    if (name === 'chatgpt_ask') {
      const flags = [];
      if (args.newChat)  flags.push('--new');
      if (args.codeOnly) flags.push('--code');
      if (args.git) {
        flags.push('--git');
        // process.cwd() is the directory OpenCode was launched from — correct for git ops
        flags.push('--cwd', process.cwd());
      }
      if (args.context)  flags.push('--context', args.context);
      flags.push(args.prompt);

      const text = runChatgpt(flags);
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } });
      return;
    }

    send({
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `Unknown tool: ${name}` },
    });
    return;
  }

  // Unknown method — only respond if it was a request (has id)
  if (id !== undefined) {
    send({
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `Method not found: ${method}` },
    });
  }
}

// ─── stdin loop ───────────────────────────────────────────────────────────────

const rl = readline.createInterface({ input: process.stdin, terminal: false });

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let req;
  try {
    req = JSON.parse(trimmed);
  } catch {
    send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  handleRequest(req);
});

// Keep the process alive waiting for stdin
process.stdin.resume();
