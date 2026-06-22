'use strict';

/**
 * ATx Enterprise 2026 — Follow-up Sender
 *
 * Opens the Messages screen (must be open in app before running).
 * For each conversation, sorted newest-first:
 *   1. Open the chat.
 *   2. Scroll to bottom to see latest messages.
 *   3. If the last message is OURS and was sent >24 h ago with no reply →
 *      generate a personalised follow-up via OpenAI and send it.
 *   4. Save result to output/followup/YYYY-MM-DD.csv.
 *
 * Daily checkpoint (output/followup/checkpoint_YYYY-MM-DD.json) prevents
 * re-processing the same conversation twice in the same calendar day.
 * The next day starts fresh.
 *
 * Flags:
 *   --dryrun   Generate messages but do NOT send; print to console instead.
 *   --reset    Clear today's checkpoint and start over.
 */

const { remote }    = require('webdriverio');
const { spawnSync } = require('child_process');
const readline      = require('readline');
const fs            = require('fs');
const path          = require('path');
const OpenAI        = require('openai');
const cfg           = require('./config');

// ── CLI flags ─────────────────────────────────────────────────────────────────
const DRY_RUN = process.argv.includes('--dryrun');
const RESET   = process.argv.includes('--reset');

// ── OpenAI ────────────────────────────────────────────────────────────────────
// Set OPENAI_API_KEY env var or add openaiApiKey to config.js
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || cfg.openaiApiKey;
if (!OPENAI_API_KEY) {
  console.error('Error: OPENAI_API_KEY env var is not set and cfg.openaiApiKey is missing.');
  process.exit(1);
}
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// ── Paths ─────────────────────────────────────────────────────────────────────
const OUT_DIR      = cfg.outputDir;
const FOLLOWUP_DIR = path.join(OUT_DIR, 'followup');
const TODAY        = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
const CHECKPOINT   = path.join(FOLLOWUP_DIR, `checkpoint_${TODAY}.json`);
const CSV_FILE     = path.join(FOLLOWUP_DIR, `${TODAY}.csv`);
const CSV_HEADERS  = ['name', 'status', 'followupMessage', 'processedAt'];

// 24-hour threshold in milliseconds
const FOLLOWUP_THRESHOLD_MS = 24 * 60 * 60 * 1000;

// ── Helpers ───────────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

function ensureDir(d) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

function csvEscape(val) {
  const s = val == null ? '' : String(val);
  return s.includes(',') || s.includes('"') || s.includes('\n')
    ? `"${s.replace(/"/g, '""')}"` : s;
}

function appendToCsv(record) {
  ensureDir(FOLLOWUP_DIR);
  const needsHeader = !fs.existsSync(CSV_FILE);
  const row = CSV_HEADERS.map(c => csvEscape(record[c] ?? '')).join(',');
  const line = (needsHeader ? CSV_HEADERS.join(',') + '\n' : '') + row + '\n';
  fs.appendFileSync(CSV_FILE, line);
}

// ── Daily checkpoint ──────────────────────────────────────────────────────────
function loadCheckpoint() {
  try {
    if (fs.existsSync(CHECKPOINT)) {
      return new Set(JSON.parse(fs.readFileSync(CHECKPOINT, 'utf8')));
    }
  } catch {}
  return new Set();
}

function saveCheckpoint(done) {
  ensureDir(FOLLOWUP_DIR);
  fs.writeFileSync(CHECKPOINT, JSON.stringify([...done], null, 2));
}

// ── Device selection (same as scraper.js) ─────────────────────────────────────
function listAdbDevices() {
  const result = spawnSync('adb', ['devices'], { encoding: 'utf8' });
  if (result.error) throw new Error(`adb not found: ${result.error.message}`);
  return (result.stdout || '').split('\n')
    .slice(1).map(l => l.trim())
    .filter(l => l.endsWith('\tdevice') || l.endsWith(' device'))
    .map(l => l.replace(/\s+device$/, '').trim())
    .filter(Boolean);
}

function getEmulatorName(udid) {
  try {
    const r = spawnSync('adb', ['-s', udid, 'emu', 'avd', 'name'], { encoding: 'utf8' });
    return (r.stdout || '').split('\n').map(l => l.trim()).filter(Boolean)[0] || udid;
  } catch { return udid; }
}

