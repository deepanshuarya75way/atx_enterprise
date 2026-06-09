'use strict';

/**
 * ATx Enterprise 2026 — Connect-Find (--cf) Mode
 *
 * For each 2-letter search term (aa → zz):
 *   1. Type the term once — results stay loaded for the whole term.
 *   2. Find the first person in the list whose status button shows "Connect".
 *   3. Tap them to open the profile pager; SWIPE through ~40 profiles connecting
 *      everyone who has a Connect button.
 *   4. When the pager gets stuck (same profile N times) → press BACK to the
 *      search results list (which is still showing the same term — no re-search).
 *   5. Find the next "Connect"-status entry in the list and open a new swipe batch.
 *   6. Repeat until no more "Connect" entries visible after exhaustive scrolling.
 *   7. Advance to next search term.
 *
 * Resume  : output/cf_state.json   (currentTerm + per-term stats)
 * DB      : output/cf_visited.json (dedup across runs)
 * Output  : output/cf_profiles_YYYY-MM-DD.csv (per-day, old files never deleted)
 */

const { remote }    = require('webdriverio');
const { spawnSync } = require('child_process');
const fs            = require('fs');
const path          = require('path');
const cfg           = require('./config');

const OUT_DIR         = cfg.outputDir;
const CF_STATE_FILE   = path.join(OUT_DIR, 'cf_state.json');
const CF_VISITED_FILE = path.join(OUT_DIR, 'cf_visited.json');

const CSV_COLS = [
  'profileId', 'name', 'designation', 'company', 'status',
  'searchTerm', 'contact', 'socialMedia', 'processedAt',
];

const TERMINAL_STATUSES = new Set(['sent', 'connected', 'pending']);
const STATUS_TEXTS      = new Set(['Connect', 'Pending', 'Connected', 'Message',
                                   'Book a meeting', 'Meet instead']);
const PROFILE_CHROME    = new Set([
  'Book a meeting', 'Pending', 'Connect', 'Meet instead',
  'Back', 'Share', 'About me', 'Biography', 'See more', 'see more slots',
  'Qualify', 'Qualify your connection', 'Connected', 'Message',
]);

const sleep = ms => new Promise(r => setTimeout(r, ms));
const PKG   = cfg.device.appPackage;

// ── Utilities ─────────────────────────────────────────────────────────────────

function ensureDir(d) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

function playSound(times = 1) {
  const f = path.join(__dirname, 'alert.wav');
  const s = fs.existsSync(f) ? f : '/System/Library/Sounds/Glass.aiff';
  for (let i = 0; i < times; i++) spawnSync('afplay', [s], { timeout: 10000 });
}

function todayStr()    { return new Date().toISOString().slice(0, 10); }
function todayCsvFile(){ return path.join(OUT_DIR, `cf_profiles_${todayStr()}.csv`); }

function makeProfileId(name, designation, company) {
  return [name, designation, company]
    .map(s => (s || '').trim().toLowerCase().replace(/\s+/g, ' '))
    .join(' | ');
}

function fmtProfile(name, designation, company) {
  const meta = [designation, company].filter(Boolean).join(' @ ');
  return meta ? `"${name}" [${meta}]` : `"${name}"`;
}

function normName(n) { return (n || '').trim().toLowerCase(); }

// ── Search-term sequence (aa → zz) ────────────────────────────────────────────

function* allSearchTerms() {
  for (let i = 0; i < 26; i++)
    for (let j = 0; j < 26; j++)
      yield String.fromCharCode(97 + i) + String.fromCharCode(97 + j);
}

function termsFrom(startTerm) {
  const out = [];
  let go = (startTerm == null);
  for (const t of allSearchTerms()) {
    if (!go && t === startTerm) go = true;
    if (go) out.push(t);
  }
  return out;
}

const TERM_INDEX = (() => {
  const m = {}; let i = 0;
  for (const t of allSearchTerms()) m[t] = ++i;
  return m;
})();

