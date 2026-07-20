const POLL_MS = 1000;
let lastQrToken = null;
let lastQrUpdatedAt = 0;
let lastChatKey = '';
let statusCache = null;
let eventSource = null;

// ── Utilities ──────────────────────────────────────────────────────────────────
const el = (id) => document.getElementById(id);

function toast(msg, isErr) {
    const t = el('toast');
    t.textContent = msg;
    t.className = 'toast show' + (isErr ? ' err' : '');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { t.className = 'toast'; }, 2800);
}

async function api(path, body) {
    const res = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {})
    });
    let data = {};
    try { data = await res.json(); } catch { /* ignore */ }
    if (!data.ok) throw new Error(data.error || ('HTTP ' + res.status));
    return data;
}

function fmtUptime(s) {
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = Math.floor(s % 60);
    const p = [];
    if (d) p.push(d + 'd');
    if (h) p.push(h + 'h');
    if (m) p.push(m + 'm');
    p.push(sec + 's');
    return p.join(' ');
}

function esc(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Navigation ─────────────────────────────────────────────────────────────────
function switchPage(page) {
    document.querySelectorAll('.page').forEach((p) => p.classList.remove('active'));
    document.querySelectorAll('#navLinks li').forEach((li) => li.classList.remove('active'));
    const target = el('page-' + page);
    if (target) target.classList.add('active');
    const nav = document.querySelector(`#navLinks li[data-page="${page}"]`);
    if (nav) nav.classList.add('active');
}

document.querySelectorAll('#navLinks li').forEach((li) => {
    li.addEventListener('click', () => switchPage(li.dataset.page));
});

// ── Render: Connection ──────────────────────────────────────────────────────────
function renderConnection(d) {
    const pill = el('statusPill');
    if (pill) {
        if (d.online) {
            pill.textContent = '● Online';
            pill.className = 'status-pill pill-on';
        } else {
            pill.textContent = '● Offline';
            pill.className = 'status-pill pill-off';
        }
    }

    const connectedNumber = el('connectedNumber');
    if (connectedNumber) connectedNumber.textContent = d.connectedNumber || '—';
    const groqKey = el('groqKey');
    if (groqKey) groqKey.textContent = d.groqKeySet ? '✓ set' : '✗ missing';
    const model = el('model');
    if (model) model.textContent = d.model || '—';
    const reconnecting = el('reconnecting');
    if (reconnecting) reconnecting.textContent = d.reconnecting ? 'yes' : 'no';
    const serverTime = el('serverTime');
    if (serverTime) serverTime.textContent = d.serverTime ? new Date(d.serverTime).toLocaleString() : '—';
    const sidebarStatus = el('sidebarStatus');
    if (sidebarStatus) sidebarStatus.textContent = d.connectedNumber || (d.online ? 'Connected' : 'Offline');

    const liveDot = el('liveDot');
    if (liveDot) liveDot.className = d.online ? 'dot live' : 'dot';

    const qrBox = el('qrBox');
    if (!qrBox) return;
    if (d.online) {
        lastQrToken = null;
        lastQrUpdatedAt = 0;
        qrBox.innerHTML = '<p class="qr-hint">✅ Connected — no QR needed.</p>';
    } else if (d.qrAvailable) {
        if (d.qrToken !== lastQrToken || d.qrUpdatedAt !== lastQrUpdatedAt) {
            lastQrToken = d.qrToken;
            lastQrUpdatedAt = d.qrUpdatedAt || 0;
            qrBox.innerHTML = '';
            const img = document.createElement('img');
            img.alt = 'WhatsApp QR code';
            img.src = '/qr?t=' + Date.now();
            qrBox.appendChild(img);
        }
    } else {
        lastQrToken = null;
        lastQrUpdatedAt = 0;
        qrBox.innerHTML = '<p class="qr-hint">Waiting for QR code…</p>';
    }
}

// ── Render: Stats ───────────────────────────────────────────────────────────────
function renderStats(d) {
    const uptime = el('uptime');
    const messagesHandled = el('messagesHandled');
    const commandsHandled = el('commandsHandled');
    const knownChats = el('knownChats');
    if (uptime) uptime.textContent = fmtUptime(d.uptimeSeconds || 0);
    if (messagesHandled) messagesHandled.textContent = d.messagesHandled ?? 0;
    if (commandsHandled) commandsHandled.textContent = d.commandsHandled ?? 0;
    if (knownChats) knownChats.textContent = d.knownChats ?? 0;
}

// ── Render: Settings ────────────────────────────────────────────────────────────
function renderSettings(d) {
    const globalAiToggle = el('globalAiToggle');
    const privateToggle = el('privateToggle');
    const autoViewStatusToggle = el('autoViewStatusToggle');
    const autoBypassViewOnceToggle = el('autoBypassViewOnceToggle');
    if (globalAiToggle) globalAiToggle.checked = Boolean(d.globalAiEnabled);
    if (privateToggle) privateToggle.checked = Boolean(d.privateMode);
    if (autoViewStatusToggle) autoViewStatusToggle.checked = Boolean(d.autoViewStatus);
    if (autoBypassViewOnceToggle) autoBypassViewOnceToggle.checked = Boolean(d.autoBypassViewOnce);

    const darkModeToggle = el('darkModeToggle');
    if (d.theme && darkModeToggle) {
        darkModeToggle.checked = d.theme.mode !== 'light';
        const accent = el('accentColor');
        if (accent) accent.value = d.theme.accent || '#25d366';
        applyTheme(d.theme.mode, d.theme.accent);
    }

    const prompt = el('aiPrompt');
    if (prompt && document.activeElement !== prompt && prompt.value !== (d.defaultAiPrompt || '')) {
        prompt.value = d.defaultAiPrompt || '';
    }

    const sel = el('aiPersonality');
    if (sel && d.aiPersonalities) {
        const current = d.defaultAiPersonality || '';
        if (!sel.options.length || sel.dataset.key !== JSON.stringify(d.aiPersonalities)) {
            sel.dataset.key = JSON.stringify(d.aiPersonalities);
            sel.innerHTML = '<option value="">Custom (use text below)</option>' +
                d.aiPersonalities.map(p => `<option value="${esc(p.id)}" data-prompt="${esc(p.prompt)}">${esc(p.name)}</option>`).join('');
        }
        if (sel.value !== current) {
            sel.value = current;
        }
    }

    const thresh = el('autoPromoThresholds');
    if (thresh && document.activeElement !== thresh) {
        thresh.value = (d.autoPromoThresholds || [100, 500, 1000]).join(', ');
    }

    const logInput = el('logChatInput');
    if (logInput && document.activeElement !== logInput) {
        logInput.value = d.logChatId || '';
    }
    const logChatInfo = el('logChatInfo');
    if (logChatInfo) {
        logChatInfo.textContent = d.logChatId
            ? '📌 Currently logging to: ' + d.logChatId
            : 'No log chat configured.';
    }

    renderTriggers(d.keywordTriggers || []);
}

// ── Render: Chats ───────────────────────────────────────────────────────────────
function renderChats(d) {
    const wrap = el('chatList');
    const list = d.knownChatsList || [];
    if (!wrap) return;
    if (!list.length) {
        wrap.innerHTML = '<p class="muted">No known chats yet.</p>';
        return;
    }
    const key = list.map((c) => c.chatId + (c.muted ? 'M' : '') + (c.aiEnabled ? 'A' : '') + (c.antiSpam ? 'S' : '')).join('|');
    if (key === lastChatKey) return;
    lastChatKey = key;

    wrap.innerHTML = list.map((c) => {
        const tags = [
            c.aiEnabled  ? '<span class="tag on">AI</span>'        : '<span class="tag">AI off</span>',
            c.autoReply  ? '<span class="tag on">Auto</span>'      : '',
            c.antiLink   ? '<span class="tag on">AntiLink</span>'  : '',
            c.antiSpam   ? '<span class="tag on">AntiSpam</span>'  : '',
            c.muted      ? '<span class="tag warn">Muted</span>'   : ''
        ].filter(Boolean).join('');
        return `<div class="chat-row">
            <img class="chat-avatar" data-jid="${esc(c.chatId)}" alt="" />
            <div class="chat-id">
                <div class="chat-name">${esc(c.displayName || c.chatId)}</div>
                <div class="chat-jid">${esc(c.chatId)}</div>
            </div>
            <div class="chat-tags">${tags}</div>
            <button class="mini-btn" data-chat="${esc(c.chatId)}" data-action="${c.muted ? 'unmute' : 'mute'}">
                ${c.muted ? 'Unmute' : 'Mute'}
            </button>
        </div>`;
    }).join('');

    loadProfilePictures();
}

async function loadProfilePictures() {
    const images = document.querySelectorAll('.chat-avatar');
    for (const img of images) {
        const jid = img.dataset.jid;
        if (!jid || jid === 'status@broadcast') continue;
        try {
            const data = await api('/api/profile-picture', { jid });
            if (data.url) {
                img.src = data.url;
            }
        } catch (e) {
            // leave empty on error
        }
    }
}

// ── Render: Scheduled messages ──────────────────────────────────────────────────
function renderScheduled(d) {
    const list = d.scheduledMessages || [];
    const wrap = el('scheduledList');
    if (!wrap) {
        return;
    }
    if (!list.length) {
        wrap.innerHTML = '<p class="muted">No scheduled messages.</p>';
    } else {
        wrap.innerHTML = list.map((m) => `<div class="list-row">
            <div style="min-width:0;flex:1">
                <div class="txt">${esc(m.text)}</div>
                <div class="meta">${esc(m.chatId)} · in ${Math.max(0, Math.round((m.sendAt - Date.now()) / 60000))}m</div>
            </div>
            <button class="mini-btn" data-sched-id="${m.id}">Clear</button>
        </div>`).join('');
    }
    const sel = el('scheduleChat');
    if (!sel) return;
    const chats = d.knownChatsList || [];
    if (chats.length && (!sel.options.length || sel.dataset.key !== String(chats.length))) {
        sel.dataset.key = String(chats.length);
        sel.innerHTML = chats.map((c) => `<option value="${esc(c.chatId)}">${esc(c.chatId)}</option>`).join('');
    }
}

// ── Render: Quotes ──────────────────────────────────────────────────────────────
function renderQuotes(d) {
    const wrap = el('quoteList');
    if (!wrap) return;
    const list = d.quotes || [];
    if (!list.length) {
        wrap.innerHTML = '<p class="muted">No quotes saved.</p>';
        return;
    }
    wrap.innerHTML = list.slice(-15).reverse().map((q) => `<div class="list-row">
        <div style="min-width:0;flex:1">
            <div class="txt">"${esc(q.text)}"</div>
            <div class="meta">${esc(q.sender || 'unknown')}</div>
        </div>
    </div>`).join('');
}

// ── Render: Triggers ────────────────────────────────────────────────────────────
function renderTriggers(list) {
    const wrap = el('triggerList');
    if (!wrap) return;
    if (!list.length) {
        wrap.innerHTML = '<p class="muted">No keyword triggers configured.</p>';
        return;
    }
    wrap.innerHTML = list.map((t) => `<div class="list-row">
        <div style="min-width:0;flex:1">
            <div class="txt"><strong>${esc(t.keyword)}</strong></div>
            <div class="meta">${esc(t.reply)}</div>
        </div>
        <button class="mini-btn" data-trigger-id="${t.id}">Delete</button>
    </div>`).join('');
}

// ── Render all ──────────────────────────────────────────────────────────────────
function renderAll(d) {
    renderConnection(d);
    renderStats(d);
    renderSettings(d);
    renderChats(d);
    renderScheduled(d);
    renderQuotes(d);
    renderTriggers(d.keywordTriggers || []);
    el('lastUpdateText').textContent = 'Updated ' + new Date().toLocaleTimeString();
    refreshModerationChatOptions();
    const modChat = el('modChatSelect');
    if (modChat && modChat.value) applyModerationState(modChat.value);
}

// ── Poll ────────────────────────────────────────────────────────────────────────
async function refresh() {
    try {
        console.log('refresh: fetching /api/status');
        const res = await fetch('/api/status');
        console.log('refresh: status', res.status);
        if (!res.ok) {
            console.log('refresh: bad response');
            return;
        }
        statusCache = await res.json();
        console.log('refresh: data', statusCache);
        renderAll(statusCache);
        el('liveDot').className = 'dot live';
    } catch (e) {
        console.error('refresh failed', e);
        el('liveDot').className = 'dot';
    }
}

// ── Action helper ───────────────────────────────────────────────────────────────
async function act(fn, okMsg, errMsg, sourceEl) {
    const prevChecked = sourceEl ? sourceEl.checked : undefined;
    try {
        await fn();
        if (okMsg) toast(okMsg);
        await refresh();
    } catch (e) {
        if (sourceEl && prevChecked !== undefined) {
            sourceEl.checked = !prevChecked;
            if (sourceEl.dataset.prevValue !== undefined) {
                sourceEl.value = sourceEl.dataset.prevValue;
            }
        }
        toast((errMsg ? errMsg + ': ' : '') + e.message, true);
    }
}

function applyTheme(mode, accent) {
    document.documentElement.setAttribute('data-theme', mode);
    if (accent) {
        document.documentElement.style.setProperty('--accent', accent);
        document.documentElement.style.setProperty('--accent-dim', accent + '22');
    }
}

// ══ SETTINGS PAGE ══════════════════════════════════════════════════════════════
el('darkModeToggle').addEventListener('change', (e) => {
    const mode = e.target.checked ? 'dark' : 'light';
    const accent = el('accentColor').value;
    act(() => api('/api/settings/theme', { mode, accent }),
        'Theme updated', 'Could not update theme', e.target);
});

el('accentColor').addEventListener('change', (e) => {
    const mode = el('darkModeToggle').checked ? 'dark' : 'light';
    act(() => api('/api/settings/theme', { mode, accent: e.target.value }),
        'Accent color updated', 'Could not update accent', e.target);
});
el('globalAiToggle').addEventListener('change', (e) =>
    act(() => api('/api/settings/global-ai', { enabled: e.target.checked }),
        'Global AI ' + (e.target.checked ? 'enabled' : 'disabled'),
        'Could not change Global AI', e.target));

el('privateToggle').addEventListener('change', (e) =>
    act(() => api('/api/settings/private', { enabled: e.target.checked }),
        'Private mode ' + (e.target.checked ? 'on' : 'off'),
        'Could not change private mode', e.target));

el('autoViewStatusToggle').addEventListener('change', (e) =>
    act(() => api('/api/settings/auto-view-status', { enabled: e.target.checked }),
        'Auto-view status ' + (e.target.checked ? 'on' : 'off'),
        'Could not change auto-view status', e.target));

el('autoBypassViewOnceToggle').addEventListener('change', (e) =>
    act(() => api('/api/settings/auto-bypass-view-once', { enabled: e.target.checked }),
        'Auto-bypass view-once ' + (e.target.checked ? 'on' : 'off'),
        'Could not change auto-bypass view-once', e.target));

el('savePrompt').addEventListener('click', () =>
    act(() => api('/api/settings/ai-prompt', { text: el('aiPrompt').value, personality: el('aiPersonality').value }),
        'AI prompt saved', 'Could not save prompt'));

const personalitySelect = el('aiPersonality');
if (personalitySelect) {
    personalitySelect.addEventListener('change', () => {
        const val = personalitySelect.value;
        const promptEl = el('aiPrompt');
        if (val && promptEl) {
            const opt = personalitySelect.querySelector(`option[value="${val}"]`);
            if (opt) {
                promptEl.value = opt.dataset.prompt || '';
                act(() => api('/api/settings/ai-prompt', { text: promptEl.value, personality: val }),
                    'Personality applied', 'Could not apply personality');
            }
        }
    });
}

el('saveAutoPromo').addEventListener('click', () => {
    const raw = el('autoPromoThresholds').value;
    const thresholds = raw.split(/[,\s]+/).map(Number).filter((n) => n > 0);
    if (!thresholds.length) { toast('Enter at least one number', true); return; }
    act(() => api('/api/autopromo/thresholds', { thresholds }),
        'Thresholds saved ✅', 'Could not save');
});

el('sendBroadcast').addEventListener('click', async () => {
    const text = el('broadcastText').value.trim();
    if (!text) { toast('Enter broadcast text', true); return; }
    try {
        const r = await api('/api/broadcast', { text });
        toast('Broadcast sent to ' + r.sent + '/' + r.total + ' chats');
        el('broadcastText').value = '';
        el('broadcastInfo').textContent = 'Last sent to ' + r.sent + ' chats';
        refresh();
    } catch (e) {
        toast('Broadcast failed: ' + e.message, true);
    }
});

el('restartBtn').addEventListener('click', () => {
    if (!confirm('Restart the bot? It will reconnect automatically.')) return;
    act(() => api('/api/restart', {}), 'Restarting…', 'Could not restart');
});

// ══ CHATS PAGE ═════════════════════════════════════════════════════════════════
el('chatList').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-chat]');
    if (!btn) return;
    const chatId  = btn.dataset.chat;
    const muted   = btn.dataset.action === 'mute';
    act(() => api('/api/chat/mute', { chatId, muted }),
        muted ? 'Chat muted' : 'Chat unmuted', 'Could not update chat');
});

