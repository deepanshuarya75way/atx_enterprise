'use strict';

/**
 * ATx Enterprise 2026 — Attendee Connector
 *
 * Flow:
 *   1. Start on the Attendees list screen in the app.
 *   2. Scroll the list to find the first person not yet processed.
 *   3. Tap their card to open the profile view.
 *   4. In profile view:
 *        a. If a connect button is visible → tap it → type personalised message → send.
 *        b. If already Pending / Connected → skip.
 *   5. Swipe the profile card LEFT to reveal the next person.
 *   6. Repeat steps 4–5 until list is exhausted.
 *
 * Re-run safety:
 *   Processed names are saved to output/visited.json after every person.
 *   On restart the script scrolls to the first unvisited person automatically.
 *
 * Rate-limit handling:
 *   If the connect dialog stays open after 5 s without dismissing, the script
 *   treats it as a server rejection, waits for the configured cooldown, then
 *   retries.  State is persisted in output/rate_limit.json.
 */

const { remote } = require('webdriverio');
const { spawnSync } = require('child_process');
const readline = require('readline');
const fs   = require('fs');
const path = require('path');
const cfg  = require('./config');

// ── Run mode ──────────────────────────────────────────────────────────────────
// --data  Scrape contact/social for ALL profiles (including pending/connected)
//         AND send connections.  When the pager exhausts, play an alert and
//         wait for the human to open the next card manually, then press Enter.
const DATA_MODE = process.argv.includes('--data');


const OUT_DIR      = cfg.outputDir;
const VISITED_FILE = path.join(OUT_DIR, 'visited.json');
const CSV_FILE     = path.join(OUT_DIR, 'profiles.csv');
const RATE_FILE    = path.join(OUT_DIR, 'rate_limit.json');

const CSV_COLS = ['profileId', 'name', 'designation', 'company', 'status', 'contact', 'socialMedia', 'processedAt'];

const RATE_SEQUENCE_MS = [30 * 60 * 1000, 10 * 60 * 1000, 5 * 60 * 1000];

// Domain substrings used to classify a text link as a social media URL.
const SOCIAL_DOMAINS = [
  'linkedin.com', 'twitter.com', 'x.com', 'facebook.com', 'instagram.com',
  'youtube.com', 'youtu.be', 'github.com', 'medium.com', 'tiktok.com',
  'snapchat.com', 'pinterest.com', 'reddit.com', 't.me', 'telegram.me',
  'wa.me', 'slack.com', 'discord.gg', 'discord.com', 'behance.net',
  'dribbble.com', 'xing.com', 'weibo.com', 'line.me',
];

