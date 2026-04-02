// ═══════════════════════════════════════════════════════════════
// BACKGROUND.JS — Claude Prompt Runner v4.0
// Service worker for alarm-based auto-resume after session limit
// ═══════════════════════════════════════════════════════════════

const LIMIT_ALARM = 'cpr-session-limit-resume';
const LIMIT_WAIT_MS = 5 * 60 * 60 * 1000; // 5 hours

// Listen for alarm
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== LIMIT_ALARM) return;

  console.log('[CPR-BG] Session limit alarm fired — attempting auto-resume');

  // Clear the timer metadata
  await chrome.storage.local.set({ limitResumeAt: null });

  // Get saved run state
  const { runState } = await chrome.storage.local.get(['runState']);
  if (!runState || runState.status !== 'paused_limit') {
    console.log('[CPR-BG] No paused run to resume');
    return;
  }

  // Find a claude.ai tab
  const tabs = await chrome.tabs.query({ url: 'https://claude.ai/*' });
  if (!tabs.length) {
    console.log('[CPR-BG] No claude.ai tab found — cannot resume');
    // Keep state as paused so user can manually resume
    return;
  }

  const tab = tabs[0];

  // Navigate to /new for a fresh chat
  await chrome.tabs.update(tab.id, { url: 'https://claude.ai/new', active: true });
  await new Promise(r => setTimeout(r, 3000));

  // Ensure content script is loaded
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
  } catch (_) {}
  await new Promise(r => setTimeout(r, 500));

  // Update state and send resume
  runState.status = 'running';
  runState.running = true;
  await chrome.storage.local.set({ runState });

  try {
    await chrome.tabs.sendMessage(tab.id, { action: 'RESUME_RUN', data: runState });
    console.log('[CPR-BG] Resume message sent to content script');
  } catch (e) {
    console.log('[CPR-BG] Failed to send resume:', e.message);
  }
});

// Listen for messages from popup/content to set alarm
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'SET_LIMIT_ALARM') {
    const resumeAt = Date.now() + LIMIT_WAIT_MS;
    chrome.alarms.create(LIMIT_ALARM, { when: resumeAt });
    chrome.storage.local.set({ limitResumeAt: resumeAt });
    console.log('[CPR-BG] Session limit alarm set for', new Date(resumeAt).toLocaleTimeString());
    sendResponse({ resumeAt });
  }
  if (msg.action === 'CLEAR_LIMIT_ALARM') {
    chrome.alarms.clear(LIMIT_ALARM);
    chrome.storage.local.set({ limitResumeAt: null });
    console.log('[CPR-BG] Session limit alarm cleared');
    sendResponse({ ok: true });
  }
  return true; // keep channel open for async
});