el('scheduleBtn').addEventListener('click', () => {
    const chatId  = el('scheduleChat').value;
    const minutes = Number(el('scheduleMinutes').value);
    const text    = el('scheduleText').value.trim();
    if (!minutes || !text) { toast('Minutes and text required', true); return; }
    act(() => api('/api/schedule', { chatId, minutes, text }),
        'Message scheduled', 'Could not schedule').then(() => {
            el('scheduleText').value = '';
            el('scheduleMinutes').value = '';
        });
});

el('scheduledList').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-sched-id]');
    if (!btn) return;
    act(() => api('/api/scheduled/clear', { id: Number(btn.dataset.schedId) }),
        'Scheduled message cleared', 'Could not clear');
});

// ══ MODERATION PAGE ══════════════════════════════════════════════════════════════
const modChatSelect = el('modChatSelect');
const modAntiSpam = el('modAntiSpam');
const modAntiLink = el('modAntiLink');
const modAutoReply = el('modAutoReply');
const modInfo = el('modInfo');
const modWordInput = el('modWordInput');
const modWordList = el('modWordList');

function refreshModerationChatOptions() {
    if (!modChatSelect) return;
    const list = statusCache?.knownChatsList || [];
    if (!modChatSelect.options.length || String(modChatSelect.dataset.key) !== String(list.length)) {
        modChatSelect.dataset.key = String(list.length);
        modChatSelect.innerHTML = list.map((c) => `<option value="${esc(c.chatId)}">${esc(c.displayName || c.chatId)}</option>`).join('');
    }
}

