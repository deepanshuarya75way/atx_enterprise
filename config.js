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
    'At the ATX Summit, businesses will explore AI and automation tools to reduce ' +
    'operational costs and scale growth.\n\n' +
    'We at 75way help you build and adopt AI solutions, AI agents, apps, and software ' +
    'to automate workflows. Our solutions include:\n' +
    '1. Ready-made AI agents for process automation\n' +
    '2. AI chatbots & voice assistants for customer support\n' +
    '3. Custom & on-demand mobile apps industry-specific needs\n' +
    '4. Enterprise and custom software solutions\n' +
    '5. Scalable websites and web apps\n' +
    '6. Advanced analytics and AI-driven BI systems\n\n' +
    'If AI & tech initiatives are part of your 2026 roadmap, we would be glad to ' +
    'schedule a 30-minute strategic discussion to explore relevant use cases and ' +
    'opportunities for your business.\n\n' +
    'Connect with us: https://75way.com/',

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
