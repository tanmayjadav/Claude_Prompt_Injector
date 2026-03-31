// ═══════════════════════════════════════════════════════════════
// CONTENT.JS — Claude Prompt Runner v2.2
// ═══════════════════════════════════════════════════════════════

let isRunning  = false;
let shouldStop = false;

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.action === 'START_RUN') startRun(msg.data);
  if (msg.action === 'STOP_RUN') { shouldStop = true; isRunning = false; }
});

// ─────────────────────────────────────────────────────────────
// MAIN LOOP
// ─────────────────────────────────────────────────────────────

async function startRun({ countries, prompt, delay, timeout }) {
  if (isRunning) return;
  isRunning  = true;
  shouldStop = false;

  for (let i = 0; i < countries.length; i++) {
    if (shouldStop) break;

    const country     = countries[i];
    const finalPrompt = prompt.replaceAll('{{COUNTRY_REGION}}', country);

    notify('COUNTRY_STARTED', { country, index: i });
    log(`▶ ${i+1}/${countries.length}: ${country}`);

    // 1. Find editor
    const editor = await poll(() => findEditor(), 15000);
    if (!editor) return fail('Editor not found. Are you on a claude.ai page?');

    // 2. Inject prompt
    const injected = await inject(editor, finalPrompt);
    if (!injected) return fail('Could not inject text into editor.');

    // 3. Send — clipboard paste worked, now we need to actually send
    notify('COUNTRY_WAITING', { country, index: i });
    const sent = await send(editor);
    if (!sent) return fail('Could not send message.');

    // 4. Wait for URL to settle (/new → /chat/xxx)
    await settleUrl();

    // 5. Wait for full response, auto-clicking Continue
    await waitDone(timeout, country);

    notify('COUNTRY_DONE', { country, index: i });
    log(`✓ Done: ${country}`);

    if (i < countries.length - 1 && !shouldStop) {
      log(`Waiting ${delay}s…`);
      await sleep(delay * 1000);
    }
  }

  if (!shouldStop) notify('ALL_DONE', { total: countries.length });
  isRunning = false;
}

function fail(msg) {
  log('ERROR: ' + msg);
  notify('RUN_ERROR', { error: msg });
  isRunning = false;
}

// ─────────────────────────────────────────────────────────────
// EDITOR
// ─────────────────────────────────────────────────────────────

function findEditor() {
  // data-testid="chat-input" is the most reliable selector from the real DOM
  const byTestId = document.querySelector('[data-testid="chat-input"]');
  if (byTestId) {
    const r = byTestId.getBoundingClientRect();
    if (r.width > 0) return byTestId;
  }
  // Fallbacks
  for (const sel of [
    'div.tiptap.ProseMirror[contenteditable="true"]',
    'div.ProseMirror[contenteditable="true"]',
    '[contenteditable="true"][aria-label*="prompt"]',
    '[contenteditable="true"][aria-label*="Reply"]',
    '[contenteditable="true"]',
  ]) {
    for (const el of document.querySelectorAll(sel)) {
      const r = el.getBoundingClientRect();
      if (r.width > 80 && r.height > 0) return el;
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────
// INJECT
// ─────────────────────────────────────────────────────────────

async function inject(editor, text) {
  // Method A: clipboard write → paste (Chrome-safe, works across CSP)
  try {
    window.focus();
    editor.click();
    editor.focus();
    await sleep(150);

    await navigator.clipboard.writeText(text);
    await sleep(100);

    document.execCommand('selectAll', false, null);
    document.execCommand('delete', false, null);
    await sleep(50);
    document.execCommand('paste', false, null);
    await sleep(400);

    if (editor.textContent.trim().length > 0) {
      log('Inject: clipboard paste OK');
      return true;
    }
  } catch(e) { log('Inject clipboard failed: ' + e.message); }

  // Method B: execCommand insertText
  try {
    window.focus();
    editor.click();
    editor.focus();
    await sleep(150);

    document.execCommand('selectAll', false, null);
    document.execCommand('delete', false, null);
    await sleep(50);
    document.execCommand('insertText', false, text);
    await sleep(300);

    if (editor.textContent.trim().length > 0) {
      log('Inject: execCommand OK');
      return true;
    }
  } catch(e) { log('Inject execCommand failed: ' + e.message); }

  return false;
}

// ─────────────────────────────────────────────────────────────
// SEND
// Real DOM analysis shows:
//   - On /new page: send button is type="submit" (suggestion chips area)
//   - On /chat page: send button is type="button", appears after content
//   - Voice mode button is always present as type="button"
//   - Send button has NO aria-label in some builds, or "Send message" in others
// Strategy: find button by position (last button in input row after voice btn)
// Fallback: Enter key via KeyboardEvent on the editor element
// ─────────────────────────────────────────────────────────────

async function send(editor) {
  // Wait a bit for React to re-render after inject
  await sleep(300);

  // Try button first
  const btn = await poll(() => findSendButton(), 6000);
  if (btn) {
    log('Send button found: ' + (btn.getAttribute('aria-label') || btn.className.slice(0,50)));
    for (const t of ['mousedown', 'mouseup', 'click']) {
      btn.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window }));
    }
    await sleep(500);
    if (wasSent(editor)) { log('Sent via button'); return true; }
  }

  // Fallback: Enter key — must be dispatched on the editor with correct props
  // Claude intercepts Enter to submit (not newline) when no shift key
  log('Trying Enter key fallback…');
  editor.focus();
  await sleep(100);

  const enter = new KeyboardEvent('keydown', {
    bubbles: true,
    cancelable: true,
    key: 'Enter',
    code: 'Enter',
    keyCode: 13,
    which: 13,
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
  });
  editor.dispatchEvent(enter);
  await sleep(600);

  if (wasSent(editor)) { log('Sent via Enter'); return true; }

  // Last resort: click any visible button near bottom-right of input area
  log('Trying positional button search…');
  const anyBtn = findButtonByPosition();
  if (anyBtn) {
    anyBtn.click();
    await sleep(500);
    if (wasSent(editor)) { log('Sent via positional button'); return true; }
  }

  log('All send strategies failed');
  return false;
}

