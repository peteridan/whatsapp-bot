const http = require('http');
const fs = require('fs');
const path = require('path');

require('dotenv').config();

const QRCode = require('qrcode');
const qrcode = require('qrcode-terminal');
const sharp = require('sharp');
const cheerio = require('cheerio');
const { execSync } = require('child_process');
const {
    default: makeWASocket,
    DisconnectReason,
    fetchLatestBaileysVersion,
    getContentType,
    jidNormalizedUser,
    useMultiFileAuthState,
    downloadMediaMessage
} = require('@whiskeysockets/baileys');

const PREFIX = '!';
const DATA_FILE = path.join(__dirname, 'bot-data.json');
const AUTH_PATH = process.env.BAILEYS_AUTH_PATH || path.join(__dirname, '.baileys_auth');
const QR_IMAGE_PATH = path.join(AUTH_PATH, 'whatsapp-qr.png');
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
const DEFAULT_AI_PROMPT = 'Act as a sarcastic, nonchalant 16-year-old. You have a massive attitude, you easily get annoyed, and you absolutely love talking back to people when they annoy you or ask stupid questions.';

const AI_PERSONALITY_PRESETS = [
    { id: 'sarcastic_teen',   name: 'Sarcastic Teen',     prompt: DEFAULT_AI_PROMPT },
    { id: 'professional',     name: 'Professional Assistant', prompt: 'You are a professional, helpful assistant. Be concise, polite, and solution-oriented. Avoid slang or casual language.' },
    { id: 'customer_support', name: 'Customer Support',   prompt: 'You are a friendly customer support agent. Be empathetic, clear, and patient. Always offer to escalate issues you cannot resolve.' },
    { id: 'tech_expert',      name: 'Tech Expert',        prompt: 'You are a senior software engineer and tech expert. Explain concepts clearly with examples. Use technical terms when appropriate but keep explanations accessible.' },
    { id: 'motivational',     name: 'Motivational Coach', prompt: 'You are an energetic motivational coach. Be encouraging, use positive language, and help people push through challenges.' },
    { id: 'mysterious',       name: 'Mysterious Oracle',  prompt: 'You are a cryptic oracle. Speak in riddles and metaphors. Be playful but vague. Never give straight answers.' }
];
const chatHistories = new Map();
const groupMessageBuffers = new Map();
const seenMessageIds = new Set();
const sentMessageIds = new Set();
const spamTracker = new Map(); // key: `${chatId}:${userId}` => [timestamp, ...]

let sock;
let reconnecting = false;
let reconnectTimer = null;
let reconnectAttempts = 0;
let qrToken = 0;
let qrUpdatedAt = 0;
let qrWatchdogTimer = null;
let scheduledMessagesTimer = null;
let startupTimeSec = Math.floor(Date.now() / 1000);
let totalMessagesHandled = 0;
let totalCommandsHandled = 0;
const sseClients = new Set();

function broadcastSse(data) {
    const payload = 'data: ' + JSON.stringify(data) + '\n\n';
    for (const res of sseClients) {
        try {
            if (!res.writableEnded) {
                res.write(payload);
            }
        } catch {
            sseClients.delete(res);
        }
    }
}

async function broadcastStatus() {
    try {
        const status = await buildStatus();
        broadcastSse({ type: 'status', ...status });
    } catch (error) {
        console.error('broadcastStatus failed:', error);
    }
}

function createDefaultStore() {
    return {
        mutedChats: {},
        autoReplyChats: {},
        antiLinkChats: {},
        aiEnabledChats: {},
        aiSystemPrompts: {},
        globalAiEnabled: false,
        privateMode: false,
        defaultAiPrompt: '',
        defaultAiPersonality: 'sarcastic_teen',
        theme: {
            mode: 'dark',
            accent: '#25d366'
        },
        autoViewStatus: false,
        autoBypassViewOnce: false,
        quotes: [],
        keywordTriggers: [],
        welcomeMessages: {},
        wordFilters: {},
        scheduledMessages: [],
        antiSpamChats: {},
        antiSpamSettings: {},
        userWarnings: {},
        logChatId: '',
        messageMilestones: {},
        autoPromoEnabled: {},
        autoPromoThresholds: [100, 500, 1000]
    };
}

function loadStore() {
    if (!fs.existsSync(DATA_FILE)) {
        return createDefaultStore();
    }

    try {
        return {
            ...createDefaultStore(),
            ...JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))
        };
    } catch (error) {
        console.error('Failed to read bot-data.json, using empty settings:', error);
        return createDefaultStore();
    }
}

const store = loadStore();

function saveStore() {
    fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2));
}

function scheduleQrWatchdog() {
    if (qrWatchdogTimer) {
        clearTimeout(qrWatchdogTimer);
    }

    qrWatchdogTimer = setTimeout(() => {
        qrWatchdogTimer = null;

        if (sock && sock.user) {
            return;
        }

        if (reconnecting) {
            return;
        }

        console.log('QR not scanned in time. Restarting socket to fetch a fresh QR code...');
        startSock();
    }, 60000);
}

function clearQrWatchdog() {
    if (qrWatchdogTimer) {
        clearTimeout(qrWatchdogTimer);
        qrWatchdogTimer = null;
    }
}
function clearScheduledMessagesTimer() {
    if (scheduledMessagesTimer) {
        clearTimeout(scheduledMessagesTimer);
        scheduledMessagesTimer = null;
    }
}

async function processDueScheduledMessages() {
    const now = Date.now();
    const due = store.scheduledMessages.filter((item) => item.sendAt <= now && !item.sent);

    for (const item of due) {
        try {
            await sendText(item.chatId, item.text, item.options || {});
            item.sent = true;
            item.sentAt = now;
        } catch (error) {
            console.error('Scheduled message failed:', error);
            item.failed = true;
            item.error = String(error.message);
        }
    }

    store.scheduledMessages = store.scheduledMessages.filter((item) => !item.sent);
    saveStore();
}

function scheduleNextMessageCheck() {
    clearScheduledMessagesTimer();

    if (!store.scheduledMessages.length) {
        return;
    }

    const next = store.scheduledMessages
        .filter((item) => !item.sent)
        .sort((a, b) => a.sendAt - b.sendAt)[0];

    if (!next) {
        clearScheduledMessagesTimer();
        return;
    }

    const delayMs = Math.max(1000, next.sendAt - Date.now());
    scheduledMessagesTimer = setTimeout(async () => {
        scheduledMessagesTimer = null;
        try {
            await processDueScheduledMessages();
        } catch (error) {
            console.error('Scheduled message processing failed:', error);
        } finally {
            scheduleNextMessageCheck();
        }
    }, delayMs);
}

async function hasInternetConnection() {
    try {
        const response = await fetch('https://www.gstatic.com/generate_204', {
            method: 'HEAD',
            signal: AbortSignal.timeout(2000)
        });

        return response.ok || response.status === 204 || response.status === 200;
    } catch (error) {
        return false;
    }
}

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ensureStartedWhenOnline() {
    while (true) {
        const online = await hasInternetConnection();

        if (online) {
            try {
                console.log('Internet connection detected. Starting WhatsApp bot...');
                await startSock();
                return;
            } catch (error) {
                console.error('Bot start failed, retrying in 3 seconds:', error);
            }
        } else {
            console.log('No internet connection available. Retrying in 3 seconds...');
        }

        await delay(3000);
    }
}

function ensureChatSettings(chatId) {
    if (!(chatId in store.mutedChats)) {
        store.mutedChats[chatId] = false;
    }

    if (!(chatId in store.autoReplyChats)) {
        store.autoReplyChats[chatId] = true;
    }

    if (!(chatId in store.antiLinkChats)) {
        store.antiLinkChats[chatId] = false;
    }

    if (!(chatId in store.aiEnabledChats)) {
        store.aiEnabledChats[chatId] = store.globalAiEnabled;
    }

    if (!(chatId in store.aiSystemPrompts)) {
        store.aiSystemPrompts[chatId] = store.defaultAiPrompt || DEFAULT_AI_PROMPT;
    }

    if (!(chatId in store.antiSpamChats)) {
        store.antiSpamChats[chatId] = false;
    }

    if (!(chatId in store.antiSpamSettings)) {
        store.antiSpamSettings[chatId] = { maxMessages: 5, windowSeconds: 5 };
    }

    if (!(chatId in store.autoPromoEnabled)) {
        store.autoPromoEnabled[chatId] = false;
    }
}

saveStore();

function getBaseUserId(value) {
    if (!value) {
        return '';
    }

    return String(value).split('@')[0].split(':')[0];
}

function getTextFromMessage(message) {
    if (!message?.message) {
        return '';
    }

    const contentType = getContentType(message.message);

    if (!contentType) {
        return '';
    }

    const content = message.message[contentType];

    if (typeof content === 'string') {
        return content;
    }

    if (contentType === 'conversation') {
        return message.message.conversation || '';
    }

    if (contentType === 'extendedTextMessage') {
        return content.text || '';
    }

    if (contentType === 'imageMessage' || contentType === 'videoMessage') {
        return content.caption || '';
    }

    if (contentType === 'audioMessage' || contentType === 'pttMessage') {
        return '';
    }

    if (contentType === 'ephemeralMessage' || contentType === 'viewOnceMessageV2' || contentType === 'viewOnceMessageV2Extension') {
        return getTextFromMessage({
            message: content.message
        });
    }

    return '';
}