function applyModerationState(chatId) {
    if (!chatId || !statusCache) return;
    const chat = (statusCache.knownChatsList || []).find((c) => c.chatId === chatId);
    if (!chat) return;
    if (modAntiSpam) modAntiSpam.checked = Boolean(chat.antiSpam);
    if (modAntiLink) modAntiLink.checked = Boolean(chat.antiLink);
    if (modAutoReply) modAutoReply.checked = Boolean(chat.autoReply);
    if (modInfo) modInfo.textContent = 'Managing: ' + (chat.displayName || chatId);
    renderModerationWordList(chatId);
}

async function renderModerationWordList(chatId) {
    if (!modWordList || !chatId) return;
    try {
        const data = await api('/api/moderation/wordfilter', { chatId });
        const filters = data.filters || [];
        if (!filters.length) {
            modWordList.innerHTML = '<p class="muted">No blocked words.</p>';
            return;
        }
        modWordList.innerHTML = filters.map((word) => `<div class="list-row">
            <div style="min-width:0;flex:1"><div class="txt">${esc(word)}</div></div>
            <button class="mini-btn" data-mod-word="${esc(word)}">Remove</button>
        </div>`).join('');
    } catch (e) {
        modWordList.innerHTML = '';
    }
}

if (modChatSelect) {
    modChatSelect.addEventListener('change', () => applyModerationState(modChatSelect.value));
}