function findSendButton() {
  // Strategy 1: aria-label Send variants
  for (const label of ['Send message', 'Send Message', 'Send']) {
    const b = document.querySelector(`button[aria-label="${label}"]`);
    if (b && !b.disabled && isVisible(b)) return b;
  }

  // Strategy 2: type=submit icon-only button in fieldset (new chat page)
  const fs = document.querySelector('fieldset');
  if (fs) {
    const submits = [...fs.querySelectorAll('button[type="submit"]')]
      .filter(b => !b.disabled && isVisible(b) && b.innerText.trim() === '' && b.querySelector('svg'));
    if (submits.length) return submits[submits.length - 1];
  }

  // Strategy 3: last visible SVG-icon-only button inside the input box area
  // The input container has class including "rounded-[20px]"
  const inputBox = document.querySelector('[class*="rounded-[20px]"]') ||
                   document.querySelector('[class*="chat-input"]') ||
                   document.querySelector('fieldset');
  if (inputBox) {
    const btns = [...inputBox.querySelectorAll('button')]
      .filter(b => !b.disabled && isVisible(b) && b.querySelector('svg') && b.innerText.trim() === '');
    // The send button is the LAST one (voice mode is second-to-last usually)
    if (btns.length > 0) return btns[btns.length - 1];
  }

  return null;
}

function findButtonByPosition() {
  // Find all visible buttons, get the one closest to bottom-right of viewport
  const allBtns = [...document.querySelectorAll('button')]
    .filter(b => isVisible(b) && !b.disabled);

  let best = null, bestScore = -1;
  for (const b of allBtns) {
    const r = b.getBoundingClientRect();
    // Score = bottom + right (higher = closer to bottom-right)
    const score = r.bottom + r.right;
    if (score > bestScore) { bestScore = score; best = b; }
  }
  return best;
}

function isVisible(el) {
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && el.offsetParent !== null;
}

function wasSent(editor) {
  return editor.textContent.trim().length === 0 || isGenerating();
}

// ─────────────────────────────────────────────────────────────
// WAIT FOR FULL RESPONSE — auto-clicks Continue
// ─────────────────────────────────────────────────────────────

const CONTINUE_POLL_TOTAL_MS = 7000;
const CONTINUE_POLL_INTERVAL_MS = 250;

/**
 * After isGenerating() goes false, the Continue control may mount a few hundred
 * ms later. Poll for it while re-checking isGenerating() so we don't declare
 * "done" early or miss a late Continue.
 */
async function pollForContinueButton() {
  const end = Date.now() + CONTINUE_POLL_TOTAL_MS;
  while (Date.now() < end) {
    if (shouldStop) return { kind: 'stop' };
    if (isGenerating()) return { kind: 'resume' };
    const btn = findContinue();
    if (btn) return { kind: 'continue', btn };
    await sleep(CONTINUE_POLL_INTERVAL_MS);
  }
  if (isGenerating()) return { kind: 'resume' };
  return { kind: 'none' };
}

async function waitDone(timeoutSec, country) {
  const deadline = Date.now() + timeoutSec * 1000;

  // Wait up to 30s for generation to START
  const started = await poll(() => isGenerating() ? true : null, 30000);
  if (!started) { await sleep(2000); return; }

  while (Date.now() < deadline) {
    if (shouldStop) return;
    if (isGenerating()) { await sleep(800); continue; }

    // Stopped — brief settle, then poll for Continue (avoids race with slow mount)
    await sleep(400);
    const phase = await pollForContinueButton();
    if (phase.kind === 'stop') return;
    if (phase.kind === 'resume') continue;
    if (phase.kind === 'continue') {
      log('Clicking Continue…');
      notify('COUNTRY_WAITING', { country: `${country} · continuing…`, index: -1 });
      for (const t of ['mousedown','mouseup','click']) {
        phase.btn.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window }));
      }
      phase.btn.click?.();
      await sleep(2000);
      continue;
    }

    // Truly done
    await sleep(1200);
    log('Response complete');
    return;
  }
  log('Timeout');
}

