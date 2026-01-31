// Message Templates System for Reddit Insight Gatherer

const TEMPLATES_STORAGE_KEY = 'messageTemplates';

// Available template variables
const TEMPLATE_VARIABLES = {
    '{{author}}': 'Username of the post author',
    '{{subreddit}}': 'Subreddit name',
    '{{post_title}}': 'Title of the post',
    '{{greeting}}': 'Random greeting (Hey/Hi/Hello)'
};

// Get random greeting
function getRandomGreeting() {
    const greetings = ['Hey', 'Hi', 'Hello', 'Hi there'];
    return greetings[Math.floor(Math.random() * greetings.length)];
}

// Render template with context
function renderTemplate(template, context) {
    return template
        .replace(/\{\{author\}\}/g, context.author || 'there')
        .replace(/\{\{subreddit\}\}/g, context.subreddit || '')
        .replace(/\{\{post_title\}\}/g, context.postTitle || '')
        .replace(/\{\{greeting\}\}/g, getRandomGreeting());
}

// Save a new template
async function saveTemplate(template) {
    const templates = await getTemplates();

    const newTemplate = {
        id: `template_${Date.now()}`,
        name: template.name,
        content: template.content,
        category: template.category || 'general',
        createdAt: new Date().toISOString()
    };

    templates.push(newTemplate);
    await chrome.storage.local.set({ [TEMPLATES_STORAGE_KEY]: templates });

    return newTemplate;
}

// Get all templates
async function getTemplates() {
    const data = await chrome.storage.local.get([TEMPLATES_STORAGE_KEY]);
    return data[TEMPLATES_STORAGE_KEY] || getDefaultTemplates();
}

// Get a single template by ID
async function getTemplate(id) {
    const templates = await getTemplates();
    return templates.find(t => t.id === id);
}

// Update an existing template
async function updateTemplate(id, updates) {
    const templates = await getTemplates();
    const index = templates.findIndex(t => t.id === id);

    if (index === -1) {
        throw new Error('Template not found');
    }

    templates[index] = {
        ...templates[index],
        ...updates,
        updatedAt: new Date().toISOString()
    };

    await chrome.storage.local.set({ [TEMPLATES_STORAGE_KEY]: templates });
    return templates[index];
}

// Delete a template
async function deleteTemplate(id) {
    const templates = await getTemplates();
    const filtered = templates.filter(t => t.id !== id && !t.isDefault);

    await chrome.storage.local.set({ [TEMPLATES_STORAGE_KEY]: filtered });
    return true;
}

// Get default templates
function getDefaultTemplates() {
    return [
        {
            id: 'default_curious',
            name: 'Curious Question',
            content: '{{greeting}}! I saw your post about "{{post_title}}" in r/{{subreddit}}. I\'m curious - what led you to that decision?',
            category: 'general',
            isDefault: true
        },
        {
            id: 'default_empathy',
            name: 'Empathetic Inquiry',
            content: '{{greeting}}, I noticed your post in r/{{subreddit}} and it really resonated with me. Would you mind sharing more about your experience?',
            category: 'general',
            isDefault: true
        },
        {
            id: 'default_pain_point',
            name: 'Pain Point Discovery',
            content: '{{greeting}}! Reading your post in r/{{subreddit}}, I\'m wondering - what\'s been the most frustrating part of dealing with this?',
            category: 'research',
            isDefault: true
        },
        {
            id: 'default_solution',
            name: 'Solution Explorer',
            content: '{{greeting}}! Your post in r/{{subreddit}} caught my attention. Have you found any solutions that worked well for you?',
            category: 'research',
            isDefault: true
        }
    ];
}

// Export for use in content script
if (typeof window !== 'undefined') {
    window.TemplateEngine = {
        TEMPLATE_VARIABLES,
        renderTemplate,
        saveTemplate,
        getTemplates,
        getTemplate,
        updateTemplate,
        deleteTemplate,
        getDefaultTemplates
    };
}

// Export for use in background script
if (typeof globalThis !== 'undefined') {
    globalThis.templates = {
        TEMPLATE_VARIABLES,
        renderTemplate,
        saveTemplate,
        getTemplates,
        getTemplate,
        updateTemplate,
        deleteTemplate,
        getDefaultTemplates
    };
}
