// ═══════════════════════════════════════════════════════════════
// POPUP.JS — Claude Prompt Runner v2
// ═══════════════════════════════════════════════════════════════

const $  = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);

// ── Tabs ──
$$('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    $$('.tab').forEach(t => t.classList.remove('active'));
    $$('.panel').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    $(`#panel-${tab.dataset.tab}`).classList.add('active');
  });
});

// ── Load saved state ──
chrome.storage.local.get(['masterPrompt','delay','timeout','countries','runState'], d => {
  if (d.masterPrompt) { $('#promptInput').value = d.masterPrompt; updateStats(); }
  if (d.delay)     $('#delayInput').value   = d.delay;
  if (d.timeout)   $('#timeoutInput').value = d.timeout;
  if (d.countries) $('#countriesInput').value = d.countries;
  if (d.runState?.running) restoreUI(d.runState);
});

// ── Prompt panel ──
$('#promptInput').addEventListener('input', () => {
  clearTimeout(window._t);
  window._t = setTimeout(() => {
    chrome.storage.local.set({ masterPrompt: $('#promptInput').value.trim() });
    updateStats();
  }, 800);
});
$('#btnSavePrompt').addEventListener('click', () => {
  chrome.storage.local.set({ masterPrompt: $('#promptInput').value.trim() }, flash);
  updateStats();
});
$('#btnClearPrompt').addEventListener('click', () => {
  $('#promptInput').value = '';
  chrome.storage.local.set({ masterPrompt: '' });
  updateStats();
});

function updateStats() {
  const t = $('#promptInput').value;
  const has = t.includes('{{COUNTRY_REGION}}');
  $('#promptStats').textContent = `${t.length.toLocaleString()} chars${has ? ' · placeholder ✓' : t.length ? ' · ⚠ no {{COUNTRY_REGION}}' : ''}`;
}

// ── Settings ──
$('#btnSaveSettings').addEventListener('click', () => {
  chrome.storage.local.set({
    delay:   parseInt($('#delayInput').value)   || 5,
    timeout: parseInt($('#timeoutInput').value) || 600,
  }, flash);
});

// ── Run / Stop ──
$('#btnStart').addEventListener('click', startRun);
$('#btnStop').addEventListener('click',  stopRun);

function startRun() {
  const raw = $('#countriesInput').value.trim();
  if (!raw) return setStatus('Enter at least one region', 'error');

  chrome.storage.local.get(['masterPrompt'], d => {
    const prompt = d.masterPrompt?.trim();
    if (!prompt)                              return setStatus('No prompt saved', 'error');
    if (!prompt.includes('{{COUNTRY_REGION}}')) return setStatus('Prompt missing {{COUNTRY_REGION}}', 'error');

    const countries = raw.split('\n').map(c => c.trim()).filter(Boolean);
    chrome.storage.local.set({ countries: raw });

    const delay   = parseInt($('#delayInput').value)   || 5;
    const timeout = parseInt($('#timeoutInput').value) || 600;

    const state = { running: true, countries, currentIndex: 0, delay, timeout, prompt };
    chrome.storage.local.set({ runState: state }, async () => {
      showRunning(state);
      await sendMsg('START_RUN', state);
    });
  });
}

function stopRun() {
  chrome.storage.local.get(['runState'], d => {
    if (d.runState) { d.runState.running = false; chrome.storage.local.set({ runState: d.runState }); }
  });
  sendMsg('STOP_RUN', {});
  resetUI();
  setStatus('Stopped', 'error');
}

// ── UI state ──
function showRunning(state) {
  $('#btnStart').style.display = 'none';
  $('#btnStop').style.display  = 'inline-flex';
  $('#countriesInput').disabled = true;
  $('#progressSection').style.display = 'flex';
  renderQueue(state);
  renderProgress(state);
}

function restoreUI(state) {
  showRunning(state);
  setStatus(`Running: ${state.countries[state.currentIndex] || '…'}`, 'running');
}

function resetUI() {
  $('#btnStart').style.display = 'inline-flex';
  $('#btnStop').style.display  = 'none';
  $('#countriesInput').disabled = false;
  $('#progressSection').style.display = 'none';
  $('#countryQueue').style.display    = 'none';
}

function renderQueue(state) {
  const q = $('#countryQueue');
  q.style.display = 'block';
  q.innerHTML = state.countries.map((c, i) => {
    const cls = i < state.currentIndex ? 'ci-done'
              : i === state.currentIndex && state.running ? 'ci-active'
              : 'ci-pending';
    return `<div class="country-item ${cls}"><span class="ci-dot"></span>${c}</div>`;
  }).join('');
}

function renderProgress(state) {
  const pct = state.countries.length ? Math.round(state.currentIndex / state.countries.length * 100) : 0;
  $('#progressFill').style.width = pct + '%';
  $('#progressText').textContent = `${state.currentIndex} / ${state.countries.length}`;
}

function setStatus(text, type = 'idle') {
  const el = $('#statusText');
  el.textContent = text;
  el.className   = `status-${type}`;
}

function flash() {
  const el = $('#savedFlash');
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 1500);
}

// ── Message to content script ──
async function sendMsg(action, data) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url?.includes('claude.ai')) {
    setStatus('Open claude.ai first', 'error');
    resetUI();
    return;
  }
  try {
    await chrome.tabs.sendMessage(tab.id, { action, data });
  } catch {
    // Content script not yet injected — inject it first
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
      await new Promise(r => setTimeout(r, 200));
      await chrome.tabs.sendMessage(tab.id, { action, data });
    } catch(e) {
      setStatus('Reload the Claude page and try again', 'error');
      resetUI();
    }
  }
}

// ── Messages from content script ──
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.action === 'COUNTRY_STARTED') {
    chrome.storage.local.get(['runState'], d => {
      if (!d.runState) return;
      d.runState.currentIndex = msg.index;
      chrome.storage.local.set({ runState: d.runState });
      renderQueue(d.runState);
      renderProgress(d.runState);
      setStatus(`Sending: ${msg.country}`, 'running');
    });
  }
  if (msg.action === 'COUNTRY_WAITING') {
    setStatus(`Waiting: ${msg.country}`, 'running');
  }
  if (msg.action === 'COUNTRY_DONE') {
    chrome.storage.local.get(['runState'], d => {
      if (!d.runState) return;
      d.runState.currentIndex = msg.index + 1;
      chrome.storage.local.set({ runState: d.runState });
      renderQueue(d.runState);
      renderProgress(d.runState);
      setStatus(`✓ ${msg.country} — waiting ${d.runState.delay}s…`, 'done');
    });
  }
  if (msg.action === 'ALL_DONE') {
    chrome.storage.local.get(['runState'], d => {
      if (!d.runState) return;
      d.runState.running      = false;
      d.runState.currentIndex = d.runState.countries.length;
      chrome.storage.local.set({ runState: d.runState });
      renderQueue(d.runState);
      renderProgress(d.runState);
    });
    setStatus(`✅ All ${msg.total} done!`, 'done');
    resetUI();
    $('#btnStart').style.display = 'inline-flex';
  }
  if (msg.action === 'RUN_ERROR') {
    setStatus(`Error: ${msg.error}`, 'error');
    resetUI();
  }
});