function isGreeting(text) {
    return /^(hi|hello|hey|good morning|good afternoon|good evening|how are you|how are u|how far|sup|what's up|whats up|who are you|who are u|who re u|who r u)\b/i.test(text.trim());
}

function hasLink(text) {
    return /(https?:\/\/|www\.|chat\.whatsapp\.com\/)/i.test(text);
}

function formatMenu() {
    const sections = [
        { title: 'General', items: [
            '!menu - Show this menu',
            '!ping - Check if the bot is online',
            '!echo <text> - Repeat your text',
            '!time - Show server time',
            '!info - Show bot status',
            '!chatid - Show the current chat ID',
            '!owner - Show the connected bot number',
            '!uptime - Show bot uptime',
            '!stats - Show bot usage stats',
            '!debug - Show diagnostic info for this chat',
            '!restart - Restart the bot process (owner only)',
            '!private on|off - Owner only: restrict bot to yourself'
        ]},
        { title: 'AI', items: [
            '!ask <question> - Ask the AI a one-off question',
            '!ai on/off/status - Control AI chat mode in this chat',
            '!globalai on/off/status - Control AI for all chats by default',
            '!ai prompt <text> - Set the AI behavior for this chat',
            '!ai reset - Clear recent AI chat memory for this chat'
        ]},
        { title: 'Group Management (admins)', items: [
            '!groupinfo - Show group details',
            '!admins - List group admins',
            '!tagall - Mention everyone in the group',
            '!promote <phone|@user> - Make a member admin',
            '!demote <phone|@user> - Remove admin from a member',
            '!add <phone> - Add a number to the group',
            '!creategroup <name> - Create a new group with you and the bot',
            '!rename <text> - Change the group name',
            '!grouplink - Get the group invite link',
            '!lock - Only admins can send (group locked)',
            '!unlock - Everyone can send again',
            '!kick <@user> - Remove user from group',
            '!leave - Make the bot leave the group'
        ]},
        { title: 'Moderation (group admins)', items: [
            '!antilink on/off - Warn when non-admins send links',
            '!antispam on/off - Enable/disable spam detection',
            '!antispam set <maxMsgs> <seconds> - Set spam threshold',
            '!antispam status - Show current anti-spam config',
            '!warn <@user|phone> - Warn a user (3 warnings = auto-kick)',
            '!warnings <@user|phone> - Show warning count',
            '!clearwarns <@user|phone> - Clear all warnings',
            '!autopromo on|off - Auto-promote users at milestones',
            '!autopromo thresholds [values...] - Set promotion milestones',
            '!autopromo status - Show auto-promote config',
            '!filter add|remove|list [word] - Block words and auto-delete'
        ]},
        { title: 'User Commands', items: [
            '!mute - Pause bot replies in this chat',
            '!unmute - Resume bot replies in this chat',
            '!autoreply on/off - Enable or disable greeting replies',
            '!react <emoji> - React to the last message',
            '!quote save|list|random|clear - Save and replay quotes',
            '!schedule msg <minutes> <text> - Schedule a message',
            '!schedule list|clear - Manage scheduled messages',
            '!welcome set <text> - Custom welcome message'
        ]},
        { title: 'Media / Fun', items: [
            '!fact - Random fun fact',
            '!news - Top tech news',
            '!8ball <question> - Ask the magic 8ball',
            '!weather <city> - Get weather info',
            '!search <query> - Search the web',
            '!img <terms> - Image search via Unsplash',
            '!toimg - Reply to a sticker to turn it into an image',
            '!viewonce - Reply to a view-once media message to bypass it',
            '!mp3 - Convert video to audio (needs ffmpeg)'
        ]},
        { title: 'Status / Logging', items: [
            '!autoviewstatus on|off|status - Auto-view incoming statuses',
            '!autoviewonce on|off|status - Auto-bypass view-once media to owner',
            '!setlogchat - Set this chat as the join/leave activity log',
            '!logchat status|clear - Manage the log chat setting',
            '!broadcast <text> - Owner only: message all known chats',
            '!recap - Summarize recent messages in this group'
        ]}
    ];

    const lines = ['Bot commands:', ''];
    for (const section of sections) {
        lines.push(section.title + ':');
        for (const item of section.items) {
            lines.push('  ' + item);
        }
        lines.push('');
    }
    return lines.join('\n');
}

async function generateAiReply(chatId, userText) {
    if (!GROQ_API_KEY) {
        throw new Error('missing_api_key');
    }

    ensureChatSettings(chatId);

    const history = chatHistories.get(chatId) || [];
    const systemPrompt = store.aiSystemPrompts[chatId] || DEFAULT_AI_PROMPT;
    const messages = [
        {
            role: 'system',
            content: systemPrompt
        },
        ...history,
        {
            role: 'user',
            content: userText
        }
    ];

    let response;
    let lastError;

    for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
            response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${GROQ_API_KEY}`
                },
                body: JSON.stringify({
                    model: GROQ_MODEL,
                    messages,
                    temperature: 0.7
                }),
                signal: AbortSignal.timeout(30000)
            });
            break;
        } catch (error) {
            lastError = error;

            if (attempt === 2) {
                throw error;
            }

            await new Promise((resolve) => setTimeout(resolve, 1500));
        }
    }

    if (!response) {
        throw lastError || new Error('groq_request_failed');
    }

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`groq_${response.status}:${errorText}`);
    }

    const data = await response.json();
    const reply = data.choices?.[0]?.message?.content?.trim();

    if (!reply) {
        throw new Error('empty_ai_reply');
    }

    chatHistories.set(
        chatId,
        [
            ...history,
            {
                role: 'user',
                content: userText
            },
            {
                role: 'assistant',
                content: reply
            }
        ].slice(-12)
    );

    return reply;
}

async function sendText(jid, text, options = {}) {
    const result = await sock.sendMessage(jid, { text, ...options });

    if (result?.key?.id) {
        sentMessageIds.add(result.key.id);

        if (sentMessageIds.size > 5000) {
            sentMessageIds.clear();
        }
    }

    return result;
}

async function getGroupMetadata(chatId) {
    try {
        return await sock.groupMetadata(chatId);
    } catch (error) {
        return null;
    }
}

async function getSenderName(message, metadata) {
    const senderJid = jidNormalizedUser(message.key.participant || message.key.remoteJid || '');
    const participant = metadata?.participants?.find((item) => jidNormalizedUser(item.id) === senderJid);
    return participant?.notify || participant?.name || getBaseUserId(senderJid) || 'there';
}

async function isSenderAdmin(message, metadata) {
    if (!metadata) {
        return true;
    }

    const senderJid = jidNormalizedUser(message.key.participant || message.key.remoteJid || '');
    const senderBaseId = getBaseUserId(senderJid);
    const participant = metadata.participants.find((item) => {
        const participantJid = jidNormalizedUser(item.id);
        return participantJid === senderJid || getBaseUserId(participantJid) === senderBaseId;
    });

    return Boolean(participant && ['admin', 'superadmin'].includes(participant.admin));
}

async function requireGroup(context) {
    if (!context.isGroup) {
        await context.reply('This command only works in groups.');
        return null;
    }

    return context.metadata || (await getGroupMetadata(context.chatId));
}

async function requireGroupAdmin(context) {
    const metadata = await requireGroup(context);

    if (!metadata) {
        return null;
    }

    if (!(await isSenderAdmin(context.rawMessage, metadata))) {
        await context.reply('You need to be a group admin to use this command.');
        return null;
    }

    return metadata;
}

async function getAdminNames(metadata) {
    return metadata.participants
        .filter((item) => ['admin', 'superadmin'].includes(item.admin))
        .map((item) => item.notify || item.name || getBaseUserId(item.id));
}

function findParticipantJid(metadata, target) {
    if (!target) {
        return null;
    }

    const targetDigits = target.replace(/[^0-9]/g, '');

    for (const participant of metadata.participants) {
        const participantJid = jidNormalizedUser(participant.id);
        const baseId = getBaseUserId(participantJid);

        if (target.includes('@')) {
            if (participantJid === jidNormalizedUser(target)) {
                return participantJid;
            }
        } else if (baseId && targetDigits) {
            if (baseId === targetDigits || baseId.endsWith(targetDigits) || targetDigits.endsWith(baseId)) {
                return participantJid;
            }
        }
    }

    return null;
}

function getQuotedSticker(context) {
    const ctx = context.rawMessage?.message?.extendedTextMessage?.contextInfo;
    const quoted = ctx?.quotedMessage;

    if (!quoted || !quoted.stickerMessage) {
        return null;
    }

    return {
        key: {
            remoteJid: context.chatId,
            id: ctx.stanzaId,
            participant: ctx.participant
        },
        message: quoted
    };
}

function unwrapViewOnce(messageObj) {
    if (!messageObj || !messageObj.message) {
        return messageObj;
    }

    const content = messageObj.message;
    const viewOnceKeys = [
        'viewOnceMessageV2',
        'viewOnceMessageV2Extension',
        'viewOnceMessage',
        'ephemeralMessage'
    ];

    for (const key of viewOnceKeys) {
        if (content[key]) {
            const inner = content[key];
            if (inner.message) {
                return inner.message;
            }
        }
    }

    return messageObj;
}

function getIncomingViewOnceMedia(message) {
    if (!message?.message) {
        return null;
    }

    const unwrapped = unwrapViewOnce(message);
    const inner = unwrapped === message ? message.message : unwrapped;

    if (!inner.imageMessage && !inner.videoMessage && !inner.documentMessage && !inner.audioMessage && !inner.pttMessage && !inner.stickerMessage) {
        return null;
    }

    return {
        key: message.key,
        message: inner
    };
}

function getQuotedMedia(context) {
    const ctx = context.rawMessage?.message?.extendedTextMessage?.contextInfo;
    const quoted = ctx?.quotedMessage;

    if (!quoted) {
        return null;
    }

    const quotedMessageObj = { message: quoted };
    const unwrapped = unwrapViewOnce(quotedMessageObj);
    const inner = unwrapped === quotedMessageObj ? quoted : unwrapped;

    if (!inner.imageMessage && !inner.videoMessage && !inner.documentMessage && !inner.audioMessage && !inner.pttMessage && !inner.stickerMessage) {
        return null;
    }

    return {
        key: {
            remoteJid: context.chatId,
            id: ctx.stanzaId,
            participant: ctx.participant
        },
        message: inner
    };
}

function hasFfmpeg() {
    try {
        execSync('ffmpeg -version', { encoding: 'utf8', timeout: 5000 });
        return true;
    } catch {
        return false;
    }
}

async function videoToAudio(context) {
    if (!hasFfmpeg()) {
        await context.reply('Video-to-audio needs ffmpeg. Install ffmpeg, add it to PATH, then restart the bot to enable !mp3/!tomp3.');
        return;
    }

    const quoted = getQuotedVideo(context);
    if (!quoted) {
        await context.reply('Reply to a video with !mp3 or !tomp3 to convert it to audio.');
        return;
    }

    try {
        const buffer = await downloadMediaMessage(quoted, 'buffer', {});
        const tempDir = path.join(AUTH_PATH, 'tmp');
        fs.mkdirSync(tempDir, { recursive: true });
        const base = Date.now();
        const inPath = path.join(tempDir, `in-${base}.mp4`);
        const outPath = path.join(tempDir, `out-${base}.mp3`);
        fs.writeFileSync(inPath, buffer);
        const cmd = `ffmpeg -y -i "${inPath.replace(/\\/g, '/')}" -vn -acodec libmp3lame -q:a 2 "${outPath.replace(/\\/g, '/')}"`;
        execSync(cmd, { encoding: 'utf8', timeout: 300000 });
        const mp3 = fs.readFileSync(outPath);
        await sock.sendMessage(context.chatId, { audio: mp3, mimetype: 'audio/mpeg' }, { quoted: context.rawMessage });
        cleanup();
    } catch (error) {
        console.error('videoToAudio failed:', error);
        await context.reply('Could not convert that video. Make sure it is a video file and ffmpeg is installed.');
    }

    function cleanup() {
        try { fs.unlinkSync(inPath); } catch {}
        try { fs.unlinkSync(outPath); } catch {}f
    }
}

function createContext(message) {
    const chatId = jidNormalizedUser(message.key.remoteJid || '');
    const senderId = jidNormalizedUser(message.key.participant || message.key.remoteJid || '');
    const body = getTextFromMessage(message).trim();

    return {
        rawMessage: message,
        chatId,
        senderId,
        body,
        isGroup: chatId.endsWith('@g.us'),
        isFromMe: Boolean(message.key.fromMe),
        metadata: null,
        reply: async (text) => sendText(chatId, text, { quoted: message }),
        send: async (text, options) => sendText(chatId, text, options)
    };
}

const commands = {
    menu: {
        run: async (context) => {
            await context.reply(formatMenu());
        }
    },
    help: {
        run: async (context) => {
            await context.reply(formatMenu());
        }
    },
    ping: {
        run: async (context) => {
            await context.reply('pong');
        }
    },
    echo: {
        run: async (context, args) => {
            if (!args.length) {
                await context.reply('Usage: !echo <text>');
                return;
            }

            await context.reply(args.join(' '));
        }
    },
    ask: {
        run: async (context, args) => {
            if (!args.length) {
                await context.reply('Usage: !ask <question>');
                return;
            }

            await context.reply('Thinking...');
            const reply = await generateAiReply(context.chatId, args.join(' '));
            await context.reply(reply);
        }
    },
    ai: {
        run: async (context, args) => {
            ensureChatSettings(context.chatId);
            const subcommand = (args[0] || '').toLowerCase();

            if (!subcommand || subcommand === 'status') {
                const state = store.aiEnabledChats[context.chatId] ? 'on' : 'off';
                const prompt = store.aiSystemPrompts[context.chatId] || DEFAULT_AI_PROMPT;
                await context.reply(`AI mode is ${state}.\nModel: ${GROQ_MODEL}\nPrompt: ${prompt}`);
                return;
            }

            if (subcommand === 'on' || subcommand === 'off') {
                if (!GROQ_API_KEY) {
                    await context.reply('Set GROQ_API_KEY first before enabling AI mode.');
                    return;
                }

                store.aiEnabledChats[context.chatId] = subcommand === 'on';
                saveStore();
                await context.reply(`AI mode is now ${subcommand} in this chat.`);
                return;
            }

            if (subcommand === 'reset') {
                chatHistories.delete(context.chatId);
                await context.reply('AI memory cleared for this chat.');
                return;
            }

            if (subcommand === 'prompt') {
                const promptText = args.slice(1).join(' ').trim();

                if (!promptText) {
                    await context.reply('Usage: !ai prompt <text>');
                    return;
                }

                store.aiSystemPrompts[context.chatId] = promptText;
                chatHistories.delete(context.chatId);
                saveStore();
                await context.reply('AI prompt updated for this chat.');
                return;
            }

            await context.reply('Usage: !ai on|off|status|prompt <text>|reset');
        }
    },
    globalai: {
        run: async (context, args) => {
            const mode = (args[0] || '').toLowerCase();

            if (!mode || mode === 'status') {
                await context.reply(`Global AI is ${store.globalAiEnabled ? 'on' : 'off'}.`);
                return;
            }

            if (!GROQ_API_KEY) {
                await context.reply('Set GROQ_API_KEY first before enabling global AI.');
                return;
            }

            if (!['on', 'off'].includes(mode)) {
                await context.reply('Usage: !globalai on|off|status');
                return;
            }

            const enabled = mode === 'on';
            store.globalAiEnabled = enabled;

            for (const chatId of Object.keys(store.aiEnabledChats)) {
                store.aiEnabledChats[chatId] = enabled;
            }

            saveStore();
            broadcastStatus();
            await context.reply(
                `Global AI is now ${mode}. ${enabled ? 'New and existing chats will reply with AI.' : 'Chats will stop AI replies unless enabled again.'}`
            );
        }
    },
    time: {
        run: async (context) => {
            const now = new Date().toLocaleString('en-NG', {
                dateStyle: 'full',
                timeStyle: 'medium'
            });
            await context.reply(`Server time: ${now}`);
        }
    },
    info: {
        run: async (context) => {
            const knownChats = new Set([
                ...Object.keys(store.mutedChats),
                ...Object.keys(store.autoReplyChats),
                ...Object.keys(store.antiLinkChats),
                ...Object.keys(store.aiEnabledChats)
            ]);
            const connectedUser = jidNormalizedUser(sock.user?.id || '');
            await context.reply(
                [
                    'Bot status:',
                    `Connected number: ${connectedUser || 'unknown'}`,
                    `Known chats: ${knownChats.size}`,
                    `Prefix: ${PREFIX}`,
                    `AI model: ${GROQ_MODEL}`,
                    `Groq key set: ${GROQ_API_KEY ? 'yes' : 'no'}`,
                    `Global AI: ${store.globalAiEnabled ? 'on' : 'off'}`
                ].join('\n')
            );
        }
    },
    debug: {
        run: async (context) => {
            ensureChatSettings(context.chatId);
            const connectedUser = jidNormalizedUser(sock.user?.id || '');
            const isGroup = context.isGroup;
            const chatType = isGroup ? 'group' : 'direct';
            const hasAiKey = Boolean(GROQ_API_KEY);
            const aiState = store.aiEnabledChats[context.chatId] ? 'on' : 'off';
            const autoReplyState = store.autoReplyChats[context.chatId] ? 'on' : 'off';
            const mutedState = store.mutedChats[context.chatId] ? 'on' : 'off';
            const antiLinkState = store.antiLinkChats[context.chatId] ? 'on' : 'off';
            const prompt = store.aiSystemPrompts[context.chatId] || DEFAULT_AI_PROMPT;
            const portValue = process.env.PORT || 3000;

            await context.reply(
                [
                    'Debug info:',
                    `Chat type: ${chatType}`,
                    `Chat ID: ${context.chatId}`,
                    `Connected number: ${connectedUser || 'unknown'}`,
                    `AI key set: ${hasAiKey ? 'yes' : 'no'}`,
                    `AI enabled in this chat: ${aiState}`,
                    `Global AI: ${store.globalAiEnabled ? 'on' : 'off'}`,
                    `Auto-reply: ${autoReplyState}`,
                    `Muted: ${mutedState}`,
                    `Anti-link: ${antiLinkState}`,
                    `AI prompt: ${prompt}`,
                    `Health endpoint port: ${portValue}`
                ].join('\n')
            );
        }
    },
    restart: {
        ownerOnly: true,
        run: async (context) => {
            await context.reply('Restarting the bot now...');
            setTimeout(() => {
                process.exit(0);
            }, 1000);
        }
    },
    owner: {
        run: async (context) => {
            const connectedUser = jidNormalizedUser(sock.user?.id || '');
            await context.reply(connectedUser ? `Connected as ${connectedUser}` : 'Owner number is not available yet.');
        }
    },
    private: {
        ownerOnly: true,
        run: async (context, args) => {
            const mode = (args[0] || '').toLowerCase();
            if (!['on', 'off'].includes(mode)) {
                await context.reply('Usage: !private on|off');
                return;
            }
            store.privateMode = mode === 'on';
            saveStore();
            await context.reply(`Private mode is now ${mode}. ${store.privateMode ? 'Only you can use commands.' : 'Everyone can use commands again.'}`);
        }
    },
    chatid: {
        run: async (context) => {
            await context.reply(`Chat ID: ${context.chatId}`);
        }
    },
    autoreply: {
        run: async (context, args) => {
            const mode = (args[0] || '').toLowerCase();
            ensureChatSettings(context.chatId);

            if (!['on', 'off'].includes(mode)) {
                await context.reply('Usage: !autoreply on|off');
                return;
            }

            store.autoReplyChats[context.chatId] = mode === 'on';
            saveStore();
            await context.reply(`Auto-reply is now ${mode} in this chat.`);
        }
    },
    autoviewstatus: {
        run: async (context, args) => {
            const mode = (args[0] || '').toLowerCase();

            if (!mode || !['on', 'off', 'status'].includes(mode)) {
                await context.reply('Usage: !autoviewstatus on|off|status');
                return;
            }

            if (mode === 'status') {
                await context.reply(`Auto-view status is ${store.autoViewStatus ? 'on' : 'off'}.`);
                return;
            }

            store.autoViewStatus = mode === 'on';
            saveStore();
            await context.reply(`Auto-view status is now ${mode}.`);
        }
    },
    autoviewonce: {
        run: async (context, args) => {
            const mode = (args[0] || '').toLowerCase();

            if (!mode || !['on', 'off', 'status'].includes(mode)) {
                await context.reply('Usage: !autoviewonce on|off|status');
                return;
            }

            if (mode === 'status') {
                await context.reply(`Auto-bypass view-once is ${store.autoBypassViewOnce ? 'on' : 'off'}.`);
                return;
            }

            store.autoBypassViewOnce = mode === 'on';
            saveStore();
            await context.reply(`Auto-bypass view-once is now ${mode}.`);
        }
    },
    groupinfo: {
        run: async (context) => {
            const metadata = await requireGroup(context);

            if (!metadata) {
                return;
            }

            await context.reply(
                [
                    `Group: ${metadata.subject || 'this chat'}`,
                    `Participants: ${metadata.participants.length}`,
                    `Description: ${metadata.desc || 'No group description.'}`
                ].join('\n')
            );
        }
    },
    admins: {
        run: async (context) => {
            const metadata = await requireGroup(context);

            if (!metadata) {
                return;
            }

            const names = await getAdminNames(metadata);
            await context.reply(`Admins:\n${names.map((name) => `- ${name}`).join('\n')}`);
        }
    },
    tagall: {
        run: async (context) => {
            const metadata = await requireGroupAdmin(context);

            if (!metadata) {
                return;
            }

            const mentions = metadata.participants.map((item) => jidNormalizedUser(item.id));
            const lines = metadata.participants.map((item, index) => `@${getBaseUserId(item.id)} ${item.notify || item.name || `member ${index + 1}`}`);
            await context.send(lines.join('\n'), { mentions });
        }
    },
    mute: {
        run: async (context) => {
            const metadata = context.isGroup ? await getGroupMetadata(context.chatId) : null;

            if (context.isGroup && !(await isSenderAdmin(context.rawMessage, metadata))) {
                await context.reply('Only a group admin can mute the bot here.');
                return;
            }

            ensureChatSettings(context.chatId);
            store.mutedChats[context.chatId] = true;
            saveStore();
            await context.reply(`Bot replies are now muted in ${metadata?.subject || 'this chat'}.`);
        }
    },
    unmute: {
        runWhenMuted: true,
        run: async (context) => {
            const metadata = context.isGroup ? await getGroupMetadata(context.chatId) : null;

            if (context.isGroup && !(await isSenderAdmin(context.rawMessage, metadata))) {
                await context.reply('Only a group admin can unmute the bot here.');
                return;
            }

            ensureChatSettings(context.chatId);
            store.mutedChats[context.chatId] = false;
            saveStore();
            await context.reply(`Bot replies are active again in ${metadata?.subject || 'this chat'}.`);
        }
    },
    antilink: {
        run: async (context, args) => {
            const metadata = await requireGroupAdmin(context);

            if (!metadata) {
                return;
            }

            const mode = (args[0] || '').toLowerCase();

            if (!['on', 'off'].includes(mode)) {
                await context.reply('Usage: !antilink on|off');
                return;
            }

            ensureChatSettings(context.chatId);
            store.antiLinkChats[context.chatId] = mode === 'on';
            saveStore();
            await context.reply(`Anti-link is now ${mode} in ${metadata.subject || 'this chat'}.`);
        }
    },
    uptime: {
        run: async (context) => {
            const uptimeMs = Date.now() - startupTimeSec * 1000;
            const days = Math.floor(uptimeMs / 86400000);
            const hours = Math.floor((uptimeMs % 86400000) / 3600000);
            const minutes = Math.floor((uptimeMs % 3600000) / 60000);
            const seconds = Math.floor((uptimeMs % 60000) / 1000);
            await context.reply(
                `Bot uptime: ${days}d ${hours}h ${minutes}m ${seconds}s\nMessages handled: ${totalMessagesHandled}\nCommands run: ${totalCommandsHandled}`
            );
        }
    },
    stats: {
        run: async (context) => {
            await context.reply(
                [
                    'Bot stats:',
                    `Messages handled: ${totalMessagesHandled}`,
                    `Commands run: ${totalCommandsHandled}`,
                    `Known chats: ${new Set([...Object.keys(store.mutedChats), ...Object.keys(store.autoReplyChats), ...Object.keys(store.antiLinkChats), ...Object.keys(store.aiEnabledChats)]).size}`
                ].join('\n')
            );
        }
    },
    quote: {
        run: async (context, args) => {
            const sub = (args[0] || 'random').toLowerCase();
            const remaining = args.slice(1).join(' ').trim();

            if (sub === 'save') {
                if (!remaining && !context.rawMessage.messageStubType && !context.rawMessage.message?.protocolMessage) {
                    if (!context.rawMessage.message || !getTextFromMessage(context.rawMessage)) {
                        await context.reply('Usage: !quote save <text>');
                        return;
                    }
                }
                const text = remaining || getTextFromMessage(context.rawMessage);
                const senderName = context.isGroup ? await getSenderName(context.rawMessage, context.metadata) : 'someone';
                store.quotes.push({ text, sender: senderName, timestamp: Date.now() });
                if (store.quotes.length > 200) {
                    store.quotes = store.quotes.slice(-100);
                }
                saveStore();
                await context.reply('Quote saved.');
                return;
            }

            if (sub === 'list') {
                if (!store.quotes.length) {
                    await context.reply('No quotes saved yet.');
                    return;
                }
                const lines = store.quotes.slice(-10).map((q, i) => `${i + 1}. ${q.sender}: ${q.text}`);
                await context.reply('Saved quotes:\n' + lines.join('\n'));
                return;
            }

            if (sub === 'clear') {
                if (!store.quotes.length) {
                    await context.reply('No quotes to clear.');
                    return;
                }
                store.quotes = [];
                saveStore();
                await context.reply('All quotes cleared.');
                return;
            }

            const item = sub === 'random' ? store.quotes[Math.floor(Math.random() * store.quotes.length)] : null;
            if (!item) {
                await context.reply('No quotes saved yet. Use !quote save <text> first.');
                return;
            }
            await context.reply(`"${item.text}"\n- ${item.sender}`);
        }
    },
    search: {
        run: async (context, args) => {
            const query = args.join(' ').trim();
            if (!query) {
                await context.reply('Usage: !search <query>');
                return;
            }
            if (!GROQ_API_KEY) {
                await context.reply('GROQ_API_KEY is not set. Search cannot generate an answer.');
                return;
            }

            await context.reply(`Searching the web for: "${query}"...`);

            try {
                const ddgUrl = `https://lite.duckduckgo.com/lite/`;
                const searchRes = await fetch(ddgUrl, { 
                    method: 'POST',
                    headers: { 
                        'Content-Type': 'application/x-www-form-urlencoded',
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' 
                    },
                    body: 'q=' + encodeURIComponent(query)
                });
                const html = await searchRes.text();
                const $ = cheerio.load(html);
                let snippets = [];
                $('.result-snippet').each((i, el) => {
                    if (i < 5) snippets.push($(el).text().trim());
                });

                if (snippets.length === 0) {
                    await context.reply('Could not find relevant search results.');
                    return;
                }

                const searchContext = snippets.join('\n\n');
                const prompt = `Answer the user's query based ONLY on the following search results. Be conversational but concise.\n\nQuery: ${query}\n\nSearch Results:\n${searchContext}`;

                const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${GROQ_API_KEY}` },
                    body: JSON.stringify({ model: GROQ_MODEL, messages: [{ role: 'user', content: prompt }], temperature: 0.5 }),
                    signal: AbortSignal.timeout(30000)
                });
                
                if (!response.ok) {
                    await context.reply('Search API failed to generate an answer.');
                    return;
                }
                
                const data = await response.json();
                const reply = data.choices?.[0]?.message?.content?.trim();
                if (reply) {
                    await context.reply(reply);
                } else {
                    await context.reply('Could not generate an answer right now.');
                }
            } catch (error) {
                console.error('Search failed:', error);
                await context.reply('Search failed.');
            }
        }
    },
    recap: {
        run: async (context) => {
            const metadata = await requireGroup(context);
            if (!metadata) return;

            const buffer = groupMessageBuffers.get(context.chatId) || [];
            if (buffer.length < 5) {
                await context.reply('Not enough recent messages in this group to summarize (need at least 5).');
                return;
            }

            if (!GROQ_API_KEY) {
                await context.reply('GROQ_API_KEY is not set. Recap cannot be generated.');
                return;
            }

            await context.reply('Generating recap from recent messages...');
            const transcript = buffer.map(m => `[${new Date(m.timestamp).toLocaleTimeString()}] ${m.sender}: ${m.text}`).join('\n');
            const prompt = `Summarize the following group chat conversation into concise bullet points. Highlight key topics, arguments, and decisions if any:\n\n${transcript}`;

            try {
                const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${GROQ_API_KEY}` },
                    body: JSON.stringify({ model: GROQ_MODEL, messages: [{ role: 'user', content: prompt }], temperature: 0.5 }),
                    signal: AbortSignal.timeout(30000)
                });
                
                if (!response.ok) {
                    await context.reply('Failed to generate recap (API Error).');
                    return;
                }
                
                const data = await response.json();
                const reply = data.choices?.[0]?.message?.content?.trim();
                if (reply) {
                    await context.reply(reply);
                } else {
                    await context.reply('Could not generate a recap right now.');
                }
            } catch (error) {
                console.error('Recap failed:', error);
                await context.reply('Recap generation failed.');
            }
        }
    },
    '8ball': {
        run: async (context, args) => {
            const text = args.join(' ').trim();
            if (!text) {
                await context.reply('Usage: !8ball <question>');
                return;
            }
            const answers = [
                'It is certain.', 'It is decidedly so.', 'Without a doubt.', 'Yes - definitely.',
                'You may rely on it.', 'As I see it, yes.', 'Most likely.', 'Outlook good.',
                'Yes.', 'Signs point to yes.', 'Reply hazy, try again.', 'Ask again later.',
                'Better not tell you now.', 'Cannot predict now.', 'Concentrate and ask again.',
                "Don't count on it.", 'My reply is no.', 'My sources say no.',
                'Outlook not so good.', 'Very doubtful.'
            ];
            await context.reply(answers[Math.floor(Math.random() * answers.length)]);
        }
    },
    weather: {
        run: async (context, args) => {
            const city = args.join(' ').trim();
            if (!city) {
                await context.reply('Usage: !weather <city>');
                return;
            }
            try {
                const response = await fetch(`https://wttr.in/${encodeURIComponent(city)}?format=%l:+%c+%t+%h+%w+%p\n`);
                if (!response.ok) {
                    await context.reply('Could not fetch weather. Check the city name and try again.');
                    return;
                }
                const data = await response.text();
                await context.reply(data.trim());
            } catch (error) {
                await context.reply('Weather service is unreachable right now.');
            }
        }
    },
    welcome: {
        run: async (context, args) => {
            const metadata = await requireGroupAdmin(context);
            if (!metadata) {
                return;
            }
            const text = args.join(' ').trim();
            if (!text) {
                await context.reply('Usage: !welcome set <text>');
                return;
            }
            store.welcomeMessages[context.chatId] = text;
            saveStore();
            await context.reply('Custom welcome message set for this group.');
        }
    },
    filter: {
        run: async (context, args) => {
            const metadata = await requireGroupAdmin(context);
            if (!metadata) {
                return;
            }
            const sub = (args[0] || '').toLowerCase();
            const word = args.slice(1).join(' ').trim();

            if (sub === 'add' && word) {
                store.wordFilters[context.chatId] = store.wordFilters[context.chatId] || [];
                if (!store.wordFilters[context.chatId].includes(word)) {
                    store.wordFilters[context.chatId].push(word);
                }
                saveStore();
                await context.reply(`Added filter word: ${word}`);
                return;
            }

            if (sub === 'remove' && word) {
                store.wordFilters[context.chatId] = (store.wordFilters[context.chatId] || []).filter((w) => w !== word);
                saveStore();
                await context.reply(`Removed filter word: ${word}`);
                return;
            }

            if (sub === 'list') {
                const list = store.wordFilters[context.chatId] || [];
                await context.reply(list.length ? `Filtered words:\n${list.join('\n')}` : 'No filtered words in this group.');
                return;
            }

            await context.reply('Usage: !filter add|remove|list [word]');
        }
    },
    schedule: {
        run: async (context, args) => {
            const sub = (args[0] || '').toLowerCase();
            const remaining = args.slice(1);

            if (sub === 'msg') {
                const minutes = Number(remaining[0]);
                const text = remaining.slice(1).join(' ').trim();
                if (!minutes || minutes <= 0 || !text) {
                    await context.reply('Usage: !schedule msg <minutes> <text>');
                    return;
                }
                const item = {
                    id: Date.now(),
                    chatId: context.chatId,
                    text,
                    sendAt: Date.now() + minutes * 60000,
                    sent: false,
                    options: { quoted: context.rawMessage }
                };
                store.scheduledMessages.push(item);
                saveStore();
                scheduleNextMessageCheck();
                await context.reply(`Message scheduled in ${minutes} minute(s).`);
                return;
            }

            if (sub === 'list') {
                const pending = store.scheduledMessages.filter((item) => !item.sent && item.chatId === context.chatId);
                if (!pending.length) {
                    await context.reply('No pending scheduled messages in this chat.');
                    return;
                }
                const lines = pending.map((item, i) => `${i + 1}. In ${Math.max(1, Math.round((item.sendAt - Date.now()) / 60000))}m: ${item.text}`);
                await context.reply('Scheduled messages:\n' + lines.join('\n'));
                return;
            }

            if (sub === 'clear') {
                store.scheduledMessages = store.scheduledMessages.filter((item) => item.chatId !== context.chatId || item.sent);
                saveStore();
                await context.reply('Cleared pending scheduled messages for this chat.');
                return;
            }

            await context.reply('Usage: !schedule msg|list|clear');
        }
    },
    broadcast: {
        ownerOnly: true,
        run: async (context, args) => {
            const text = args.join(' ').trim();
            if (!text) {
                await context.reply('Usage: !broadcast <text>');
                return;
            }
            const chats = new Set([
                ...Object.keys(store.mutedChats),
                ...Object.keys(store.autoReplyChats),
                ...Object.keys(store.antiLinkChats),
                ...Object.keys(store.aiEnabledChats)
            ]);
            let sent = 0;
            for (const chatId of chats) {
                try {
                    await sendText(chatId, text);
                    sent += 1;
                } catch (error) {
                    console.error('Broadcast failed for', chatId, error);
                }
            }
            await context.reply(`Broadcast sent to ${sent} chat(s).`);
        }
    },
    kick: {
        run: async (context, args) => {
            const metadata = await requireGroupAdmin(context);
            if (!metadata) {
                return;
            }
            const target = args[0];
            if (!target) {
                await context.reply('Usage: !kick <phone|@user|jid>');
                return;
            }

            const participants = metadata.participants;
            let targetJid = null;
            const targetDigits = target.replace(/[^0-9]/g, '');

            for (const participant of participants) {
                const participantJid = jidNormalizedUser(participant.id);
                const baseId = getBaseUserId(participantJid);

                if (target.includes('@')) {
                    if (participantJid === jidNormalizedUser(target)) {
                        targetJid = participantJid;
                        break;
                    }
                } else if (baseId && targetDigits) {
                    if (baseId === targetDigits || baseId.endsWith(targetDigits) || targetDigits.endsWith(baseId)) {
                        targetJid = participantJid;
                        break;
                    }
                }
            }

            if (!targetJid) {
                await context.reply('User not found in this group. Use phone number, @mention, or JID.');
                return;
            }

            try {
                await sock.groupParticipantsUpdate(context.chatId, [targetJid], 'remove');
                await context.reply('User removed from the group.');
            } catch (error) {
                await context.reply('Failed to remove user. Make sure the bot is admin.');
            }
        }
    },
    creategroup: {
        run: async (context, args) => {
            const name = args.join(' ').trim();
            if (!name) {
                await context.reply('Usage: !creategroup <group name>');
                return;
            }

            const ownerJid = jidNormalizedUser(sock.user?.id || '');
            const participants = [ownerJid, context.senderId].filter(Boolean);

            try {
                const metadata = await sock.groupCreate(name, participants);
                const groupJid = metadata.id;
                await context.reply(`Group "${name}" created.\nGroup ID: ${groupJid}`);
            } catch (error) {
                console.error('creategroup failed:', error);
                await context.reply('Failed to create group. Make sure the bot is online and the numbers are valid.');
            }
        }
    },
    leave: {
        run: async (context) => {
            const metadata = await requireGroupAdmin(context);
            if (!metadata) {
                return;
            }
            await context.reply('Leaving the group...');
            setTimeout(async () => {
                try {
                    await sock.groupLeave(context.chatId);
                } catch (error) {
                    console.error('Failed to leave group:', error);
                }
            }, 1000);
        }
    },
    react: {
        run: async (context, args) => {
            const emoji = args[0];
            if (!emoji) {
                await context.reply('Usage: !react <emoji>');
                return;
            }
            try {
                await sock.sendMessage(context.chatId, {
                    react: {
                        text: emoji,
                        key: context.rawMessage.key
                    }
                });
            } catch (error) {
                await context.reply('Failed to react. Try again.');
            }
        }
    },

    promote: {
        run: async (context, args) => {
            const metadata = await requireGroupAdmin(context);
            if (!metadata) {
                return;
            }
            const target = args[0];
            if (!target) {
                await context.reply('Usage: !promote <phone|@user|jid>');
                return;
            }
            const jid = findParticipantJid(metadata, target);
            if (!jid) {
                await context.reply('User not found in this group.');
                return;
            }
            try {
                await sock.groupParticipantsUpdate(context.chatId, [jid], 'promote');
                await context.reply('Promoted to admin.');
            } catch (error) {
                await context.reply('Failed to promote. Make sure the bot is admin.');
            }
        }
    },
    demote: {
        run: async (context, args) => {
            const metadata = await requireGroupAdmin(context);
            if (!metadata) {
                return;
            }
            const target = args[0];
            if (!target) {
                await context.reply('Usage: !demote <phone|@user|jid>');
                return;
            }
            const jid = findParticipantJid(metadata, target);
            if (!jid) {
                await context.reply('User not found in this group.');
                return;
            }
            try {
                await sock.groupParticipantsUpdate(context.chatId, [jid], 'demote');
                await context.reply('Demoted from admin.');
            } catch (error) {
                await context.reply('Failed to demote.');
            }
        }
    },
    add: {
        run: async (context, args) => {
            const metadata = await requireGroupAdmin(context);
            if (!metadata) {
                return;
            }
            const num = (args[0] || '').replace(/[^0-9]/g, '');
            if (num.length < 6) {
                await context.reply('Usage: !add <phone number>');
                return;
            }
            const jid = num + '@s.whatsapp.net';
            try {
                await sock.groupParticipantsUpdate(context.chatId, [jid], 'add');
                await context.reply('Added ' + num + ' to the group.');
            } catch (error) {
                await context.reply('Failed to add. The number may not be on WhatsApp or may block group adds.');
            }
        }
    },
    rename: {
        run: async (context, args) => {
            const metadata = await requireGroupAdmin(context);
            if (!metadata) {
                return;
            }
            const text = args.join(' ').trim();
            if (!text) {
                await context.reply('Usage: !rename <new group name>');
                return;
            }
            try {
                await sock.groupUpdateSubject(context.chatId, text);
                await context.reply('Group renamed.');
            } catch (error) {
                await context.reply('Failed to rename the group.');
            }
        }
    },
    grouplink: {
        run: async (context) => {
            const metadata = await requireGroupAdmin(context);
            if (!metadata) {
                return;
            }
            try {
                const code = await sock.groupInviteCode(context.chatId);
                await context.reply('Invite link: https://chat.whatsapp.com/' + code);
            } catch (error) {
                await context.reply('Failed to get the invite link.');
            }
        }
    },
    lock: {
        run: async (context) => {
            const metadata = await requireGroupAdmin(context);
            if (!metadata) {
                return;
            }
            try {
                await sock.groupSettingUpdate(context.chatId, 'announcement');
                await context.reply('Group locked — only admins can send messages.');
            } catch (error) {
                await context.reply('Failed to lock the group.');
            }
        }
    },
    unlock: {
        run: async (context) => {
            const metadata = await requireGroupAdmin(context);
            if (!metadata) {
                return;
            }
            try {
                await sock.groupSettingUpdate(context.chatId, 'not_announcement');
                await context.reply('Group unlocked — everyone can send messages.');
            } catch (error) {
                await context.reply('Failed to unlock the group.');
            }
        }
    },
    fact: {
        run: async (context) => {
            try {
                const res = await fetch('https://uselessfacts.jsph.pl/api/v2/facts/random?language=en');
                const data = await res.json();
                await context.reply((data && data.text ? data.text : 'No fact found.').trim());
            } catch (error) {
                await context.reply('Could not fetch a fact right now.');
            }
        }
    },
    news: {
        run: async (context) => {
            try {
                const res = await fetch('https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=5');
                const data = await res.json();
                const hits = data.hits || [];
                if (!hits.length) {
                    await context.reply('No news found right now.');
                    return;
                }
                const lines = hits.map((h, i) => `${i + 1}. ${h.title}\n${h.url}`);
                await context.reply('Top tech news:\n' + lines.join('\n\n'));
            } catch (error) {
                await context.reply('Could not fetch news right now.');
            }
        }
    },
    viewonce: {
        run: async (context) => {
            const quoted = getQuotedMedia(context);
            if (!quoted) {
                await context.reply('Reply to a view-once media message with !viewonce to bypass it.');
                return;
            }

            const ownerJid = jidNormalizedUser(sock.user?.id || '');

            if (!ownerJid) {
                await context.reply('Owner JID is not available yet.');
                return;
            }

            try {
                const buffer = await downloadMediaMessage(quoted, 'buffer', {});
                const inner = quoted.message;
                const caption = inner.caption || '';

                if (inner.stickerMessage) {
                    await context.reply('Stickers cannot be bypassed with !viewonce.');
                    return;
                } else if (inner.imageMessage) {
                    await sock.sendMessage(ownerJid, { image: buffer, caption: caption || undefined });
                } else if (inner.videoMessage) {
                    await sock.sendMessage(ownerJid, { video: buffer, caption: caption || undefined });
                } else if (inner.documentMessage) {
                    await sock.sendMessage(ownerJid, { document: buffer, mimetype: inner.documentMessage.mimetype || 'application/octet-stream', caption: caption || undefined });
                } else if (inner.audioMessage || inner.pttMessage) {
                    await sock.sendMessage(ownerJid, { audio: buffer, mimetype: 'audio/ogg; codecs=opus' });
                } else {
                    await sock.sendMessage(ownerJid, { document: buffer });
                }

                await context.reply('Sent to your number.');
            } catch (error) {
                console.error('viewonce failed:', error);
                await context.reply('Could not bypass that view-once message.');
            }
        }
    },
    toimg: {
        run: async (context) => {
            const quoted = getQuotedSticker(context);
            if (!quoted) {
                await context.reply('Reply to a sticker with !toimg to convert it to an image.');
                return;
            }
            try {
        const buffer = await downloadMediaMessage(quoted, 'buffer', {});
                const png = await sharp(buffer).png().toBuffer();
                await sock.sendMessage(context.chatId, { image: png, caption: 'Here you go.' }, { quoted: context.rawMessage });
            } catch (error) {
                console.error('toimg failed:', error);
                await context.reply('Could not convert that sticker.');
            }
        }
    },
    image: {
        run: (context, args) => commands.toimg.run(context, args)
    },
    img: {
        run: async (context, args) => {
            const accessKey = process.env.UNSPLASH_ACCESS_KEY;
            if (!accessKey) {
                await context.reply('Image search is not configured. Set the UNSPLASH_ACCESS_KEY environment variable to enable it.');
                return;
            }
            const query = args.join(' ').trim();
            if (!query) {
                await context.reply('Usage: !img <search terms>');
                return;
            }
            try {
                const url = `https://api.unsplash.com/search/photos?query=${encodeURIComponent(query)}&client_id=${accessKey}&per_page=5`;
                const res = await fetch(url);
                const data = await res.json();
                const items = data.results || [];
                if (!items.length) {
                    await context.reply('No images found for that query.');
                    return;
                }
                const it = items[0];
                const title = it.description || it.alt_description || 'Untitled';
                const imgUrl = it.urls.regular || it.urls.small || it.urls.raw;
                try {
                    await sock.sendMessage(context.chatId, { image: { url: imgUrl }, caption: title }, { quoted: context.rawMessage });
                } catch (sendErr) {
                    console.error('Failed to send image', imgUrl, sendErr);
                    await context.reply(title + '\n' + imgUrl);
                }
            } catch (error) {
                await context.reply('Image search failed.');
            }
        }
    },
    mp3: {
        run: async (context) => {
            await videoToAudio(context);
        }
    },
    tomp3: {
        run: async (context) => {
            await videoToAudio(context);
        }
    },

    antispam: {
        run: async (context, args) => {
            const metadata = await requireGroup(context);
            if (!metadata) return;
            if (!(await isSenderAdmin(context.rawMessage, metadata))) {
                await context.reply('Only group admins can configure anti-spam.');
                return;
            }
            ensureChatSettings(context.chatId);
            const sub = (args[0] || 'status').toLowerCase();

            if (sub === 'on' || sub === 'off') {
                store.antiSpamChats[context.chatId] = sub === 'on';
                saveStore();
                await context.reply(`Anti-spam is now ${sub} in this group.`);
                return;
            }

            if (sub === 'set') {
                const max = Number(args[1]);
                const secs = Number(args[2]);
                if (!max || max < 1 || !secs || secs < 1) {
                    await context.reply('Usage: !antispam set <maxMessages> <windowSeconds>\nExample: !antispam set 5 5');
                    return;
                }
                store.antiSpamSettings[context.chatId] = { maxMessages: max, windowSeconds: secs };
                saveStore();
                await context.reply(`Anti-spam set: max ${max} messages per ${secs} seconds.`);
                return;
            }

            if (sub === 'status') {
                const enabled = store.antiSpamChats[context.chatId] ? 'on' : 'off';
                const cfg = store.antiSpamSettings[context.chatId] || { maxMessages: 5, windowSeconds: 5 };
                await context.reply(`Anti-spam: ${enabled}\nThreshold: ${cfg.maxMessages} messages per ${cfg.windowSeconds}s`);
                return;
            }

            await context.reply('Usage: !antispam on|off|set|status');
        }
    },

    warn: {
        run: async (context, args) => {
            const metadata = await requireGroupAdmin(context);
            if (!metadata) return;
            const target = args[0];
            if (!target) {
                await context.reply('Usage: !warn <@user|phone>');
                return;
            }
            const targetJid = findParticipantJid(metadata, target);
            if (!targetJid) {
                await context.reply('User not found in this group.');
                return;
            }
            const warnKey = `${context.chatId}:${getBaseUserId(targetJid)}`;
            store.userWarnings[warnKey] = (store.userWarnings[warnKey] || 0) + 1;
            saveStore();
            const count = store.userWarnings[warnKey];
            await context.send(
                `⚠️ @${getBaseUserId(targetJid)} has been warned. (${count}/3 warnings)`,
                { mentions: [targetJid] }
            );
            if (count >= 3) {
                try {
                    await sock.groupParticipantsUpdate(context.chatId, [targetJid], 'remove');
                    await context.send(
                        `🚫 @${getBaseUserId(targetJid)} was removed after 3 warnings.`,
                        { mentions: [targetJid] }
                    );
                    store.userWarnings[warnKey] = 0;
                    saveStore();
                } catch (_) {
                    await context.reply('Could not remove user. Make sure the bot is admin.');
                }
            }
        }
    },

    warnings: {
        run: async (context, args) => {
            const metadata = await requireGroup(context);
            if (!metadata) return;
            const target = args[0];
            if (!target) {
                await context.reply('Usage: !warnings <@user|phone>');
                return;
            }
            const targetJid = findParticipantJid(metadata, target);
            if (!targetJid) {
                await context.reply('User not found.');
                return;
            }
            const warnKey = `${context.chatId}:${getBaseUserId(targetJid)}`;
            const count = store.userWarnings[warnKey] || 0;
            await context.reply(`@${getBaseUserId(targetJid)} has ${count}/3 warnings.`);
        }
    },

    clearwarns: {
        run: async (context, args) => {
            const metadata = await requireGroupAdmin(context);
            if (!metadata) return;
            const target = args[0];
            if (!target) {
                await context.reply('Usage: !clearwarns <@user|phone>');
                return;
            }
            const targetJid = findParticipantJid(metadata, target);
            if (!targetJid) {
                await context.reply('User not found.');
                return;
            }
            const warnKey = `${context.chatId}:${getBaseUserId(targetJid)}`;
            store.userWarnings[warnKey] = 0;
            saveStore();
            await context.send(
                `✅ Warnings cleared for @${getBaseUserId(targetJid)}.`,
                { mentions: [targetJid] }
            );
        }
    },

    setlogchat: {
        ownerOnly: true,
        run: async (context) => {
            store.logChatId = context.chatId;
            saveStore();
            await context.reply(`✅ This chat is now set as the join/leave log chat.\nID: ${context.chatId}`);
        }
    },

    logchat: {
        ownerOnly: true,
        run: async (context, args) => {
            const sub = (args[0] || 'status').toLowerCase();
            if (sub === 'clear') {
                store.logChatId = '';
                saveStore();
                await context.reply('Log chat cleared.');
                return;
            }
            if (store.logChatId) {
                await context.reply(`Log chat is set to:\n${store.logChatId}`);
            } else {
                await context.reply('No log chat configured. Use !setlogchat in the target chat.');
            }
        }
    },

    autopromo: {
        run: async (context, args) => {
            const metadata = await requireGroup(context);
            if (!metadata) return;
            if (!(await isSenderAdmin(context.rawMessage, metadata))) {
                await context.reply('Only group admins can configure auto-promote.');
                return;
            }
            ensureChatSettings(context.chatId);
            const sub = (args[0] || 'status').toLowerCase();

            if (sub === 'on' || sub === 'off') {
                store.autoPromoEnabled[context.chatId] = sub === 'on';
                saveStore();
                await context.reply(`Auto-promote is now ${sub} in this group.`);
                return;
            }

            if (sub === 'thresholds') {
                if (args[1]) {
                    const thresholds = args.slice(1).map(Number).filter((n) => n > 0).sort((a, b) => a - b);
                    if (!thresholds.length) {
                        await context.reply('Usage: !autopromo thresholds 100 500 1000');
                        return;
                    }
                    store.autoPromoThresholds = thresholds;
                    saveStore();
                    await context.reply(`Auto-promote milestones set: ${thresholds.join(', ')} messages.`);
                } else {
                    await context.reply(`Current milestones: ${store.autoPromoThresholds.join(', ')} messages.`);
                }
                return;
            }

            if (sub === 'status') {
                const enabled = store.autoPromoEnabled[context.chatId] ? 'on' : 'off';
                await context.reply(`Auto-promote: ${enabled}\nMilestones: ${store.autoPromoThresholds.join(', ')} messages`);
                return;
            }

            await context.reply('Usage: !autopromo on|off|status|thresholds [values...]');
        }
    }
};

