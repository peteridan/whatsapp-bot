const config = require('./config');
const state = require('./state');
const utils = require('./utils');

async function generateAiReply(chatId, userText) {
    if (!config.GROQ_API_KEY) {
        throw new Error('missing_api_key');
    }

    utils.ensureChatSettings(chatId);

    const history = state.chatHistories.get(chatId) || [];
    const systemPrompt = state.store.aiSystemPrompts[chatId] || state.store.defaultAiPrompt || config.DEFAULT_AI_PROMPT;
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
                    Authorization: `Bearer ${config.GROQ_API_KEY}`
                },
                body: JSON.stringify({
                    model: config.GROQ_MODEL,
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

            await utils.delay(1500);
        }
    }

    if (!response) {
        throw lastError || new Error('groq_request_failed');
    }

    if (!response.ok) {
        const errorText = await response.text();
        const status = response.status;
        const lower = String(errorText).toLowerCase();
        if (status === 404 || status === 400 && (lower.includes('model') || lower.includes('not found'))) {
            const fallback = await pickFallbackGroqModel();
            if (fallback && fallback !== config.GROQ_MODEL) {
                console.warn(`Groq model ${config.GROQ_MODEL} unavailable, retrying with ${fallback}`);
                config.GROQ_MODEL = fallback;
                return generateAiReply(chatId, userText);
            }
        }
        throw new Error(`groq_${status}:${errorText}`);
    }

    const data = await response.json();
    const reply = data.choices?.[0]?.message?.content?.trim();

    if (!reply) {
        throw new Error('empty_ai_reply');
    }

    state.chatHistories.set(
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

async function pickFallbackGroqModel() {
    try {
        const models = await config.fetchGroqChatModels();
        const preferred = ['qwen/qwen3.6-27b', 'openai/gpt-oss-20b', 'llama-3.1-8b-instant', 'meta-llama/llama-4-scout-17b-16e-instruct'];
        for (const candidate of preferred) {
            if (candidate !== config.GROQ_MODEL && models.includes(candidate)) {
                return candidate;
            }
        }
        const other = models.find((m) => m !== config.GROQ_MODEL);
        return other || null;
    } catch {
        return null;
    }
}

module.exports = {
    generateAiReply
};
