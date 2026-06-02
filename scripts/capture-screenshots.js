// scripts/capture-screenshots.js
//
// Reproduce every PNG in docs/screenshots/ plus the README hero GIF, against
// the demo data produced by scripts/seed-demo.js.
//
// Usage:
//   1.  cp data.json /tmp/data.json.bak    # back up real data
//   2.  node scripts/seed-demo.js          # write demo data.json
//   3.  node scripts/capture-screenshots.js
//   4.  cp /tmp/data.json.bak data.json    # restore
//
// Prereqs (one-off):
//   npm install --no-save playwright ffmpeg-static
//   npx playwright install chromium
//
// The script uses a Playwright initScript to pin "now" to 2026-06-28 so the
// habit-streak grid and daily notes line up with the seeded data.
//
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const ffmpegPath = require('ffmpeg-static');

const ROOT = path.resolve(__dirname, '..');
const OUT  = path.join(ROOT, 'docs', 'screenshots');
const URL  = process.env.UN_URL || 'http://localhost:3366/';
const settle = (p, ms = 800) => p.waitForTimeout(ms);

const FAKE_NOW = new Date('2026-06-28T12:00:00.000Z').getTime();
const FAKE_INIT = `(() => {
  const RealDate = Date;
  const offset = ${FAKE_NOW} - RealDate.now();
  const FakeDate = function (...a) { return a.length ? new RealDate(...a) : new RealDate(RealDate.now() + offset); };
  FakeDate.prototype = RealDate.prototype;
  FakeDate.now   = () => RealDate.now() + offset;
  FakeDate.parse = RealDate.parse;
  FakeDate.UTC   = RealDate.UTC;
  Object.setPrototypeOf(FakeDate, RealDate);
  Date = FakeDate;
})();`;

async function newPage(ctx) {
  const p = await ctx.newPage();
  await p.addInitScript(FAKE_INIT);
  return p;
}

async function go(p, route) {
  await p.goto(URL, { waitUntil: 'networkidle' });
  await settle(p, 800);
  await p.evaluate((r) => {
    const btn = document.querySelector(`button[data-route="${r}"]`);
    if (btn) btn.click();
  }, route);
  await settle(p, 1000);
}