if (modAntiSpam) {
    modAntiSpam.addEventListener('change', (e) => {
        const chatId = modChatSelect?.value;
        if (!chatId) return;
        act(() => api('/api/moderation/antispam', { chatId, enabled: e.target.checked }),
            'Anti-spam ' + (e.target.checked ? 'enabled' : 'disabled'), 'Could not update anti-spam', e.target);
    });
}

if (modAntiLink) {
    modAntiLink.addEventListener('change', (e) => {
        const chatId = modChatSelect?.value;
        if (!chatId) return;
        act(() => api('/api/moderation/antilink', { chatId, enabled: e.target.checked }),
            'Anti-link ' + (e.target.checked ? 'enabled' : 'disabled'), 'Could not update anti-link', e.target);
    });
}

if (modAutoReply) {
    modAutoReply.addEventListener('change', (e) => {
        const chatId = modChatSelect?.value;
        if (!chatId) return;
        act(() => api('/api/moderation/autoreply', { chatId, enabled: e.target.checked }),
            'Auto-reply ' + (e.target.checked ? 'enabled' : 'disabled'), 'Could not update auto-reply', e.target);
    });
}

const modWordAdd = el('modWordAdd');
if (modWordAdd) {
    modWordAdd.addEventListener('click', async () => {
        const chatId = modChatSelect?.value;
        const word = modWordInput?.value.trim();
        if (!chatId) return;
        if (!word) { toast('Enter a word to block', true); return; }
        await api('/api/moderation/wordfilter', { chatId, action: 'add', word });
        const input = modWordInput;
        if (input) input.value = '';
        renderModerationWordList(chatId);
    });
}