function isGenerating() {
  for (const l of ['Stop Response','Stop response','Stop generating','Stop']) {
    if (document.querySelector(`button[aria-label="${l}"]`)) return true;
  }
  for (const b of document.querySelectorAll('button')) {
    if ((b.getAttribute('aria-label') || '').toLowerCase().includes('stop') && isVisible(b)) return true;
  }
  for (const sel of ['[class*="streaming"]','[class*="generating"]','[data-testid="thinking-indicator"]']) {
    const el = document.querySelector(sel);
    if (el && el.getBoundingClientRect().height > 0) return true;
  }
  return false;
}

function looksLikeContinueLabel(s) {
  if (!s) return false;
  const t = s.trim().toLowerCase();
  if (t.includes('discontinue')) return false;
  if (/\bcontinue\b/.test(t)) return true;
  return t === 'continue' || t.startsWith('continue ') || t.startsWith('continue,');
}

/** Claude renders assistant prose + tool rows inside `.font-claude-response`; Continue often mounts there or in the gap before the next user bubble. */
function continueSearchRoots() {
  const roots = [];
  const responses = [...document.querySelectorAll('.font-claude-response')].filter((el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  });
  if (!responses.length) return roots;

  const last = responses[responses.length - 1];
  roots.push(last);

  let sib = last.nextElementSibling;
  for (let i = 0; sib && i < 12; i++, sib = sib.nextElementSibling) {
    if (sib.matches?.('[data-test-render-count]')) break;
    if (sib.querySelector?.('[data-testid="user-message"]')) break;
    roots.push(sib);
  }
  return roots;
}

function findContinueInRoot(root) {
  if (!root || !root.querySelectorAll) return null;

  for (const sel of ['button[data-testid="continue-button"]', 'button[data-testid="message-continue"]']) {
    for (const b of root.querySelectorAll(sel)) {
      if (b.disabled || !isVisible(b)) continue;
      return b;
    }
  }

  for (const el of root.querySelectorAll('[data-testid]')) {
    const id = (el.getAttribute('data-testid') || '').toLowerCase();
    if (!id.includes('continue')) continue;
    const b = el.closest('button') || (el.tagName === 'BUTTON' ? el : null);
    if (b && !b.disabled && isVisible(b)) return b;
  }

  for (const b of root.querySelectorAll('button')) {
    if (b.disabled || !isVisible(b)) continue;
    const lbl = b.getAttribute('aria-label') || '';
    if (looksLikeContinueLabel(lbl)) return b;

    const txt = (b.innerText || '').replace(/\s+/g, ' ').trim();
    if (looksLikeContinueLabel(txt)) return b;
  }
  return null;
}

function findContinue() {
  for (const root of continueSearchRoots()) {
    const hit = findContinueInRoot(root);
    if (hit) return hit;
  }

  // Portals / outside last response — keep global fallback
  for (const sel of ['button[data-testid="continue-button"]', 'button[data-testid="message-continue"]']) {
    for (const b of document.querySelectorAll(sel)) {
      if (b.disabled || !isVisible(b)) continue;
      return b;
    }
  }

  for (const el of document.querySelectorAll('[data-testid]')) {
    const id = (el.getAttribute('data-testid') || '').toLowerCase();
    if (!id.includes('continue')) continue;
    const b = el.closest('button') || (el.tagName === 'BUTTON' ? el : null);
    if (b && !b.disabled && isVisible(b)) return b;
  }

  for (const b of document.querySelectorAll('button')) {
    if (b.disabled || !isVisible(b)) continue;
    const lbl = b.getAttribute('aria-label') || '';
    if (looksLikeContinueLabel(lbl)) return b;

    const txt = (b.innerText || '').replace(/\s+/g, ' ').trim();
    if (looksLikeContinueLabel(txt)) return b;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────
// URL SETTLE
// ─────────────────────────────────────────────────────────────

async function settleUrl() {
  let last = location.href, stable = 0;
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    await sleep(100);
    if (location.href === last) {
      stable += 100;
      if (stable >= 1500) return;
    } else {
      log('URL → ' + location.href);
      last = location.href; stable = 0;
    }
  }
}

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────

function poll(fn, timeoutMs, interval = 100) {
  return new Promise(resolve => {
    const deadline = Date.now() + timeoutMs;
    (function check() {
      const r = fn();
      if (r) return resolve(r);
      if (Date.now() >= deadline) return resolve(null);
      setTimeout(check, interval);
    })();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function log(msg)  { console.log('[CPR]', msg); }

// Fire-and-forget — closed popup must NOT crash the loop
function notify(action, extra) {
  try { chrome.runtime.sendMessage({ action, ...extra }).catch(() => {}); } catch(_) {}
}

log('content script loaded — ' + location.href);