// ── Persistence ───────────────────────────────────────────────────────────────

function loadState() {
  try {
    if (fs.existsSync(CF_STATE_FILE))
      return JSON.parse(fs.readFileSync(CF_STATE_FILE, 'utf8'));
  } catch {}
  return { currentTerm: 'aa', termsCompleted: [], stats: {} };
}

function saveState(state) {
  ensureDir(OUT_DIR);
  fs.writeFileSync(CF_STATE_FILE, JSON.stringify(state, null, 2));
}

function loadVisited() {
  try {
    if (fs.existsSync(CF_VISITED_FILE)) {
      const d = JSON.parse(fs.readFileSync(CF_VISITED_FILE, 'utf8'));
      return new Map((d.profiles || []).map(p => [p.profileId, p]));
    }
  } catch {}
  return new Map();
}

function saveVisited(map) {
  ensureDir(OUT_DIR);
  fs.writeFileSync(CF_VISITED_FILE, JSON.stringify({
    lastRun:  new Date().toISOString(),
    total:    map.size,
    profiles: Array.from(map.values()),
  }, null, 2));
}

function upsertProfile(map, profileId, patch) {
  const existing = map.get(profileId) || {
    profileId, name: null, designation: null, company: null,
    status: 'unknown', searchTerm: null, contact: [], socialMedia: [],
    processedAt: null,
  };
  const updated = { ...existing, ...patch, processedAt: new Date().toISOString() };
  map.set(profileId, updated);
  return updated;
}

function appendToCsv(csvFile, profile) {
  ensureDir(OUT_DIR);
  const writeHeader = !fs.existsSync(csvFile);
  const line = CSV_COLS.map(c => {
    const v = profile[c];
    const s = Array.isArray(v) ? v.join('; ') : String(v ?? '');
    return `"${s.replace(/"/g, '""')}"`;
  }).join(',');
  if (writeHeader) fs.appendFileSync(csvFile, CSV_COLS.join(',') + '\n');
  fs.appendFileSync(csvFile, line + '\n');
}

// ── XML helpers ───────────────────────────────────────────────────────────────

function parseSource(xml) {
  const elements = [];
  const re = /<([\w.]+)(\s[^>]*?)?\s*\/?>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const tag = m[1];
    if (tag === '?xml' || tag === 'hierarchy') continue;
    const el = { _tag: tag };
    const ar = /([\w-]+)="([^"]*)"/g; let a;
    while ((a = ar.exec(m[2] || '')) !== null) el[a[1]] = a[2];
    elements.push(el);
  }
  return elements;
}

function parseBoundsRect(b) {
  const m = b && b.match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
  if (!m) return null;
  const [x1, y1, x2, y2] = [+m[1], +m[2], +m[3], +m[4]];
  return { x1, y1, x2, y2, cx: Math.round((x1+x2)/2), cy: Math.round((y1+y2)/2) };
}

// ── Touch helpers ─────────────────────────────────────────────────────────────

async function tapAt(driver, x, y) {
  await driver.action('pointer')
    .move({ x, y, duration: 0 }).down({ button: 0 }).up({ button: 0 }).perform();
}

async function swipeFromTo(driver, x1, y1, x2, y2, durationMs) {
  await driver.action('pointer')
    .move({ duration: 0, x: x1, y: y1 })
    .down({ button: 0 })
    .move({ duration: durationMs, x: x2, y: y2 })
    .up({ button: 0 }).perform();
}

/** Swipe the profile pager LEFT to reveal the next attendee (same as main scraper). */
async function swipeToNextProfile(driver) {
  const { width } = await driver.getWindowSize();
  await swipeFromTo(driver,
    Math.round(width * 0.83), 300,
    Math.round(width * 0.14), 300,
    480,
  );
  await sleep(cfg.timing.afterSwipe);
}

async function waitForEl(driver, xpath, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || cfg.timing.profileTimeout);
  while (Date.now() < deadline) {
    try { const el = await driver.$(xpath); if (await el.isDisplayed()) return el; } catch {}
    await sleep(120);
  }
  return null;
}