async function handleNonCommandMessage(context) {
    if (!context.body) {
        return;
    }

    if (store.privateMode && !isOwner(context)) {
        return;
    }

    ensureChatSettings(context.chatId);

    if (store.mutedChats[context.chatId]) {
        return;
    }

    context.metadata = context.isGroup ? await getGroupMetadata(context.chatId) : null;
    const senderIsAdmin = context.isGroup ? await isSenderAdmin(context.rawMessage, context.metadata) : false;

    // ── Anti-spam check ──────────────────────────────────────────────────────
    if (context.isGroup && store.antiSpamChats[context.chatId] && !senderIsAdmin) {
        const cfg = store.antiSpamSettings[context.chatId] || { maxMessages: 5, windowSeconds: 5 };
        const trackerKey = `${context.chatId}:${context.senderId}`;
        const now = Date.now();
        const windowMs = cfg.windowSeconds * 1000;
        const timestamps = (spamTracker.get(trackerKey) || []).filter((t) => now - t < windowMs);
        timestamps.push(now);
        spamTracker.set(trackerKey, timestamps);

        if (timestamps.length > cfg.maxMessages) {
            try {
                await sock.sendMessage(context.chatId, { delete: context.rawMessage.key });
            } catch (_) { /* ignore if bot lacks permission */ }
            const warnKey = `${context.chatId}:${getBaseUserId(context.senderId)}`;
            store.userWarnings[warnKey] = (store.userWarnings[warnKey] || 0) + 1;
            saveStore();
            const warnCount = store.userWarnings[warnKey];
            await context.send(
                `🚫 @${getBaseUserId(context.senderId)}, slow down! Sending too many messages. (Warning ${warnCount}/3)`,
                { mentions: [context.senderId] }
            );
            if (warnCount >= 3) {
                try {
                    await sock.groupParticipantsUpdate(context.chatId, [context.senderId], 'remove');
                    store.userWarnings[warnKey] = 0;
                    saveStore();
                } catch (_) { /* ignore kick failure if bot is not admin */ }
            }
            return;
        }
    }

    // ── Anti-link check ──────────────────────────────────────────────────────
    if (context.isGroup && store.antiLinkChats[context.chatId] && !senderIsAdmin && hasLink(context.body)) {
        const senderName = await getSenderName(context.rawMessage, context.metadata);
        try {
            await sock.sendMessage(context.chatId, { delete: context.rawMessage.key });
        } catch (_) { /* ignore */ }
        await context.send(`⚠️ ${senderName}, links are not allowed here.`, {
            mentions: [context.senderId]
        });
        return;
    }

    // ── Word filter (auto-delete) ─────────────────────────────────────────────
    if (context.isGroup && store.wordFilters[context.chatId]?.length && !senderIsAdmin) {
        const filters = store.wordFilters[context.chatId] || [];
        const matched = filters.find((word) =>
            new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(context.body)
        );
        if (matched) {
            const senderName = await getSenderName(context.rawMessage, context.metadata);
            try {
                await sock.sendMessage(context.chatId, { delete: context.rawMessage.key });
            } catch (_) { /* ignore delete failure */ }
            await context.send(`🚫 ${senderName}, that word is not allowed here.`, {
                mentions: [context.senderId]
            });
            return;
        }
    }

    // ── Auto-promote milestone counter ────────────────────────────────────────
    if (context.isGroup && store.autoPromoEnabled[context.chatId] && !senderIsAdmin) {
        const userId = getBaseUserId(context.senderId);
        if (!store.messageMilestones[context.chatId]) {
            store.messageMilestones[context.chatId] = {};
        }
        const prev = store.messageMilestones[context.chatId][userId] || 0;
        const next = prev + 1;
        store.messageMilestones[context.chatId][userId] = next;
        saveStore();
        const hit = store.autoPromoThresholds.find((t) => prev < t && next >= t);
        if (hit) {
            try {
                await sock.groupParticipantsUpdate(context.chatId, [context.senderId], 'promote');
                await context.send(
                    `🎉 @${userId} just reached ${hit} messages and has been promoted to admin!`,
                    { mentions: [context.senderId] }
                );
            } catch (_) { /* ignore if bot is not admin */ }
        }
    }

    // ── Keyword trigger auto-reply ─────────────────────────────────────────────
    if (context.isGroup && store.keywordTriggers?.length && !senderIsAdmin) {
        const lowered = context.body.toLowerCase();
        const matched = store.keywordTriggers.find(t => lowered.includes(t.keyword));
        if (matched) {
            await context.reply(matched.reply);
            return;
        }
    }

    // ── Auto-reply greetings ──────────────────────────────────────────────────
    if (store.autoReplyChats[context.chatId] && isGreeting(context.body)) {
        await context.reply('Hello. I am online and ready. Send !menu to see commands.');
        return;
    }

    // ── AI auto-reply ─────────────────────────────────────────────────────────
    if (store.aiEnabledChats[context.chatId]) {
        // Do not auto-reply with AI to messages from the bot owner (you) unless
        // they explicitly use a command like `!ask`. Commands are handled
        // elsewhere, so non-command messages from the owner should not trigger
        // AI auto-replies.
        try {
            const ownerJid = jidNormalizedUser(sock.user?.id || '');
            if (context.senderId === ownerJid) {
                return;
            }

            const reply = await generateAiReply(context.chatId, context.body);
            await context.reply(reply);
        } catch (error) {
            console.error('AI reply failed:', error);

            if (String(error.message).includes('missing_api_key')) {
                await context.reply('AI mode needs GROQ_API_KEY to be set on this computer.');
                return;
            }

            if (String(error.message).includes('groq_429')) {
                await context.reply('Groq rate limit or free quota is exhausted right now. Please try again shortly.');
                return;
            }

            if (String(error.message).includes('groq_503')) {
                await context.reply('Groq is under heavy demand right now. Please try again shortly.');
                return;
            }

            if (String(error.message).includes('UND_ERR_CONNECT_TIMEOUT')) {
                await context.reply('AI is online but Groq timed out. Please try again in a moment.');
                return;
            }

            await context.reply('AI reply failed right now. Try again in a moment.');
        }
    }
}