function isSocialUrl(text) {
  const lower = text.toLowerCase();
  return SOCIAL_DOMAINS.some(d => lower.includes(d));
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── Persistence ───────────────────────────────────────────────────────────────

function ensureDir(d) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

/**
 * Stable composite ID from the three fields visible on the list card.
 * Normalised to lowercase so minor rendering differences don't create duplicates.
 */
function makeProfileId(name, designation, company) {
  return [name, designation, company]
    .map(s => (s || '').trim().toLowerCase().replace(/\s+/g, ' '))
    .join(' | ');
}

/**
 * Build a name→status map from all saved profiles.
 * Used as a fallback: profiles saved via swipe use null designation/company so
 * their composite key differs from the full key on the list card.
 * We only skip someone by name if their saved status is a terminal one
 * (sent / connected / pending) — NOT if they were skipped due to rate-limit,
 * so those get retried automatically.
 */
const TERMINAL_STATUSES = new Set(['sent', 'connected', 'pending']);

function buildProcessedNameSet(profiles) {
  const s = new Set();
  for (const p of profiles.values()) {
    if (p.name && TERMINAL_STATUSES.has(p.status)) {
      s.add(p.name.trim().toLowerCase());
    }
  }
  return s;
}

function isAlreadyProcessed(profiles, processedNames, name, designation, company) {
  // Exact composite key match — trust it regardless of status
  if (profiles.has(makeProfileId(name, designation, company))) return true;
  // Name-only fallback for terminal statuses saved under a different key form
  return processedNames.has((name || '').trim().toLowerCase());
}

function loadProfiles() {
  try {
    if (fs.existsSync(VISITED_FILE)) {
      const d = JSON.parse(fs.readFileSync(VISITED_FILE, 'utf8'));
      return new Map((d.profiles || []).map(p => [p.profileId, p]));
    }
  } catch {}
  return new Map();
}

function saveProfiles(map) {
  ensureDir(OUT_DIR);
  fs.writeFileSync(VISITED_FILE, JSON.stringify({
    lastRun:  new Date().toISOString(),
    total:    map.size,
    profiles: Array.from(map.values()),
  }, null, 2));
}

function escapeCSV(val) {
  if (val == null) return '';
  const s = (Array.isArray(val) ? val.join('; ') : String(val)).replace(/\r?\n/g, ' ');
  return (s.includes(',') || s.includes('"')) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function writeCSV(map) {
  const lines = [CSV_COLS.join(',')];
  for (const p of map.values()) {
    lines.push(CSV_COLS.map(c => escapeCSV(p[c])).join(','));
  }
  fs.writeFileSync(CSV_FILE, lines.join('\n') + '\n', 'utf8');
}

function upsertProfile(map, profileId, patch) {
  const existing = map.get(profileId) || {
    profileId,
    name:        null,
    designation: null,
    company:     null,
    status:      'unknown',
    contact:     [],
    socialMedia: [],
    processedAt: null,
  };
  const updated = { ...existing, ...patch };
  updated.processedAt = new Date().toISOString();
  map.set(profileId, updated);
  return updated;
}

// ── Rate-limit helpers ────────────────────────────────────────────────────────

function loadRateLimit() {
  try {
    if (fs.existsSync(RATE_FILE)) return JSON.parse(fs.readFileSync(RATE_FILE, 'utf8'));
  } catch {}
  return {};
}

function isRateLimited() {
  const d = loadRateLimit();
  return !!(d.blockedUntil && new Date(d.blockedUntil) > new Date());
}

function rateLimitResumesAt() {
  const d = loadRateLimit();
  return d.blockedUntil ? new Date(d.blockedUntil) : null;
}

function setRateLimited() {
  ensureDir(OUT_DIR);
  const d = loadRateLimit();
  const prevIdx = typeof d.seqIdx === 'number' ? d.seqIdx : -1;
  const nextIdx = (prevIdx + 1) % RATE_SEQUENCE_MS.length;
  const waitMs  = RATE_SEQUENCE_MS[nextIdx];
  const blockedUntil = new Date(Date.now() + waitMs).toISOString();
  fs.writeFileSync(RATE_FILE, JSON.stringify({
    blockedUntil,
    triggeredAt:  new Date().toISOString(),
    seqIdx:       nextIdx,
    waitMinutes:  Math.round(waitMs / 60000),
  }, null, 2));
  return { resumeAt: new Date(blockedUntil), waitMinutes: Math.round(waitMs / 60000) };
}

function clearRateLimit() {
  try { if (fs.existsSync(RATE_FILE)) fs.unlinkSync(RATE_FILE); } catch {}
}

// ── XML helpers ───────────────────────────────────────────────────────────────

function parseSource(xml) {
  const elements = [];
  const re = /<([\w.]+)(\s[^>]*?)?\s*\/?>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const tag = m[1];
    if (tag === '?xml' || tag === 'hierarchy') continue;
    const attrStr = m[2] || '';
    const el = { _tag: tag };
    const ar = /([\w-]+)="([^"]*)"/g;
    let a;
    while ((a = ar.exec(attrStr)) !== null) el[a[1]] = a[2];
    elements.push(el);
  }
  return elements;
}

function parseBoundsRect(b) {
  const m = b && b.match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
  if (!m) return null;
  const [x1, y1, x2, y2] = [+m[1], +m[2], +m[3], +m[4]];
  return { x1, y1, x2, y2, cx: Math.round((x1 + x2) / 2), cy: Math.round((y1 + y2) / 2) };
}

// ── Tap / Swipe helpers ───────────────────────────────────────────────────────

async function tapAt(driver, x, y) {
  await driver.action('pointer')
    .move({ x, y, duration: 0 })
    .down({ button: 0 })
    .up({ button: 0 })
    .perform();
}

async function swipeFromTo(driver, x1, y1, x2, y2, durationMs) {
  await driver.action('pointer')
    .move({ duration: 0, x: x1, y: y1 })
    .down({ button: 0 })
    .move({ duration: durationMs, x: x2, y: y2 })
    .up({ button: 0 })
    .perform();
}

// ── Smart-wait helpers ────────────────────────────────────────────────────────

async function waitForEl(driver, xpath, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || cfg.timing.profileTimeout);
  while (Date.now() < deadline) {
    try {
      const el = await driver.$(xpath);
      if (await el.isDisplayed()) return el;
    } catch {}
    await sleep(120);
  }
  return null;
}

async function waitForList(driver) {
  // List is ready when ≥2 "Connect" text buttons appear OR ≥2 person names visible
  const deadline = Date.now() + cfg.timing.listTimeout;
  while (Date.now() < deadline) {
    try {
      const xml = await driver.getPageSource();
      const connectCount = (xml.match(/text="Connect"/g) || []).length;
      if (connectCount >= 1) return true;
      // Fallback: any scrollable list with person data
      if (xml.includes('PeopleListActivity') || xml.includes('Book a meeting')) {
        // check we're back at list (not profile) — list has multiple Avatar-like cards
        const bookCount = (xml.match(/text="Book a meeting"/g) || []).length;
        if (bookCount === 0) return true; // no booking = list view
      }
    } catch {}
    await sleep(150);
  }
  return false;
}

// ── List scanning ─────────────────────────────────────────────────────────────

/**
 * Returns visible person cards from the attendee list.
 * Each card: { name, designation, company, center: {x, y} }
 *
 * The list uses android.view.View clickable=true cards that span the full
 * screen width ([0, y1][720, y2]) and contain 2-3 TextViews.
 * The Connect button is a SEPARATE smaller View inside the card.
 */