// ── Search navigation ─────────────────────────────────────────────────────────

async function openSearch(driver) {
  const xml = await driver.getPageSource();
  if (xml.includes(`id/search_src_text`)) return; // already open
  // Tap the search icon [544,76][640,172]
  await tapAt(driver, 592, 124);
  await sleep(cfg.timing.afterTap);
}

/**
 * Clear the field and type a fresh 2-letter term.
 * Uses select-all + delete to guarantee no residual text, then setValue.
 */
async function setSearchTerm(driver, term) {
  const FIELD_ID = `android=new UiSelector().resourceId("${PKG}:id/search_src_text")`;

  // Focus the field
  await tapAt(driver, 416, 124);
  await sleep(cfg.timing.settle);

  // Select-all then delete via key events — wipes any existing text
  try {
    const field = await driver.$(FIELD_ID);
    await field.clearValue();
    await sleep(150);
  } catch {}

  // Extra insurance: long-press to select-all remaining text, then delete
  try {
    const xml = await driver.getPageSource();
    const curMatch = xml.match(/id\/search_src_text[^>]*?text="([^"]*)"/);
    const cur = (curMatch?.[1] || '').trim();
    if (cur && cur !== 'Search' && cur !== '') {
      // Send select-all key combo via ADB (reliable fallback)
      const { spawnSync: sp } = require('child_process');
      sp('adb', ['shell', 'input', 'keyevent', 'KEYCODE_CTRL_A'], { timeout: 2000 });
      await sleep(100);
      sp('adb', ['shell', 'input', 'keyevent', 'KEYCODE_DEL'], { timeout: 2000 });
      await sleep(150);
    }
  } catch {}

  // Type the 2-letter term
  try {
    const field = await driver.$(FIELD_ID);
    await field.setValue(term);
  } catch {
    await driver.action('key')
      .down(term[0]).up(term[0])
      .down(term[1]).up(term[1]).perform();
  }

  await sleep(1800); // let the search query fire
}

/** Returns true once results or "No results" appear. */
async function waitForSearchResults(driver) {
  const deadline = Date.now() + cfg.timing.listTimeout;
  while (Date.now() < deadline) {
    try {
      const xml = await driver.getPageSource();
      if (xml.includes('text="No results"') || xml.includes(`id/personComposeView`)) return true;
    } catch {}
    await sleep(200);
  }
  return false;
}

function isNoResults(xml) {
  return xml.includes('text="No results"') && !xml.includes(`id/personComposeView`);
}

// ── Search result list scanning ───────────────────────────────────────────────

function extractSearchCards(elements) {
  const COMPOSE_ID = `${PKG}:id/personComposeView`;
  const cards = [];

  for (const el of elements) {
    if (el['resource-id'] !== COMPOSE_ID) continue;
    const r = parseBoundsRect(el.bounds);
    if (!r || r.x1 > 10 || r.x2 < 700) continue;
    if (r.y2 - r.y1 < 100 || r.y2 - r.y1 > 400) continue;

    // Text rows inside the card (excl. status labels), sorted top→bottom
    const tvs = elements
      .filter(e => {
        if (!e._tag.includes('TextView')) return false;
        const t = (e.text || '').trim();
        if (!t || t.toLowerCase() === 'null' || STATUS_TEXTS.has(t)) return false;
        const tr = parseBoundsRect(e.bounds);
        return tr && tr.y1 >= r.y1 && tr.y2 <= r.y2 && tr.x1 >= r.x1 && tr.x2 <= r.x2;
      })
      .sort((a, b) =>
        (parseBoundsRect(a.bounds)?.y1 || 0) - (parseBoundsRect(b.bounds)?.y1 || 0));

    if (tvs.length < 1) continue;

    // Status label (Connect / Pending / Connected / Message)
    const statusTv = elements.find(e => {
      if (!e._tag.includes('TextView')) return false;
      const t = (e.text || '').trim();
      if (!STATUS_TEXTS.has(t)) return false;
      const tr = parseBoundsRect(e.bounds);
      return tr && tr.y1 >= r.y1 && tr.y2 <= r.y2;
    });

    const n = tvs.length;
    cards.push({
      name:        n >= 1 ? tvs[0].text.trim() : null,
      designation: n >= 3 ? tvs.slice(1, n-1).map(t => t.text.trim()).join(', ') : null,
      company:     n >= 2 ? tvs[n-1].text.trim() : null,
      center:      { x: r.cx, y: r.cy },
      statusText:  (statusTv?.text || '').trim() || null,
    });
  }
  return cards.sort((a, b) => a.center.y - b.center.y);
}

