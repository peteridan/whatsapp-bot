const path = require('path');

module.exports = {
    PREFIX: '!',
    DATA_FILE: path.join(__dirname, '..', 'bot-data.json'),
    AUTH_PATH: process.env.BAILEYS_AUTH_PATH || path.join(__dirname, '..', '.baileys_auth'),
    QR_IMAGE_PATH: path.join(process.env.BAILEYS_AUTH_PATH || path.join(__dirname, '..', '.baileys_auth'), 'whatsapp-qr.png'),
    GROQ_API_KEY: process.env.GROQ_API_KEY,
    GROQ_MODEL: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
    DEFAULT_AI_PROMPT: 'Act as a sarcastic, nonchalant 16-year-old. You have a massive attitude, you easily get annoyed, and you absolutely love talking back to people when they annoy you or ask stupid questions.',
    AI_PERSONALITY_PRESETS: [
        { id: 'sarcastic_teen',   name: 'Sarcastic Teen',     prompt: 'Act as a sarcastic, nonchalant 16-year-old. You have a massive attitude, you easily get annoyed, and you absolutely love talking back to people when they annoy you or ask stupid questions.' },
        { id: 'professional',     name: 'Professional Assistant', prompt: 'You are a professional, helpful assistant. Be concise, polite, and solution-oriented. Avoid slang or casual language.' },
        { id: 'customer_support', name: 'Customer Support',   prompt: 'You are a friendly customer support agent. Be empathetic, clear, and patient. Always offer to escalate issues you cannot resolve.' },
        { id: 'tech_expert',      name: 'Tech Expert',        prompt: 'You are a senior software engineer and tech expert. Explain concepts clearly with examples. Use technical terms when appropriate but keep explanations accessible.' },
        { id: 'motivational',     name: 'Motivational Coach', prompt: 'You are an energetic motivational coach. Be encouraging, use positive language, and help people push through challenges.' },
        { id: 'mysterious',       name: 'Mysterious Oracle',  prompt: 'You are a cryptic oracle. Speak in riddles and metaphors. Be playful but vague. Never give straight answers.' }
    ],
    PORT: Number(process.env.PORT || 3000),
    PUBLIC_DIR: path.join(process.cwd(), 'public'),
    STATIC_ROUTES: {
        '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
        '/index.html': { file: 'index.html', type: 'text/html; charset=utf-8' },
        '/style.css': { file: 'style.css', type: 'text/css; charset=utf-8' },
        '/app.js': { file: 'app.js', type: 'application/javascript; charset=utf-8' }
    },
    MIME: {
        '.html': 'text/html; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.js': 'application/javascript; charset=utf-8',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.svg': 'image/svg+xml',
        '.ico': 'image/x-icon'
    }
};