const commandAliases = {
    status: 'story'
};

function isOwner(context) {
    return context.rawMessage?.key?.fromMe === true || (() => {
        const ownerBaseId = getBaseUserId(sock.user?.id || '');
        const senderBaseId = getBaseUserId(context.senderId);
        return Boolean(ownerBaseId && senderBaseId === ownerBaseId);
    })();
}

async function handleCommandMessage(context) {
    if (!context.body) {
        return;
    }

    if (!context.body.startsWith(PREFIX)) {
        await handleNonCommandMessage(context);
        return;
    }

    ensureChatSettings(context.chatId);

    const [commandName, ...args] = context.body.slice(PREFIX.length).split(/\s+/);
    const resolvedCommand = commandAliases[commandName.toLowerCase()] || commandName.toLowerCase();
    const command = commands[resolvedCommand];

    if (!command) {
        await context.reply("Unknown command. Send !menu to see what's available.");
        return;
    }

    if (!isOwner(context)) {
        await context.reply('Only the bot owner can use this command.');
        return;
    }

    if (store.mutedChats[context.chatId] && !command.runWhenMuted) {
        return;
    }

    if (store.privateMode && !isOwner(context)) {
        await context.reply('Bot is in private mode. Only the owner can use commands here.');
        return;
    }

    totalCommandsHandled += 1;

    try {
        await command.run(context, args);
    } catch (error) {
        console.error(`Command "${commandName}" failed:`, error);

        if (commandName.toLowerCase() === 'ask' && String(error.message).includes('groq_429')) {
            await context.reply('Groq rate limit or free quota is exhausted right now. Please try again shortly.');
            return;
        }

        if (commandName.toLowerCase() === 'ask' && String(error.message).includes('groq_503')) {
            await context.reply('Groq is under heavy demand right now. Please try again shortly.');
            return;
        }

        await context.reply('Something went wrong while running that command.');
    }
}