const modWordRefresh = el('modWordRefresh');
if (modWordRefresh) {
    modWordRefresh.addEventListener('click', () => {
        const chatId = modChatSelect?.value;
        if (!chatId) return;
        renderModerationWordList(chatId);
    });
}

if (modWordList) {
    modWordList.addEventListener('click', async (e) => {
        const btn = e.target.closest('button[data-mod-word]');
        if (!btn) return;
        const chatId = modChatSelect?.value;
        const word = btn.dataset.modWord;
        if (!chatId || !word) return;
        await api('/api/moderation/wordfilter', { chatId, action: 'remove', word });
        renderModerationWordList(chatId);
    });
}

el('saveLogChat').addEventListener('click', () => {
    const chatId = el('logChatInput').value.trim();
    if (!chatId) { toast('Enter a chat ID', true); return; }
    act(() => api('/api/logchat', { chatId }),
        'Log chat saved ✅', 'Could not save log chat');
});

el('clearLogChat').addEventListener('click', () =>
    act(() => api('/api/logchat', { chatId: '' }),
        'Log chat cleared', 'Could not clear'));

const saveQuoteBtn = el('saveQuote');
if (saveQuoteBtn) {
    saveQuoteBtn.addEventListener('click', () => {
        const text = el('quoteText').value.trim();
        if (!text) { toast('Enter quote text', true); return; }
        act(() => api('/api/quotes/save', { text }),
            'Quote saved', 'Could not save quote')
            .then(() => { const q = el('quoteText'); if (q) q.value = ''; });
    });
}