function extractListCards(elements) {
  const cards = [];
  const usedBounds = new Set();

  for (const el of elements) {
    if (el.clickable !== 'true' || el._tag !== 'android.view.View') continue;
    const r = parseBoundsRect(el.bounds);
    if (!r) continue;
    // Full-width cards span from x=0 to x=720 (± a few px)
    if (r.x1 > 10 || r.x2 < 700) continue;
    // Height sanity: person cards are ~140–220 px tall
    const h = r.y2 - r.y1;
    if (h < 100 || h > 350) continue;
    if (usedBounds.has(el.bounds)) continue;
    usedBounds.add(el.bounds);

    // Collect TextViews within this card's bounds (sorted top-to-bottom)
    const tvs = elements
      .filter(e => {
        if (!e._tag.includes('TextView')) return false;
        const t = (e.text || '').trim();
        if (!t || t.toLowerCase() === 'null') return false;
        // Exclude the Connect button text — it's inside the card but not the name
        if (t === 'Connect') return false;
        const tr = parseBoundsRect(e.bounds);
        if (!tr) return false;
        return tr.x1 >= r.x1 && tr.y1 >= r.y1 && tr.x2 <= r.x2 && tr.y2 <= r.y2;
      })
      .sort((a, b) => (parseBoundsRect(a.bounds)?.y1 || 0) - (parseBoundsRect(b.bounds)?.y1 || 0));

    if (tvs.length < 1) continue;

    // Skip event-banner cards (start with date/time text)
    const firstText = tvs[0]?.text.trim() || '';
    if (/^(Today|Tomorrow|\w+day)\s*[•·]|\d{1,2}:\d{2}\s*(am|pm)/i.test(firstText)) continue;

    cards.push({
      name:        firstText,
      designation: tvs[1]?.text.trim() || null,
      company:     tvs[2]?.text.trim() || null,
      center:      { x: r.cx, y: r.cy },
    });
  }

  return cards.sort((a, b) => a.center.y - b.center.y);
}

async function scanList(driver) {
  const xml = await driver.getPageSource();
  return extractListCards(parseSource(xml));
}

// ── List scroll ───────────────────────────────────────────────────────────────

async function scrollListDown(driver) {
  const { width, height } = await driver.getWindowSize();
  const cardsBefore = await scanList(driver);
  const lastBefore  = cardsBefore[cardsBefore.length - 1]?.name ?? null;

  await swipeFromTo(
    driver,
    Math.round(width / 2), Math.round(height * 0.75),
    Math.round(width / 2), Math.round(height * 0.2),
    700,
  );
  await sleep(cfg.timing.afterScroll);

  const cardsAfter = await scanList(driver);
  const lastAfter  = cardsAfter[cardsAfter.length - 1]?.name ?? null;
  return lastAfter !== lastBefore || cardsAfter.length > cardsBefore.length;
}

async function scrollListToTop(driver) {
  const { width, height } = await driver.getWindowSize();
  // Swipe down in short fast bursts starting from mid-screen.
  // Starting mid-screen (not y=0) avoids triggering pull-to-refresh.
  // Stop as soon as the first visible card no longer changes — we're at the top.
  let prevFirst = null;
  for (let i = 0; i < 20; i++) {
    const cards = await scanList(driver);
    const first  = cards[0]?.name ?? null;
    if (first !== null && first === prevFirst) break; // top reached — no movement
    prevFirst = first;
    await swipeFromTo(
      driver,
      Math.round(width / 2), Math.round(height * 0.45),
      Math.round(width / 2), Math.round(height * 0.75),
      250, // fast swipe — avoids pull-to-refresh threshold
    );
    await sleep(cfg.timing.afterScroll);
  }
}

// ── Profile content scroll helpers ───────────────────────────────────────────
//
// These operate inside the profile card's content area (y 800–1300) to avoid
// triggering the horizontal pager swipe, which lives at y≈300.

async function scrollProfileContentDown(driver) {
  await swipeFromTo(driver, 360, 1300, 360, 800, 600);
  await sleep(cfg.timing.afterScroll);
}

async function scrollProfileContentToTop(driver) {
  for (let i = 0; i < 4; i++) {
    await swipeFromTo(driver, 360, 800, 360, 1350, 400);
    await sleep(cfg.timing.afterScroll);
  }
}

// ── Profile extras scraping (contact + social media) ─────────────────────────
//
// Called once per new profile, before sending the connection request.
// Returns: { contact: string[], socialMedia: string[] }
//
// contact     — every text item from detailsRecyclerView (URLs, emails, phone …)
// socialMedia — platform label for each social icon found, detected by tapping
//               the icon and reading getCurrentPackage() to identify the app.
//
// Social icons are ImageButton[@resource-id="…id/icon"] with NAF=true — they
// carry no accessible URL, so tap-and-detect is the only viable approach.