async function handleMessages(messages) {
    for (const message of messages) {
        console.log('DEBUG message', message.key?.remoteJid, 'fromMe=', message.key?.fromMe, 'hasMessage=', !!message.message);

        if (!message.message || sentMessageIds.has(message.key.id)) {
            console.log('DEBUG skip: no message/sent');
            continue;
        }

        if (message.key.remoteJid === 'status@broadcast') {
            if (store.autoViewStatus) {
                try {
                    await sock.sendReceipt('status@broadcast', message.key.participant, [message.key.id], 'read');
                } catch (receiptError) {
                    console.error('Auto-view status failed:', receiptError);
                }
            }
            console.log('DEBUG skip: status broadcast');
            continue;
        }

        if (store.autoBypassViewOnce) {
            const viewOnceMedia = getIncomingViewOnceMedia(message);
            console.log('DEBUG auto-bypass view-once check:', viewOnceMedia ? 'found' : 'none');
            if (viewOnceMedia) {
                try {
                    const buffer = await downloadMediaMessage(viewOnceMedia, 'buffer', {});
                    const inner = viewOnceMedia.message;
                    const ownerJid = jidNormalizedUser(sock.user?.id || '');

                    if (ownerJid) {
                        if (inner.stickerMessage) {
                            continue;
                        } else if (inner.imageMessage) {
                            await sock.sendMessage(ownerJid, { image: buffer, caption: inner.caption || undefined });
                        } else if (inner.videoMessage) {
                            await sock.sendMessage(ownerJid, { video: buffer, caption: inner.caption || undefined });
                        } else if (inner.documentMessage) {
                            await sock.sendMessage(ownerJid, { document: buffer, mimetype: inner.documentMessage.mimetype || 'application/octet-stream', caption: inner.caption || undefined });
                        } else if (inner.audioMessage || inner.pttMessage) {
                            await sock.sendMessage(ownerJid, { audio: buffer, mimetype: 'audio/ogg; codecs=opus' });
                        } else {
                            await sock.sendMessage(ownerJid, { document: buffer });
                        }
                    }
                } catch (bypassError) {
                    console.error('Auto-bypass view-once failed:', bypassError);
                }
            }
        }

        // Ignore non-command messages that were sent from this WhatsApp account
        // (message.key.fromMe === true). This prevents the bot from auto-replying
        // to messages you send to others while still allowing you to run commands
        // (messages starting with the command prefix).
        const isFromMe = Boolean(message.key.fromMe);
        const outgoingBody = getTextFromMessage(message).trim();
        console.log('DEBUG body=', JSON.stringify(outgoingBody), 'isFromMe=', isFromMe);

        if (isFromMe && !outgoingBody.startsWith(PREFIX)) {
            console.log('DEBUG skip: fromMe and not command');
            continue;
        }

        if (message.messageStubType || message.message?.protocolMessage) {
            console.log('DEBUG skip: stub/protocol');
            continue;
        }

        const messageTimestamp = Number(message.messageTimestamp || 0);
        if (messageTimestamp && messageTimestamp < startupTimeSec - 120) {
            console.log('DEBUG skip: old message');
            continue;
        }

        const messageId = message.key.id;

        if (!messageId || seenMessageIds.has(messageId)) {
            console.log('DEBUG skip: no id/seen');
            continue;
        }

        seenMessageIds.add(messageId);

        if (seenMessageIds.size > 5000) {
            seenMessageIds.clear();
        }

        const context = createContext(message);
        
        if (context.isGroup && context.body) {
            let buffer = groupMessageBuffers.get(context.chatId) || [];
            buffer.push({
                sender: message.pushName || getBaseUserId(context.senderId),
                text: context.body,
                timestamp: Date.now()
            });
            if (buffer.length > 200) {
                buffer = buffer.slice(-200);
            }
            groupMessageBuffers.set(context.chatId, buffer);
        }

        console.log('DEBUG context body=', JSON.stringify(context.body), 'chatId=', context.chatId);
        await handleCommandMessage(context);
        totalMessagesHandled += 1;
    }
}

