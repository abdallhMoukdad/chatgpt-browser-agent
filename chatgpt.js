#!/usr/bin/env node
/**
 * ChatGPT POC
 *
 * First time setup:
 *   node chatgpt.js --login
 *   → Opens Chrome, log in to chatgpt.com, then press Enter in the terminal.
 *
 * Every run after:
 *   node chatgpt.js "your prompt here"
 */

const { addExtra } = require('puppeteer-extra');
const puppeteerCore = require('puppeteer-core');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const path = require('path');
const os = require('os');
const readline = require('readline');

const puppeteer = addExtra(puppeteerCore);
puppeteer.use(StealthPlugin());

const CHROME_PATH      = '/usr/bin/google-chrome';
const PROFILE_DIR      = path.join(os.homedir(), '.chatgpt-poc-profile');
const CHATGPT_URL      = 'https://chatgpt.com';
const RESPONSE_TIMEOUT = 120_000;

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

async function ask(prompt) {
  console.log('[*] Launching Chrome...');
  const browser = await launchBrowser(false);
  const page = await browser.newPage();

  try {
    console.log('[*] Navigating to chatgpt.com...');
    await page.goto(CHATGPT_URL, { waitUntil: 'networkidle2', timeout: 30_000 });

    // Detect logged-out state: login button visible in header, no prompt input
    const isLoggedOut = await page.evaluate(() => {
      const hasLoginBtn = [...document.querySelectorAll('button, a')]
        .some(el => el.textContent.trim() === 'Log in' || el.textContent.trim() === 'Sign in');
      const hasInput = !!document.querySelector('#prompt-textarea');
      return hasLoginBtn && !hasInput;
    });

    if (isLoggedOut) {
      console.log('');
      console.log('[!] Not logged in. Run this first:');
      console.log('      node chatgpt.js --login');
      console.log('');
      await browser.close();
      process.exit(1);
    }

    // Fresh new chat
    console.log('[*] Starting new chat...');
    await page.goto(CHATGPT_URL, { waitUntil: 'networkidle2', timeout: 30_000 });

    const inputSelector = '#prompt-textarea';
    await page.waitForSelector(inputSelector, { timeout: 15_000 });

    console.log(`[*] Sending prompt: "${prompt}"`);
    await page.click(inputSelector);
    await page.keyboard.type(prompt, { delay: 20 });
    await page.keyboard.press('Enter');

    console.log('[*] Waiting for response...');

    // Wait for streaming to start
    await page.waitForFunction(
      () => [...document.querySelectorAll('button')].some(
        b => b.getAttribute('data-testid') === 'stop-button' ||
             b.textContent.trim() === 'Stop streaming'
      ),
      { timeout: 15_000 }
    ).catch(() => {});

    // Wait for streaming to finish
    await page.waitForFunction(
      () => ![...document.querySelectorAll('button')].some(
        b => b.getAttribute('data-testid') === 'stop-button' ||
             b.textContent.trim() === 'Stop streaming'
      ),
      { timeout: RESPONSE_TIMEOUT }
    );

    await new Promise(r => setTimeout(r, 500));

    const response = await page.evaluate(() => {
      const msgs = document.querySelectorAll('[data-message-author-role="assistant"]');
      if (msgs.length > 0) return msgs[msgs.length - 1].innerText.trim();
      const blocks = document.querySelectorAll('.markdown, .prose');
      if (blocks.length > 0) return blocks[blocks.length - 1].innerText.trim();
      return null;
    });

    if (!response) throw new Error('Could not extract response from page');

    console.log('\n--- RESPONSE ---');
    console.log(response);
    console.log('--- END ---\n');

    return response;

  } finally {
    await browser.close();
  }
}

// CLI entry point
const args = process.argv.slice(2);

if (args[0] === '--login') {
  login().catch(err => { console.error('[ERROR]', err.message); process.exit(1); });
} else if (args.length === 0) {
  console.error('Usage:');
  console.error('  node chatgpt.js --login          # first time setup');
  console.error('  node chatgpt.js "your prompt"    # send a prompt');
  process.exit(1);
} else {
  ask(args.join(' ')).catch(err => { console.error('[ERROR]', err.message); process.exit(1); });
}