async function scrapeProfileExtras(driver) {
  const PKG      = cfg.device.appPackage;
  const DETAIL   = `${PKG}:id/detailsRecyclerView`;
  const SOCIAL   = `${PKG}:id/socialMediaRecyclerView`;
  const TEXT_RID = `${PKG}:id/text`;

  const result = { contact: [], socialMedia: [] };

  // Scroll down up to 6 times to find either section.
  async function scrollToExtrasSection() {
    for (let i = 0; i < 6; i++) {
      const xml = await driver.getPageSource();
      if (xml.includes(`resource-id="${DETAIL}"`) || xml.includes(`resource-id="${SOCIAL}"`)) return true;
      await scrollProfileContentDown(driver);
    }
    return false;
  }

  const found = await scrollToExtrasSection();
  if (!found) {
    await scrollProfileContentToTop(driver);
    return result;
  }

  // Read all id/text TextViews visible after scrolling to the extras section.
  // Classify each value: social media URLs go to socialMedia[], everything else
  // (website, email, phone, etc.) goes to contact[].
  const xml = await driver.getPageSource();
  const els = parseSource(xml);
  for (const el of els) {
    if (el._tag !== 'android.widget.TextView') continue;
    if (el['resource-id'] !== TEXT_RID) continue;
    const t = (el.text || '').trim();
    if (!t) continue;
    if (isSocialUrl(t)) {
      result.socialMedia.push(t);
    } else {
      result.contact.push(t);
    }
  }

  await scrollProfileContentToTop(driver);
  return result;
}

// ── Profile page helpers ──────────────────────────────────────────────────────

/**
 * The profile view is a horizontal pager backed by a Compose UI.
 *
 * Key observation from UI dumps:
 *   - The CURRENT (center) card's elements have REAL bounds (positive y-coords).
 *   - ADJACENT cards (left/right) have [0,0][0,0] bounds (not rendered in viewport).
 *
 * Strategy for current person's name:
 *   Find the first TextView with REAL bounds in the name-area y-range (400–700).
 *   The layout is: avatar (y≈236–476) → name (y≈508–565) → designation → company
 *   → Book a meeting button (y≈679–791).
 */
const PROFILE_CHROME = new Set([
  'Book a meeting', 'Pending', 'Connect', 'Meet instead',
  'Back', 'Share', 'About me', 'Biography', 'See more', 'see more slots',
  'Qualify', 'Qualify your connection', 'Connected',
]);

/**
 * Extract name, designation, and company from the CURRENT profile card.
 * The layout (top→bottom within y 400–700) is always: name → designation → company.
 * Returns { name, designation, company } — any field may be null if not found.
 */
function getCurrentProfileInfo(elements) {
  // On a regular profile the name/designation/company sit at y≈508–640.
  // On a "Connected" profile the "Qualify your connection" panel is inserted
  // at the top, pushing everything down to y≈946–1085.
  // Detect which layout we're in by checking for the qualify panel with real bounds.
  const hasQualifyPanel = elements.some(el => {
    if (!el._tag.includes('TextView')) return false;
    if ((el.text || '').trim() !== 'Qualify your connection') return false;
    const b = parseBoundsRect(el.bounds);
    return b && !(b.x1 === 0 && b.y1 === 0 && b.x2 === 0 && b.y2 === 0);
  });
  const yMin = 400;
  const yMax = hasQualifyPanel ? 1150 : 700;

  const candidates = [];
  for (const el of elements) {
    if (!el._tag.includes('TextView')) continue;
    const t = (el.text || '').trim();
    if (!t || t.toLowerCase() === 'null') continue;
    const b = parseBoundsRect(el.bounds);
    // Must have real (non-zero) bounds — CURRENT card's elements only
    if (!b || (b.x1 === 0 && b.y1 === 0 && b.x2 === 0 && b.y2 === 0)) continue;
    // Name/designation/company all live in this y band
    if (b.y1 < yMin || b.y1 > yMax) continue;
    if (PROFILE_CHROME.has(t)) continue;
    // Skip single-word all-caps badges (PREMIUM, VIP…); multi-word all-caps = valid name
    if (t === t.toUpperCase() && t.length > 2 && !t.includes(' ')) continue;
    if (/^\d|^[0-9:]+\s*(am|pm)/i.test(t)) continue;
    if (t.length < 2) continue;
    candidates.push({ text: t, y: b.y1 });
  }
  candidates.sort((a, b) => a.y - b.y);
  return {
    name:        candidates[0]?.text ?? null,
    designation: candidates[1]?.text ?? null,
    company:     candidates[2]?.text ?? null,
  };
}

// Keep old name exported for any internal callers that just need the name
function getCurrentProfileName(elements) {
  return getCurrentProfileInfo(elements).name;
}

/**
 * Checks whether the connect button is visible on the current profile.
 * The circular connect button (person+ icon) sits to the right of "Book a meeting"
 * at a consistent position: Button bounds ~[544,679][656,791].
 *
 * We look for a clickable Button (or View) whose bounds x1 is between 520–580
 * and y1 is between 640–720, with size ~100×100 px.
 */
function findConnectButtonBounds(elements) {
  for (const el of elements) {
    if (!['android.widget.Button', 'android.view.View'].includes(el._tag)) continue;
    if (el.clickable !== 'true') continue;
    const r = parseBoundsRect(el.bounds);
    if (!r) continue;
    const w = r.x2 - r.x1;
    const h = r.y2 - r.y1;
    // Circular button: ~80–140 px wide/tall, to the right of center
    if (w < 60 || w > 160 || h < 60 || h > 160) continue;
    if (r.x1 < 500 || r.x1 > 620) continue;
    if (r.y1 < 600 || r.y1 > 800) continue;
    // No text / no desc (it's an icon button)
    const t = (el.text || '').trim();
    const d = (el['content-desc'] || '').trim();
    if (t || d) continue;
    return r;
  }
  return null;
}

