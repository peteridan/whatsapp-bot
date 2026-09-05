const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');
const qrcode = require('qrcode-terminal');
const config = require('./config');
const state = require('./state');
const utils = require('./utils');
const commands = require('./commands');
const moderation = require('./moderation');
const media = require('./media');
const { makeWASocket, DisconnectReason, fetchLatestBaileysVersion, useMultiFileAuthState } = require('@whiskeysockets/baileys');

function logActivity(type, message) {
    const entry = { time: new Date().toISOString(), type, message };
    state.activityLog.push(entry);
    if (state.activityLog.length > 500) state.activityLog = state.activityLog.slice(-500);
    console.log(`[${entry.type}] ${entry.message}`);
}

function scheduleQrWatchdog() {
    if (state.qrWatchdogTimer) {
        clearTimeout(state.qrWatchdogTimer);
    }

    state.qrWatchdogTimer = setTimeout(() => {
        state.qrWatchdogTimer = null;

        if (state.sock && state.sock.user) {
            return;
        }

        if (state.reconnecting) {
            return;
        }

        console.log('QR not scanned in time. Restarting socket to fetch a fresh QR code...');
        startSock().catch((err) => console.error('QR watchdog restart failed:', err));
    }, 60000);
}

function clearQrWatchdog() {
    if (state.qrWatchdogTimer) {
        clearTimeout(state.qrWatchdogTimer);
        state.qrWatchdogTimer = null;
    }
}

function clearScheduledMessagesTimer() {
    if (state.scheduledMessagesTimer) {
        clearTimeout(state.scheduledMessagesTimer);
        state.scheduledMessagesTimer = null;
    }
}

async function processDueScheduledMessages() {
    const now = Date.now();
    const due = state.store.scheduledMessages.filter((item) => item.sendAt <= now && !item.sent);

    for (const item of due) {
        try {
            await utils.sendText(item.chatId, item.text, item.options || {});
            item.sent = true;
            item.sentAt = now;
        } catch (error) {
            console.error('Scheduled message failed:', error);
            item.failed = true;
            item.error = String(error.message);
        }
    }

    state.store.scheduledMessages = state.store.scheduledMessages.filter((item) => !item.sent);
    utils.saveStore();
}

function scheduleNextMessageCheck() {
    clearScheduledMessagesTimer();

    if (!state.store.scheduledMessages.length) {
        return;
    }

    const next = state.store.scheduledMessages
        .filter((item) => !item.sent)
        .sort((a, b) => a.sendAt - b.sendAt)[0];

    if (!next) {
        clearScheduledMessagesTimer();
        return;
    }

    const delayMs = Math.max(1000, next.sendAt - Date.now());
    state.scheduledMessagesTimer = setTimeout(async () => {
        state.scheduledMessagesTimer = null;
        try {
            await processDueScheduledMessages();
        } catch (error) {
            console.error('Scheduled message processing failed:', error);
        } finally {
            scheduleNextMessageCheck();
        }
    }, delayMs);
}

