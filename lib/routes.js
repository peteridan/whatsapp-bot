const fs = require('fs');
const path = require('path');
const http = require('http');
const { jidNormalizedUser } = require('@whiskeysockets/baileys');
const config = require('./config');
const state = require('./state');
const utils = require('./utils');

function buildStatus() {
    const connected = Boolean(state.sock && state.sock.user);
    const chatIds = Array.from(
        new Set([
            ...Object.keys(state.store.mutedChats),
            ...Object.keys(state.store.autoReplyChats),
            ...Object.keys(state.store.antiLinkChats),
            ...Object.keys(state.store.aiEnabledChats)
        ])
    );

    const knownChatsList = chatIds.map((chatId) => {
        let displayName = chatId;
        return {
            chatId,
            displayName,
            muted: Boolean(state.store.mutedChats[chatId]),
            autoReply: state.store.autoReplyChats[chatId] !== false,
            antiLink: Boolean(state.store.antiLinkChats[chatId]),
            antiSpam: Boolean(state.store.antiSpamChats[chatId]),
            aiEnabled: Boolean(state.store.aiEnabledChats[chatId]),
            aiPrompt: state.store.aiSystemPrompts[chatId] || config.DEFAULT_AI_PROMPT
        };
    });

    return {
        online: connected,
        connectedNumber: state.sock?.user?.id ? jidNormalizedUser(state.sock.user.id) : null,
        uptimeSeconds: Math.max(0, Math.floor(Date.now() / 1000) - state.startupTimeSec),
        messagesHandled: state.totalMessagesHandled,
        commandsHandled: state.totalCommandsHandled,
        knownChats: chatIds.length,
        knownChatsList,
        globalAiEnabled: state.store.globalAiEnabled,
        privateMode: state.store.privateMode,
        autoViewStatus: state.store.autoViewStatus,
        autoBypassViewOnce: state.store.autoBypassViewOnce,
        defaultAiPrompt: state.store.defaultAiPrompt || '',
        defaultAiPersonality: state.store.defaultAiPersonality || 'sarcastic_teen',
        aiPersonalities: config.AI_PERSONALITY_PRESETS.map(p => ({ id: p.id, name: p.name, prompt: p.prompt })),
        theme: state.store.theme || { mode: 'dark', accent: '#25d366' },
        groqKeySet: Boolean(config.GROQ_API_KEY),
        model: config.GROQ_MODEL,
        reconnecting: state.reconnecting,
        logChatId: state.store.logChatId || '',
        autoPromoThresholds: state.store.autoPromoThresholds || [100, 500, 1000],
        scheduledMessages: state.store.scheduledMessages.map((item) => ({
            id: item.id,
            chatId: item.chatId,
            text: item.text,
            sendAt: item.sendAt
        })),
        quotes: state.store.quotes,
        keywordTriggers: state.store.keywordTriggers,
        qrAvailable: fs.existsSync(config.QR_IMAGE_PATH),
        qrToken: state.qrToken,
        qrUpdatedAt: state.qrUpdatedAt,
        serverTime: new Date().toISOString()
    };
}

function sendJson(res, code, data) {
    res.writeHead(code, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
    });
    res.end(JSON.stringify(data));
}

function readJsonBody(req) {
    return new Promise((resolve) => {
        let data = '';
        req.on('data', (chunk) => {
            data += chunk;
            if (data.length > 1e6) {
                req.destroy();
            }
        });
        req.on('end', () => {
            if (!data) {
                return resolve({});
            }
            try {
                resolve(JSON.parse(data));
            } catch {
                resolve({});
            }
        });
        req.on('error', () => resolve({}));
    });
}

