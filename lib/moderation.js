const config = require('./config');
const state = require('./state');
const utils = require('./utils');
const { jidNormalizedUser } = require('@whiskeysockets/baileys');
const ai = require('./ai');

async function handleGroupParticipantsUpdate(update) {
    const { id: groupId, participants, action } = update;

    if (action === 'add') {
        try {
            const welcomeText = state.store.welcomeMessages[groupId] || 'Welcome. The bot is online here. Send !menu to see commands.';
            await utils.sendText(groupId, welcomeText);
        } catch (error) {
            console.error('Failed to send welcome message:', error);
        }
    }
}

async function handleNonCommandMessage(context) {
    if (!context.body) {
        return;
    }

    const isFromMe = context.isFromMe;
    const senderIsAdmin = false;

    if (context.isGroup) {
        try {
            const metadata = await state.sock.groupMetadata(context.chatId);
            const admins = metadata.participants.filter(p => p.admin !== null).map(p => utils.getBaseUserId(p.id));
            senderIsAdmin = admins.includes(utils.getBaseUserId(context.senderId));
            context.metadata = metadata;
        } catch (_) {
            senderIsAdmin = false;
        }
    }

    if (senderIsAdmin) {
        return;
    }

    if (context.isGroup && state.store.autoReplyChats[context.chatId] && utils.isGreeting(context.body)) {
        await context.reply('Hello. I am online and ready. Send !menu to see commands.');
        return;
    }

    if (context.isGroup && state.store.antiSpamChats[context.chatId]) {
        const settings = state.store.antiSpamSettings[context.chatId] || { maxMessages: 5, windowSeconds: 5 };
        const userId = utils.getBaseUserId(context.senderId);
        const key = `${context.chatId}:${userId}`;
        const now = Date.now();
        const window = settings.windowSeconds * 1000;

        if (!state.spamTracker.has(key)) {
            state.spamTracker.set(key, []);
        }

        const timestamps = state.spamTracker.get(key).filter(t => now - t < window);
        timestamps.push(now);
        state.spamTracker.set(key, timestamps);

        if (timestamps.length > settings.maxMessages) {
            const warnKey = `${context.chatId}:${userId}`;
            state.store.userWarnings[warnKey] = (state.store.userWarnings[warnKey] || 0) + 1;
            utils.saveStore();
            const warnCount = state.store.userWarnings[warnKey];
            await context.send(
                `🚫 @${utils.getBaseUserId(context.senderId)}, slow down! Sending too many messages. (Warning ${warnCount}/3)`,
                { mentions: [context.senderId] }
            );
            if (warnCount >= 3) {
                try {
                    await state.sock.groupParticipantsUpdate(context.chatId, [context.senderId], 'remove');
                    state.store.userWarnings[warnKey] = 0;
                    utils.saveStore();
                } catch (_) { /* ignore kick failure if bot is not admin */ }
            }
            return;
        }
    }

    if (context.isGroup && state.store.antiLinkChats[context.chatId] && utils.hasLink(context.body)) {
        const senderName = utils.getSenderName(context.rawMessage, context.metadata);
        try {
            await state.sock.sendMessage(context.chatId, { delete: context.rawMessage.key });
        } catch (_) { /* ignore */ }
        await context.send(`⚠️ ${senderName}, links are not allowed here.`, {
            mentions: [context.senderId]
        });
        return;
    }

    if (context.isGroup && state.store.wordFilters[context.chatId]?.length && !senderIsAdmin) {
        const filters = state.store.wordFilters[context.chatId] || [];
        const matched = filters.find((word) =>
            new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(context.body)
        );
        if (matched) {
            const senderName = utils.getSenderName(context.rawMessage, context.metadata);
            try {
                await state.sock.sendMessage(context.chatId, { delete: context.rawMessage.key });
            } catch (_) { /* ignore delete failure */ }
            await context.send(`🚫 ${senderName}, that word is not allowed here.`, {
                mentions: [context.senderId]
            });
            return;
        }
    }

    if (context.isGroup && state.store.autoPromoEnabled[context.chatId] && !senderIsAdmin) {
        const userId = utils.getBaseUserId(context.senderId);
        if (!state.store.messageMilestones[context.chatId]) {
            state.store.messageMilestones[context.chatId] = {};
        }
        const prev = state.store.messageMilestones[context.chatId][userId] || 0;
        const next = prev + 1;
        state.store.messageMilestones[context.chatId][userId] = next;
        utils.saveStore();
        const hit = state.store.autoPromoThresholds.find((t) => prev < t && next >= t);
        if (hit) {
            try {
                await state.sock.groupParticipantsUpdate(context.chatId, [context.senderId], 'promote');
                await context.send(
                    `🎉 @${userId} just reached ${hit} messages and has been promoted to admin!`,
                    { mentions: [context.senderId] }
                );
            } catch (_) { /* ignore if bot is not admin */ }
        }
    }

    if (context.isGroup && state.store.keywordTriggers?.length && !senderIsAdmin) {
        const lowered = context.body.toLowerCase();
        const matched = state.store.keywordTriggers.find(t => lowered.includes(t.keyword));
        if (matched) {
            await context.reply(matched.reply);
            return;
        }
    }

    if (state.store.autoReplyChats[context.chatId] && utils.isGreeting(context.body)) {
        await context.reply('Hello. I am online and ready. Send !menu to see commands.');
        return;
    }

    if (state.store.aiEnabledChats[context.chatId]) {
        try {
            const ownerJid = jidNormalizedUser(state.sock?.user?.id || '');
            if (context.senderId === ownerJid) {
                return;
            }

            const reply = await ai.generateAiReply(context.chatId, context.body);
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

module.exports = {
    handleGroupParticipantsUpdate,
    handleNonCommandMessage
};