async function scanSearchList(driver) {
  const xml   = await driver.getPageSource();
  const cards = extractSearchCards(parseSource(xml));
  return { cards, xml };
}

async function scrollSearchDown(driver) {
  const { width, height } = await driver.getWindowSize();
  const { cards: before } = await scanSearchList(driver);
  const lastBefore = before[before.length - 1]?.name ?? null;

  await swipeFromTo(driver,
    Math.round(width / 2), Math.round(height * 0.72),
    Math.round(width / 2), Math.round(height * 0.22), 700);
  await sleep(cfg.timing.afterScroll);

  const { cards: after } = await scanSearchList(driver);
  const lastAfter = after[after.length - 1]?.name ?? null;
  return lastAfter !== lastBefore || after.length > before.length;
}

// ── Profile-page helpers ──────────────────────────────────────────────────────

function getCurrentProfileInfo(elements) {
  const hasQualifyPanel = elements.some(el => {
    if (!el._tag.includes('TextView')) return false;
    if ((el.text || '').trim() !== 'Qualify your connection') return false;
    const b = parseBoundsRect(el.bounds);
    return b && !(b.x1 === 0 && b.y1 === 0 && b.x2 === 0 && b.y2 === 0);
  });
  const yMin = 400, yMax = hasQualifyPanel ? 1150 : 700;
  const candidates = [];
  for (const el of elements) {
    if (!el._tag.includes('TextView')) continue;
    const t = (el.text || '').trim();
    if (!t || t.toLowerCase() === 'null') continue;
    const b = parseBoundsRect(el.bounds);
    if (!b || (b.x1 === 0 && b.y1 === 0 && b.x2 === 0 && b.y2 === 0)) continue;
    if (b.y1 < yMin || b.y1 > yMax) continue;
    if (PROFILE_CHROME.has(t)) continue;
    if (t === t.toUpperCase() && t.length > 2 && !t.includes(' ')) continue;
    if (/^\d|^[0-9:]+\s*(am|pm)/i.test(t)) continue;
    if (t.length < 2) continue;
    candidates.push({ text: t, y: b.y1 });
  }
  candidates.sort((a, b) => a.y - b.y);
  const n = candidates.length;
  return {
    name:        n >= 1 ? candidates[0].text : null,
    designation: n >= 3 ? candidates.slice(1, n-1).map(c => c.text).join(', ') : null,
    company:     n >= 2 ? candidates[n-1].text : null,
  };
}