function serveStatic(url, req, res) {
    const route = config.STATIC_ROUTES[url];
    if (route) {
        const filePath = path.join(config.PUBLIC_DIR, route.file);
        if (!filePath.startsWith(config.PUBLIC_DIR) || !fs.existsSync(filePath)) {
            return false;
        }
        res.writeHead(200, { 'Content-Type': route.type, 'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': '*' });
        fs.createReadStream(filePath).pipe(res);
        return true;
    }

    const ext = path.extname(url);
    if (ext && config.MIME[ext]) {
        const filePath = path.join(config.PUBLIC_DIR, url.replace(/^\//, ''));
        if (!filePath.startsWith(config.PUBLIC_DIR) || !fs.existsSync(filePath)) {
            return false;
        }
        res.writeHead(200, { 'Content-Type': config.MIME[ext], 'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': '*' });
        fs.createReadStream(filePath).pipe(res);
        return true;
    }

    return false;
}

async function handleApiPost(req, res, url, body) {
    const ok = (extra) => sendJson(res, 200, { ok: true, ...extra });
    const fail = (error, code = 400) => sendJson(res, code, { ok: false, error });

    switch (url) {
        case '/api/settings/global-ai': {
            const enabled = Boolean(body.enabled);
            if (enabled && !config.GROQ_API_KEY) {
                return fail('Set GROQ_API_KEY before enabling AI.');
            }
            state.store.globalAiEnabled = enabled;
            for (const chatId of Object.keys(state.store.aiEnabledChats)) {
                state.store.aiEnabledChats[chatId] = enabled;
            }
            utils.saveStore();
            return ok({ globalAiEnabled: enabled });
        }
        case '/api/settings/private': {
            state.store.privateMode = Boolean(body.enabled);
            utils.saveStore();
            return ok({ privateMode: state.store.privateMode });
        }
        case '/api/settings/ai-prompt': {
            if (body.text !== undefined) {
                state.store.defaultAiPrompt = body.text;
            }
            if (body.personality) {
                state.store.defaultAiPersonality = body.personality;
            }
            utils.saveStore();
            return ok({ defaultAiPrompt: state.store.defaultAiPrompt, defaultAiPersonality: state.store.defaultAiPersonality });
        }
        case '/api/settings/theme': {
            state.store.theme = {
                mode: body.mode === 'light' ? 'light' : 'dark',
                accent: body.accent || '#25d366'
            };
            utils.saveStore();
            return ok({ theme: state.store.theme });
        }
        case '/api/settings/auto-view-status': {
            state.store.autoViewStatus = Boolean(body.enabled);
            utils.saveStore();
            return ok({ autoViewStatus: state.store.autoViewStatus });
        }
        case '/api/settings/auto-bypass-view-once': {
            state.store.autoBypassViewOnce = Boolean(body.enabled);
            utils.saveStore();
            return ok({ autoBypassViewOnce: state.store.autoBypassViewOnce });
        }
        case '/api/chat/mute': {
            state.store.mutedChats[body.chatId] = Boolean(body.muted);
            utils.saveStore();
            return ok({ muted: state.store.mutedChats[body.chatId] });
        }
        case '/api/moderation/antispam': {
            state.store.antiSpamChats[body.chatId] = Boolean(body.enabled);
            utils.saveStore();
            return ok({ antiSpam: state.store.antiSpamChats[body.chatId] });
        }
        case '/api/moderation/antilink': {
            state.store.antiLinkChats[body.chatId] = Boolean(body.enabled);
            utils.saveStore();
            return ok({ antiLink: state.store.antiLinkChats[body.chatId] });
        }
        case '/api/moderation/autoreply': {
            state.store.autoReplyChats[body.chatId] = Boolean(body.enabled);
            utils.saveStore();
            return ok({ autoReply: state.store.autoReplyChats[body.chatId] });
        }
        case '/api/moderation/wordfilter': {
            if (!state.store.wordFilters[body.chatId]) {
                state.store.wordFilters[body.chatId] = [];
            }
            const filters = state.store.wordFilters[body.chatId];
            if (body.action === 'add' && body.word) {
                const word = body.word.toLowerCase();
                if (!filters.includes(word)) {
                    filters.push(word);
                }
            } else if (body.action === 'remove' && body.word) {
                state.store.wordFilters[body.chatId] = filters.filter(w => w !== body.word.toLowerCase());
            }
            utils.saveStore();
            return ok({ filters: state.store.wordFilters[body.chatId] || [] });
        }
        case '/api/broadcast': {
            const text = String(body.text || '').trim();
            if (!text) {
                return fail('Broadcast text is empty.');
            }
            const chats = new Set([
                ...Object.keys(state.store.mutedChats),
                ...Object.keys(state.store.autoReplyChats),
                ...Object.keys(state.store.antiLinkChats),
                ...Object.keys(state.store.aiEnabledChats)
            ]);
            let sent = 0;
            for (const chatId of chats) {
                try {
                    await utils.sendText(chatId, text);
                    sent++;
                } catch (error) {
                    // ignore send failures
                }
            }
            return ok({ sent, total: chats.size });
        }
        case '/api/schedule': {
            state.store.scheduledMessages.push({
                chatId: body.chatId,
                text: body.text,
                sendAt: Date.now() + (Number(body.minutes) || 0) * 60000,
                sent: false
            });
            utils.saveStore();
            utils.scheduleNextMessageCheck();
            return ok({ scheduled: true });
        }
        case '/api/scheduled/clear': {
            state.store.scheduledMessages = state.store.scheduledMessages.filter((item) => item.id !== Number(body.id));
            utils.saveStore();
            return ok({ cleared: true });
        }
        case '/api/quotes/save': {
            const text = String(body.text || '').trim();
            if (!text) {
                return fail('Quote text is empty.');
            }
            state.store.quotes.push({
                text,
                sender: '',
                timestamp: Date.now()
            });
            utils.saveStore();
            return ok({ saved: true });
        }
        case '/api/quotes/clear': {
            state.store.quotes = [];
            utils.saveStore();
            return ok({ cleared: true });
        }
        case '/api/profile-picture': {
            try {
                const jid = body.jid;
                if (!jid || jid === 'status@broadcast') {
                    return ok({ url: null });
                }
                const profile = await state.sock.profilePictureUrl(jid, 'image');
                return ok({ url: profile });
            } catch (error) {
                return ok({ url: null });
            }
        }
        case '/api/restart': {
            sendJson(res, 200, { ok: true, message: 'Restarting...' });
            setTimeout(() => process.exit(1), 1000);
            return;
        }
        case '/api/logchat': {
            state.store.logChatId = body.chatId || '';
            utils.saveStore();
            return ok({ logChatId: state.store.logChatId });
        }
        case '/api/autopromo/thresholds': {
            state.store.autoPromoThresholds = Array.isArray(body.thresholds) ? body.thresholds : [100, 500, 1000];
            utils.saveStore();
            return ok({ autoPromoThresholds: state.store.autoPromoThresholds });
        }
        case '/api/triggers': {
            if (body.action === 'add' && body.keyword && body.reply) {
                state.store.keywordTriggers.push({
                    id: Date.now(),
                    keyword: body.keyword.toLowerCase(),
                    reply: body.reply
                });
                utils.saveStore();
            } else if (body.action === 'delete' && body.id) {
                state.store.keywordTriggers = state.store.keywordTriggers.filter(t => t.id !== Number(body.id));
                utils.saveStore();
            }
            return ok({ triggers: state.store.keywordTriggers });
        }
        default:
            return fail('Unknown API endpoint.', 404);
    }
}

function requestHandler(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`).pathname;

    if (req.method === 'OPTIONS') {
        res.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type'
        });
        res.end();
        return;
    }

    if (req.method === 'POST' && url.startsWith('/api/')) {
        readJsonBody(req).then((body) => {
            handleApiPost(req, res, url, body).catch((error) => {
                sendJson(res, 500, { ok: false, error: String((error && error.message) || error) });
            });
        });
        return;
    }

    if (url === '/api/triggers') {
        sendJson(res, 200, { triggers: state.store.keywordTriggers });
        return;
    }

    if (url === '/api/status') {
        sendJson(res, 200, buildStatus());
        return;
    }

    if (url === '/qr') {
        if (!fs.existsSync(config.QR_IMAGE_PATH)) {
            res.writeHead(404, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
            res.end('QR image not available yet. Wait for bot initialization and scan log output first.');
            return;
        }
        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
        fs.createReadStream(config.QR_IMAGE_PATH).pipe(res);
        return;
    }

    if (url === '/api/events') {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'Access-Control-Allow-Origin': '*'
        });
        state.sseClients.add(res);
        res.write('retry: 2000\n\n');

        const heartbeat = setInterval(() => {
            if (!res.writableEnded) {
                res.write(':\n\n');
            } else {
                clearInterval(heartbeat);
                state.sseClients.delete(res);
            }
        }, 15000);

        req.on('close', () => {
            state.sseClients.delete(res);
            clearInterval(heartbeat);
        });
        return;
    }

    if (url === '/healthz') {
        res.writeHead(200, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
        res.end('OK');
        return;
    }

    if (url === '/favicon.ico') {
        const ico = path.join(config.PUBLIC_DIR, 'favicon.ico');
        if (fs.existsSync(ico)) {
            res.writeHead(200, { 'Content-Type': 'image/x-icon', 'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': '*' });
            fs.createReadStream(ico).pipe(res);
            return;
        }
        res.writeHead(204);
        res.end();
        return;
    }

    if (serveStatic(url, req, res)) return;

    res.writeHead(404, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
    res.end('Not found');
}

function createServerInstance() {
    return http.createServer(requestHandler);
}

module.exports = {
    buildStatus,
    requestHandler,
    createServerInstance
};