async function selectDevice() {
  const udids = listAdbDevices();
  if (udids.length === 0) { console.error('No Android devices found.'); process.exit(1); }
  if (udids.length === 1) {
    const label = udids[0].startsWith('emulator-') ? getEmulatorName(udids[0]) : udids[0];
    console.log(`  Device : ${label} (auto-selected)`);
    return udids[0];
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = p => new Promise(res => rl.question(p, a => { rl.close(); res(a.trim()); }));
  console.log('\nConnected devices:');
  udids.forEach((u, i) => {
    const label = u.startsWith('emulator-') ? `${getEmulatorName(u)} (${u})` : u;
    console.log(`  [${i + 1}] ${label}`);
  });
  while (true) {
    const n = parseInt(await ask(`Select device [1-${udids.length}]: `), 10);
    if (n >= 1 && n <= udids.length) return udids[n - 1];
  }
}

// ── XML parsing (same as scraper.js) ─────────────────────────────────────────
function parseSource(xml) {
  const elements = [];
  const re = /<([\w.]+)(\s[^>]*?)?\s*\/?>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const tag = m[1];
    if (tag === '?xml' || tag === 'hierarchy') continue;
    const attrStr = m[2] || '';
    const el = { _tag: tag };
    const attrRe = /([\w-]+)="([^"]*)"/g;
    let a;
    while ((a = attrRe.exec(attrStr)) !== null) el[a[1]] = a[2];
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

function getScreenSize(elements) {
  let maxArea = 0, sw = 1080, sh = 2400;
  for (const el of elements) {
    const b = parseBoundsRect(el.bounds);
    if (!b || b.x1 !== 0 || b.y1 !== 0 || b.x2 === 0) continue;
    const area = b.x2 * b.y2;
    if (area > maxArea) { maxArea = area; sw = b.x2; sh = b.y2; }
  }
  return { sw, sh };
}

// ── Touch helpers ─────────────────────────────────────────────────────────────
async function tapAt(driver, x, y) {
  const actions = [{ type: 'pointer', id: 'touch', parameters: { pointerType: 'touch' }, actions: [
    { type: 'pointerMove', duration: 0, x, y },
    { type: 'pointerDown', button: 0 },
    { type: 'pause', duration: 80 },
    { type: 'pointerUp', button: 0 },
  ]}];
  await driver.performActions(actions);
  await driver.releaseActions();
}

async function swipeUp(driver, startY, endY, x) {
  const actions = [{ type: 'pointer', id: 'touch', parameters: { pointerType: 'touch' }, actions: [
    { type: 'pointerMove', duration: 0, x, y: startY },
    { type: 'pointerDown', button: 0 },
    { type: 'pause', duration: 50 },
    { type: 'pointerMove', duration: 600, x, y: endY },
    { type: 'pointerUp', button: 0 },
  ]}];
  await driver.performActions(actions);
  await driver.releaseActions();
}

// ── Message list parsing ──────────────────────────────────────────────────────
const PKG = cfg.device.appPackage;

/**
 * Returns array of { name, agoTime, message, center } from visible messages list.
 */
function extractMessageListRows(elements) {
  const NAME_ID = `${PKG}:id/name`;
  const AGO_ID  = `${PKG}:id/agoTime`;
  const MSG_ID  = `${PKG}:id/message`;

  const names = elements.filter(e => e['resource-id'] === NAME_ID);
  const rows = [];

  for (const nameEl of names) {
    const nb = parseBoundsRect(nameEl.bounds);
    if (!nb) continue;
    const name = (nameEl.text || '').trim();
    if (!name) continue;

    // agoTime and message are siblings within the same card — same y-band
    const rowY1 = nb.y1 - 50;
    const rowY2 = nb.y2 + 200;

    let agoTime = '', lastMsg = '';
    for (const el of elements) {
      const rid = el['resource-id'] || '';
      const b = parseBoundsRect(el.bounds);
      if (!b || b.cy < rowY1 || b.cy > rowY2) continue;
      if (rid === AGO_ID)  agoTime = (el.text || '').trim();
      if (rid === MSG_ID)  lastMsg = (el.text || '').trim();
    }

    // Clickable container for this row: full-width row containing the name
    let rowCenter = { x: nb.cx, y: nb.cy + 50 }; // fallback
    for (const el of elements) {
      if (el.clickable !== 'true') continue;
      const b = parseBoundsRect(el.bounds);
      if (!b) continue;
      // Full-width row: w > 90% of screen and contains nameEl y-center
      const { sw } = getScreenSize(elements);
      if ((b.x2 - b.x1) > sw * 0.9 && nb.cy >= b.y1 && nb.cy <= b.y2) {
        rowCenter = { x: b.cx, y: b.cy };
        break;
      }
    }

    rows.push({ name, agoTime, lastMsg, center: rowCenter });
  }

  return rows;
}