/**
 * Check profile state from a single page-source call.
 * Returns: { name, isPending, isConnected, hasConnectButton, connectCenter }
 *
 * Real-bounds rule: only TextView nodes with non-zero bounds belong to the
 * CURRENT (center) card. Adjacent cards' elements all have [0,0][0,0] bounds.
 *
 * isConnected is true when:
 *   - A "Connected" label has real bounds, OR
 *   - A "Qualify your connection" panel has real bounds
 *   (both appear on already-connected profiles — see UI dump)
 * When isConnected, hasConnectButton is forced false so we never attempt to tap.
 */
async function readProfileState(driver) {
  const xml      = await driver.getPageSource();
  const elements = parseSource(xml);
  const { name, designation, company } = getCurrentProfileInfo(elements);

  function hasRealBoundsText(target) {
    for (const el of elements) {
      if (!el._tag.includes('TextView')) continue;
      if ((el.text || '').trim() !== target) continue;
      const b = parseBoundsRect(el.bounds);
      if (b && !(b.x1 === 0 && b.y1 === 0 && b.x2 === 0 && b.y2 === 0)) return true;
    }
    return false;
  }

  const isPending   = hasRealBoundsText('Pending');
  const isConnected = hasRealBoundsText('Connected') || hasRealBoundsText('Qualify your connection');

  const connectR = isConnected ? null : findConnectButtonBounds(elements);
  return {
    name, designation, company,
    isPending,
    isConnected,
    hasConnectButton: !!connectR,
    connectCenter:    connectR ? { x: connectR.cx, y: connectR.cy } : null,
  };
}

// ── Swipe to next profile ─────────────────────────────────────────────────────

/**
 * Swipe the profile card LEFT to reveal the next attendee.
 * The swipe must happen in the card HEADER area (avatar/name region, y≈300)
 * to avoid triggering in-profile scrolling.
 */
async function swipeToNextProfile(driver) {
  const { width } = await driver.getWindowSize();
  await swipeFromTo(
    driver,
    Math.round(width * 0.83), 300,
    Math.round(width * 0.14), 300,
    480,
  );
  await sleep(cfg.timing.afterSwipe);
}

// ── Connect dialog ────────────────────────────────────────────────────────────

/**
 * After the connect button is tapped and the dialog is open:
 *   1. Clear the EditText and type the personalised message.
 *   2. Tap the Connect button in the dialog.
 *   3. Poll until the dialog dismisses (success) or times out (rate-limited).
 *
 * Throws 'RATE_LIMITED' if the dialog stays open after 5 s.
 */
async function sendConnectionMessage(driver, firstName) {
  // Wait for the dialog's EditText to appear
  const msgInput = await waitForEl(driver, '//android.widget.EditText', cfg.timing.dialogTimeout);
  if (!msgInput) {
    // Check whether a "Qualify your connection" sheet opened instead of the message dialog
    try {
      const xml = await driver.getPageSource();
      if (xml.includes('Qualify your connection') || xml.includes('Qualify')) {
        throw new Error('QUALIFY_CONNECTION');
      }
    } catch (inner) { if (inner.message === 'QUALIFY_CONNECTION') throw inner; }
    throw new Error('Message EditText not found in connect dialog');
  }

  // Build message (keep newlines — this app supports multiline input)
  let message = cfg.connectionMessage.replace('{{first_name}}', firstName);
  if (message.length > 990) message = message.substring(0, 987) + '…';

  await msgInput.clearValue();
  await sleep(cfg.timing.settle);
  await msgInput.setValue(message);
  await sleep(cfg.timing.afterType);

  // Tap the "Connect" button in the dialog.
  // It's a clickable View whose only child is a TextView with text "Connect".
  // Try XPath first; fall back to fixed coords if XPath misses.
  let tapped = false;
  try {
    const connectViews = await driver.$$(
      '//android.view.View[@clickable="true"]',
    );
    for (const v of connectViews) {
      try {
        const children = await v.$$('./android.widget.TextView[@text="Connect"]');
        if (children.length > 0) {
          await v.click();
          tapped = true;
          break;
        }
      } catch {}
    }
  } catch {}

  if (!tapped) {
    // Fallback: tap fixed coordinates for the Connect button in dialog
    await tapAt(driver, 360, 808);
  }

  // Poll for dialog dismissal
  const SEND_POLL  = 200;
  const SEND_LIMIT = Date.now() + 6000;
  while (Date.now() < SEND_LIMIT) {
    await sleep(SEND_POLL);
    let xml;
    try { xml = await driver.getPageSource(); } catch { continue; }

    // Rate-limit signal
    const errorTexts = [...xml.matchAll(/text="([^"]*)"/g)].map(m => m[1]);
    if (errorTexts.some(t => t.includes('429') || t.includes('Too many'))) {
      throw new Error('RATE_LIMITED');
    }

    // Success: dialog dismissed — EditText no longer present
    if (!xml.includes('android.widget.EditText')) return;
  }

  // Still open → treat as rate-limited
  throw new Error('RATE_LIMITED');
}

