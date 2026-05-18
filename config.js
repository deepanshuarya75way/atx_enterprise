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
    'We, 75way Technologies, will be attending Asia Tech x Singapore 2026. ' +
    'At the event, we\'ll showcase AI solutions, IoT and Blockchain integrations, ' +
    'and custom web/mobile apps.\n' +
    'We\'ve also launched an AI Agent Store, a modular ecosystem where enterprises ' +
    'can deploy ready-to-integrate AI agents.\n\n' +
    'AI Sales Agent\n' +
    'AI Marketing Agent\n' +
    'AI Finance Agent\n' +
    'Customer Support Agent\n' +
    'AI Voice Agent\n' +
    'AI IT Agent\n' +
    'Conversational AI Agent\n' +
    'AI Code Assistant\n' +
    'AI Healthcare Agent\n' +
    'AI Travel Agent\n' +
    'AI Banking Agent\n' +
    'E-commerce AI Agents\n' +
    'AI Real Estate Agent\n' +
    'AI Logistics Agent\n' +
    'AI Education Agent\n\n' +
    'There are many more. If this aligns with your 2026 roadmap, ' +
    'We can arrange a short virtual call on this week or next week\n\n' +
    'Connect with Us:\n' +
    'Website: www.75way.com',

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