/**
 * Parse a date label ("Today", "Yesterday", "Fri, Jun 19", "Friday", "2 days ago")
 * combined with a time ("3:16 PM") into a Date object.
 */
function parseMessageTimestamp(dateLabel, timeStr) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  let base = today;

  const dl = (dateLabel || '').trim().toLowerCase();

  if (dl === 'today') {
    base = today;
  } else if (dl === 'yesterday') {
    base = new Date(today); base.setDate(base.getDate() - 1);
  } else if (/^\d+ day/.test(dl)) {
    const days = parseInt(dl);
    base = new Date(today); base.setDate(base.getDate() - days);
  } else if (/^\d+ hour/.test(dl)) {
    // e.g. "3 hours ago" — use now directly
    const hours = parseInt(dl);
    return new Date(now.getTime() - hours * 3600 * 1000);
  } else {
    // "Mon, Jun 16", "Fri, Jun 19", "Friday", etc.
    const months = { jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11 };
    const dayNames = { monday:1,tuesday:2,wednesday:3,thursday:4,friday:5,saturday:6,sunday:0 };
    const mth = dl.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b/);
    const dom = dl.match(/\b(\d{1,2})\b/);
    if (mth && dom) {
      base = new Date(now.getFullYear(), months[mth[1]], parseInt(dom[1]));
      // If this date is in the future, subtract a year
      if (base > now) base.setFullYear(base.getFullYear() - 1);
    } else {
      // Day name only ("Friday") → find most recent past occurrence
      const target = dayNames[dl.split(',')[0].trim()];
      if (target !== undefined) {
        base = new Date(today);
        const cur = base.getDay();
        let diff = cur - target;
        if (diff <= 0) diff += 7;
        base.setDate(base.getDate() - diff);
      }
      // else: unknown format — fall back to today
    }
  }

  // Parse time string "3:16 PM" / "7:33 PM" / "4:00 AM"
  if (timeStr) {
    const tm = timeStr.match(/(\d+):(\d+)\s*(AM|PM)/i);
    if (tm) {
      let h = parseInt(tm[1]), min = parseInt(tm[2]);
      const ampm = tm[3].toUpperCase();
      if (ampm === 'PM' && h !== 12) h += 12;
      if (ampm === 'AM' && h === 12) h = 0;
      base = new Date(base.getFullYear(), base.getMonth(), base.getDate(), h, min, 0, 0);
    }
  }

  return base;
}

// ── Chat message parsing ──────────────────────────────────────────────────────

/**
 * Parse all messages visible in the current chat screen.
 * Returns array of { sender: 'us'|'them', text, time, dateLabel }
 * ordered top-to-bottom (oldest first).
 */
