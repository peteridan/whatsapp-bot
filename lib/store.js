const fs = require('fs');
const path = require('path');
const config = require('./config');

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
    if (!fs.existsSync(config.DATA_FILE)) {
        return createDefaultStore();
    }

    try {
        return {
            ...createDefaultStore(),
            ...JSON.parse(fs.readFileSync(config.DATA_FILE, 'utf8'))
        };
    } catch (error) {
        console.error('Failed to read bot-data.json, using empty settings:', error);
        return createDefaultStore();
    }
}

function saveStore(state) {
    fs.writeFileSync(config.DATA_FILE, JSON.stringify(state.store, null, 2));
}

module.exports = {
    createDefaultStore,
    loadStore,
    saveStore
};
