const config = require('./config');
const state = require('./state');
const utils = require('./utils');
const ai = require('./ai');
const media = require('./media');
const moderation = require('./moderation');

const commandAliases = {
    status: 'story'
};

function isOwner(context) {
    return context.rawMessage?.key?.fromMe === true || (() => {
        const ownerBaseId = utils.getBaseUserId(state.sock?.user?.id || '');
        const senderBaseId = utils.getBaseUserId(context.senderId);
        return Boolean(ownerBaseId && senderBaseId === ownerBaseId);
    })();
}

async function handleCommandMessage(context) {
    if (!context.body) {
        return;
    }

    if (!context.body.startsWith(config.PREFIX)) {
        await handleNonCommandMessage(context);
        return;
    }

    utils.ensureChatSettings(context.chatId);

    const [commandName, ...args] = context.body.slice(config.PREFIX.length).split(/\s+/);
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

    if (state.store.mutedChats[context.chatId] && !command.runWhenMuted) {
        return;
    }

    if (state.store.privateMode && !isOwner(context)) {
        await context.reply('Bot is in private mode. Only the owner can use commands here.');
        return;
    }

    state.totalCommandsHandled += 1;

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

async function handleNonCommandMessage(context) {
    await moderation.handleNonCommandMessage(context);
}

const commands = {
    menu: {
        run: async (context) => {
            await context.reply(utils.formatMenu());
        }
    },
    help: {
        run: async (context) => {
            await context.reply(utils.formatMenu());
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
    time: {
        run: async (context) => {
            await context.reply('Server time: ' + new Date().toLocaleString());
        }
    },
    info: {
        run: async (context) => {
            const uptime = utils.fmtUptime(Math.floor(Date.now() / 1000) - state.startupTimeSec);
            await context.reply(
                `Bot is ${state.sock?.user ? 'online' : 'offline'}.\n` +
                `Uptime: ${uptime}\n` +
                `Model: ${config.GROQ_MODEL}\n` +
                `Groq key set: ${config.GROQ_API_KEY ? 'yes' : 'no'}\n` +
                `AI model: ${config.GROQ_MODEL}`
            );
        }
    },
    chatid: {
        run: async (context) => {
            await context.reply('Chat ID: ' + context.chatId);
        }
    },
    owner: {
        run: async (context) => {
            const ownerJid = state.sock?.user?.id ? utils.getBaseUserId(state.sock.user.id) : 'not connected';
            await context.reply('Connected bot number: ' + ownerJid);
        }
    },
    uptime: {
        run: async (context) => {
            const uptime = utils.fmtUptime(Math.floor(Date.now() / 1000) - state.startupTimeSec);
            await context.reply('Uptime: ' + uptime);
        }
    },
    stats: {
        run: async (context) => {
            const chats = new Set([
                ...Object.keys(state.store.mutedChats),
                ...Object.keys(state.store.autoReplyChats),
                ...Object.keys(state.store.antiLinkChats),
                ...Object.keys(state.store.aiEnabledChats)
            ]);
            await context.reply(
                `Messages handled: ${state.totalMessagesHandled}\n` +
                `Commands run: ${state.totalCommandsHandled}\n` +
                `Known chats: ${chats.size}`
            );
        }
    },
    debug: {
        run: async (context) => {
            await context.reply(
                `Chat ID: ${context.chatId}\n` +
                `Sender: ${context.senderId}\n` +
                `Body: ${context.body}\n` +
                `AI mode: ${state.store.aiEnabledChats[context.chatId] ? 'on' : 'off'}\n` +
                `Global AI: ${state.store.globalAiEnabled ? 'on' : 'off'}\n` +
                `Private mode: ${state.store.privateMode ? 'on' : 'off'}\n` +
                `Model: ${config.GROQ_MODEL}\n` +
                `Groq key set: ${config.GROQ_API_KEY ? 'yes' : 'no'}`
            );
        }
    },
    restart: {
        run: async (context) => {
            await context.reply('Restarting bot...');
            setTimeout(() => process.exit(1), 1000);
        }
    },
    private: {
        run: async (context, args) => {
            const mode = (args[0] || '').toLowerCase();
            if (!mode || !['on', 'off'].includes(mode)) {
                await context.reply('Usage: !private on|off');
                return;
            }
            state.store.privateMode = mode === 'on';
            utils.saveStore();
            await context.reply(`Private mode is now ${mode}.`);
        }
    },
    ask: {
        run: async (context, args) => {
            if (!args.length) {
                await context.reply('Usage: !ask <question>');
                return;
            }
            await context.reply('Thinking...');
            const reply = await ai.generateAiReply(context.chatId, args.join(' '));
            await context.reply(reply);
        }
    },
    ai: {
        run: async (context, args) => {
            utils.ensureChatSettings(context.chatId);
            const subcommand = (args[0] || '').toLowerCase();

            if (!subcommand || subcommand === 'status') {
                const mode = state.store.aiEnabledChats[context.chatId] ? 'on' : 'off';
                const prompt = state.store.aiSystemPrompts[context.chatId] || state.store.defaultAiPrompt || config.DEFAULT_AI_PROMPT;
                await context.reply(`AI mode is ${mode}.\nModel: ${config.GROQ_MODEL}\nPrompt: ${prompt}`);
                return;
            }

            if (subcommand === 'on' || subcommand === 'off') {
                if (!config.GROQ_API_KEY) {
                    await context.reply('Set GROQ_API_KEY first before enabling AI mode.');
                    return;
                }
                state.store.aiEnabledChats[context.chatId] = subcommand === 'on';
                utils.saveStore();
                await context.reply(`AI mode is now ${subcommand} in this chat.`);
                return;
            }

            if (subcommand === 'reset') {
                state.chatHistories.delete(context.chatId);
                delete state.store.aiSystemPrompts[context.chatId];
                utils.saveStore();
                await context.reply('AI memory and custom prompt cleared for this chat.');
                return;
            }

            if (subcommand === 'prompt') {
                const promptText = args.slice(1).join(' ').trim();
                if (!promptText) {
                    await context.reply('Usage: !ai prompt <text>');
                    return;
                }
                state.store.aiSystemPrompts[context.chatId] = promptText;
                state.chatHistories.delete(context.chatId);
                utils.saveStore();
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
                await context.reply(`Global AI is ${state.store.globalAiEnabled ? 'on' : 'off'}.`);
                return;
            }

            if (!config.GROQ_API_KEY) {
                await context.reply('Set GROQ_API_KEY first before enabling global AI.');
                return;
            }

            if (!['on', 'off'].includes(mode)) {
                await context.reply('Usage: !globalai on|off|status');
                return;
            }

            const enabled = mode === 'on';
            state.store.globalAiEnabled = enabled;

            for (const chatId of Object.keys(state.store.aiEnabledChats)) {
                state.store.aiEnabledChats[chatId] = enabled;
            }

            utils.saveStore();
            utils.broadcastStatus();
            await context.reply(
                `Global AI is now ${mode}. ${enabled ? 'New and existing chats will reply with AI.' : 'Chats will stop AI replies unless enabled again.'}`
            );
        }
    },
    groupinfo: {
        run: async (context) => {
            if (!context.isGroup) {
                await context.reply('This command can only be used in groups.');
                return;
            }
            try {
                const metadata = await state.sock.groupMetadata(context.chatId);
                await context.reply(
                    `Group: ${metadata.subject}\n` +
                    `ID: ${metadata.id}\n` +
                    `Participants: ${metadata.participants.length}`
                );
            } catch (error) {
                await context.reply('Could not fetch group info.');
            }
        }
    },
    online: {
        run: async (context) => {
            if (!context.isGroup) {
                await context.reply('This command can only be used in groups.');
                return;
            }
            try {
                const metadata = await state.sock.groupMetadata(context.chatId);
                const lines = metadata.participants.map((p) => {
                    const id = utils.getBaseUserId(p.id);
                    const admin = p.admin ? ` (${p.admin})` : '';
                    return `• ${id}${admin}`;
                });
                const text = `Online list (${metadata.participants.length}):\n` + lines.join('\n');
                await context.reply(text);
            } catch (error) {
                await context.reply('Could not fetch participant list.');
            }
        }
    },
    admins: {
        run: async (context) => {
            if (!context.isGroup) {
                await context.reply('This command can only be used in groups.');
                return;
            }
            try {
                const metadata = await state.sock.groupMetadata(context.chatId);
                const admins = metadata.participants.filter(p => p.admin !== null).map(p => utils.getBaseUserId(p.id));
                await context.reply('Admins: ' + (admins.length ? admins.join(', ') : 'none'));
            } catch (error) {
                await context.reply('Could not fetch admins.');
            }
        }
    },
    tagall: {
        run: async (context) => {
            if (!context.isGroup) {
                await context.reply('This command can only be used in groups.');
                return;
            }
            try {
                const metadata = await state.sock.groupMetadata(context.chatId);
                const mentions = metadata.participants.map(p => p.id);
                await utils.sendText(context.chatId, '@all', { mentions });
            } catch (error) {
                await context.reply('Could not tag all.');
            }
        }
    },
    promote: {
        run: async (context, args) => {
            if (!context.isGroup) {
                await context.reply('This command can only be used in groups.');
                return;
            }
            if (!args.length) {
                await context.reply('Usage: !promote <phone|@user>');
                return;
            }
            const target = args[0];
            try {
                await state.sock.groupParticipantsUpdate(context.chatId, [target], 'promote');
                await context.reply(`Promoted ${target} to admin.`);
            } catch (error) {
                await context.reply('Could not promote user. Make sure the bot is admin.');
            }
        }
    },
    demote: {
        run: async (context, args) => {
            if (!context.isGroup) {
                await context.reply('This command can only be used in groups.');
                return;
            }
            if (!args.length) {
                await context.reply('Usage: !demote <phone|@user>');
                return;
            }
            const target = args[0];
            try {
                await state.sock.groupParticipantsUpdate(context.chatId, [target], 'demote');
                await context.reply(`Demoted ${target} from admin.`);
            } catch (error) {
                await context.reply('Could not demote user. Make sure the bot is admin.');
            }
        }
    },
    add: {
        run: async (context, args) => {
            if (!context.isGroup) {
                await context.reply('This command can only be used in groups.');
                return;
            }
            if (!args.length) {
                await context.reply('Usage: !add <phone>');
                return;
            }
            const target = args[0];
            try {
                await state.sock.groupParticipantsUpdate(context.chatId, [target], 'add');
                await context.reply(`Added ${target} to the group.`);
            } catch (error) {
                await context.reply('Could not add user. Make sure the bot is admin.');
            }
        }
    },
    creategroup: {
        run: async (context, args) => {
            const name = args.join(' ');
            if (!name) {
                await context.reply('Usage: !creategroup <name>');
                return;
            }
            try {
                const ownerJid = state.sock.user.id;
                const group = await state.sock.groupCreate(name, [ownerJid]);
                await context.reply(`Group created: ${group.gid}`);
            } catch (error) {
                await context.reply('Could not create group.');
            }
        }
    },
    rename: {
        run: async (context, args) => {
            if (!context.isGroup) {
                await context.reply('This command can only be used in groups.');
                return;
            }
            const name = args.join(' ');
            if (!name) {
                await context.reply('Usage: !rename <name>');
                return;
            }
            try {
                await state.sock.groupUpdateSubject(context.chatId, name);
                await context.reply('Group name updated.');
            } catch (error) {
                await context.reply('Could not rename group.');
            }
        }
    },
    grouplink: {
        run: async (context) => {
            if (!context.isGroup) {
                await context.reply('This command can only be used in groups.');
                return;
            }
            try {
                const code = await state.sock.groupInviteCode(context.chatId);
                await context.reply('https://chat.whatsapp.com/' + code);
            } catch (error) {
                await context.reply('Could not get group link.');
            }
        }
    },
    lock: {
        run: async (context) => {
            if (!context.isGroup) {
                await context.reply('This command can only be used in groups.');
                return;
            }
            try {
                await state.sock.groupSettingUpdate(context.chatId, 'announcement');
                await context.reply('Group locked. Only admins can send messages.');
            } catch (error) {
                await context.reply('Could not lock group.');
            }
        }
    },
    unlock: {
        run: async (context) => {
            if (!context.isGroup) {
                await context.reply('This command can only be used in groups.');
                return;
            }
            try {
                await state.sock.groupSettingUpdate(context.chatId, 'not_announcement');
                await context.reply('Group unlocked. Everyone can send messages.');
            } catch (error) {
                await context.reply('Could not unlock group.');
            }
        }
    },
    kick: {
        run: async (context, args) => {
            if (!context.isGroup) {
                await context.reply('This command can only be used in groups.');
                return;
            }
            if (!args.length) {
                await context.reply('Usage: !kick <@user>');
                return;
            }
            const target = args[0];
            try {
                await state.sock.groupParticipantsUpdate(context.chatId, [target], 'remove');
                await context.reply(`Removed ${target} from the group.`);
            } catch (error) {
                await context.reply('Could not kick user. Make sure the bot is admin.');
            }
        }
    },
    leave: {
        run: async (context) => {
            if (!context.isGroup) {
                await context.reply('This command can only be used in groups.');
                return;
            }
            try {
                await state.sock.groupLeave(context.chatId);
                await context.reply('Leaving group...');
            } catch (error) {
                await context.reply('Could not leave group.');
            }
        }
    },
    antilink: {
        run: async (context, args) => {
            if (!context.isGroup) {
                await context.reply('This command can only be used in groups.');
                return;
            }
            const mode = (args[0] || '').toLowerCase();
            if (!mode || !['on', 'off'].includes(mode)) {
                await context.reply('Usage: !antilink on|off');
                return;
            }
            state.store.antiLinkChats[context.chatId] = mode === 'on';
            utils.saveStore();
            utils.broadcastStatus();
            await context.reply(`Anti-link is now ${mode} in this chat.`);
        }
    },
    antispam: {
        run: async (context, args) => {
            if (!context.isGroup) {
                await context.reply('This command can only be used in groups.');
                return;
            }
            const subcommand = (args[0] || '').toLowerCase();

            if (!subcommand || subcommand === 'status') {
                const settings = state.store.antiSpamSettings[context.chatId] || { maxMessages: 5, windowSeconds: 5 };
                await context.reply(
                    `Anti-spam is ${state.store.antiSpamChats[context.chatId] ? 'on' : 'off'}.\n` +
                    `Max messages: ${settings.maxMessages}\n` +
                    `Window: ${settings.windowSeconds}s`
                );
                return;
            }

            if (subcommand === 'on' || subcommand === 'off') {
                state.store.antiSpamChats[context.chatId] = subcommand === 'on';
                utils.saveStore();
                utils.broadcastStatus();
                await context.reply(`Anti-spam is now ${subcommand} in this chat.`);
                return;
            }

            if (subcommand === 'set') {
                const maxMessages = parseInt(args[1]) || 5;
                const windowSeconds = parseInt(args[2]) || 5;
                state.store.antiSpamSettings[context.chatId] = { maxMessages, windowSeconds };
                utils.saveStore();
                await context.reply(`Anti-spam settings updated: ${maxMessages} messages per ${windowSeconds}s.`);
                return;
            }

            await context.reply('Usage: !antispam on|off|set <maxMsgs> <seconds>|status');
        }
    },
    warn: {
        run: async (context, args) => {
            if (!context.isGroup) {
                await context.reply('This command can only be used in groups.');
                return;
            }
            if (!args.length) {
                await context.reply('Usage: !warn <@user|phone>');
                return;
            }
            const target = args[0];
            const warnKey = `${context.chatId}:${utils.getBaseUserId(target)}`;
            state.store.userWarnings[warnKey] = (state.store.userWarnings[warnKey] || 0) + 1;
            utils.saveStore();
            const warnCount = state.store.userWarnings[warnKey];
            await context.send(
                `🚫 @${utils.getBaseUserId(target)}, you have been warned. (Warning ${warnCount}/3)`,
                { mentions: [target] }
            );
            if (warnCount >= 3) {
                try {
                    await state.sock.groupParticipantsUpdate(context.chatId, [target], 'remove');
                    state.store.userWarnings[warnKey] = 0;
                    utils.saveStore();
                } catch (_) { /* ignore */ }
            }
        }
    },
    warnings: {
        run: async (context, args) => {
            if (!context.isGroup) {
                await context.reply('This command can only be used in groups.');
                return;
            }
            if (!args.length) {
                await context.reply('Usage: !warnings <@user|phone>');
                return;
            }
            const target = args[0];
            const warnKey = `${context.chatId}:${utils.getBaseUserId(target)}`;
            const count = state.store.userWarnings[warnKey] || 0;
            await context.reply(`${utils.getBaseUserId(target)} has ${count} warning(s).`);
        }
    },
    clearwarns: {
        run: async (context, args) => {
            if (!context.isGroup) {
                await context.reply('This command can only be used in groups.');
                return;
            }
            if (!args.length) {
                await context.reply('Usage: !clearwarns <@user|phone>');
                return;
            }
            const target = args[0];
            const warnKey = `${context.chatId}:${utils.getBaseUserId(target)}`;
            state.store.userWarnings[warnKey] = 0;
            utils.saveStore();
            await context.reply(`Warnings cleared for ${utils.getBaseUserId(target)}.`);
        }
    },
    autopromo: {
        run: async (context, args) => {
            if (!context.isGroup) {
                await context.reply('This command can only be used in groups.');
                return;
            }
            const subcommand = (args[0] || '').toLowerCase();

            if (!subcommand || subcommand === 'status') {
                const enabled = state.store.autoPromoEnabled[context.chatId] ? 'on' : 'off';
                const thresholds = state.store.autoPromoThresholds.join(', ');
                await context.reply(`Auto-promote is ${enabled}.\nThresholds: ${thresholds}`);
                return;
            }

            if (subcommand === 'on' || subcommand === 'off') {
                state.store.autoPromoEnabled[context.chatId] = subcommand === 'on';
                utils.saveStore();
                utils.broadcastStatus();
                await context.reply(`Auto-promote is now ${subcommand} in this chat.`);
                return;
            }

            if (subcommand === 'thresholds') {
                const values = args.slice(1).map(Number).filter((n) => n > 0);
                if (!values.length) {
                    await context.reply('Usage: !autopromo thresholds <value1> <value2> ...');
                    return;
                }
                state.store.autoPromoThresholds = values;
                utils.saveStore();
                utils.broadcastStatus();
                await context.reply('Promotion thresholds updated: ' + values.join(', '));
                return;
            }

            await context.reply('Usage: !autopromo on|off|status|thresholds <values...>');
        }
    },
    filter: {
        run: async (context, args) => {
            if (!context.isGroup) {
                await context.reply('This command can only be used in groups.');
                return;
            }
            const subcommand = (args[0] || '').toLowerCase();
            const word = args.slice(1).join(' ').trim();

            if (subcommand === 'add') {
                if (!word) {
                    await context.reply('Usage: !filter add <word>');
                    return;
                }
                if (!state.store.wordFilters[context.chatId]) {
                    state.store.wordFilters[context.chatId] = [];
                }
                if (!state.store.wordFilters[context.chatId].includes(word.toLowerCase())) {
                    state.store.wordFilters[context.chatId].push(word.toLowerCase());
                    utils.saveStore();
                    utils.broadcastStatus();
                }
                await context.reply(`Word filter added: ${word}`);
                return;
            }

            if (subcommand === 'remove') {
                if (!word) {
                    await context.reply('Usage: !filter remove <word>');
                    return;
                }
                const filters = state.store.wordFilters[context.chatId] || [];
                state.store.wordFilters[context.chatId] = filters.filter(w => w !== word.toLowerCase());
                utils.saveStore();
                utils.broadcastStatus();
                await context.reply(`Word filter removed: ${word}`);
                return;
            }

            if (subcommand === 'list') {
                const filters = state.store.wordFilters[context.chatId] || [];
                await context.reply('Blocked words: ' + (filters.length ? filters.join(', ') : 'none'));
                return;
            }

            await context.reply('Usage: !filter add|remove|list [word]');
        }
    },
    mute: {
        run: async (context) => {
            state.store.mutedChats[context.chatId] = true;
            utils.saveStore();
            utils.broadcastStatus();
            await context.reply('Bot muted in this chat.');
        }
    },
    unmute: {
        run: async (context) => {
            state.store.mutedChats[context.chatId] = false;
            utils.saveStore();
            utils.broadcastStatus();
            await context.reply('Bot unmuted in this chat.');
        }
    },
    autoreply: {
        run: async (context, args) => {
            const mode = (args[0] || '').toLowerCase();
            if (!mode || !['on', 'off'].includes(mode)) {
                await context.reply('Usage: !autoreply on|off');
                return;
            }
            state.store.autoReplyChats[context.chatId] = mode === 'on';
            utils.saveStore();
            utils.broadcastStatus();
            await context.reply(`Auto-reply is now ${mode} in this chat.`);
        }
    },
    react: {
        run: async (context, args) => {
            if (!args.length) {
                await context.reply('Usage: !react <emoji>');
                return;
            }
            const emoji = args[0];
            try {
                await state.sock.sendMessage(context.chatId, { react: { text: emoji, key: context.rawMessage.key } });
            } catch (error) {
                await context.reply('Could not react to that message.');
            }
        }
    },
    quote: {
        run: async (context, args) => {
            const subcommand = (args[0] || '').toLowerCase();

            if (subcommand === 'save') {
                const text = args.slice(1).join(' ');
                if (!text) {
                    await context.reply('Usage: !quote save <text>');
                    return;
                }
                state.store.quotes.push({
                    text,
                    sender: utils.getBaseUserId(context.senderId),
                    timestamp: Date.now()
                });
                utils.saveStore();
                await context.reply('Quote saved.');
                return;
            }

            if (subcommand === 'list') {
                const quotes = state.store.quotes.slice(-15).reverse();
                if (!quotes.length) {
                    await context.reply('No quotes saved yet.');
                    return;
                }
                const text = quotes.map((q, i) => `${i + 1}. "${q.text}" — ${q.sender || 'unknown'}`).join('\n');
                await context.reply(text);
                return;
            }

            if (subcommand === 'random') {
                const quotes = state.store.quotes;
                if (!quotes.length) {
                    await context.reply('No quotes saved yet.');
                    return;
                }
                const q = quotes[Math.floor(Math.random() * quotes.length)];
                await context.reply(`"${q.text}" — ${q.sender || 'unknown'}`);
                return;
            }

            if (subcommand === 'clear') {
                state.store.quotes = [];
                utils.saveStore();
                await context.reply('All quotes cleared.');
                return;
            }

            await context.reply('Usage: !quote save|list|random|clear');
        }
    },
    schedule: {
        run: async (context, args) => {
            const subcommand = (args[0] || '').toLowerCase();

            if (subcommand === 'msg') {
                const minutes = parseInt(args[1]);
                const text = args.slice(2).join(' ');
                if (!minutes || !text) {
                    await context.reply('Usage: !schedule msg <minutes> <text>');
                    return;
                }
                state.store.scheduledMessages.push({
                    chatId: context.chatId,
                    text,
                    sendAt: Date.now() + minutes * 60000,
                    sent: false
                });
                utils.saveStore();
                utils.scheduleNextMessageCheck();
                await context.reply(`Message scheduled in ${minutes} minutes.`);
                return;
            }

            if (subcommand === 'list') {
                const list = state.store.scheduledMessages.filter(m => !m.sent);
                if (!list.length) {
                    await context.reply('No scheduled messages.');
                    return;
                }
                const text = list.map((m, i) => `${i + 1}. ${m.text} — in ${Math.max(0, Math.round((m.sendAt - Date.now()) / 60000))}m`).join('\n');
                await context.reply(text);
                return;
            }

            if (subcommand === 'clear') {
                state.store.scheduledMessages = state.store.scheduledMessages.filter(m => m.sent);
                utils.saveStore();
                await context.reply('Pending scheduled messages cleared.');
                return;
            }

            await context.reply('Usage: !schedule msg <minutes> <text>|list|clear');
        }
    },
    welcome: {
        run: async (context, args) => {
            if (!context.isGroup) {
                await context.reply('This command can only be used in groups.');
                return;
            }
            const subcommand = (args[0] || '').toLowerCase();

            if (subcommand === 'set') {
                const text = args.slice(1).join(' ');
                if (!text) {
                    await context.reply('Usage: !welcome set <text>');
                    return;
                }
                state.store.welcomeMessages[context.chatId] = text;
                utils.saveStore();
                await context.reply('Welcome message updated.');
                return;
            }

            await context.reply('Usage: !welcome set <text>');
        }
    },
    story: {
        run: async (context, args) => {
            const mode = (args[0] || '').toLowerCase();
            if (!mode || !['on', 'off'].includes(mode)) {
                await context.reply('Usage: !story on|off');
                return;
            }
            state.store.autoViewStatus = mode === 'on';
            utils.saveStore();
            utils.broadcastStatus();
            await context.reply(`Auto-view status is now ${mode}.`);
        }
    },
    bypass: {
        run: async (context, args) => {
            const mode = (args[0] || '').toLowerCase();
            if (!mode || !['on', 'off'].includes(mode)) {
                await context.reply('Usage: !bypass on|off');
                return;
            }
            state.store.autoBypassViewOnce = mode === 'on';
            utils.saveStore();
            utils.broadcastStatus();
            await context.reply(`Auto-bypass view-once is now ${mode}.`);
        }
    },
    fact: {
        run: async (context) => {
            try {
                const res = await fetch('https://uselessfacts.jsph.pl/api/v2/facts/random?language=en');
                const data = await res.json();
                await context.reply(data.text || 'Could not fetch a fact right now.');
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
                const text = hits.slice(0, 5).map((h, i) => `${i + 1}. ${h.title}`).join('\n');
                await context.reply(text);
            } catch (error) {
                await context.reply('Could not fetch news right now.');
            }
        }
    },
    '8ball': {
        run: async (context, args) => {
            if (!args.length) {
                await context.reply('Usage: !8ball <question>');
                return;
            }
            const responses = [
                'It is certain.', 'It is decidedly so.', 'Without a doubt.', 'Yes - definitely.',
                'You may rely on it.', 'As I see it, yes.', 'Most likely.', 'Outlook good.',
                'Yes.', 'Signs point to yes.', 'Reply hazy, try again.', 'Ask again later.',
                'Better not tell you now.', 'Cannot predict now.', 'Concentrate and ask again.',
                "Don't count on it.", 'My reply is no.', 'My sources say no.', 'Outlook not so good.', 'Very doubtful.'
            ];
            await context.reply(responses[Math.floor(Math.random() * responses.length)]);
        }
    },
    weather: {
        run: async (context, args) => {
            const city = args.join(' ');
            if (!city) {
                await context.reply('Usage: !weather <city>');
                return;
            }
            try {
                const res = await fetch(`https://wttr.in/${encodeURIComponent(city)}?format=3`);
                const text = await res.text();
                await context.reply(text || 'Could not fetch weather.');
            } catch (error) {
                await context.reply('Could not fetch weather right now.');
            }
        }
    },
    search: {
        run: async (context, args) => {
            const query = args.join(' ');
            if (!query) {
                await context.reply('Usage: !search <query>');
                return;
            }
            try {
                const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`);
                const html = await res.text();
                const $ = cheerio.load(html);
                const results = [];
                $('.result__a').each((i, el) => {
                    if (i < 5) {
                        results.push($(el).text().trim() + '\n' + $(el).attr('href'));
                    }
                });
                if (!results.length) {
                    await context.reply('No results found.');
                    return;
                }
                await context.reply(results.join('\n\n'));
            } catch (error) {
                await context.reply('Search failed.');
            }
        }
    },
    img: {
        run: async (context, args) => {
            await media.imageSearch(context, args);
        }
    },
    toimg: {
        run: async (context) => {
            await media.toimg(context);
        }
    },
    mp3: {
        run: async (context) => {
            await media.videoToAudio(context);
        }
    },
    tomp3: {
        run: async (context) => {
            await media.videoToAudio(context);
        }
    },
    viewonce: {
        run: async (context) => {
            await context.reply('Reply to a view-once message with !viewonce to bypass it.');
        }
    }
};

module.exports = {
    commands,
    handleCommandMessage,
    handleNonCommandMessage,
    isOwner
};