async function startSock() {
    if (state.reconnectTimer) {
        clearTimeout(state.reconnectTimer);
        state.reconnectTimer = null;
    }

    if (state.sock?.ws?.close) {
        try {
            state.sock.ws.close();
        } catch (error) {
            console.warn('Failed to close existing socket cleanly:', error);
        }
    }

    const { state: authState, saveCreds } = await useMultiFileAuthState(config.AUTH_PATH);
    const { version } = await fetchLatestBaileysVersion();

    console.log('Starting WhatsApp bot with Baileys...');
    console.log(`Auth path: ${config.AUTH_PATH}`);
    
    try {
        const authFiles = fs.readdirSync(config.AUTH_PATH).filter(f => f !== 'tmp' && f !== 'whatsapp-qr.png');
        console.log('Existing auth files:', authFiles.length > 0 ? authFiles.join(', ') : 'none (will need QR)');
    } catch {
        console.log('No existing auth directory found (will need QR)');
    }
    
    console.log('Waiting for WhatsApp to initialize...');

    state.sock = makeWASocket({
        auth: authState,
        version,
        printQRInTerminal: false,
        markOnlineOnConnect: true,
        syncFullHistory: false,
        browser: ['WhatsApp Bot', 'Chrome', '1.0.0']
    });

    state.sock.ev.on('creds.update', saveCreds);
    state.sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (!messages?.length || type !== 'notify') {
            return;
        }

        console.log('DEBUG upsert received', messages.length, type);
        try {
            await handleMessages(messages);
        } catch (err) {
            console.error('Message handling crashed (skipped batch):', err);
        }
    });
    state.sock.ev.on('group-participants.update', moderation.handleGroupParticipantsUpdate);
    state.sock.ev.on('presence.update', (update) => {
        const { id, presence } = update;
        if (!id) return;
        const isOnline = presence === 'available';
        const wasOnline = state.presence.get(id) === 'available';
        if (isOnline && !wasOnline) {
            console.log('Presence online:', id);
        } else if (!isOnline && wasOnline) {
            console.log('Presence offline:', id);
        }
        state.presence.set(id, presence || 'unavailable');
    });

    state.sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            const qrValue = typeof qr === 'string' ? qr : JSON.stringify(qr);
            const now = Date.now();
            const unchanged = qrValue === state.lastQrValue;
            const cooldown = now - (state.lastQrUpdateAt || 0) < 20000;
            if (unchanged && cooldown) {
                return;
            }
            state.lastQrValue = qrValue;
            state.lastQrUpdateAt = now;
            console.log('Scan this QR code with WhatsApp:');
            console.log('QR type:', typeof qr, 'length:', qrValue.length);
            qrcode.generate(qrValue, { small: true });

            try {
                fs.mkdirSync(config.AUTH_PATH, { recursive: true });
                await QRCode.toFile(config.QR_IMAGE_PATH, qrValue, {
                    type: 'png',
                    errorCorrectionLevel: 'H',
                    margin: 2,
                    width: 600
                });
                state.qrToken += 1;
                state.qrUpdatedAt = Date.now();
                scheduleQrWatchdog();
                logActivity('QR', 'QR code generated');
                console.log('Saved QR image to: ' + config.QR_IMAGE_PATH);
                console.log('If needed, open /qr in a browser to view the QR image.');
                utils.broadcastSse({ type: 'status', online: false, qrAvailable: true, qrToken: state.qrToken, qrUpdatedAt: state.qrUpdatedAt });
                utils.broadcastStatus();
            } catch (error) {
                console.error('Failed to save QR image:', error);
            }
        }

        if (connection === 'open') {
            state.reconnecting = false;
            state.reconnectAttempts = 0;
            console.log('Client is ready!');
            logActivity('CONNECT', 'WhatsApp connected');
            clearQrWatchdog();
            
            try {
                await saveCreds();
                console.log('Auth credentials saved successfully');
            } catch (saveError) {
                console.error('Failed to save auth credentials:', saveError);
            }
            
            try {
                if (fs.existsSync(config.QR_IMAGE_PATH)) {
                    fs.unlinkSync(config.QR_IMAGE_PATH);
                }
            } catch (error) {
                console.warn('Failed to remove stale QR image:', error);
            }
            state.qrToken += 1;
            state.qrUpdatedAt = Date.now();
            scheduleNextMessageCheck();
            utils.broadcastSse({ type: 'status', online: true });
            utils.broadcastStatus();
            return;
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const statusText = lastDisconnect?.error?.output?.payload || lastDisconnect?.error?.message || 'unknown';
            const isLoggedOut = statusCode === DisconnectReason.loggedOut;
            const isConflict = [DisconnectReason.connectionReplaced, 405, 440].includes(statusCode);

            console.warn('Connection closed:', statusCode || 'unknown', 'reason:', statusText);
            logActivity('DISCONNECT', `Connection closed: ${statusCode || 'unknown'} - ${statusText}`);

            if (isLoggedOut) {
                console.error('Logged out. Clearing auth and waiting for a new QR scan...');
                try {
                    if (fs.existsSync(config.AUTH_PATH)) {
                        const entries = fs.readdirSync(config.AUTH_PATH);
                        for (const entry of entries) {
                            const entryPath = path.join(config.AUTH_PATH, entry);
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

                if (!state.reconnecting) {
                    state.reconnecting = true;
                    state.reconnectTimer = setTimeout(async () => {
                        state.reconnectTimer = null;
                        state.reconnecting = false;
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
                state.reconnecting = false;
                utils.broadcastSse({ type: 'status', online: false });
                utils.broadcastStatus();
                return;
            }

            if (statusCode === 428) {
                console.warn('Connection terminated (428). Attempting quick reconnect...');
                if (!state.reconnecting) {
                    state.reconnecting = true;
                    state.reconnectTimer = setTimeout(async () => {
                        state.reconnectTimer = null;
                        try {
                            await startSock();
                        } catch (error) {
                            console.error('Quick reconnect after 428 failed:', error);
                        } finally {
                            state.reconnecting = false;
                        }
                    }, 3000);
                }
                utils.broadcastSse({ type: 'status', online: false });
                utils.broadcastStatus();
                return;
            }

            if (!state.reconnecting) {
                state.reconnecting = true;
                state.reconnectAttempts += 1;
                const delayMs = Math.min(15000, Math.max(800, 1500 * state.reconnectAttempts));
                console.log(`Reconnecting in ${delayMs / 1000}s...`);
                state.reconnectTimer = setTimeout(async () => {
                    state.reconnectTimer = null;
                    try {
                        await startSock();
                    } catch (error) {
                        console.error('Reconnection failed:', error);
                    } finally {
                        state.reconnecting = false;
                    }
                }, delayMs);
            }
            utils.broadcastSse({ type: 'status', online: false });
            utils.broadcastStatus();
            return;
        }
    });
}

async function handleMessages(messages) {
    for (const message of messages) {
        console.log('DEBUG message', message.key?.remoteJid, 'fromMe=', message.key?.fromMe, 'hasMessage=', !!message.message);

        if (!message.message || state.sentMessageIds.has(message.key.id)) {
            console.log('DEBUG skip: no message/sent');
            continue;
        }

        if (message.key.remoteJid === 'status@broadcast') {
            if (state.store.autoViewStatus) {
                try {
                    await state.sock.sendReceipt('status@broadcast', message.key.participant, [message.key.id], 'read');
                } catch (receiptError) {
                    console.error('Auto-view status failed:', receiptError);
                }
            }
            console.log('DEBUG skip: status broadcast');
            continue;
        }

        if (state.store.autoBypassViewOnce) {
            await media.viewonceBypass(message);
        }

        const isFromMe = Boolean(message.key.fromMe);
        const outgoingBody = utils.getTextFromMessage(message).trim();
        console.log('DEBUG body=', JSON.stringify(outgoingBody), 'isFromMe=', isFromMe);

        if (isFromMe && !outgoingBody.startsWith(config.PREFIX)) {
            console.log('DEBUG skip: fromMe and not command');
            continue;
        }

        if (message.messageStubType || message.message?.protocolMessage) {
            console.log('DEBUG skip: stub/protocol');
            continue;
        }

        const messageTimestamp = Number(message.messageTimestamp || 0);
        if (messageTimestamp && messageTimestamp < state.startupTimeSec - 120) {
            console.log('DEBUG skip: old message');
            continue;
        }

        const messageId = message.key.id;

        if (!messageId || state.seenMessageIds.has(messageId)) {
            console.log('DEBUG skip: no id/seen');
            continue;
        }

        state.seenMessageIds.add(messageId);

        if (state.seenMessageIds.size > 5000) {
            state.seenMessageIds.clear();
        }

        const context = utils.createContext(message);
        utils.ensureChatSettings(context.chatId);
        
        if (context.isGroup && context.body) {
            let buffer = state.groupMessageBuffers.get(context.chatId) || [];
            buffer.push({
                sender: message.pushName || utils.getBaseUserId(context.senderId),
                text: context.body,
                timestamp: Date.now()
            });
            if (buffer.length > 200) {
                buffer = buffer.slice(-200);
            }
            state.groupMessageBuffers.set(context.chatId, buffer);
        }

        console.log('DEBUG context body=', JSON.stringify(context.body), 'chatId=', context.chatId);
        if (context.body.startsWith(config.PREFIX)) {
            await commands.handleCommandMessage(context);
        } else {
            await commands.handleNonCommandMessage(context);
        }
        state.totalMessagesHandled += 1;
    }
}

module.exports = {
    startSock,
    scheduleQrWatchdog,
    clearQrWatchdog,
    scheduleNextMessageCheck,
    processDueScheduledMessages,
    handleMessages
};

