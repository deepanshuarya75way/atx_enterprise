'use strict';

module.exports = {

  // ── Appium server ──────────────────────────────────────────────────────────
  appium: {
    hostname: '127.0.0.1',
    port: 4723,
  },

  // ── Android device & app ───────────────────────────────────────────────────
  device: {
    name:        '6TWKKNT8EIZXTWUW',
    appPackage:  'com.swapcard.apps.android.asiatechxsg',
    appActivity: 'com.swapcard.apps.android.ui.main.MainActivity',
    noReset:     true,
  },

  // ── Output ─────────────────────────────────────────────────────────────────
  outputDir: './output',

  // ── Connection message ─────────────────────────────────────────────────────
  // {{first_name}} is replaced at runtime with the person's first name.
  // Max 1000 chars (app limit).
  connectionMessage:
    'Hi {{first_name}},\n\n' +
    'We\'re exhibiting at the ATX Summit, Singapore, from May 20–22, 2026.\n' +
    'We help businesses automate repetitive workflows, reduce operational load, ' +
    'and improve customer response efficiency with AI and Agentic AI systems.\n\n' +
    'Our solutions include:\n' +
    '1. Ready-Made AI agents for process automation\n' +
    '2. AI chatbots & voice assistants for customer support\n' +
    '3. AI-powered apps and workflow systems\n' +
    '4. Advanced data analytics for business operations\n' +
    '5. AI-driven sales automation systems to close deals\n\n' +
    'If improving operational efficiency or scaling automation is on your roadmap, ' +
    'we\'d be glad to connect at the event or schedule a 30-minute strategic AI ' +
    'consultation to share relevant use cases.\n\n' +
    'Looking forward to your response!\n' +
    'Warm Regards,\n' +
    'Team https://75way.com/',

  // ── Timing (milliseconds) ──────────────────────────────────────────────────
  timing: {
    afterAppLaunch:  2500,  // initial settle after session start
    afterTap:        1800,  // wait for profile page to fully load after tapping card
    afterSwipe:      1200,  // wait after swipe-left for next profile to settle
    afterScroll:      700,  // wait after list scroll gesture
    afterConnect:    1500,  // wait after tapping connect button for dialog
    afterType:        300,  // tiny pause after setValue before tapping Send
    settle:           200,  // micro-settle between UI actions
    profileTimeout:  6000,  // max poll time waiting for profile page elements
    listTimeout:     5000,  // max poll time waiting for list to appear
    dialogTimeout:   4000,  // max poll time waiting for connect dialog
  },

  // ── Safety limits ──────────────────────────────────────────────────────────
  maxStaleScrolls:  8,   // stop if N consecutive list scrolls yield no new cards
  maxSwipeMisses:   5,   // stop if N consecutive swipes show no change in profile
};