function parseChatMessages(elements) {
  const TEXT_ID   = `${PKG}:id/text`;
  const TIME_ID   = `${PKG}:id/time`;
  const TITLE_ID  = `${PKG}:id/title`; // date separator
  const SENDER_ID = `${PKG}:id/sender`;

  const { sw } = getScreenSize(elements);
  const ourMsgMinX = sw * 0.15; // our messages start after x=~15% (right-aligned bubbles)

  // Find date separators ordered by y
  const separators = elements
    .filter(e => e['resource-id'] === TITLE_ID)
    .map(e => ({ label: (e.text || '').trim(), b: parseBoundsRect(e.bounds) }))
    .filter(s => s.b)
    .sort((a, b) => a.b.y1 - b.b.y1);

  // Collect all message text elements
  const textEls = elements
    .filter(e => e['resource-id'] === TEXT_ID)
    .map(e => ({ text: (e.text || '').replace(/&#10;/g, '\n').trim(), b: parseBoundsRect(e.bounds) }))
    .filter(m => m.b && m.text.length > 0)
    .sort((a, b) => a.b.y1 - b.b.y1);

  const timeEls = elements
    .filter(e => e['resource-id'] === TIME_ID)
    .map(e => ({ text: (e.text || '').trim(), b: parseBoundsRect(e.bounds) }))
    .filter(t => t.b)
    .sort((a, b) => a.b.y1 - b.b.y1);

  const senderEls = elements
    .filter(e => e['resource-id'] === SENDER_ID)
    .map(e => ({ text: (e.text || '').trim(), b: parseBoundsRect(e.bounds) }))
    .filter(s => s.b)
    .sort((a, b) => a.b.y1 - b.b.y1);

  const messages = [];

  for (const tm of textEls) {
    // Find closest time element below or near this text element
    let closestTime = null, minDist = Infinity;
    for (const t of timeEls) {
      const dist = Math.abs(t.b.y1 - tm.b.y2);
      if (dist < minDist && t.b.y1 >= tm.b.y1 - 50) { minDist = dist; closestTime = t; }
    }

    // Find date separator above this message
    let dateLabel = '';
    for (const sep of separators) {
      if (sep.b.y1 <= tm.b.y1) dateLabel = sep.label;
    }

    // Determine sender:
    // - "them" if a sender element appears just above the text element
    // - or if time element is on the LEFT (x1 < sw * 0.3)
    // - "us" otherwise (time on the right, x1 > sw * 0.7)
    let sender = 'us';

    // Check for a sender name element above this message
    for (const s of senderEls) {
      if (s.b.y2 <= tm.b.y1 && s.b.y2 >= tm.b.y1 - 120) {
        sender = 'them';
        break;
      }
    }

    // Fallback: time position tells us sender
    if (closestTime && sender === 'us') {
      if (closestTime.b.x1 < sw * 0.3) sender = 'them';
    }

    messages.push({
      sender,
      text:      tm.text,
      time:      closestTime ? closestTime.text : '',
      dateLabel,
      timestamp: parseMessageTimestamp(dateLabel, closestTime ? closestTime.text : ''),
      y:         tm.b.y1,
    });
  }

  return messages.sort((a, b) => a.y - b.y);
}

/**
 * Scroll chat to bottom so the latest messages are visible.
 */
async function scrollChatToBottom(driver) {
  const { width, height } = await driver.getWindowSize();
  // Swipe up (finger moves up = content moves up = we see newer messages)
  for (let i = 0; i < 5; i++) {
    await swipeUp(driver, Math.round(height * 0.75), Math.round(height * 0.25), Math.round(width / 2));
    await sleep(400);
    // Check if we've reached the bottom by seeing if page source changes
  }
  await sleep(600);
}

// ── OpenAI follow-up generation ───────────────────────────────────────────────

async function generateFollowup(contactName, chatHistory) {
  const firstName = contactName.split(/\s+/)[0];

  // Build readable chat transcript
  const transcript = chatHistory.map(m =>
    `[${m.sender === 'us' ? 'US' : contactName}] ${m.text}`
  ).join('\n\n');

  const prompt = `You are writing a professional follow-up message on behalf of Lokesh from 75Way (an AI & software development company).

Contact name: ${contactName}
First name: ${firstName}

Chat history (oldest to newest):
${transcript}

Task: Write a concise, warm follow-up message (2-4 short paragraphs, max 300 words) that:
- Addresses them by first name
- References something specific from the conversation if possible
- Gently re-surfaces the value of 75Way's services (AI agents, automation, custom software)
- Ends with a simple, low-pressure call to action (e.g. a brief 15-min call)
- Sounds human, not templated
- Sign off as "Lokesh" (just the first name, no title)

Output ONLY the message text, no subject line, no explanation.`;

  const res = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.7,
    max_tokens: 500,
  });

  return (res.choices[0].message.content || '').trim();
}

// ── Send message in chat ──────────────────────────────────────────────────────

async function sendFollowupMessage(driver, text, elements) {
  const INPUT_ID = `${PKG}:id/textMessage`;
  const inputEl = elements.find(e => e['resource-id'] === INPUT_ID);
  if (!inputEl) throw new Error('Message input not found');

  const b = parseBoundsRect(inputEl.bounds);
  if (!b) throw new Error('Cannot parse input bounds');

  // Tap input field
  await tapAt(driver, b.cx, b.cy);
  await sleep(500);

  // Type the message
  await driver.keys(text);
  await sleep(400);

  // Re-fetch page source after typing to find send button
  const freshXml = await driver.getPageSource();
  const freshEls = parseSource(freshXml);

  const SEND_ID = `${PKG}:id/sendButton`;
  let sendBtn = null;

  // Try resource-id first (most reliable)
  const sendEl = freshEls.find(e => e['resource-id'] === SEND_ID);
  if (sendEl) {
    sendBtn = parseBoundsRect(sendEl.bounds);
  }

  if (!sendBtn) {
    // Fallback: rightmost small clickable near the input
    const { sw, sh } = getScreenSize(freshEls);
    for (const el of freshEls) {
      if (el.clickable !== 'true') continue;
      const rb = parseBoundsRect(el.bounds);
      if (!rb) continue;
      const w = rb.x2 - rb.x1, h = rb.y2 - rb.y1;
      if (w > 200 || h > 200) continue;
      if (rb.x1 < sw * 0.7) continue;
      if (rb.cy < sh * 0.75) continue;
      sendBtn = rb;
      break;
    }
  }

  if (sendBtn) {
    await tapAt(driver, sendBtn.cx, sendBtn.cy);
  } else {
    const ib = parseBoundsRect(inputEl.bounds);
    const { sw } = getScreenSize(freshEls);
    await tapAt(driver, Math.round(sw * 0.95), ib.cy);
  }

  await sleep(800);
}

// ── Scroll message list ───────────────────────────────────────────────────────

async function scrollMessageListDown(driver) {
  const { width, height } = await driver.getWindowSize();
  await swipeUp(driver, Math.round(height * 0.75), Math.round(height * 0.25), Math.round(width / 2));
  await sleep(600);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`  ATx Follow-up Sender${DRY_RUN ? ' [DRY-RUN]' : ''}`);
  console.log(`  Date: ${TODAY}`);
  console.log(`${'─'.repeat(60)}\n`);

  ensureDir(FOLLOWUP_DIR);

  if (RESET) {
    if (fs.existsSync(CHECKPOINT)) { fs.unlinkSync(CHECKPOINT); console.log('  Checkpoint cleared.\n'); }
  }

  const done = loadCheckpoint();
  console.log(`  Checkpoint: ${done.size} conversation(s) already processed today.\n`);

  const deviceId = await selectDevice();

  const driver = await remote({
    hostname: cfg.appium.hostname,
    port:     cfg.appium.port,
    logLevel: 'warn',
    capabilities: {
      platformName:            'Android',
      'appium:deviceName':     deviceId,
      'appium:appPackage':     cfg.device.appPackage,
      'appium:appActivity':    cfg.device.appActivity,
      'appium:automationName': 'UiAutomator2',
      'appium:noReset':        true,
    },
  });

  console.log('  Connected to Appium.\n');
  console.log('  IMPORTANT: Make sure the app is on the Messages screen.\n');
  await sleep(1500);

  let totalSent = 0, totalSkipped = 0, totalNoAction = 0;
  let staleScrolls = 0;
  const maxStaleScrolls = 6;
  const seenNames = new Set();

  while (staleScrolls <= maxStaleScrolls) {
    const xml = await driver.getPageSource();
    const elements = parseSource(xml);
    const rows = extractMessageListRows(elements);

    if (rows.length === 0) {
      console.log('  No message rows found on screen — are you on the Messages tab?');
      break;
    }

    let foundNew = false;

    for (const row of rows) {
      const key = row.name.trim().toLowerCase();

      // Skip if already seen in this pass (avoids re-processing after scroll)
      if (seenNames.has(key)) continue;
      seenNames.add(key);

      // Skip if already handled today
      if (done.has(key)) {
        console.log(`  ↷  ${row.name} — already processed today`);
        continue;
      }

      foundNew = true;
      console.log(`\n  ── ${row.name} (${row.agoTime}) ────────────────────`);

      // ── Open conversation ───────────────────────────────────────────────────
      await tapAt(driver, row.center.x, row.center.y);
      await sleep(cfg.timing.afterTap);

      // Scroll chat to bottom to see newest messages
      await scrollChatToBottom(driver);

      const chatXml = await driver.getPageSource();
      const chatEls = parseSource(chatXml);
      const messages = parseChatMessages(chatEls);

      if (messages.length === 0) {
        console.log('    No messages parsed — skipping.');
        await driver.back();
        await sleep(800);
        done.add(key);
        saveCheckpoint(done);
        appendToCsv({ name: row.name, status: 'skipped_no_messages', followupMessage: '', processedAt: new Date().toISOString() });
        totalSkipped++;
        continue;
      }

      // Find last message and determine sender
      const lastMsg = messages[messages.length - 1];
      console.log(`    Last message: [${lastMsg.sender}] "${lastMsg.text.slice(0, 80)}..."`);
      console.log(`    Timestamp:    ${lastMsg.dateLabel} ${lastMsg.time} → ${lastMsg.timestamp.toISOString()}`);

      const ageMs = Date.now() - lastMsg.timestamp.getTime();
      const ageH  = (ageMs / 3600000).toFixed(1);

      if (lastMsg.sender === 'them') {
        console.log(`    ✓ They replied — no follow-up needed.`);
        done.add(key);
        saveCheckpoint(done);
        appendToCsv({ name: row.name, status: 'replied', followupMessage: '', processedAt: new Date().toISOString() });
        totalNoAction++;
        await driver.back();
        await sleep(800);
        continue;
      }

      if (ageMs < FOLLOWUP_THRESHOLD_MS) {
        console.log(`    ⏳ Last message only ${ageH}h ago — too soon for follow-up.`);
        done.add(key);
        saveCheckpoint(done);
        appendToCsv({ name: row.name, status: 'too_soon', followupMessage: '', processedAt: new Date().toISOString() });
        totalNoAction++;
        await driver.back();
        await sleep(800);
        continue;
      }

      console.log(`    ⚑ Last message was ${ageH}h ago — follow-up needed.`);

      // ── Generate follow-up ─────────────────────────────────────────────────
      let followupText;
      try {
        console.log('    Generating follow-up via OpenAI...');
        followupText = await generateFollowup(row.name, messages);
        console.log(`\n    ─── Generated message ───\n${followupText.split('\n').map(l => '    ' + l).join('\n')}\n    ${'─'.repeat(40)}\n`);
      } catch (err) {
        console.error(`    ✗ OpenAI error: ${err.message}`);
        await driver.back();
        await sleep(800);
        continue;
      }

      if (DRY_RUN) {
        console.log('    [DRY-RUN] Message NOT sent.');
        done.add(key);
        saveCheckpoint(done);
        appendToCsv({ name: row.name, status: 'dryrun', followupMessage: followupText, processedAt: new Date().toISOString() });
        totalSent++;
      } else {
        // ── Send the follow-up ───────────────────────────────────────────────
        try {
          await sendFollowupMessage(driver, followupText, chatEls);
          console.log('    ✓ Follow-up sent!');
          done.add(key);
          saveCheckpoint(done);
          appendToCsv({ name: row.name, status: 'sent', followupMessage: followupText, processedAt: new Date().toISOString() });
          totalSent++;
        } catch (err) {
          console.error(`    ✗ Send failed: ${err.message}`);
          appendToCsv({ name: row.name, status: 'send_failed', followupMessage: followupText, processedAt: new Date().toISOString() });
        }
      }

      await driver.back();
      await sleep(1000);
    } // end for rows

    if (!foundNew) {
      staleScrolls++;
      console.log(`\n  Scrolling down for more conversations... (${staleScrolls}/${maxStaleScrolls})`);
      await scrollMessageListDown(driver);
    } else {
      staleScrolls = 0;
    }
  }

  await driver.deleteSession();

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`  Done.`);
  console.log(`  Follow-ups sent    : ${totalSent}`);
  console.log(`  Replied (skipped)  : ${totalNoAction}`);
  console.log(`  Skipped (other)    : ${totalSkipped}`);
  if (!DRY_RUN) console.log(`  CSV: ${CSV_FILE}`);
  console.log(`${'─'.repeat(60)}\n`);
}

main().catch(err => {
  console.error('\n✗ Fatal error:', err.message);
  process.exit(1);
});
