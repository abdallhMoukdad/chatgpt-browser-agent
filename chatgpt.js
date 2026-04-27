#!/usr/bin/env node
/**
 * chatgpt.js — Codex-style CLI backed by chatgpt.com
 *
 * Setup (first time):
 *   node chatgpt.js --login
 *
 * Usage:
 *   node chatgpt.js "your prompt"
 *   node chatgpt.js --code "write fizzbuzz in Go"
 *   node chatgpt.js --file src/main.go "add error handling"
 *   node chatgpt.js --git "write a commit message for my changes"
 *   node chatgpt.js --context "we use Fiber v2 + PostgreSQL" "add auth middleware"
 *   cat error.log | node chatgpt.js "what is wrong and how do I fix it"
 *   git diff | node chatgpt.js --code "review and suggest improvements"
 */

const { addExtra }   = require('puppeteer-extra');
const puppeteerCore  = require('puppeteer-core');
const StealthPlugin  = require('puppeteer-extra-plugin-stealth');
const path           = require('path');
const os             = require('os');
const fs             = require('fs');
const readline       = require('readline');
const { execSync }   = require('child_process');

const puppeteer = addExtra(puppeteerCore);
puppeteer.use(StealthPlugin());

const CHROME_PATH      = '/usr/bin/google-chrome';
const PROFILE_DIR      = path.join(os.homedir(), '.chatgpt-poc-profile');
const CHATGPT_URL      = 'https://chatgpt.com';
const RESPONSE_TIMEOUT = 120_000;

// ─── System prompt ───────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `\
You are a senior software engineer acting as a coding assistant.
Rules:
- Be concise. Code over explanation.
- Write complete, working, production-quality code.
- Match the language, style, and patterns of any provided code or context.
- When fixing code show only the corrected version, no before/after commentary.
- No disclaimers, caveats, or filler text.
- If the task is ambiguous, pick the most reasonable interpretation and go.
---
`;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function readStdin() {
  return new Promise(resolve => {
    if (process.stdin.isTTY) return resolve(null);
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => (data += chunk));
    process.stdin.on('end', () => resolve(data.trim() || null));
  });
}

function readFile(filePath) {
  const abs = path.resolve(filePath);
  if (!fs.existsSync(abs)) throw new Error(`File not found: ${abs}`);
  return fs.readFileSync(abs, 'utf8');
}

function getGitContext() {
  const run = cmd => { try { return execSync(cmd, { encoding: 'utf8' }).trim(); } catch { return ''; } };
  const branch = run('git branch --show-current');
  const status = run('git status --short');
  const diff   = run('git diff HEAD');
  if (!branch && !status && !diff) throw new Error('Not inside a git repository or no changes found.');
  let out = '';
  if (branch)  out += `Branch: ${branch}\n`;
  if (status)  out += `\nStatus:\n${status}\n`;
  if (diff)    out += `\nDiff:\n${diff}\n`;
  return out;
}

function extractCodeBlocks(text) {
  const blocks = [];
  const re = /```[\w]*\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(text)) !== null) blocks.push(m[1].trimEnd());
  return blocks.length > 0 ? blocks.join('\n\n') : text; // fallback to full text
}

function buildFullPrompt({ userPrompt, stdinData, fileData, gitData, contextData }) {
  let parts = [SYSTEM_PROMPT];

  if (contextData) parts.push(`Context:\n${contextData}\n`);
  if (gitData)     parts.push(`Git context:\n${gitData}\n`);
  if (fileData)    parts.push(`File content:\n\`\`\`\n${fileData}\n\`\`\`\n`);
  if (stdinData)   parts.push(`Input:\n\`\`\`\n${stdinData}\n\`\`\`\n`);

  parts.push(`Task: ${userPrompt}`);
  return parts.join('\n');
}

// ─── Browser ─────────────────────────────────────────────────────────────────

function launchBrowser(headless) {
  return puppeteer.launch({
    executablePath: CHROME_PATH,
    userDataDir: PROFILE_DIR,
    headless,
    args: [
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-blink-features=AutomationControlled',
      '--disable-extensions-except=',
    ],
    defaultViewport: null,
  });
}

function waitForEnter(message) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(message, () => { rl.close(); resolve(); });
  });
}

// ─── Commands ────────────────────────────────────────────────────────────────

async function login() {
  console.log('[*] Opening Chrome for login...');
  const browser = await launchBrowser(false);
  const page = await browser.newPage();
  await page.goto(CHATGPT_URL, { waitUntil: 'networkidle2', timeout: 30_000 });
  console.log('');
  console.log('  Log in to chatgpt.com in the Chrome window that just opened.');
  console.log('  When you are fully logged in and see the chat interface,');
  await waitForEnter('  press Enter here to save the session and close Chrome: ');
  await browser.close();
  console.log('[*] Session saved. You can now run:');
  console.log('      node chatgpt.js "your prompt here"');
}

