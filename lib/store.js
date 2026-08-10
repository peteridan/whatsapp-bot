const fs = require('fs');
const path = require('path');
const config = require('./config');
const state = require('./state');

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
        autoPromoThresholds: [100, 500, 1000],
        commands: [],
        personality: {
            name: 'WA Bot',
            tone: 'Casual',
            style: 'Balanced',
            emoji: 'None',
            length: 'Medium',
            language: 'English',
            greeting: '',
            avoid: ''
        }
    };
}

function pickWritablePath(preferred) {
    const candidates = [
        preferred,
        path.join('/tmp', path.basename(preferred)),
        path.join(process.cwd(), path.basename(preferred))
    ];
    for (const candidate of candidates) {
        try {
            const dir = path.dirname(candidate);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            fs.accessSync(dir, fs.constants.W_OK);
            return candidate;
        } catch {
            continue;
        }
    }
    return null;
}

let activeDataPath = null;

function getActiveDataPath() {
    if (!activeDataPath) {
        activeDataPath = pickWritablePath(config.DATA_FILE);
    }
    return activeDataPath;
}

function loadStore() {
    const dataPath = getActiveDataPath();
    if (!dataPath || !fs.existsSync(dataPath)) {
        return createDefaultStore();
    }

    try {
        return {
            ...createDefaultStore(),
            ...JSON.parse(fs.readFileSync(dataPath, 'utf8'))
        };
    } catch (error) {
        console.error('Failed to read bot data, using empty settings:', error);
        return createDefaultStore();
    }
}

function saveStore() {
    const dataPath = getActiveDataPath() || config.DATA_FILE;
    const payload = JSON.stringify(state.store, null, 2);
    try {
        const dir = path.dirname(dataPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(dataPath, payload, 'utf8');
        if (dataPath !== config.DATA_FILE) {
            console.warn('Bot data saved to fallback path:', dataPath);
        }
    } catch (error) {
        console.error('Failed to save bot data:', error.message);
        try {
            const tmpPath = path.join('/tmp', path.basename(config.DATA_FILE));
            fs.writeFileSync(tmpPath, payload, 'utf8');
            activeDataPath = tmpPath;
            console.warn('Bot data saved to fallback path:', tmpPath);
        } catch (fallbackError) {
            console.error('Fallback save also failed:', fallbackError.message);
        }
    }
}

module.exports = {
    createDefaultStore,
    loadStore,
    saveStore
};