function findConnectButtonBounds(elements) {
  // Strategy 1: "Connect" TextView → smallest enclosing clickable
  let connectText = null;
  for (const el of elements) {
    if (!el._tag.includes('TextView')) continue;
    if ((el.text || '').trim() !== 'Connect') continue;
    const b = parseBoundsRect(el.bounds);
    if (!b || (b.x1===0 && b.y1===0 && b.x2===0 && b.y2===0)) continue;
    if (b.y1 < 600 || b.y1 > 900) continue;
    connectText = b; break;
  }
  if (connectText) {
    let best = null, bestArea = Infinity;
    for (const el of elements) {
      if (el.clickable !== 'true') continue;
      const r = parseBoundsRect(el.bounds);
      if (!r || (r.x1===0 && r.y1===0 && r.x2===0 && r.y2===0)) continue;
      if (r.x1 > connectText.x1 || r.x2 < connectText.x2) continue;
      if (r.y1 > connectText.y1 || r.y2 < connectText.y2) continue;
      const area = (r.x2-r.x1)*(r.y2-r.y1);
      if (area < bestArea) { best = r; bestArea = area; }
    }
    return best || connectText;
  }
  // Strategy 2: small circular icon button (no label, right side)
  for (const el of elements) {
    if (el.clickable !== 'true') continue;
    const r = parseBoundsRect(el.bounds);
    if (!r || (r.x1===0 && r.y1===0 && r.x2===0 && r.y2===0)) continue;
    const w = r.x2-r.x1, h = r.y2-r.y1;
    if (w < 80 || w > 160 || h < 80 || h > 160) continue;
    if (r.x1 < 480 || r.x1 > 660) continue;
    if (r.y1 < 600 || r.y1 > 900) continue;
    if ((el.text||'').trim() || (el['content-desc']||'').trim()) continue;
    return r;
  }
  return null;
}

async function readProfileState(driver) {
  const xml      = await driver.getPageSource();
  const elements = parseSource(xml);
  const { name, designation, company } = getCurrentProfileInfo(elements);

  function hasRealBoundsText(target) {
    for (const el of elements) {
      if (!el._tag.includes('TextView')) continue;
      if ((el.text || '').trim() !== target) continue;
      const b = parseBoundsRect(el.bounds);
      if (b && !(b.x1===0 && b.y1===0 && b.x2===0 && b.y2===0)) return true;
    }
    return false;
  }

  const isPending   = hasRealBoundsText('Pending');
  const isConnected = hasRealBoundsText('Connected') || hasRealBoundsText('Qualify your connection');
  const connectR    = isConnected ? null : findConnectButtonBounds(elements);

  return {
    name, designation, company, isPending, isConnected,
    hasConnectButton: !!connectR,
    connectCenter: connectR ? { x: connectR.cx, y: connectR.cy } : null,
  };
}

async function waitForProfile(driver) {
  const deadline = Date.now() + cfg.timing.profileTimeout;
  while (Date.now() < deadline) {
    try {
      const xml = await driver.getPageSource();
      if (xml.includes('text="Book a meeting"') || xml.includes('text="Pending"') ||
          xml.includes('text="Connected"')      || xml.includes('text="Connect"') ||
          xml.includes('text="Message"')) return true;
    } catch {}
    await sleep(200);
  }
  return false;
}

async function sendConnectionMessage(driver, firstName) {
  const msgInput = await waitForEl(driver, '//android.widget.EditText', cfg.timing.dialogTimeout);
  if (!msgInput) {
    const xml = await driver.getPageSource();
    if (xml.includes('Qualify your connection') || xml.includes('Qualify'))
      throw new Error('QUALIFY_CONNECTION');
    throw new Error('Message EditText not found');
  }

  let message = cfg.connectionMessage.replace('{{first_name}}', firstName);
  if (message.length > 990) message = message.substring(0, 987) + '…';

  await msgInput.clearValue(); await sleep(cfg.timing.settle);
  await msgInput.setValue(message); await sleep(cfg.timing.afterType);

  let tapped = false;
  try {
    const views = await driver.$$('//android.view.View[@clickable="true"]');
    for (const v of views) {
      try {
        const kids = await v.$$('./android.widget.TextView[@text="Connect"]');
        if (kids.length > 0) { await v.click(); tapped = true; break; }
      } catch {}
    }
  } catch {}
  if (!tapped) await tapAt(driver, 360, 808);

  const limit = Date.now() + 6000;
  while (Date.now() < limit) {
    await sleep(200);
    let xml; try { xml = await driver.getPageSource(); } catch { continue; }
    if ([...xml.matchAll(/text="([^"]*)"/g)].map(m => m[1])
        .some(t => t.includes('429') || t.includes('Too many')))
      throw new Error('RATE_LIMITED');
    if (!xml.includes('android.widget.EditText')) return;
  }
  throw new Error('RATE_LIMITED');
}