async function ask({ fullPrompt, codeOnly }) {
  console.log('[*] Launching Chrome...');
  const browser = await launchBrowser(false);
  const page = await browser.newPage();

  try {
    console.log('[*] Navigating to chatgpt.com...');
    await page.goto(CHATGPT_URL, { waitUntil: 'networkidle2', timeout: 30_000 });

    // Detect logged-out state
    const isLoggedOut = await page.evaluate(() => {
      const hasLoginBtn = [...document.querySelectorAll('button, a')]
        .some(el => ['Log in', 'Sign in'].includes(el.textContent.trim()));
      const hasInput = !!document.querySelector('#prompt-textarea');
      return hasLoginBtn && !hasInput;
    });

    if (isLoggedOut) {
      console.error('\n[!] Not logged in. Run first:\n      node chatgpt.js --login\n');
      await browser.close();
      process.exit(1);
    }

    // Fresh chat
    await page.goto(CHATGPT_URL, { waitUntil: 'networkidle2', timeout: 30_000 });
    const inputSelector = '#prompt-textarea';
    await page.waitForSelector(inputSelector, { timeout: 15_000 });

    console.log('[*] Sending prompt...');
    await page.click(inputSelector);

    // Type in chunks to avoid browser input limits choking on large pastes
    const CHUNK = 500;
    for (let i = 0; i < fullPrompt.length; i += CHUNK) {
      await page.keyboard.type(fullPrompt.slice(i, i + CHUNK), { delay: 5 });
    }
    await page.keyboard.press('Enter');

    console.log('[*] Waiting for response...');

    // Wait for streaming start
    await page.waitForFunction(
      () => [...document.querySelectorAll('button')].some(
        b => b.getAttribute('data-testid') === 'stop-button' ||
             b.textContent.trim() === 'Stop streaming'
      ),
      { timeout: 15_000 }
    ).catch(() => {});

    // Wait for streaming end
    await page.waitForFunction(
      () => ![...document.querySelectorAll('button')].some(
        b => b.getAttribute('data-testid') === 'stop-button' ||
             b.textContent.trim() === 'Stop streaming'
      ),
      { timeout: RESPONSE_TIMEOUT }
    );

    await new Promise(r => setTimeout(r, 500));

    const raw = await page.evaluate(() => {
      const msgs = document.querySelectorAll('[data-message-author-role="assistant"]');
      if (msgs.length > 0) return msgs[msgs.length - 1].innerText.trim();
      const blocks = document.querySelectorAll('.markdown, .prose');
      if (blocks.length > 0) return blocks[blocks.length - 1].innerText.trim();
      return null;
    });

    if (!raw) throw new Error('Could not extract response from page');

    const output = codeOnly ? extractCodeBlocks(raw) : raw;

    console.log('\n--- RESPONSE ---');
    console.log(output);
    console.log('--- END ---\n');

    return output;

  } finally {
    await browser.close();
  }
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = { login: false, codeOnly: false, file: null, git: false, context: null, prompt: [] };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--login':   opts.login   = true;          break;
      case '--code':    opts.codeOnly = true;          break;
      case '--git':     opts.git     = true;           break;
      case '--file':    opts.file    = args[++i];      break;
      case '--context': opts.context = args[++i];      break;
      default:          opts.prompt.push(args[i]);
    }
  }
  return opts;
}

function printHelp() {
  console.log(`
Usage:
  node chatgpt.js --login                              # first-time setup
  node chatgpt.js "prompt"                             # ask anything
  node chatgpt.js --code "write fizzbuzz in Go"        # extract code only
  node chatgpt.js --file <path> "prompt"               # attach a file
  node chatgpt.js --git "write a commit message"       # attach git context
  node chatgpt.js --context "we use Fiber v2" "prompt" # inline context
  cat error.log | node chatgpt.js "what is wrong"      # pipe input
  git diff | node chatgpt.js --code "review this"      # pipe + code mode
`);
}

(async () => {
  const opts = parseArgs(process.argv);

  if (opts.login) {
    await login().catch(err => { console.error('[ERROR]', err.message); process.exit(1); });
    return;
  }

  if (opts.prompt.length === 0) {
    printHelp();
    process.exit(1);
  }

  const userPrompt = opts.prompt.join(' ');
  const stdinData  = await readStdin();
  const fileData   = opts.file    ? readFile(opts.file)   : null;
  const gitData    = opts.git     ? getGitContext()        : null;
  const contextData = opts.context || null;

  const fullPrompt = buildFullPrompt({ userPrompt, stdinData, fileData, gitData, contextData });

  await ask({ fullPrompt, codeOnly: opts.codeOnly })
    .catch(err => { console.error('[ERROR]', err.message); process.exit(1); });
})();
