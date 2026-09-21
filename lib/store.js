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

function firebaseRequest(dbUrl, pathSegments, method, body, token) {
    return new Promise((resolve, reject) => {
        const trimmedDbUrl = dbUrl.replace(/\/$/, '');
        const suffix = '/' + pathSegments.filter(Boolean).join('/');
        const pathname = (suffix === '/' ? '/bot-data.json' : suffix) + '.json';
        const options = {
            hostname: new URL(trimmedDbUrl).hostname,
            path: pathname + '?auth=' + encodeURIComponent(token || ''),
            method: method || 'GET',
            headers: {
                'User-Agent': 'whatsapp-bot',
                'Content-Type': 'application/json'
            }
        };
        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                if (res.statusCode === 404 && method === 'GET') {
                    resolve(null);
                    return;
                }
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    try {
                        resolve(JSON.parse(data));
                    } catch {
                        resolve(data);
                    }
                } else {
                    reject(new Error(`Firebase ${res.statusCode}: ${data}`));
                }
            });
        });
        req.on('error', reject);
        req.write(JSON.stringify(body));
        req.end();
    });
}

function getFirebaseConfig() {
    const dbUrl = process.env.FIREBASE_DB_URL;
    const token = process.env.FIREBASE_DB_TOKEN || process.env.FIREBASE_DB_SECRET || '';
    return { dbUrl, token };
}

async function loadFirebaseStore() {
    try {
        const { dbUrl, token } = getFirebaseConfig();
        if (!dbUrl) return null;
        const data = await firebaseRequest(dbUrl, ['bot-data'], 'GET', null, token);
        if (data && typeof data === 'object') {
            return data;
        }
    } catch (error) {
        console.error('Failed to load Firebase store:', error.message);
    }
    return null;
}

async function saveFirebaseStore(payload) {
    try {
        const { dbUrl, token } = getFirebaseConfig();
        if (!dbUrl) return;
        await firebaseRequest(dbUrl, ['bot-data'], 'PUT', payload, token);
    } catch (error) {
        console.error('Failed to save Firebase store:', error.message);
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

async function loadStoreWithFirebase() {
    const firebaseStore = await loadFirebaseStore();
    const localStore = loadStore();
    if (!firebaseStore) return localStore;
    return {
        ...createDefaultStore(),
        ...localStore,
        ...firebaseStore
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
    if (process.env.FIREBASE_DB_URL) {
        saveFirebaseStore(state.store).catch((error) => {
            console.error('Background Firebase save failed:', error.message);
        });
    }
}

module.exports = {
    createDefaultStore,
    loadStore,
    loadStoreWithFirebase,
    saveStore
};