const clearQuotesBtn = el('clearQuotes');
if (clearQuotesBtn) {
    clearQuotesBtn.addEventListener('click', () =>
        act(() => api('/api/quotes/clear', {}),
            'All quotes cleared', 'Could not clear quotes'));
}

el('addTrigger').addEventListener('click', () => {
    const keyword = el('triggerKeyword').value.trim().toLowerCase();
    const reply = el('triggerReply').value.trim();
    if (!keyword || !reply) { toast('Keyword and reply required', true); return; }
    act(() => api('/api/triggers', { action: 'add', keyword, reply }),
        'Trigger added', 'Could not add trigger').then(() => {
            el('triggerKeyword').value = '';
            el('triggerReply').value = '';
        });
});

el('triggerList').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-trigger-id]');
    if (!btn) return;
    act(() => api('/api/triggers', { action: 'delete', id: Number(btn.dataset.triggerId) }),
        'Trigger deleted', 'Could not delete trigger');
});

// ══ INIT ═══════════════════════════════════════════════════════════════════════
refresh();
setInterval(refresh, POLL_MS);

if (typeof EventSource !== 'undefined') {
    eventSource = new EventSource('/api/events');
    eventSource.onmessage = (event) => {
        try {
            const msg = JSON.parse(event.data);
            if (msg.type === 'status') {
                statusCache = { ...(statusCache || {}), ...msg };
                renderAll(statusCache);
            }
        } catch {
            /* ignore malformed events */
        }
    };
    eventSource.onerror = () => {
        el('liveDot').className = 'dot';
    };
}