async function handleGroupParticipantsUpdate(update) {
    const { id: groupId, participants, action } = update;

    // Welcome new members
    if (action === 'add') {
        try {
            const welcomeText = store.welcomeMessages[groupId] || 'Welcome. The bot is online here. Send !menu to see commands.';
            await sendText(groupId, welcomeText);
        } catch (error) {
            console.error('Failed to send welcome message:', error);
        }
    }

    // Log join/leave events to the configured log chat
    if (store.logChatId) {
        try {
            let groupName = groupId;
            try {
                const meta = await getGroupMetadata(groupId);
                if (meta?.subject) groupName = meta.subject;
            } catch (_) {}

            const actionLabel =
                action === 'add'    ? 'joined' :
                action === 'remove' ? 'was removed from' :
                action === 'leave'  ? 'left' : action;

            for (const participant of (participants || [])) {
                const num = getBaseUserId(participant);
                await sendText(store.logChatId, `📋 ${num} ${actionLabel} *${groupName}*`);
            }
        } catch (error) {
            console.error('Failed to send log message:', error);
        }
    }
}

async function startSock() {
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }

    if (sock?.ws?.close) {
        try {
            sock.ws.close();
        } catch (error) {
            console.warn('Failed to close existing socket cleanly:', error);
        }
    }

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_PATH);
    const { version } = await fetchLatestBaileysVersion();

    console.log('Starting WhatsApp bot with Baileys...');
    console.log(`Auth path: ${AUTH_PATH}`);
    
    try {
        const authFiles = fs.readdirSync(AUTH_PATH).filter(f => f !== 'tmp' && f !== 'whatsapp-qr.png');
        console.log('Existing auth files:', authFiles.length > 0 ? authFiles.join(', ') : 'none (will need QR)');
    } catch {
        console.log('No existing auth directory found (will need QR)');
    }
    
    console.log('Waiting for WhatsApp to initialize...');

    sock = makeWASocket({
        auth: state,
        version,
        printQRInTerminal: false,
        markOnlineOnConnect: true,
        syncFullHistory: false,
        enableAutoSessionRecreation: true,
        browser: ['WhatsApp Bot', 'Chrome', '1.0.0']
    });

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (!messages?.length || type !== 'notify') {
            return;
        }

        console.log('DEBUG upsert received', messages.length, type);
        await handleMessages(messages);
    });
    sock.ev.on('group-participants.update', handleGroupParticipantsUpdate);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            const qrValue = typeof qr === 'string' ? qr : JSON.stringify(qr);
            console.log('Scan this QR code with WhatsApp:');
            console.log('QR type:', typeof qr, 'length:', qrValue.length);
            qrcode.generate(qrValue, { small: true });

            try {
                fs.mkdirSync(AUTH_PATH, { recursive: true });
                await QRCode.toFile(QR_IMAGE_PATH, qrValue, {
                    type: 'png',
                    errorCorrectionLevel: 'H',
                    margin: 2,
                    width: 600
                });
                qrToken += 1;
                qrUpdatedAt = Date.now();
                scheduleQrWatchdog();
                console.log('Saved QR image to: ' + QR_IMAGE_PATH);
                console.log('If needed, open /qr in a browser to view the QR image.');
                broadcastSse({ type: 'status', online: false, qrAvailable: true, qrToken, qrUpdatedAt });
                broadcastStatus();
            } catch (error) {
                console.error('Failed to save QR image:', error);
            }
        }

        if (connection === 'open') {
            reconnecting = false;
            reconnectAttempts = 0;
            console.log('Client is ready!');
            clearQrWatchdog();
            
            try {
                await saveCreds();
                console.log('Auth credentials saved successfully');
            } catch (saveError) {
                console.error('Failed to save auth credentials:', saveError);
            }
            
            try {
                if (fs.existsSync(QR_IMAGE_PATH)) {
                    fs.unlinkSync(QR_IMAGE_PATH);
                }
            } catch (error) {
                console.warn('Failed to remove stale QR image:', error);
            }
            qrToken += 1;
            qrUpdatedAt = Date.now();
            scheduleNextMessageCheck();
            broadcastSse({ type: 'status', online: true });
            broadcastStatus();
            return;
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const statusText = lastDisconnect?.error?.output?.payload || lastDisconnect?.error?.message || 'unknown';
            const isLoggedOut = statusCode === DisconnectReason.loggedOut;
            const isConflict = [DisconnectReason.connectionReplaced, 405, 440].includes(statusCode);

            console.warn('Connection closed:', statusCode || 'unknown', 'reason:', statusText);

            if (isLoggedOut) {
                console.error('Logged out. Clearing auth and waiting for a new QR scan...');
                try {
                    if (fs.existsSync(AUTH_PATH)) {
                        const entries = fs.readdirSync(AUTH_PATH);
                        for (const entry of entries) {
                            const entryPath = path.join(AUTH_PATH, entry);
                            const stat = fs.statSync(entryPath);
                            if (stat.isDirectory()) {
                                fs.rmSync(entryPath, { recursive: true });
                            } else {
                                fs.unlinkSync(entryPath);
                            }
                        }
                    }
                } catch (error) {
                    console.error('Failed to clear auth on logout:', error);
                }

                if (!reconnecting) {
                    reconnecting = true;
                    reconnectTimer = setTimeout(async () => {
                        reconnectTimer = null;
                        reconnecting = false;
                        try {
                            await startSock();
                        } catch (error) {
                            console.error('Re-link after logout failed:', error);
                        }
                    }, 2000);
                }
                return;
            }

            if (isConflict) {
                if (statusCode === DisconnectReason.connectionReplaced || statusCode === 440) {
                    console.warn('Session conflict detected (code ' + statusCode + '). Stopping auto reconnect to avoid repeated replacement loops.');
                } else if (statusCode === 405) {
                    console.warn('Multi-device conflict detected (code 405). Stopping auto reconnect.');
                }
                reconnecting = false;
                broadcastSse({ type: 'status', online: false });
                broadcastStatus();
                return;
            }

            if (!reconnecting) {
                reconnecting = true;
                reconnectAttempts += 1;
                const delayMs = Math.min(30000, 5000 * reconnectAttempts);
                console.log(`Reconnecting in ${delayMs / 1000}s...`);
                reconnectTimer = setTimeout(async () => {
                    reconnectTimer = null;
                    try {
                        await startSock();
                    } catch (error) {
                        console.error('Reconnection failed:', error);
                    } finally {
                        reconnecting = false;
                    }
                }, delayMs);
                broadcastSse({ type: 'status', online: false });
                broadcastStatus();
            }
        }
    });
}

