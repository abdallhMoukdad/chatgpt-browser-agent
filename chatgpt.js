#!/usr/bin/env node
/**
 * chatgpt.js — Fast persistent-browser Codex-style CLI backed by chatgpt.com
 *
 * The browser runs as a background daemon so the launch/navigation overhead
 * only happens once. Subsequent calls take ~2-5s (ChatGPT response time only).
 *
 * Setup (first time):
 *   node chatgpt.js --login
 *
 * Usage:
 *   node chatgpt.js "prompt"                              # continue last chat
 *   node chatgpt.js --new "prompt"                        # start fresh chat
 *   node chatgpt.js --code "write fizzbuzz in Go"         # extract code only
 *   node chatgpt.js --file <path> "prompt"                # attach a file
 *   node chatgpt.js --git "write a commit message"        # attach git context
 *   node chatgpt.js --context "we use Fiber v2" "prompt"  # inline context
 *   cat error.log | node chatgpt.js "what is wrong"       # pipe input
 *   node chatgpt.js --status                              # check daemon
 *   node chatgpt.js --stop                                # kill daemon
 */

const { addExtra }        = require('puppeteer-extra');
const puppeteerCore       = require('puppeteer-core');
const StealthPlugin       = require('puppeteer-extra-plugin-stealth');
const path                = require('path');
const os                  = require('os');
const fs                  = require('fs');
const http                = require('http');
const readline            = require('readline');
const { execSync, spawn } = require('child_process');

const puppeteer = addExtra(puppeteerCore);
puppeteer.use(StealthPlugin());

// ─── Constants ────────────────────────────────────────────────────────────────

const CHROME_PATH      = '/usr/bin/google-chrome';
const PROFILE_DIR      = path.join(os.homedir(), '.chatgpt-poc-profile');
const SESSION_FILE     = path.join(os.homedir(), '.chatgpt-poc-session');
const DAEMON_FILE      = path.join(os.homedir(), '.chatgpt-poc-daemon.json');
const DAEMON_LOG       = path.join(os.homedir(), '.chatgpt-poc-daemon.log');
const CHATGPT_URL      = 'https://chatgpt.com';
const RESPONSE_TIMEOUT = 300_000; // 5 min — file analysis can be slow

// ─── System prompt ────────────────────────────────────────────────────────────

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

// ─── Prompt builders ──────────────────────────────────────────────────────────

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

function getGitContext(cwd) {
  const run = cmd => { try { return execSync(cmd, { encoding: 'utf8', cwd }).trim(); } catch { return ''; } };
  const branch = run('git branch --show-current');
  const status = run('git status --short');
  const diff   = run('git diff HEAD');
  if (!branch && !status && !diff) throw new Error('Not inside a git repo or no changes found.');
  let out = '';
  if (branch) out += `Branch: ${branch}\n`;
  if (status) out += `\nStatus:\n${status}\n`;
  if (diff)   out += `\nDiff:\n${diff}\n`;
  return out;
}

function extractCodeBlocks(text) {
  const blocks = [];
  const re = /```[\w]*\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(text)) !== null) blocks.push(m[1].trimEnd());
  return blocks.length > 0 ? blocks.join('\n\n') : text;
}

function buildFullPrompt({ userPrompt, stdinData, fileData, gitData, contextData }) {
  const parts = [SYSTEM_PROMPT];
  if (contextData) parts.push(`Context:\n${contextData}\n`);
  if (gitData)     parts.push(`Git context:\n${gitData}\n`);
  if (fileData)    parts.push(`File content:\n\`\`\`\n${fileData}\n\`\`\`\n`);
  if (stdinData)   parts.push(`Input:\n\`\`\`\n${stdinData}\n\`\`\`\n`);
  parts.push(`Task: ${userPrompt}`);
  return parts.join('\n');
}

// ─── Browser helpers (daemon-side only) ───────────────────────────────────────

/**
 * Upload a local file to ChatGPT via direct CDP file-input injection.
 *
 * The ChatGPT composer always has a hidden <input id="upload-files"> in the DOM.
 * Puppeteer's uploadFile() uses the Chrome DevTools Protocol to set files on
 * the input element without needing a native file-picker dialog (which requires
 * a real user gesture and cannot be triggered programmatically in headless mode).
 * After setting the files via CDP we fire a synthetic change event so React's
 * event system picks up the new FileList and registers the attachment.
 */
