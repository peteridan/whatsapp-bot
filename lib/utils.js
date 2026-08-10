const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const {
    getContentType,
    jidNormalizedUser,
    downloadMediaMessage
} = require('@whiskeysockets/baileys');
const config = require('./config');
const state = require('./state');
const { saveStore } = require('./store');

function esc(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
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

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
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
            '!story on|off - Auto-view status updates',
            '!bypass on|off - Auto-forward view-once media to owner'
        ]}
    ];

    let text = 'Available commands:\n\n';
    for (const section of sections) {
        text += `*${section.title}*\n`;
        for (const item of section.items) {
            text += `  ${item}\n`;
        }
        text += '\n';
    }
    return text.trim();
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

function isOwner(context) {
    return context.rawMessage?.key?.fromMe === true || (() => {
        const ownerBaseId = getBaseUserId(state.sock?.user?.id || '');
        const senderBaseId = getBaseUserId(context.senderId);
        return Boolean(ownerBaseId && senderBaseId === ownerBaseId);
    })();
}

function ensureChatSettings(chatId) {
    if (!(chatId in state.store.mutedChats)) {
        state.store.mutedChats[chatId] = false;
    }

    if (!(chatId in state.store.autoReplyChats)) {
        state.store.autoReplyChats[chatId] = true;
    }

    if (!(chatId in state.store.antiLinkChats)) {
        state.store.antiLinkChats[chatId] = false;
    }

    if (!(chatId in state.store.aiEnabledChats)) {
        state.store.aiEnabledChats[chatId] = state.store.globalAiEnabled;
    }

    if (!(chatId in state.store.antiSpamChats)) {
        state.store.antiSpamChats[chatId] = false;
    }

    if (!(chatId in state.store.antiSpamSettings)) {
        state.store.antiSpamSettings[chatId] = { maxMessages: 5, windowSeconds: 5 };
    }

    if (!(chatId in state.store.autoPromoEnabled)) {
        state.store.autoPromoEnabled[chatId] = false;
    }
}

async function sendText(chatId, text, options = {}) {
    if (!state.sock) {
        throw new Error('Socket not ready');
    }
    await state.sock.sendMessage(chatId, { text, ...options });
}

async function sendMedia(chatId, media, options = {}) {
    if (!state.sock) {
        throw new Error('Socket not ready');
    }
    await state.sock.sendMessage(chatId, media, options);
}

function getQuotedSticker(context) {
    const quoted = context.rawMessage.message?.extendedTextMessage?.contextInfo?.quotedMessage;
    if (!quoted) return null;
    if (quoted.stickerMessage) {
        return {
            key: context.rawMessage.key,
            message: { stickerMessage: quoted.stickerMessage }
        };
    }
    return null;
}

function getQuotedVideo(context) {
    const quoted = context.rawMessage.message?.extendedTextMessage?.contextInfo?.quotedMessage;
    if (!quoted) return null;
    if (quoted.videoMessage) {
        return {
            key: context.rawMessage.key,
            message: { videoMessage: quoted.videoMessage }
        };
    }
    return null;
}

function getIncomingViewOnceMedia(message) {
    const inner = message.message?.extendedTextMessage?.message ||
        message.message?.ephemeralMessage?.message ||
        message.message?.viewOnceMessageV2?.message ||
        message.message?.viewOnceMessageV2Extension?.message;

    if (!inner) return null;

    const sticker = inner.stickerMessage;
    const image = inner.imageMessage;
    const video = inner.videoMessage;
    const document = inner.documentMessage;
    const audio = inner.audioMessage || inner.pttMessage;

    if (sticker || image || video || document || audio) {
        return {
            key: message.key,
            message: inner
        };
    }
    return null;
}

function getSenderName(rawMessage, metadata) {
    const participant = rawMessage.key?.participant || rawMessage.key?.remoteJid;
    if (metadata?.participants) {
        const found = metadata.participants.find(p => jidNormalizedUser(p.id) === jidNormalizedUser(participant));
        if (found?.name) return found.name;
    }
    return getBaseUserId(participant);
}

function hasFfmpeg() {
    try {
        execSync('ffmpeg -version', { encoding: 'utf8', timeout: 5000 });
        return true;
    } catch {
        return false;
    }
}

function broadcastSse(data) {
    const payload = 'data: ' + JSON.stringify(data) + '\n\n';
    for (const res of state.sseClients) {
        try {
            if (!res.writableEnded) {
                res.write(payload);
            }
        } catch {
            state.sseClients.delete(res);
        }
    }
}

async function broadcastStatus() {
    try {
        const status = await require('./routes').buildStatus(state.store, state.sock);
        broadcastSse({ type: 'status', ...status });
    } catch (error) {
        console.error('broadcastStatus failed:', error);
    }
}

module.exports = {
    esc,
    fmtUptime,
    delay,
    hasInternetConnection,
    getBaseUserId,
    getTextFromMessage,
    isGreeting,
    hasLink,
    formatMenu,
    createContext,
    isOwner,
    ensureChatSettings,
    sendText,
    sendMedia,
    getQuotedSticker,
    getQuotedVideo,
    getIncomingViewOnceMedia,
    getSenderName,
    hasFfmpeg,
    broadcastSse,
    broadcastStatus,
    saveStore
};
