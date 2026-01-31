const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
const DEFAULT_MODEL = 'tngtech/deepseek-r1t2-chimera:free';

export async function generateQuestion(inputData) {
    const { post, settings } = inputData;

    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
        throw new Error('OpenRouter API key not configured');
    }

    const model = settings.model || DEFAULT_MODEL;

    try {
        const response = await fetch(OPENROUTER_API_URL, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
                'HTTP-Referer': 'https://github.com/reddit-insight-gatherer',
                'X-Title': 'Reddit Insight Gatherer'
            },
            body: JSON.stringify({
                model: model,
                messages: [
                    {
                        role: 'system',
                        content: `You are a helpful assistant for a founder/marketer.
Your goal is to generate a single, natural, open-ended DM question with an introduction like hey or hi to a Reddit user based on their post.

CONTEXT:
Business: ${settings.businessDesc || 'Not specified'}
Target Persona: ${settings.persona || 'General'}
Insight Goal: ${settings.insightTypes ? settings.insightTypes.join(', ') : 'General insights'}
Tone: ${settings.tone || 'Curious'}

RULES:
1. NO selling, pitching, or promoting.
2. NO links or product mentions.
3. Must feel like a personal, human message.
4. Keep it short (1-2 sentences).
5. Focus on the user's problem/situation.
6. The output should be ONLY the message text, no quotes or explanations.`
                    },
                    {
                        role: 'user',
                        content: `Post Title: ${post.title || 'No title'}
Post Body: ${post.body || 'No body'}
Subreddit: ${post.subreddit || 'Unknown'}

Generate a DM question:`
                    }
                ]
            })
        });

        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(errorData.error?.message || 'Failed to generate question');
        }

        const data = await response.json();

        if (!data.choices || !data.choices.length || !data.choices[0].message) {
            console.error('Unexpected API response structure:', data);
            throw new Error('Invalid API response format');
        }

        return data.choices[0].message.content.trim();

    } catch (error) {
        console.error('LLM Generation Error:', error);
        throw error;
    }
}

export function getAvailableModels() {
    return [
        { id: 'tngtech/deepseek-r1t2-chimera:free', name: 'DeepSeek R1T2 Chimera (Free)' },
        { id: 'google/gemma-2-9b-it:free', name: 'Gemma 2 9B (Free)' },
        { id: 'meta-llama/llama-3.1-8b-instruct:free', name: 'Llama 3.1 8B (Free)' },
        { id: 'anthropic/claude-3-haiku', name: 'Claude 3 Haiku' },
        { id: 'openai/gpt-4o-mini', name: 'GPT-4o Mini' }
    ];
}