async function uploadFileToChatGPT(page, uploadPath, log) {
  const abs = path.resolve(uploadPath);
  if (!fs.existsSync(abs)) throw new Error(`Upload file not found: ${abs}`);
  log(`Uploading file: ${abs}`);

  await page.bringToFront();

  // Wait for the hidden file input to be present in the DOM
  const inputHandle = await page.waitForSelector('#upload-files', { timeout: 8_000 });

  // CDP-level file injection — no dialog needed
  await inputHandle.uploadFile(abs);

  // Notify React that the input's FileList changed
  await page.evaluate(() => {
    const el = document.getElementById('upload-files');
    if (el) el.dispatchEvent(new Event('change', { bubbles: true }));
  });

  // Give ChatGPT's React handler a moment to process the file and render a preview
  await new Promise(r => setTimeout(r, 2_000));

  // ChatGPT may show a "You've already uploaded this file" warning dialog when
  // the same file has been uploaded recently.  Dismiss it so the flow continues.
  const dialog = await page.$('[role="dialog"]');
  if (dialog) {
    const dialogText = await page.evaluate(el => el.textContent.trim().slice(0, 120), dialog);
    log(`Dismissing dialog: "${dialogText}"`);
    const okBtn = await page.$('[role="dialog"] button');
    if (okBtn) await okBtn.click();
    await new Promise(r => setTimeout(r, 800));
  }

  log('Upload complete.');
}

function launchBrowser() {
  return puppeteer.launch({
    executablePath: CHROME_PATH,
    userDataDir: PROFILE_DIR,
    headless: false,
    args: [
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-blink-features=AutomationControlled',
      '--disable-extensions-except=',
    ],
    defaultViewport: null,
  });
}

// Single DOM operation — no keystroke simulation, no chunking, no delay.
// execCommand('insertText') is the fastest reliable way to fill a
// React-controlled contenteditable without breaking its event listeners.
async function fillTextarea(page, text) {
  await page.bringToFront();
  await page.waitForSelector('#prompt-textarea', { timeout: 10_000 });
  await page.click('#prompt-textarea');
  await page.evaluate(t => {
    const el = document.querySelector('#prompt-textarea');
    el.focus();
    document.execCommand('selectAll', false, null);
    document.execCommand('insertText', false, t);
  }, text);
}

async function waitForStreamingDone(page, log, beforeCount) {
  // beforeCount must be measured BEFORE the message is sent so we don't
  // accidentally measure it after ChatGPT has already started responding.
  // The caller passes it in; fall back to measuring now only for text-only paths.
  if (beforeCount === undefined) {
    beforeCount = await page.evaluate(
      () => document.querySelectorAll('[data-message-author-role="assistant"]').length
    );
  }
  log(`waitForStreamingDone: beforeCount=${beforeCount}`);

  // Phase 1 — wait for a new assistant message to appear (ChatGPT started replying).
  // polling:1000 reduces CDP round-trips on heavy pages and avoids
  // "Runtime.callFunctionOn timed out" errors that occur with the default 100ms poll.
  await page.waitForFunction(
    before => {
      const msgs = document.querySelectorAll('[data-message-author-role="assistant"]');
      if (msgs.length <= before) return false;
      // Also ensure the last message has at least some text
      return (msgs[msgs.length - 1].innerText || '').trim().length > 0;
    },
    { timeout: RESPONSE_TIMEOUT, polling: 1_000 },
    beforeCount
  ).catch(async err => {
    // On timeout, dump the DOM state to the log for debugging
    const dump = await page.evaluate(() => {
      const assistants = [...document.querySelectorAll('[data-message-author-role="assistant"]')]
        .map(el => el.innerText.trim().slice(0, 100));
      const allRoles = [...document.querySelectorAll('[data-message-author-role]')]
        .map(el => `${el.getAttribute('data-message-author-role')}: ${(el.innerText||'').trim().slice(0,80)}`);
      const buttons = [...document.querySelectorAll('button')].map(b => b.getAttribute('aria-label') || b.textContent.trim().slice(0,30)).filter(Boolean);
      const url = location.href;
      return { assistants, allRoles, buttons: buttons.slice(0,15), url };
    }).catch(() => ({ error: 'page.evaluate failed' }));
    log(`waitForStreamingDone TIMEOUT dump: ${JSON.stringify(dump)}`);
    throw err;
  });

  // Phase 2 — wait for the message to stop growing (streaming complete).
  // Three consecutive 600 ms checks with identical length = done.
  let lastLen = -1;
  let stableCount = 0;
  while (stableCount < 3) {
    await new Promise(r => setTimeout(r, 600));
    const len = await page.evaluate(() => {
      const msgs = document.querySelectorAll('[data-message-author-role="assistant"]');
      return msgs.length > 0 ? msgs[msgs.length - 1].innerText.length : 0;
    });
    if (len === lastLen && len > 0) stableCount++;
    else { lastLen = len; stableCount = 0; }
  }
}