ensureStartedWhenOnline().catch((error) => {
    console.error('Client initialization failed:', error);
});

const port = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(process.cwd(), 'public');
const STATIC_ROUTES = {
    '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
    '/index.html': { file: 'index.html', type: 'text/html; charset=utf-8' },
    '/style.css': { file: 'style.css', type: 'text/css; charset=utf-8' },
    '/app.js': { file: 'app.js', type: 'application/javascript; charset=utf-8' }
};

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon'
};

function serveStatic(url, req, res) {
    const route = STATIC_ROUTES[url];
    if (route) {
        const filePath = path.join(PUBLIC_DIR, route.file);
        if (!filePath.startsWith(PUBLIC_DIR) || !fs.existsSync(filePath)) {
            return false;
        }
        res.writeHead(200, { 'Content-Type': route.type, 'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': '*' });
        fs.createReadStream(filePath).pipe(res);
        return true;
    }

    const ext = path.extname(url);
    if (ext && MIME[ext]) {
        const filePath = path.join(PUBLIC_DIR, url.replace(/^\//, ''));
        if (!filePath.startsWith(PUBLIC_DIR) || !fs.existsSync(filePath)) {
            return false;
        }
        res.writeHead(200, { 'Content-Type': MIME[ext], 'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': '*' });
        fs.createReadStream(filePath).pipe(res);
        return true;
    }

    return false;
}

async function buildStatus() {
    const connected = Boolean(sock && sock.user);
    const chatIds = Array.from(
        new Set([
            ...Object.keys(store.mutedChats),
            ...Object.keys(store.autoReplyChats),
            ...Object.keys(store.antiLinkChats),
            ...Object.keys(store.aiEnabledChats)
        ])
    );
    const defaultPrompt = store.defaultAiPrompt || DEFAULT_AI_PROMPT;

    const knownChatsList = await Promise.all(chatIds.map(async (chatId) => {
        let displayName = chatId;
        try {
            if (chatId.endsWith('@g.us')) {
                const meta = await getGroupMetadata(chatId);
                if (meta?.subject) {
                    displayName = meta.subject;
                }
            } else if (chatId !== 'status@broadcast') {
                const base = getBaseUserId(chatId);
                displayName = base || chatId;
            }
        } catch (error) {
            displayName = chatId;
        }

        return {
            chatId,
            displayName,
            muted: Boolean(store.mutedChats[chatId]),
            autoReply: store.autoReplyChats[chatId] !== false,
            antiLink: Boolean(store.antiLinkChats[chatId]),
            antiSpam: Boolean(store.antiSpamChats[chatId]),
            aiEnabled: Boolean(store.aiEnabledChats[chatId]),
            aiPrompt: store.aiSystemPrompts[chatId] || defaultPrompt
        };
    }));

    return {
        online: connected,
        connectedNumber: sock?.user?.id ? jidNormalizedUser(sock.user.id) : null,
        uptimeSeconds: Math.max(0, Math.floor(Date.now() / 1000) - startupTimeSec),
        messagesHandled: totalMessagesHandled,
        commandsHandled: totalCommandsHandled,
        knownChats: chatIds.length,
        knownChatsList,
        globalAiEnabled: store.globalAiEnabled,
        privateMode: store.privateMode,
        autoViewStatus: store.autoViewStatus,
        autoBypassViewOnce: store.autoBypassViewOnce,
        defaultAiPrompt: store.defaultAiPrompt || '',
        defaultAiPersonality: store.defaultAiPersonality || 'sarcastic_teen',
        aiPersonalities: AI_PERSONALITY_PRESETS.map(p => ({ id: p.id, name: p.name, prompt: p.prompt })),
        theme: store.theme || { mode: 'dark', accent: '#25d366' },
        groqKeySet: Boolean(GROQ_API_KEY),
        model: GROQ_MODEL,
        reconnecting,
        logChatId: store.logChatId || '',
        autoPromoThresholds: store.autoPromoThresholds || [100, 500, 1000],
        scheduledMessages: store.scheduledMessages.map((item) => ({
            id: item.id,
            chatId: item.chatId,
            text: item.text,
            sendAt: item.sendAt
        })),
        quotes: store.quotes,
        keywordTriggers: store.keywordTriggers,
        qrAvailable: fs.existsSync(QR_IMAGE_PATH),
        qrToken,
        qrUpdatedAt,
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

async function handleApiPost(req, res, url, body) {
    const ok = (extra) => sendJson(res, 200, { ok: true, ...extra });
    const fail = (error, code = 400) => sendJson(res, code, { ok: false, error });

    switch (url) {
        case '/api/settings/global-ai': {
            const enabled = Boolean(body.enabled);
            if (enabled && !GROQ_API_KEY) {
                return fail('Set GROQ_API_KEY before enabling AI.');
            }
            store.globalAiEnabled = enabled;
            for (const chatId of Object.keys(store.aiEnabledChats)) {
                store.aiEnabledChats[chatId] = enabled;
            }
            saveStore();
            return ok({ globalAiEnabled: enabled });
        }

        case '/api/settings/private': {
            store.privateMode = Boolean(body.enabled);
            saveStore();
            return ok({ privateMode: store.privateMode });
        }

        case '/api/settings/ai-prompt': {
            const text = String(body.text || '').trim();
            const personality = String(body.personality || '').trim();
            if (personality) {
                const preset = AI_PERSONALITY_PRESETS.find(p => p.id === personality);
                if (preset) {
                    store.defaultAiPersonality = preset.id;
                    store.defaultAiPrompt = preset.prompt;
                }
            } else if (text) {
                store.defaultAiPrompt = text;
                store.defaultAiPersonality = '';
            }
            saveStore();
            return ok({ defaultAiPrompt: store.defaultAiPrompt, defaultAiPersonality: store.defaultAiPersonality });
        }

        case '/api/settings/theme': {
            const mode = String(body.mode || store.theme.mode).toLowerCase();
            const accent = String(body.accent || store.theme.accent).trim();
            if (!['dark', 'light'].includes(mode)) {
                return fail('mode must be dark or light');
            }
            if (!/^#[0-9a-fA-F]{6}$/.test(accent)) {
                return fail('accent must be a valid hex color');
            }
            store.theme = { mode, accent };
            saveStore();
            return ok({ theme: store.theme });
        }

        case '/api/settings/auto-view-status': {
            store.autoViewStatus = Boolean(body.enabled);
            saveStore();
            return ok({ autoViewStatus: store.autoViewStatus });
        }

        case '/api/settings/auto-bypass-view-once': {
            store.autoBypassViewOnce = Boolean(body.enabled);
            saveStore();
            return ok({ autoBypassViewOnce: store.autoBypassViewOnce });
        }

        case '/api/chat/mute': {
            const chatId = String(body.chatId || '');
            if (!chatId) {
                return fail('chatId is required.');
            }
            ensureChatSettings(chatId);
            store.mutedChats[chatId] = Boolean(body.muted);
            saveStore();
            return ok({ chatId, muted: store.mutedChats[chatId] });
        }

        case '/api/moderation/antispam': {
            const chatId = String(body.chatId || '');
            if (!chatId) return fail('chatId is required.');
            ensureChatSettings(chatId);
            store.antiSpamChats[chatId] = Boolean(body.enabled);
            saveStore();
            return ok({ chatId, antiSpam: store.antiSpamChats[chatId] });
        }

        case '/api/moderation/antilink': {
            const chatId = String(body.chatId || '');
            if (!chatId) return fail('chatId is required.');
            ensureChatSettings(chatId);
            store.antiLinkChats[chatId] = Boolean(body.enabled);
            saveStore();
            return ok({ chatId, antiLink: store.antiLinkChats[chatId] });
        }

        case '/api/moderation/autoreply': {
            const chatId = String(body.chatId || '');
            if (!chatId) return fail('chatId is required.');
            ensureChatSettings(chatId);
            store.autoReplyChats[chatId] = Boolean(body.enabled);
            saveStore();
            return ok({ chatId, autoReply: store.autoReplyChats[chatId] });
        }

        case '/api/moderation/wordfilter': {
            const chatId = String(body.chatId || '');
            const action = String(body.action || '').toLowerCase();
            const word = String(body.word || '').trim().toLowerCase();
            if (!chatId) return fail('chatId is required.');
            if (action === 'add') {
                if (!word) return fail('word is required.');
                store.wordFilters[chatId] = store.wordFilters[chatId] || [];
                if (!store.wordFilters[chatId].includes(word)) {
                    store.wordFilters[chatId].push(word);
                }
                saveStore();
                return ok({ chatId, word, filters: store.wordFilters[chatId] });
            }
            if (action === 'remove') {
                if (!word) return fail('word is required.');
                store.wordFilters[chatId] = (store.wordFilters[chatId] || []).filter((w) => w !== word);
                saveStore();
                return ok({ chatId, word, filters: store.wordFilters[chatId] });
            }
            return ok({ chatId, filters: store.wordFilters[chatId] || [] });
        }

        case '/api/broadcast': {
            const text = String(body.text || '').trim();
            if (!text) {
                return fail('Broadcast text is required.');
            }
            if (!sock) {
                return fail('Bot is not connected.', 503);
            }
            const chats = Array.from(
                new Set([
                    ...Object.keys(store.mutedChats),
                    ...Object.keys(store.autoReplyChats),
                    ...Object.keys(store.antiLinkChats),
                    ...Object.keys(store.aiEnabledChats)
                ])
            );
            let sent = 0;
            for (const chatId of chats) {
                try {
                    await sendText(chatId, text);
                    sent += 1;
                } catch (error) {
                    console.error('Broadcast failed for', chatId, error);
                }
            }
            return ok({ sent, total: chats.length });
        }

        case '/api/schedule': {
            const minutes = Number(body.minutes);
            const text = String(body.text || '').trim();
            const chatId = String(body.chatId || '');
            if (!minutes || minutes <= 0 || !text) {
                return fail('minutes and text are required.');
            }
            const target = chatId || (knownChatsList[0] && knownChatsList[0].chatId);
            if (!target) {
                return fail('No target chat is available.');
            }
            const item = {
                id: Date.now(),
                chatId: target,
                text,
                sendAt: Date.now() + minutes * 60000,
                sent: false,
                options: {}
            };
            store.scheduledMessages.push(item);
            saveStore();
            scheduleNextMessageCheck();
            return ok({ scheduled: item });
        }

        case '/api/scheduled/clear': {
            if (body.id) {
                store.scheduledMessages = store.scheduledMessages.filter((item) => item.id !== Number(body.id));
            } else {
                store.scheduledMessages = [];
            }
            saveStore();
            scheduleNextMessageCheck();
            return ok({ remaining: store.scheduledMessages.length });
        }

        case '/api/quotes/save': {
            const text = String(body.text || '').trim();
            if (!text) {
                return fail('Quote text is required.');
            }
            store.quotes.push({ text, sender: 'web', timestamp: Date.now() });
            if (store.quotes.length > 200) {
                store.quotes = store.quotes.slice(-100);
            }
            saveStore();
            return ok({ count: store.quotes.length });
        }

        case '/api/quotes/clear': {
            store.quotes = [];
            saveStore();
            return ok({ count: 0 });
        }

        case '/api/profile-picture': {
            const jid = String(body.jid || '').trim();
            if (!jid) {
                return fail('jid is required.');
            }
            if (!sock) {
                return fail('Bot is not connected.', 503);
            }
            try {
                const url = await sock.profilePictureUrl(jid, 'image');
                if (!url) {
                    return ok({ url: null });
                }
                return ok({ url });
            } catch (error) {
                return ok({ url: null });
            }
        }

        case '/api/restart': {
            setTimeout(() => process.exit(0), 800);
            return ok({ restarting: true });
        }

        case '/api/logchat': {
            const chatId = String(body.chatId || '').trim();
            store.logChatId = chatId;
            saveStore();
            return ok({ logChatId: chatId });
        }

        case '/api/autopromo/thresholds': {
            const thresholds = Array.isArray(body.thresholds)
                ? body.thresholds.map(Number).filter((n) => n > 0).sort((a, b) => a - b)
                : [];
            if (!thresholds.length) {
                return fail('thresholds array is required.');
            }
            store.autoPromoThresholds = thresholds;
            saveStore();
            return ok({ autoPromoThresholds: thresholds });
        }

        case '/api/triggers': {
            const action = String(body.action || 'list').toLowerCase();

            if (action === 'list') {
                return ok({ triggers: store.keywordTriggers });
            }

            if (action === 'add' || action === 'save') {
                const keyword = String(body.keyword || '').trim().toLowerCase();
                const reply = String(body.reply || '').trim();
                if (!keyword || !reply) {
                    return fail('keyword and reply are required.');
                }
                const existing = store.keywordTriggers.findIndex(t => t.keyword === keyword);
                const trigger = { keyword, reply, id: existing >= 0 ? store.keywordTriggers[existing].id : Date.now() };
                if (existing >= 0) {
                    store.keywordTriggers[existing] = trigger;
                } else {
                    store.keywordTriggers.push(trigger);
                }
                saveStore();
                return ok({ trigger });
            }

            if (action === 'delete' || action === 'remove') {
                const id = Number(body.id);
                if (!id) {
                    return fail('trigger id is required.');
                }
                store.keywordTriggers = store.keywordTriggers.filter(t => t.id !== id);
                saveStore();
                return ok({ remaining: store.keywordTriggers.length });
            }

            return fail('action must be list|add|delete');
        }

        default:
            return fail('Unknown API route: ' + url, 404);
    }
}

async function requestHandler(req, res) {
    const url = (req.url || '/').split('?')[0];

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    if (req.method === 'POST' && url.startsWith('/api/')) {
        const body = await readJsonBody(req);
        try {
            await handleApiPost(req, res, url, body);
        } catch (error) {
            sendJson(res, 500, { ok: false, error: String((error && error.message) || error) });
        }
        return;
    }

    if (url === '/api/triggers') {
        sendJson(res, 200, { triggers: store.keywordTriggers });
        return;
    }

    if (url === '/api/status') {
        sendJson(res, 200, await buildStatus());
        return;
    }

    if (url === '/qr') {
        if (!fs.existsSync(QR_IMAGE_PATH)) {
            res.writeHead(404, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
            res.end('QR image not available yet. Wait for bot initialization and scan log output first.');
            return;
        }

        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
        fs.createReadStream(QR_IMAGE_PATH).pipe(res);
        return;
    }

    if (url === '/api/events') {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'Access-Control-Allow-Origin': '*'
        });
        sseClients.add(res);
        res.write('retry: 2000\n\n');

        const heartbeat = setInterval(() => {
            if (!res.writableEnded) {
                res.write(':\n\n');
            } else {
                clearInterval(heartbeat);
                sseClients.delete(res);
            }
        }, 15000);

        req.on('close', () => {
            sseClients.delete(res);
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
        const ico = path.join(PUBLIC_DIR, 'favicon.ico');
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

let attempts = 0;
const maxAttempts = 10;
let currentPort = port;

(function tryStart() {
    const srv = createServerInstance();

    srv.on('error', (err) => {
        if (err && err.code === 'EADDRINUSE') {
            if (process.env.PORT) {
                console.error(`Port ${currentPort} is already in use. Set PORT to a different value or free the port and retry.`);
                console.error('On Windows: run `netstat -ano | findstr :' + currentPort + '` to find the PID, then `taskkill /PID <pid> /F` to stop it.');
                process.exit(1);
            }

            if (attempts < maxAttempts) {
                attempts += 1;
                console.warn(`Port ${currentPort} in use, trying port ${currentPort + 1}...`);
                currentPort += 1;
                setTimeout(tryStart, 200);
                return;
            }

            console.error(`Unable to bind to a port after ${maxAttempts} attempts. Give up.`);
            process.exit(1);
        }

        console.error('Server error:', err);
        process.exit(1);
    });

    srv.listen(currentPort, () => {
        console.log(`Health endpoint listening on port ${currentPort}`);
    });
})();