// ── Stills (desktop) ──────────────────────────────────────────────────────
async function captureDesktopStills(browser) {
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2,
  });
  const p = await newPage(ctx);

  const route = async (r, name, full = false) => {
    await go(p, r);
    await p.screenshot({ path: path.join(OUT, name + '.png'), fullPage: full });
    console.log('  →', name + '.png');
  };

  await route('today',     '01-today');
  await route('projects',  '02-projects');

  // Notebook page with wiki-links + LaTeX
  await go(p, 'notebooks');
  await p.evaluate(() => {
    const tile = Array.from(document.querySelectorAll('button, a, div'))
      .find(el => /Course: Probabilistic ML/.test(el.textContent || ''));
    if (tile) tile.click();
  });
  await settle(p, 600);
  await p.evaluate(() => {
    const link = Array.from(document.querySelectorAll('a, button, div'))
      .find(el => /Diffusion intuition/.test(el.textContent || ''));
    if (link) link.click();
  });
  await settle(p, 800);
  await p.screenshot({ path: path.join(OUT, '03-notebook-wikilinks.png') });
  console.log('  → 03-notebook-wikilinks.png');

  // Quick capture (Alt+N) & command palette (Ctrl+K)
  await go(p, 'today');
  await p.keyboard.press('Alt+n');
  await settle(p, 400);
  await p.screenshot({ path: path.join(OUT, '04-quick-capture.png') });
  console.log('  → 04-quick-capture.png');
  await p.keyboard.press('Escape');
  await settle(p, 200);

  await p.keyboard.press('Control+k');
  await settle(p, 400);
  await p.keyboard.type('diff', { delay: 80 });
  await settle(p, 400);
  await p.screenshot({ path: path.join(OUT, '05-command-palette.png') });
  console.log('  → 05-command-palette.png');
  await p.keyboard.press('Escape');

  // Vault search
  await go(p, 'vault');
  await p.evaluate(() => { const q = document.getElementById('q'); if (q) q.value = 'diffusion'; });
  await p.evaluate(() => { const q = document.getElementById('q'); q && q.dispatchEvent(new Event('input')); });
  await settle(p, 500);
  await p.screenshot({ path: path.join(OUT, '06-vault-search.png') });
  console.log('  → 06-vault-search.png');

  await route('research',  '07-research');
  await route('monthly',   '08-monthly');
  await route('map',       '12-map');
  await route('links',     '13-links');
  await route('journal',   '14-journal-history');
  await route('review',    '15-review');

  // Habit streaks clip on Review
  await go(p, 'review');
  await p.evaluate(() => document.querySelectorAll('details').forEach(d => d.open = true));
  await settle(p, 400);
  const clip = await p.evaluate(() => {
    const head = Array.from(document.querySelectorAll('summary, h2, h3'))
      .find(el => /habit streak/i.test(el.textContent || ''));
    if (!head) return null;
    const card = head.closest('details, section, div.card, div') || head.parentElement;
    const r = card.getBoundingClientRect();
    if (r.height < 80) return null;
    return {
      x: Math.max(0, r.left - 8),
      y: Math.max(0, r.top - 8),
      width:  Math.min(window.innerWidth  - Math.max(0, r.left - 8), r.width + 16),
      height: Math.min(window.innerHeight - Math.max(0, r.top  - 8), r.height + 16),
    };
  });
  if (clip && clip.width > 200) {
    await p.screenshot({ path: path.join(OUT, '18-habit-streaks.png'), clip });
    console.log('  → 18-habit-streaks.png (clipped)');
  }

  // Today (full page) — Unfinished panel + Backlog open
  await go(p, 'today');
  await p.evaluate(() => {
    const hdr = document.getElementById('prevTasksHeader');
    if (hdr && window._prevTasksCollapsed !== false) hdr.click();
  });
  await settle(p, 500);
  await p.screenshot({ path: path.join(OUT, '16-today-unfinished.png'), fullPage: true });
  console.log('  → 16-today-unfinished.png');

  await go(p, 'today');
  await p.evaluate(() => {
    const btn = document.getElementById('toggleBacklog'); if (btn) btn.click();
    const hdr = document.getElementById('prevTasksHeader');
    if (hdr && window._prevTasksCollapsed !== false) hdr.click();
  });
  await settle(p, 700);
  await p.screenshot({ path: path.join(OUT, '17-backlog.png'), fullPage: true });
  console.log('  → 17-backlog.png');

  await ctx.close();
}

// ── Mobile stills ─────────────────────────────────────────────────────────
async function captureMobileStills(browser) {
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Mobile Safari/537.36',
    isMobile: true, hasTouch: true,
  });
  const p = await newPage(ctx);

  await go(p, 'today');
  await p.screenshot({ path: path.join(OUT, '09-mobile-today.png') });
  console.log('  → 09-mobile-today.png');

  // Tap FAB
  await p.evaluate(() => {
    const fab = document.getElementById('mobileCaptureFab') || document.querySelector('.fab');
    if (fab) fab.click();
  });
  await settle(p, 500);
  await p.screenshot({ path: path.join(OUT, '10-mobile-fab-capture.png') });
  console.log('  → 10-mobile-fab-capture.png');
  await p.keyboard.press('Escape');

  // Open drawer
  await p.evaluate(() => {
    const burger = document.querySelector('.mobile-menu-btn, #mobileMenuBtn, [aria-label="Menu"]');
    if (burger) burger.click();
  });
  await settle(p, 500);
  await p.screenshot({ path: path.join(OUT, '11-mobile-drawer.png') });
  console.log('  → 11-mobile-drawer.png');

  await ctx.close();
}