async function extractLastAssistantMessage(page) {
  return page.evaluate(() => {
    const msgs = document.querySelectorAll('[data-message-author-role="assistant"]');
    if (msgs.length > 0) return msgs[msgs.length - 1].innerText.trim();
    const blocks = document.querySelectorAll('.markdown, .prose');
    if (blocks.length > 0) return blocks[blocks.length - 1].innerText.trim();
    return null;
  });
}

// ─── Daemon process ───────────────────────────────────────────────────────────

async function startDaemonProcess() {
  const logStream = fs.createWriteStream(DAEMON_LOG, { flags: 'a' });
  const log = msg => logStream.write(`[${new Date().toISOString()}] ${msg}\n`);

  log('Daemon starting...');

  let browser, page;
  try {
    browser = await launchBrowser();
    page    = await browser.newPage();

    const initUrl = fs.existsSync(SESSION_FILE)
      ? fs.readFileSync(SESSION_FILE, 'utf8').trim()
      : CHATGPT_URL;

    log(`Navigating to ${initUrl}`);
    await page.goto(
      initUrl.startsWith('https://chatgpt.com') ? initUrl : CHATGPT_URL,
      { waitUntil: 'networkidle2', timeout: 30_000 }
    );

    const loggedOut = await page.evaluate(() => {
      const hasLoginBtn = [...document.querySelectorAll('button, a')]
        .some(el => ['Log in', 'Sign in'].includes(el.textContent.trim()));
      const hasInput = !!document.querySelector('#prompt-textarea');
      return hasLoginBtn && !hasInput;
    });

    if (loggedOut) {
      log('ERROR: Not logged in. Run: node chatgpt.js --login');
      await browser.close();
      process.exit(1);
    }

    log('Browser ready and logged in.');
  } catch (err) {
    log(`Startup error: ${err.message}`);
    if (browser) await browser.close().catch(() => {});
    process.exit(1);
  }

  // Serialize requests — ChatGPT is one-at-a-time.
  let busy = false;

  const server = http.createServer(async (req, res) => {
    const send = (status, obj) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };

    if (req.method === 'GET' && req.url === '/status') {
      return send(200, { ok: true, pid: process.pid });
    }

    if (req.method === 'POST' && req.url === '/stop') {
      send(200, { ok: true });
      log('Shutting down...');
      server.close();
      await browser.close().catch(() => {});
      if (fs.existsSync(DAEMON_FILE)) fs.unlinkSync(DAEMON_FILE);
      process.exit(0);
    }

    if (req.method === 'POST' && req.url === '/ask') {
      if (busy) return send(503, { ok: false, error: 'Daemon busy — try again in a moment.' });
      busy = true;

      let body = '';
      req.on('data', chunk => (body += chunk));
      req.on('end', async () => {
        const { fullPrompt, codeOnly, newChat, uploadPath } = JSON.parse(body);
        log(`ask: newChat=${newChat} codeOnly=${codeOnly} upload=${uploadPath||'none'} len=${fullPrompt.length}`);

        try {
          const currentUrl = page.url();

          if (newChat) {
            log('Starting new chat...');
            await page.goto(CHATGPT_URL, { waitUntil: 'networkidle2', timeout: 30_000 });
          } else if (!currentUrl.startsWith('https://chatgpt.com')) {
            // Tab drifted (e.g. browser opened a link) — restore
            const sessionUrl = fs.existsSync(SESSION_FILE)
              ? fs.readFileSync(SESSION_FILE, 'utf8').trim()
              : CHATGPT_URL;
            log(`Restoring tab to ${sessionUrl}`);
            await page.goto(sessionUrl, { waitUntil: 'networkidle2', timeout: 30_000 });
          }
          // else: already on the right chat page, skip navigation entirely

          if (uploadPath) await uploadFileToChatGPT(page, uploadPath, log);

          await fillTextarea(page, fullPrompt);

          // If a file was uploaded, wait until the send button is enabled.
          // ChatGPT uploads the file to its servers in the background; the send
          // button stays disabled until that upload finishes.  Clicking a disabled
          // button does nothing, which is what caused the previous silent failures.
          if (uploadPath) {
            log('Waiting for send button to become enabled (file upload in progress)...');
            await page.waitForFunction(
              () => {
                const btn = document.querySelector('button[data-testid="send-button"]');
                return btn && !btn.disabled;
              },
              { timeout: 60_000 }
            );
            log('Send button is now enabled.');
          }

          // Snapshot assistant count BEFORE submitting so waitForStreamingDone
          // can reliably detect the new response even if ChatGPT replies instantly.
          const beforeCount = await page.evaluate(
            () => document.querySelectorAll('[data-message-author-role="assistant"]').length
          );

          // Submit by pressing Enter in the focused textarea.
          // Clicking the send button is unreliable when text is selected or when
          // a file attachment is present — React handles keyboard Enter more robustly.
          await page.focus('#prompt-textarea');
          await page.keyboard.press('Enter');
          log('Submitted via Enter key');

          log('Prompt sent, waiting for response...');
          await waitForStreamingDone(page, log, beforeCount);

          const finalUrl = page.url();
          if (finalUrl.startsWith('https://chatgpt.com/c/')) {
            fs.writeFileSync(SESSION_FILE, finalUrl, 'utf8');
          }

          const raw = await extractLastAssistantMessage(page);
          if (!raw) throw new Error('Could not extract response from page');

          const output = codeOnly ? extractCodeBlocks(raw) : raw;
          log(`Done: ${output.length} chars`);
          send(200, { ok: true, response: output });
        } catch (err) {
          log(`Error: ${err.message}`);
          send(500, { ok: false, error: err.message });
        } finally {
          busy = false;
        }
      });
      return;
    }

    send(404, { ok: false, error: 'Not found' });
  });

  server.on('error', err => {
    log(`HTTP server error: ${err.message}`);
    process.exit(1);
  });

  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    log(`HTTP server listening on 127.0.0.1:${port}`);
    fs.writeFileSync(DAEMON_FILE, JSON.stringify({ port, pid: process.pid }), 'utf8');
    log('Daemon ready.');
  });

  const shutdown = async signal => {
    log(`${signal} received, shutting down`);
    if (fs.existsSync(DAEMON_FILE)) fs.unlinkSync(DAEMON_FILE);
    await browser.close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));
  // never returns — stays alive as the server
}

