const fs = require('fs');
const path = require('path');
const https = require('https');
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
        },
        sessionSaved: false
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

function githubRequest(options, body) {
    return new Promise((resolve, reject) => {
        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    try {
                        resolve(JSON.parse(data));
                    } catch {
                        resolve(data);
                    }
                } else {
                    reject(new Error(`GitHub API ${res.statusCode}: ${data}`));
                }
            });
        });
        req.on('error', reject);
        if (body) {
            req.write(JSON.stringify(body));
        }
        req.end();
    });
}

async function ensureGist() {
    const token = process.env.GIST_TOKEN;
    if (!token) return null;
    const gistId = process.env.GIST_ID;
    const gistFileName = process.env.GIST_FILE_NAME || 'bot-data.json';

    if (gistId) {
        const res = await githubRequest({
            hostname: 'api.github.com',
            path: `/gists/${gistId}`,
            method: 'GET',
            headers: {
                'User-Agent': 'whatsapp-bot',
                'Authorization': `Bearer ${token}`
            }
        });
        const files = res.files || {};
        if (files[gistFileName]) {
            return { gistId, file: gistFileName, raw: files[gistFileName].content || null };
        }
    }

    const store = createDefaultStore();
    const payload = {
        description: 'WhatsApp bot persistent store',
        public: false,
        files: {
            [gistFileName]: { content: JSON.stringify(store, null, 2) }
        }
    };
    const res = await githubRequest({
        hostname: 'api.github.com',
        path: '/gists',
        method: 'POST',
        headers: {
            'User-Agent': 'whatsapp-bot',
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
        }
    }, payload);
    if (process.env.GIST_ID !== res.id) {
        console.warn('Created new gist:', res.id, '- set GIST_ID to avoid duplicates.');
    }
    return { gistId: res.id, file: gistFileName, raw: payload.files[gistFileName].content };
}

async function loadGistStore() {
    try {
        const gist = await ensureGist();
        if (!gist) return null;
        if (typeof gist.raw === 'string' && gist.raw.trim()) {
            return JSON.parse(gist.raw);
        }
    } catch (error) {
        console.error('Failed to load gist store:', error.message);
    }
    return null;
}

async function saveGistStore(payload) {
    try {
        const gist = await ensureGist();
        if (!gist) return;
        await githubRequest({
            hostname: 'api.github.com',
            path: `/gists/${gist.gistId}`,
            method: 'PATCH',
            headers: {
                'User-Agent': 'whatsapp-bot',
                'Authorization': `Bearer ${process.env.GIST_TOKEN}`,
                'Content-Type': 'application/json'
            }
        }, {
            description: 'WhatsApp bot persistent store',
            files: {
                [gist.file]: { content: payload }
            }
        });
    } catch (error) {
        console.error('Failed to save gist store:', error.message);
    }
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

async function loadStoreWithGist() {
    const gistStore = await loadGistStore();
    const localStore = loadStore();
    if (!gistStore) return localStore;
    return {
        ...createDefaultStore(),
        ...localStore,
        ...gistStore
    };
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
    if (process.env.GIST_TOKEN) {
        saveGistStore(payload).catch((error) => {
            console.error('Background gist save failed:', error.message);
        });
    }
}

module.exports = {
    createDefaultStore,
    loadStore,
    loadStoreWithGist,
    saveStore
};
