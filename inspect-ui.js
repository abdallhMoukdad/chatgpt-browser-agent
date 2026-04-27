#!/usr/bin/env node
/**
 * Dumps ChatGPT's textarea-area buttons and file inputs so we can find
 * the correct selectors for the attachment flow.
 */
const { addExtra }    = require('puppeteer-extra');
const puppeteerCore   = require('puppeteer-core');
const StealthPlugin   = require('puppeteer-extra-plugin-stealth');
const path            = require('path');
const os              = require('os');
const fs              = require('fs');

const puppeteer = addExtra(puppeteerCore);
puppeteer.use(StealthPlugin());

const SESSION_FILE = path.join(os.homedir(), '.chatgpt-poc-session');

(async () => {
  const browser = await puppeteer.launch({
    executablePath: '/usr/bin/google-chrome',
    userDataDir:    path.join(os.homedir(), '.chatgpt-poc-profile'),
    headless: false,
    args: [
      '--no-first-run', '--no-default-browser-check',
      '--disable-blink-features=AutomationControlled',
    ],
    defaultViewport: null,
  });

  const page = await browser.newPage();
  const url  = fs.existsSync(SESSION_FILE)
    ? fs.readFileSync(SESSION_FILE, 'utf8').trim()
    : 'https://chatgpt.com';

  console.log(`Navigating to ${url}`);
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 30_000 });
  await new Promise(r => setTimeout(r, 2_000));

  const info = await page.evaluate(() => {
    const allButtons = [...document.querySelectorAll('button')].map(b => ({
      text:       b.textContent.trim().slice(0, 60),
      ariaLabel:  b.getAttribute('aria-label'),
      testId:     b.getAttribute('data-testid'),
      id:         b.id || null,
      classes:    b.className.slice(0, 80),
    }));

    const fileInputs = [...document.querySelectorAll('input[type="file"]')].map(i => ({
      id:         i.id || null,
      name:       i.name || null,
      accept:     i.getAttribute('accept') || null,
      hidden:     i.hidden,
      display:    getComputedStyle(i).display,
      visibility: getComputedStyle(i).visibility,
      opacity:    getComputedStyle(i).opacity,
      parentTag:  i.parentElement?.tagName,
      parentTestId: i.parentElement?.getAttribute('data-testid') || null,
    }));

    const textarea = document.querySelector('#prompt-textarea');

    return { allButtons, fileInputs, hasTextarea: !!textarea };
  });

  console.log('\n=== TEXTAREA PRESENT:', info.hasTextarea, '===\n');
  console.log('=== BUTTONS ===');
  info.allButtons.forEach((b, i) =>
    console.log(`  [${i}] ariaLabel="${b.ariaLabel}" testId="${b.testId}" text="${b.text}"`)
  );
  console.log('\n=== FILE INPUTS ===');
  info.fileInputs.forEach((f, i) =>
    console.log(`  [${i}]`, JSON.stringify(f))
  );

  await browser.close();
})().catch(err => { console.error(err); process.exit(1); });