// ─── Client helpers ───────────────────────────────────────────────────────────

function readDaemonState() {
  if (!fs.existsSync(DAEMON_FILE)) return null;
  try {
    const state = JSON.parse(fs.readFileSync(DAEMON_FILE, 'utf8'));
    process.kill(state.pid, 0); // throws if PID is dead
    return state;
  } catch {
    return null;
  }
}

function httpPost(port, endpoint, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      {
        hostname: '127.0.0.1', port, path: endpoint, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      },
      res => {
        let raw = '';
        res.on('data', c => (raw += c));
        res.on('end', () => {
          try { resolve(JSON.parse(raw)); }
          catch { reject(new Error('Invalid JSON from daemon')); }
        });
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function ensureDaemon() {
  let state = readDaemonState();
  if (state) return state.port;

  if (fs.existsSync(DAEMON_FILE)) fs.unlinkSync(DAEMON_FILE); // clean stale file

  process.stderr.write('[*] Starting browser daemon (first time ~15s)...\n');

  const child = spawn(process.execPath, [__filename, '--daemon-internal'], {
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore'],
    env: { ...process.env },
  });
  child.unref();

  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 1_000));
    state = readDaemonState();
    if (state) {
      await new Promise(r => setTimeout(r, 300)); // let HTTP server bind
      process.stderr.write('[*] Daemon ready.\n');
      return state.port;
    }
  }

  throw new Error('Daemon did not start. Check: cat ~/.chatgpt-poc-daemon.log');
}

// ─── Login (one-time setup, no daemon) ───────────────────────────────────────

function waitForEnter(prompt) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, () => { rl.close(); resolve(); });
  });
}