// ── Rate-limit wait ───────────────────────────────────────────────────────────

async function waitOutRateLimit() {
  const WAIT_MS = 10 * 60 * 1000;
  const until   = Date.now() + WAIT_MS;
  console.warn(`     ⚠ Rate-limited — pausing ${WAIT_MS / 60000} min`);
  playSound(3);
  while (Date.now() < until) {
    if (Math.round((until - Date.now()) / 1000) % 60 === 0)
      process.stdout.write(`\r     … ${Math.round((until - Date.now()) / 1000)}s remaining   `);
    await sleep(5000);
  }
  process.stdout.write('\n');
  console.log('     Resuming.');
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  ensureDir(OUT_DIR);

  const state    = loadState();
  const profiles = loadVisited();

  const alreadySent = Array.from(profiles.values()).filter(p => p.status === 'sent').length;

  console.log('┌──────────────────────────────────────────────────────┐');
  console.log('│  ATx Enterprise 2026 — Connect-Find (--cf) Mode      │');
  console.log('└──────────────────────────────────────────────────────┘');
  console.log(`  Resume term : "${(state.currentTerm || 'aa').toUpperCase()}"` +
              `  (#${TERM_INDEX[state.currentTerm || 'aa']} / 676)`);
  console.log(`  In CF DB    : ${profiles.size} profiles  |  Sent: ${alreadySent}`);
  console.log(`  Output dir  : ${path.resolve(OUT_DIR)}`);
  console.log('');

  let driver = null, sentThisRun = 0;

  const shutdown = async (sig) => {
    console.log(`\nStopped (${sig}). Sent this run: ${sentThisRun}`);
    saveState(state); saveVisited(profiles);
    if (driver) try { await driver.deleteSession(); } catch {}
    playSound(2); process.exit(0);
  };
  process.on('SIGINT',  () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  driver = await remote({
    hostname: cfg.appium.hostname,
    port:     cfg.appium.port,
    logLevel: 'warn',
    capabilities: {
      platformName:               'Android',
      'appium:automationName':    'UiAutomator2',
      'appium:deviceName':        cfg.device.name,
      'appium:appPackage':        cfg.device.appPackage,
      'appium:appActivity':       cfg.device.appActivity,
      'appium:noReset':           cfg.device.noReset,
      'appium:newCommandTimeout': 120,
    },
  });

  await sleep(cfg.timing.afterAppLaunch);
  console.log('Connected. Starting…\n');

  // ── Watchdog ────────────────────────────────────────────────────────────────
  let lastProgressAt = Date.now();
  const watchdog = setInterval(() => {
    if (Date.now() - lastProgressAt > 90_000) {
      console.warn('\n  ⚠ No progress for 90 s — script may be stuck!');
      playSound(3);
      lastProgressAt = Date.now();
    }
  }, 10_000);
  const bumpProgress = () => { lastProgressAt = Date.now(); };

  try {
    // Open search bar (stays open for the whole run)
    await openSearch(driver);

    for (const term of termsFrom(state.currentTerm || 'aa')) {

      // ── Switch search term ───────────────────────────────────────────────
      state.currentTerm = term;
      saveState(state);

      const termLabel = term.toUpperCase();
      const termIdx   = TERM_INDEX[term];
      console.log(`\n${'─'.repeat(54)}`);
      console.log(`  [${termIdx}/676]  Searching "${termLabel}"`);
      console.log(`${'─'.repeat(54)}`);

      // Type term ONCE — we never re-type it unless the search bar closes unexpectedly
      await setSearchTerm(driver, term);
      bumpProgress();

      const loaded = await waitForSearchResults(driver);
      if (!loaded) {
        console.warn(`  ⚠ Results didn't load for "${termLabel}" — skipping`);
        playSound(2); continue;
      }

      const { xml: firstXml } = await scanSearchList(driver);
      if (isNoResults(firstXml)) {
        console.log(`  No results — next term`);
        state.stats = state.stats || {};
        state.stats[term] = { total: 0, sent: 0 };
        state.termsCompleted = [...(state.termsCompleted || []), term];
        saveState(state); continue;
      }

      // ── Per-term tracking ────────────────────────────────────────────────
      // Names we've swiped through during THIS run (prevents re-tapping from list)
      const swipedThisRun = new Set(
        Array.from(profiles.values())
          .filter(p => p.searchTerm === term && TERMINAL_STATUSES.has(p.status))
          .map(p => normName(p.name))
      );

      let termTotal = 0, termSent = 0;

      // ── OUTER LOOP: find next entry card → swipe batch → repeat ──────────
      // This loop runs until no more "Connect"-status cards are visible in the list.
      outerLoop: while (true) {
        // ── Step 1: find next "Connect" entry in the search results list ────
        let entryCard  = null;
        let staleCount = 0;

        while (staleCount <= cfg.maxStaleScrolls) {
          const { cards } = await scanSearchList(driver);

          // First card that still shows "Connect" and hasn't been swiped this run
          entryCard = cards.find(c =>
            c.name &&
            c.statusText === 'Connect' &&
            !swipedThisRun.has(normName(c.name))
          );

          if (entryCard) break;

          // No Connect card visible — scroll down to see more
          const moved = await scrollSearchDown(driver);
          staleCount  = moved ? 0 : staleCount + 1;
        }

        if (!entryCard) {
          console.log(`  ✓ No more "Connect" entries for "${termLabel}"`);
          break outerLoop; // term complete
        }

        // ── Step 2: tap the entry card to open the profile pager ────────────
        console.log(`\n  [entry] Opening "${entryCard.name}" to start swipe batch…`);
        await tapAt(driver, entryCard.center.x, entryCard.center.y);
        await sleep(cfg.timing.afterTap);

        const loaded2 = await waitForProfile(driver);
        if (!loaded2) {
          console.warn(`  ✗ Profile not loaded for "${entryCard.name}" — marking skipped`);
          playSound(2);
          swipedThisRun.add(normName(entryCard.name));
          continue outerLoop; // find the next entry card
        }
        bumpProgress();

        // ── Step 3: SWIPE LOOP — process profiles until pager gets stuck ────
        let swipeMisses = 0, prevName = null;

        swipeLoop: while (true) {
          // Read current profile
          let pState = await readProfileState(driver);
          if (!pState.name) { await sleep(600); pState = await readProfileState(driver); }

          const { name, designation, company,
                  isPending, isConnected,
                  hasConnectButton, connectCenter } = pState;

          // ── End-of-pager detection (same profile N times) ──────────────
          if (name && name === prevName) {
            swipeMisses++;
            if (swipeMisses >= cfg.maxSwipeMisses) {
              console.log(`\n  Pager limit at "${name}" — back to list`);
              break swipeLoop; // exit swipe loop, go back to search list
            }
            await swipeToNextProfile(driver);
            continue swipeLoop;
          }
          swipeMisses = 0;
          prevName = name;

          if (name) swipedThisRun.add(normName(name));
          bumpProgress();

          const profileId = makeProfileId(name, designation, company);
          const display   = fmtProfile(name || '(unknown)', designation, company);

          // ── Already in DB with terminal status → skip ──────────────────
          const existing = profiles.get(profileId);
          if (existing && TERMINAL_STATUSES.has(existing.status)) {
            console.log(`  [skip] ${display} — already in DB (${existing.status})`);
            await swipeToNextProfile(driver);
            continue swipeLoop;
          }

          // ── No connect button (pending / connected) ────────────────────
          if (!hasConnectButton) {
            const reason = isPending ? 'pending' : 'connected';
            console.log(`  [skip] ${display} — ${reason}`);
            upsertProfile(profiles, profileId, {
              name, designation, company, status: reason, searchTerm: term,
            });
            saveVisited(profiles);
            appendToCsv(todayCsvFile(), profiles.get(profileId));
            termTotal++;
            await swipeToNextProfile(driver);
            continue swipeLoop;
          }

          // ── Send connection ────────────────────────────────────────────
          const firstName = (name || 'there').split(' ')[0];
          console.log(`  [→] ${display}  (connecting as "${firstName}"…)`);

          try {
            await tapAt(driver, connectCenter.x, connectCenter.y);
            await sleep(cfg.timing.afterConnect);
            await sendConnectionMessage(driver, firstName);

            sentThisRun++; termSent++; termTotal++;
            upsertProfile(profiles, profileId, {
              name, designation, company, status: 'sent', searchTerm: term,
            });
            saveVisited(profiles);
            appendToCsv(todayCsvFile(), profiles.get(profileId));
            console.log(`     ✓ sent  (this run: ${sentThisRun})`);
            bumpProgress();

            await sleep(cfg.timing.settle * 3);
            await swipeToNextProfile(driver);

          } catch (err) {
            if (err.message === 'RATE_LIMITED') {
              try { await driver.back(); } catch {} // close dialog
              await sleep(cfg.timing.settle);
              await waitOutRateLimit();
              // Go back to the search list and find the next entry
              break swipeLoop;
            } else if (err.message === 'QUALIFY_CONNECTION') {
              console.log(`  [skip] ${display} — qualify connection (connected)`);
              upsertProfile(profiles, profileId, {
                name, designation, company, status: 'connected', searchTerm: term,
              });
              saveVisited(profiles);
              appendToCsv(todayCsvFile(), profiles.get(profileId));
              try { await driver.back(); } catch {}
              await sleep(cfg.timing.settle);
              await swipeToNextProfile(driver);
            } else {
              console.error(`     ✗ ${err.message}`);
              playSound(2);
              try { await driver.back(); } catch {}
              await sleep(cfg.timing.settle);
              await swipeToNextProfile(driver);
            }
          }
        } // end swipeLoop

        // ── Press BACK to return to the search results list ────────────────
        // The search term is already typed — we do NOT call setSearchTerm again.
        console.log('  Returning to search list…');
        try { await driver.back(); } catch {}
        await sleep(cfg.timing.afterScroll);

        // Safety: if the app lost the search screen (e.g. navigated away), re-open
        const xmlCheck = await driver.getPageSource();
        if (!xmlCheck.includes(`id/search_src_text`)) {
          console.log('  (search bar closed — re-opening)');
          await openSearch(driver);
          await setSearchTerm(driver, term);   // forced re-search only in this edge case
          await waitForSearchResults(driver);
        }
        // Otherwise: results are still showing — continue outerLoop
      } // end outerLoop

      // ── Term finished ────────────────────────────────────────────────────
      console.log(`\n  ✓ "${termLabel}" complete — sent: ${termSent}  total: ${termTotal}`);
      state.stats = state.stats || {};
      state.stats[term] = { total: termTotal, sent: termSent };
      state.termsCompleted = [...(state.termsCompleted || []), term];
      saveState(state);
    } // end for each term

    console.log('\n✓ All 676 search terms processed!');

  } finally {
    clearInterval(watchdog);
    saveState(state); saveVisited(profiles);
    const totalSent = Array.from(profiles.values()).filter(p => p.status === 'sent').length;
    console.log(`\n  Sent this run : ${sentThisRun}`);
    console.log(`  Total CF sent : ${totalSent}`);
    console.log(`  In CF DB      : ${profiles.size}`);
    console.log(`  Today's CSV   : ${path.resolve(todayCsvFile())}`);
    if (driver) await driver.deleteSession();
    playSound(2);
  }
}

main().catch(async err => {
  console.error('\n✗ Fatal:', err.message || err);
  playSound(3);
  process.exit(1);
});