// ── Sound alerts ─────────────────────────────────────────────────────────────

function playSound() {
  const f = path.join(__dirname, 'alert.wav');
  if (fs.existsSync(f)) spawnSync('afplay', [f], { timeout: 10000 });
}

/** Distinct repeating alert used in --data mode when pager is exhausted. */
function playPagerAlert() {
  const custom = path.join(__dirname, 'alert.wav');
  const sound  = fs.existsSync(custom) ? custom : '/System/Library/Sounds/Glass.aiff';
  for (let i = 0; i < 4; i++) {
    spawnSync('afplay', [sound], { timeout: 5000 });
  }
}

/** Pause execution until the user presses Enter in the terminal. */
function waitForEnter(prompt) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, () => { rl.close(); resolve(); });
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  ensureDir(OUT_DIR);

  const profiles = loadProfiles();
  const alreadySent = Array.from(profiles.values()).filter(p => p.status === 'sent').length;

  console.log('┌──────────────────────────────────────────────────────┐');
  console.log('│  ATx Enterprise 2026 — Attendee Connector            │');
  console.log('└──────────────────────────────────────────────────────┘');
  console.log(`  Mode        : ${DATA_MODE ? '--data (scrape all + connect, human navigation)' : 'normal (auto navigation)'}`);
  console.log(`  Device      : ${cfg.device.name}`);
  console.log(`  Package     : ${cfg.device.appPackage}`);
  console.log(`  Output      : ${path.resolve(OUT_DIR)}`);
  console.log(`  In DB       : ${profiles.size}  |  Sent : ${alreadySent}`);

  if (isRateLimited()) {
    const resumeAt = rateLimitResumesAt();
    console.log(`  Rate-limit  : ACTIVE — sending paused until ${resumeAt.toLocaleTimeString()}`);
  } else {
    clearRateLimit();
    console.log('  Rate-limit  : clear');
  }
  console.log('');

  let driver = null;
  let sentThisRun = 0;

  const shutdown = async (sig) => {
    console.log(`\nStopped (${sig}).  Sent this run: ${sentThisRun}`);
    saveProfiles(profiles);
    writeCSV(profiles);
    if (driver) try { await driver.deleteSession(); } catch {}
    playSound();
    process.exit(0);
  };
  process.on('SIGINT',  () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  driver = await remote({
    hostname: cfg.appium.hostname,
    port:     cfg.appium.port,
    logLevel: 'warn',
    capabilities: {
      platformName:                'Android',
      'appium:automationName':     'UiAutomator2',
      'appium:deviceName':         cfg.device.name,
      'appium:appPackage':         cfg.device.appPackage,
      'appium:appActivity':        cfg.device.appActivity,
      'appium:noReset':            cfg.device.noReset,
      'appium:newCommandTimeout':  120,
    },
  });

  await sleep(cfg.timing.afterAppLaunch);
  console.log('Connected. Starting…\n');

  try {
    let batch          = 0;
    let lastSwipedName = null; // name of the last profile seen when pager was exhausted

    // ── Outer batch loop ───────────────────────────────────────────────────────
    // Each iteration: scroll the list to the correct resume point, tap the next
    // unprocessed person, swipe through ~40 profiles, return to the list, repeat.
    while (true) {
      batch++;

      // ── Phase 1: Scroll list to find the next unprocessed card ────────────
      console.log(`\n[Batch ${batch}] Scanning list for next unprocessed person…`);

      // DATA mode always starts from the very top of the list (first item).
      if (DATA_MODE) {
        console.log('  Scrolling list to top…');
        await scrollListToTop(driver);
        lastSwipedName = null; // ignore any saved anchor
      } else if (lastSwipedName) {
        console.log(`  Resuming after "${lastSwipedName}"…`);
      }

      const processedNames = buildProcessedNameSet(profiles);

      let entryCard    = null;
      let staleScrolls = 0;

      if (DATA_MODE) {
        // ── DATA mode: just tap the first card at the top — visit everyone ──
        const cards = await scanList(driver);
        entryCard = cards[0] || null;
        if (entryCard) console.log(`  → Starting from: "${entryCard.name}"\n`);
      } else {
        // ── Normal mode: scroll to find first unprocessed card ──────────────
        // When lastSwipedName is set we must scroll the list until that person
        // is visible, then look for unprocessed cards that appear AFTER them.
        // seenAnchor flips to true once we have scrolled to / past the anchor.
        let seenAnchor = (lastSwipedName === null);

        while (staleScrolls <= cfg.maxStaleScrolls) {
          const cards = await scanList(driver);

          if (!seenAnchor) {
            // ── Positioning phase: scroll until lastSwipedName is visible ──
            const anchorIdx = cards.findIndex(c =>
              (c.name || '').trim().toLowerCase() === lastSwipedName.trim().toLowerCase()
            );

            if (anchorIdx >= 0) {
              seenAnchor = true;
              // Check cards that appear BELOW the anchor in the current view
              entryCard = cards.slice(anchorIdx + 1).find(c =>
                c.name && !isAlreadyProcessed(profiles, processedNames, c.name, c.designation, c.company)
              );
              if (entryCard) {
                console.log(`  → Next unprocessed: "${entryCard.name}"\n`);
                break;
              }
              // Nothing unprocessed in the same view — scroll to bring in next cards
            }

            const moved = await scrollListDown(driver);
            if (!moved) {
              staleScrolls++;
              if (staleScrolls > cfg.maxStaleScrolls) {
                // Anchor not found after exhaustive scroll — scan from current position
                console.warn(`  Could not locate "${lastSwipedName}" in list — scanning from here`);
                seenAnchor   = true;
                staleScrolls = 0;
              }
            } else {
              staleScrolls = 0;
            }
            continue;
          }

          // ── Normal scan: find first unprocessed card ──────────────────────
          entryCard = cards.find(c =>
            c.name && !isAlreadyProcessed(profiles, processedNames, c.name, c.designation, c.company)
          );
          if (entryCard) {
            console.log(`  → Next unprocessed: "${entryCard.name}"\n`);
            break;
          }

          const moved = await scrollListDown(driver);
          if (!moved) {
            staleScrolls++;
          } else {
            staleScrolls = 0;
          }
        }
      }

      if (!entryCard) {
        console.log('All attendees have been processed!');
        break; // exit outer batch loop — we are done
      }

      // ── Phase 2: Tap the entry card to open the profile pager ─────────────
      console.log(`  Opening profile for "${entryCard.name}"…`);
      await tapAt(driver, entryCard.center.x, entryCard.center.y);
      await sleep(cfg.timing.afterTap);

      const profileReady = await waitForEl(
        driver,
        '//android.widget.TextView[@text="Book a meeting"]',
        cfg.timing.profileTimeout,
      );
      if (!profileReady) {
        console.error('  Profile page did not load — returning to list.');
        try { await driver.back(); } catch {}
        await sleep(cfg.timing.afterScroll);
        continue; // retry outer batch loop
      }
      console.log('  Profile view open.\n');

      // ── Phase 3: Swipe-based processing loop (one pager batch ~40 cards) ──
      let currentCard = entryCard;
      let swipeMisses = 0;
      let prevName    = null;

      while (true) {
        // Read profile state — retry once if name wasn't detected
        let state = await readProfileState(driver);
        if (!state.name) {
          await sleep(600);
          state = await readProfileState(driver);
        }
        const { name, designation, company, isPending, isConnected, hasConnectButton, connectCenter } = state;

        // End-of-pager: same profile stuck N times
        if (name && name === prevName) {
          swipeMisses++;
          console.log(`  (same profile "${name}" — miss ${swipeMisses}/${cfg.maxSwipeMisses})`);
          if (swipeMisses >= cfg.maxSwipeMisses) {
            lastSwipedName = name;
            if (DATA_MODE) {
              // ── DATA mode: alert + wait for human to navigate manually ──────
              playPagerAlert();
              console.log('\n  ══════════════════════════════════════════════════════');
              console.log(`  Pager limit reached at "${name}".`);
              console.log('  In the app, go back to the attendees list and open');
              console.log('  the NEXT person\'s profile card manually.');
              console.log('  ══════════════════════════════════════════════════════');
              await waitForEnter('  Press Enter when the next profile is open… ');
              swipeMisses = 0;
              prevName    = null;
              currentCard = { name: null, designation: null, company: null, center: entryCard.center };
              continue; // resume swiping from wherever human landed
            } else {
              console.log(`\n  Pager limit reached at "${name}". Returning to list for batch ${batch + 1}…`);
              break; // exits swipe loop — outer loop auto-navigates
            }
          }
          await swipeToNextProfile(driver);
          continue;
        }
        swipeMisses = 0;

        // Sync currentCard: use live profile data (name + designation + company from page)
        if (name) {
          currentCard = {
            name,
            designation: designation || currentCard.designation,
            company:     company     || currentCard.company,
            center:      currentCard.center,
          };
        }
        prevName = name || prevName;

        const profileId   = makeProfileId(currentCard.name, currentCard.designation, currentCard.company);
        const displayName = currentCard.name || '(unknown)';

        // Already processed? Skip in normal mode only.
        // In --data mode we visit every profile to fill in missing data.
        if (!DATA_MODE && isAlreadyProcessed(profiles, processedNames, currentCard.name, currentCard.designation, currentCard.company)) {
          console.log(`  [skip] "${displayName}" — already processed`);
          await swipeToNextProfile(driver);
          continue;
        }

        // ── Scrape extras ──────────────────────────────────────────────────
        // DATA mode: scrape everyone (pending/connected included).
        // Normal mode: only scrape when the connect button is present.
        let extras = { contact: [], socialMedia: [] };
        const shouldScrape = !DATA_MODE && hasConnectButton;
        if (shouldScrape) {
          try {
            extras = await scrapeProfileExtras(driver);
            const parts = [];
            if (extras.contact.length)     parts.push(`${extras.contact.length} contact(s)`);
            if (extras.socialMedia.length) parts.push(extras.socialMedia.join(', '));
            if (parts.length) console.log(`    extras: ${parts.join('  |  ')}`);
          } catch (e) {
            console.warn(`    (scrape extras failed: ${e.message})`);
          }
        }

        // No connect button → pending / connected / qualify panel
        if (!hasConnectButton) {
          const reason = isPending ? 'pending' : 'already connected';
          const label  = DATA_MODE ? '[data]' : '[skip]';
          console.log(`  ${label} "${displayName}" — ${reason}`);
          // Preserve terminal status already in DB (e.g. 'sent' → don't overwrite to 'pending')
          const existingStatus = profiles.get(profileId)?.status;
          const newStatus = TERMINAL_STATUSES.has(existingStatus)
            ? existingStatus
            : (isPending ? 'pending' : 'connected');
          upsertProfile(profiles, profileId, {
            name:        currentCard.name,
            designation: currentCard.designation,
            company:     currentCard.company,
            status:      newStatus,
            contact:     extras.contact.length ? extras.contact : (profiles.get(profileId)?.contact || []),
            socialMedia: extras.socialMedia.length ? extras.socialMedia : (profiles.get(profileId)?.socialMedia || []),
          });
          saveProfiles(profiles);
          writeCSV(profiles);
          await swipeToNextProfile(driver);
          continue;
        }

        // Rate-limited — save data, defer connection, swipe
        if (isRateLimited()) {
          const resumeAt = rateLimitResumesAt();
          console.log(`  [wait] "${displayName}" — rate-limited until ${resumeAt.toLocaleTimeString()}`);
          upsertProfile(profiles, profileId, {
            name:        currentCard.name,
            designation: currentCard.designation,
            company:     currentCard.company,
            status:      'skipped_rate_limit',
            contact:     extras.contact,
            socialMedia: extras.socialMedia,
          });
          saveProfiles(profiles);
          writeCSV(profiles);
          await swipeToNextProfile(driver);
          continue;
        }

        // ── Attempt to connect ─────────────────────────────────────────────
        const firstName = displayName.split(' ')[0];
        console.log(`[→] "${displayName}"  (connecting as "${firstName}"…)`);

        try {
          await tapAt(driver, connectCenter.x, connectCenter.y);
          await sleep(cfg.timing.afterConnect);

          await sendConnectionMessage(driver, firstName);

          sentThisRun++;
          upsertProfile(profiles, profileId, {
            name:        currentCard.name,
            designation: currentCard.designation,
            company:     currentCard.company,
            status:      'sent',
            contact:     extras.contact,
            socialMedia: extras.socialMedia,
          });
          saveProfiles(profiles);
          writeCSV(profiles);
          console.log(`    ✓ sent  (total this run: ${sentThisRun})`);

          await sleep(cfg.timing.settle * 3);
          await swipeToNextProfile(driver);

        } catch (err) {
          if (err.message === 'RATE_LIMITED') {
            const { resumeAt, waitMinutes } = setRateLimited();
            console.warn(`    ⚠ Rate-limited — pausing sends for ${waitMinutes} min (until ${resumeAt.toLocaleTimeString()})`);
            try { await driver.back(); } catch {}
            await sleep(cfg.timing.settle);
            await swipeToNextProfile(driver);
          } else if (err.message === 'QUALIFY_CONNECTION') {
            console.log(`  [skip] "${displayName}" — qualify connection prompt (already connected)`);
            upsertProfile(profiles, profileId, {
              name:        currentCard.name,
              designation: currentCard.designation,
              company:     currentCard.company,
              status:      'connected',
              contact:     extras.contact,
              socialMedia: extras.socialMedia,
            });
            saveProfiles(profiles);
            writeCSV(profiles);
            try { await driver.back(); } catch {}
            await sleep(cfg.timing.settle);
            await swipeToNextProfile(driver);
          } else {
            console.error(`    ✗ Error: ${err.message}`);
            try { await driver.back(); } catch {}
            await sleep(cfg.timing.settle);
            await swipeToNextProfile(driver);
          }
        }
      } // end swipe loop

      if (DATA_MODE) {
        // In --data mode the human navigates manually — no auto list return
        break; // exit outer batch loop after human finishes
      }

      // Normal mode: press back to return to list for next batch
      console.log('  Pressing back to attendee list…');
      try { await driver.back(); } catch {}
      await sleep(cfg.timing.afterScroll);
      await waitForList(driver);

    } // end outer batch loop

  } finally {
    saveProfiles(profiles);
    writeCSV(profiles);
    const totalSent = Array.from(profiles.values()).filter(p => p.status === 'sent').length;
    console.log(`\n✓ Done. Sent this run: ${sentThisRun}  |  Total sent: ${totalSent}  |  In DB: ${profiles.size}`);
    console.log(`  JSON : ${path.resolve(VISITED_FILE)}`);
    console.log(`  CSV  : ${path.resolve(CSV_FILE)}`);
    if (driver) await driver.deleteSession();
    playSound();
  }
}

main().catch(async err => {
  console.error('\n✗ Fatal:', err.message);
  playSound();
  process.exit(1);
});