async function login() {
  console.log('[*] Opening Chrome for login...');
  const browser = await launchBrowser();
  const page = await browser.newPage();
  await page.goto(CHATGPT_URL, { waitUntil: 'networkidle2', timeout: 30_000 });
  console.log('');
  console.log('  Log in to chatgpt.com in the Chrome window that opened.');
  console.log('  When fully logged in and the chat interface is visible,');
  await waitForEnter('  press Enter here to save the session: ');
  await browser.close();
  console.log('[*] Done. Run: node chatgpt.js "your prompt here"');
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = {
    login: false, codeOnly: false, file: null, upload: null, save: null,
    git: false, context: null, newChat: false, stop: false, status: false,
    daemonInternal: false, cwd: null, prompt: [],
  };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--login':           opts.login          = true;  break;
      case '--code':            opts.codeOnly       = true;  break;
      case '--git':             opts.git            = true;  break;
      case '--new':             opts.newChat        = true;  break;
      case '--stop':            opts.stop           = true;  break;
      case '--status':          opts.status         = true;  break;
      case '--daemon-internal': opts.daemonInternal = true;  break;
      case '--file':            opts.file    = args[++i];    break;
      case '--upload':          opts.upload  = args[++i];    break;
      case '--save':            opts.save    = args[++i];    break;
      case '--context':         opts.context = args[++i];    break;
      case '--cwd':             opts.cwd     = args[++i];    break;
      default:                  opts.prompt.push(args[i]);
    }
  }
  return opts;
}

function printHelp() {
  console.log(`
Usage:
  node chatgpt.js --login                               # first-time setup
  node chatgpt.js "prompt"                              # continue last chat (daemon auto-starts)
  node chatgpt.js --new "prompt"                        # force a new chat
  node chatgpt.js --code "write fizzbuzz in Go"         # extract code blocks only
  node chatgpt.js --file <path> "prompt"                # paste file content as text in prompt
  node chatgpt.js --upload <path> "prompt"              # upload file via ChatGPT attachment button
  node chatgpt.js --save <path> "prompt"                # save response to a file
  node chatgpt.js --git "write a commit message"        # attach git diff/status
  node chatgpt.js --context "we use Fiber v2" "prompt"  # inline context
  cat error.log | node chatgpt.js "what is wrong"       # pipe input
  node chatgpt.js --status                              # check if daemon is running
  node chatgpt.js --stop                                # shut down the daemon
`);
}

(async () => {
  const opts = parseArgs(process.argv);

  if (opts.daemonInternal) {
    await startDaemonProcess(); // never returns
    return;
  }

  if (opts.login) {
    await login().catch(err => { console.error('[ERROR]', err.message); process.exit(1); });
    return;
  }

  if (opts.stop) {
    const state = readDaemonState();
    if (!state) { console.log('[*] No daemon running.'); return; }
    try {
      await httpPost(state.port, '/stop', {});
      console.log('[*] Daemon stopped.');
    } catch {
      if (fs.existsSync(DAEMON_FILE)) fs.unlinkSync(DAEMON_FILE);
      console.log('[*] Daemon stopped.');
    }
    return;
  }

  if (opts.status) {
    const state = readDaemonState();
    if (!state) { console.log('[*] Daemon not running.'); return; }
    console.log(`[*] Daemon running — PID ${state.pid}, port ${state.port}`);
    return;
  }

  if (opts.prompt.length === 0) {
    printHelp();
    process.exit(1);
  }

  const userPrompt  = opts.prompt.join(' ');
  const stdinData   = await readStdin();
  const fileData    = opts.file    ? readFile(opts.file)  : null;
  const gitData     = opts.git     ? getGitContext(opts.cwd || process.cwd()) : null;
  const contextData = opts.context || null;

  const fullPrompt = buildFullPrompt({ userPrompt, stdinData, fileData, gitData, contextData });

  try {
    const port   = await ensureDaemon();
    const result = await httpPost(port, '/ask', {
      fullPrompt, codeOnly: opts.codeOnly, newChat: opts.newChat,
      uploadPath: opts.upload || null,
    });
    if (!result.ok) throw new Error(result.error || 'Daemon returned an error');
    console.log('\n--- RESPONSE ---');
    console.log(result.response);
    console.log('--- END ---\n');
    if (opts.save) {
      fs.writeFileSync(path.resolve(opts.save), result.response, 'utf8');
      console.error(`[*] Response saved to: ${path.resolve(opts.save)}`);
    }
  } catch (err) {
    console.error('[ERROR]', err.message);
    process.exit(1);
  }
})();
