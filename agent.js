#!/usr/bin/env node
/**
 * agent.js — Codex-style agentic loop using chatgpt.com via chatgpt.js daemon
 *
 * Usage:
 *   node agent.js [options] "task description"
 *
 * Options:
 *   --files  f1,f2,...   Comma-separated files to include as context (relative to --cwd)
 *   --run    "cmd"       Shell command to run after applying changes (e.g. "go test ./...")
 *   --cwd    /path       Working directory (default: process.cwd())
 *   --auto               Apply file changes without confirmation prompts
 *
 * Example:
 *   node agent.js --files cmd/api/users.go --run "go build ./..." \
 *     "add input validation to createUserHandler"
 */

'use strict';

const { spawnSync } = require('child_process');
const fs            = require('fs');
const path          = require('path');
const readline      = require('readline');

const SCRIPT = path.join(__dirname, 'chatgpt.js');

// ─── CLI parsing ───────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { files: [], run: null, cwd: process.cwd(), auto: false, task: null };
  for (let i = 0; i < argv.length; i++) {
    if      (argv[i] === '--files') args.files = argv[++i].split(',').map(s => s.trim());
    else if (argv[i] === '--run')   args.run   = argv[++i];
    else if (argv[i] === '--cwd')   args.cwd   = argv[++i];
    else if (argv[i] === '--auto')  args.auto  = true;
    else                            args.task  = argv[i];
  }
  return args;
}

// ─── ChatGPT call ─────────────────────────────────────────────────────────────

function ask(prompt, isNew = false) {
  const flags = [];
  if (isNew) flags.push('--new');
  flags.push(prompt);

  const result = spawnSync('node', [SCRIPT, ...flags], {
    encoding:  'utf8',
    timeout:   300_000,
    maxBuffer: 10 * 1024 * 1024,
  });
  return (result.stdout || '').trim() || (result.stderr || '').trim() || '(no response)';
}

// ─── Build initial prompt ─────────────────────────────────────────────────────

function buildInitialPrompt(task, files, cwd) {
  let prompt = '';

  if (files.length > 0) {
    prompt += `Here are the relevant files:\n\n`;
    for (const f of files) {
      const fullPath = path.isAbsolute(f) ? f : path.join(cwd, f);
      const content  = fs.readFileSync(fullPath, 'utf8');
      prompt += `===FILE: ${f}===\n${content}\n===ENDFILE===\n\n`;
    }
  }

  prompt +=
    `Task: ${task}\n\n` +
    `Instructions:\n` +
    `- For each file you want to create or modify, output the COMPLETE new file content ` +
    `using EXACTLY this plain-text format (no markdown code fences):\n` +
    `===FILE: path/to/file.go===\n` +
    `<complete file content here>\n` +
    `===ENDFILE===\n` +
    `- Use the full relative path from the project root.\n` +
    `- Output ONLY files that actually need to change.\n` +
    `- After the file blocks, briefly explain what you changed and why.`;

  return prompt;
}

// ─── Parse file blocks from response ─────────────────────────────────────────
// Looks for plain-text delimiters that survive ChatGPT's DOM rendering:
//   ===FILE: path/to/file===
//   <content>
//   ===ENDFILE===

function parseFileBlocks(response) {
  const changes = [];
  const regex   = /===FILE:\s*([^\n=]+)===\n([\s\S]*?)===ENDFILE===/g;
  let match;
  while ((match = regex.exec(response)) !== null) {
    changes.push({ path: match[1].trim(), content: match[2] });
  }
  return changes;
}

// ─── User input helper ────────────────────────────────────────────────────────

function askUser(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, ans => { rl.close(); resolve(ans.trim()); }));
}

// ─── Apply changes to disk ────────────────────────────────────────────────────

async function applyChanges(changes, cwd, auto) {
  if (changes.length === 0) {
    console.log('\n(no file changes detected in response)');
    return;
  }

  for (const change of changes) {
    const fullPath = path.isAbsolute(change.path)
      ? change.path
      : path.join(cwd, change.path);

    console.log(`\n─── ${change.path} (${change.content.split('\n').length} lines) ───`);

    let apply = 'y';
    if (!auto) {
      // Show a short preview
      const preview = change.content.split('\n').slice(0, 20).join('\n');
      const truncated = change.content.split('\n').length > 20;
      console.log(preview + (truncated ? '\n  ...(truncated, type "show" to see all)' : ''));

      apply = await askUser('Apply? [y/n/show] ');
      if (apply === 'show') {
        console.log('\n' + change.content);
        apply = await askUser('Apply? [y/n] ');
      }
    }

    if (apply === 'y' || apply === '') {
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, change.content);
      console.log(`  ✓ Written: ${change.path}`);
    } else {
      console.log(`  ✗ Skipped: ${change.path}`);
    }
  }
}

// ─── Run shell command ────────────────────────────────────────────────────────

function runCommand(cmd, cwd) {
  console.log(`\n$ ${cmd}`);
  const result = spawnSync(cmd, { shell: true, encoding: 'utf8', cwd });
  const output = (result.stdout + result.stderr).trim();
  console.log(output || '(no output)');
  return output;
}

// ─── Main loop ────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.task) {
    console.error(
      'Usage: node agent.js [--files f1,f2] [--run "cmd"] [--cwd /path] [--auto] "task"\n' +
      'Example: node agent.js --files cmd/api/users.go --run "go build ./..." ' +
      '"add validation to createUserHandler"'
    );
    process.exit(1);
  }

  console.log(`\nTask : ${args.task}`);
  if (args.files.length) console.log(`Files: ${args.files.join(', ')}`);
  if (args.run)          console.log(`Run  : ${args.run}`);
  console.log('');

  // ── Turn 1 ────────────────────────────────────────────────────────────────
  const initialPrompt = buildInitialPrompt(args.task, args.files, args.cwd);
  console.log('Sending to ChatGPT...\n');
  let response = ask(initialPrompt, /* isNew= */ true);

  console.log('── ChatGPT ──────────────────────────────────────────────\n');
  console.log(response);
  console.log('\n─────────────────────────────────────────────────────────');

  let changes = parseFileBlocks(response);
  await applyChanges(changes, args.cwd, args.auto);

  let cmdOutput = '';
  if (args.run && changes.length > 0) {
    cmdOutput = runCommand(args.run, args.cwd);
  }

  // ── Continue loop ──────────────────────────────────────────────────────────
  while (true) {
    const next = await askUser('\nNext step (or "done"): ');
    if (!next || next.toLowerCase() === 'done') break;

    // Prepend command output if available so ChatGPT sees the result
    const followUp = cmdOutput
      ? `Command output:\n\`\`\`\n${cmdOutput}\n\`\`\`\n\n${next}`
      : next;
    cmdOutput = '';

    console.log('\nSending to ChatGPT...\n');
    response = ask(followUp, /* isNew= */ false);

    console.log('── ChatGPT ──────────────────────────────────────────────\n');
    console.log(response);
    console.log('\n─────────────────────────────────────────────────────────');

    changes = parseFileBlocks(response);
    await applyChanges(changes, args.cwd, args.auto);

    if (args.run && changes.length > 0) {
      cmdOutput = runCommand(args.run, args.cwd);
    }
  }

  console.log('\nDone.');
}

main().catch(err => { console.error(err); process.exit(1); });