// ── Hero GIF (recorded webm → optimized GIF) ──────────────────────────────
async function recordHeroGif(browser) {
  const tmpDir = path.join(ROOT, 'docs', 'screenshots', '_tmp_video');
  fs.mkdirSync(tmpDir, { recursive: true });

  // Capture at high resolution so the downscaled GIF stays crisp.
  const CAPTURE_W = 1600, CAPTURE_H = 900;

  const ctx = await browser.newContext({
    viewport: { width: CAPTURE_W, height: CAPTURE_H },
    deviceScaleFactor: 1,
    recordVideo: { dir: tmpDir, size: { width: CAPTURE_W, height: CAPTURE_H } },
  });
  const p = await newPage(ctx);

  // Helper: type slowly enough to read on playback
  const slowType = async (text) => p.keyboard.type(text, { delay: 70 });

  await p.goto(URL, { waitUntil: 'networkidle' });
  await settle(p, 1600);                          // 1. Land on Today

  // 2. Quick-capture a task
  await p.keyboard.press('Alt+n');
  await settle(p, 700);
  await slowType('.reply to PR review comments');
  await settle(p, 800);
  await p.keyboard.press('Enter');
  await settle(p, 1800);                          //    Pause so viewer sees the task land

  // 3. Quick-capture a journal line
  await p.keyboard.press('Alt+n');
  await settle(p, 600);
  await slowType('j shipped the OSS docs today — feeling great about the launch');
  await settle(p, 700);
  await p.keyboard.press('Enter');
  await settle(p, 1800);

  // 4. Command palette → fuzzy jump to a note
  await p.keyboard.press('Control+k');
  await settle(p, 700);
  await slowType('diffu');
  await settle(p, 900);
  await p.keyboard.press('Enter');
  await settle(p, 2200);                          //    Linger on the wiki-linked note

  // 5. Jump to the Map view to show the graph
  await p.evaluate(() => {
    const btn = document.querySelector('button[data-route="map"]');
    if (btn) btn.click();
  });
  await settle(p, 2200);

  // 6. Jump to Review for the habit-streak grid finale
  await p.evaluate(() => {
    const btn = document.querySelector('button[data-route="review"]');
    if (btn) btn.click();
  });
  await settle(p, 2400);

  await p.close();
  await ctx.close();

  const webm = fs.readdirSync(tmpDir).find(f => f.endsWith('.webm'));
  if (!webm) throw new Error('No video produced');
  const webmPath = path.join(tmpDir, webm);
  const gifPath  = path.join(OUT, '00-hero.gif');
  const palette  = path.join(tmpDir, 'palette.png');

  // Two-pass GIF with a per-frame palette for crisp text. Output 1000px wide @
  // 15fps — good legibility on README hero, ~5–8 MB depending on motion.
  const FPS = 15;
  const W   = 1000;
  const filters = `fps=${FPS},scale=${W}:-1:flags=lanczos`;
  const run = (args) => {
    const r = spawnSync(ffmpegPath, args, { stdio: ['ignore', 'inherit', 'inherit'] });
    if (r.status !== 0) throw new Error('ffmpeg failed');
  };
  // stats_mode=full + max_colors=192 keeps text edges sharp at the cost of size.
  run(['-y', '-i', webmPath, '-vf',
       `${filters},palettegen=stats_mode=full:max_colors=192`, palette]);
  run(['-y', '-i', webmPath, '-i', palette, '-lavfi',
       `${filters} [x]; [x][1:v] paletteuse=dither=floyd_steinberg:diff_mode=rectangle`,
       gifPath]);

  const sizeMB = (fs.statSync(gifPath).size / 1024 / 1024).toFixed(2);
  console.log('  → 00-hero.gif (' + sizeMB + ' MB, ' + W + 'px @ ' + FPS + 'fps)');

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

(async () => {
  const browser = await chromium.launch();
  const args = new Set(process.argv.slice(2));
  const all = args.size === 0;
  if (all || args.has('--stills'))   await captureDesktopStills(browser);
  if (all || args.has('--mobile'))   await captureMobileStills(browser);
  if (all || args.has('--hero-gif')) await recordHeroGif(browser);
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
