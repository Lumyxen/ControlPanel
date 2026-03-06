// Demo mode module for styling without backend

// Demo mode state
let isDemoMode = false;

// Mock data for demo mode with accurate context_length and max_tokens
const MOCK_MODELS = [
    {
        id: "anthropic/claude-3.5-sonnet",
        name: "Claude 3.5 Sonnet",
        provider: "Anthropic",
        context_length: 200000,
        max_tokens: 8192
    },
    {
        id: "openai/gpt-4o",
        name: "GPT-4o",
        provider: "OpenAI",
        context_length: 128000,
        max_tokens: 16384
    },
    {
        id: "google/gemini-1.5-pro",
        name: "Gemini 1.5 Pro",
        provider: "Google",
        context_length: 2000000,
        max_tokens: 8192
    },
    {
        id: "meta-llama/llama-3.1-70b",
        name: "Llama 3.1 70B",
        provider: "Meta",
        context_length: 131072,
        max_tokens: 4096
    },
    {
        id: "deepseek/deepseek-coder",
        name: "DeepSeek Coder",
        provider: "DeepSeek",
        context_length: 64000,
        max_tokens: 4096
    },
    {
        id: "z-ai/glm-4.5-air:free",
        name: "Z AI GLM 4.5 Air",
        provider: "Z AI",
        context_length: 128000,
        max_tokens: 8192
    },
];

const MOCK_PRICING = {
    "anthropic/claude-3.5-sonnet": { prompt: 3.0, completion: 15.0 },
    "openai/gpt-4o": { prompt: 5.0, completion: 15.0 },
    "google/gemini-1.5-pro": { prompt: 3.5, completion: 10.5 },
    "meta-llama/llama-3.1-70b": { prompt: 0.9, completion: 0.9 },
    "deepseek/deepseek-coder": { prompt: 0.14, completion: 0.28 },
};

const MOCK_SETTINGS = {
    defaultModel: "anthropic/claude-3.5-sonnet",
    maxTokens: 2048,
    temperature: 0.7,
    theme: "everforest-harddark-green",
};

const MOCK_PROMPT_TEMPLATES = [
    { id: 1, name: "Code Review", template: "Please review this code for best practices and potential issues:\n\n{{code}}" },
    { id: 2, name: "Explain Code", template: "Explain what this code does in simple terms:\n\n{{code}}" },
    { id: 3, name: "Refactor", template: "Refactor this code to improve readability and performance:\n\n{{code}}" },
];

/**
 * Check if demo mode is enabled via URL parameter
 * @returns {boolean}
 */
function checkDemoMode() {
    const urlParams = new URLSearchParams(window.location.search);
    return urlParams.get('demo') === 'true';
}

/**
 * Initialize demo mode - call this early in app initialization
 * @returns {boolean} true if demo mode is active
 */
export function initDemoMode() {
    isDemoMode = checkDemoMode();
    
    if (isDemoMode) {
        console.log('[DemoMode] Demo mode enabled - API calls will be mocked');
        showDemoBanner();
    }
    
    return isDemoMode;
}

/**
 * Check if currently in demo mode
 * @returns {boolean}
 */
export function isDemoEnabled() {
    return isDemoMode;
}

/**
 * Show demo mode banner at the top of the page
 */
function showDemoBanner() {
    // Check if banner already exists
    if (document.getElementById('demo-banner')) {
        return;
    }
    
    const banner = document.createElement('div');
    banner.id = 'demo-banner';
    banner.className = 'demo-banner';
    banner.innerHTML = `
        <span class="demo-banner-icon">⚠️</span>
        <span class="demo-banner-text">DEMO MODE - No backend connection</span>
        <button class="demo-banner-close" aria-label="Close demo banner">×</button>
    `;
    
    // Add close handler
    banner.querySelector('.demo-banner-close').addEventListener('click', () => {
        banner.style.display = 'none';
    });
    
    // Insert at the start of body
    document.body.insertBefore(banner, document.body.firstChild);
    
    // Add padding to body to account for banner
    document.body.classList.add('demo-mode-active');
}

/**
 * Mock API response delay to simulate network
 * @param {number} minMs - minimum delay in ms
 * @param {number} maxMs - maximum delay in ms
 * @returns {Promise<void>}
 */
function mockDelay(minMs = 200, maxMs = 800) {
    const delay = Math.random() * (maxMs - minMs) + minMs;
    return new Promise(resolve => setTimeout(resolve, delay));
}

/**
 * Mock verify API key - always succeeds in demo mode
 * @returns {Promise<{valid: boolean}>}
 */
export async function mockVerifyApiKey() {
    await mockDelay(300, 600);
    return { valid: true };
}

/**
 * Mock get models
 * @returns {Promise<{data: Array}>}
 */
export async function mockGetModels() {
    await mockDelay(400, 800);
    return { 
        data: MOCK_MODELS.map(m => ({
            id: m.id,
            name: m.name,
            description: `${m.name} by ${m.provider}`,
            context_length: m.context_length,
            max_tokens: m.max_tokens,
            pricing: MOCK_PRICING[m.id] || { prompt: 1.0, completion: 1.0 }
        }))
    };
}

/**
 * Mock get pricing
 * @returns {Promise<Object>}
 */
export async function mockGetPricing() {
    await mockDelay(300, 600);
    return MOCK_PRICING;
}

/**
 * Mock send chat message - echoes back with "Demo: " prefix
 * @param {string} model - model ID
 * @param {string} prompt - user message
 * @param {number} maxTokens - max tokens
 * @returns {Promise<{choices: Array}>}
 */
export async function mockSendChatMessage(model, prompt, maxTokens = 2048) {
    await mockDelay(800, 1500);
    
    const modelName = MOCK_MODELS.find(m => m.id === model)?.name || 'AI';
    
    return {
        choices: [{
            message: {
                role: 'assistant',
                content: `**Demo Response from ${modelName}**\n\nYou said:\n> ${prompt}\n\nThis is a demo response. In production mode, this would be a real AI response from the selected model.\n\nKey features demonstrated:\n- Model switching works\n- Chat interface is functional\n- Response formatting with Markdown\n\n---\n*Demo mode - no backend connected*`
            }
        }],
        usage: {
            prompt_tokens: prompt.length / 4,
            completion_tokens: 150,
            total_tokens: prompt.length / 4 + 150
        }
    };
}

/**
 * Mock stream chat message - yields chunks with "Demo: " prefix
 * @param {string} model - model ID
 * @param {string} prompt - user message
 * @param {number} maxTokens - max tokens
 * @param {function} onChunk - callback for each chunk
 */
export async function mockStreamChatMessage(model, prompt, maxTokens = 2048, onChunk) {
    const modelName = MOCK_MODELS.find(m => m.id === model)?.name || 'AI';
    
    const demoResponse = `**Demo Response from ${modelName}**\n\nYou said:\n> ${prompt}\n\nThis is a simulated streaming response. In production mode, this would stream tokens from the actual AI model.\n\nKey features demonstrated:\n- Streaming responses\n- Token-by-token display\n- Model selection\n- Chat history\n\n---\n*Demo mode - no backend connected*`;
    
    // Split into chunks and yield
    const chunks = demoResponse.split(' ');
    
    for (let i = 0; i < chunks.length; i++) {
        await mockDelay(50, 150);
        
        const chunk = chunks[i] + (i < chunks.length - 1 ? ' ' : '');
        
        if (onChunk) {
            onChunk({
                choices: [{
                    delta: {
                        content: chunk
                    }
                }]
            });
        }
    }
}

/**
 * Mock get settings
 * @returns {Promise<Object>}
 */
export async function mockGetSettings() {
    await mockDelay(200, 400);
    return { ...MOCK_SETTINGS };
}

/**
 * Mock update settings
 * @param {Object} settings - new settings
 * @returns {Promise<Object>}
 */
export async function mockUpdateSettings(settings) {
    await mockDelay(300, 500);
    Object.assign(MOCK_SETTINGS, settings);
    return { ...MOCK_SETTINGS };
}

/**
 * Mock get prompt templates
 * @returns {Promise<{templates: Array}>}
 */
export async function mockGetPromptTemplates() {
    await mockDelay(200, 400);
    return { templates: [...MOCK_PROMPT_TEMPLATES] };
}

/**
 * Mock create prompt template
 * @param {string} name - template name
 * @param {string} template - template content
 * @returns {Promise<Object>}
 */
export async function mockCreatePromptTemplate(name, template) {
    await mockDelay(300, 500);
    const newTemplate = {
        id: MOCK_PROMPT_TEMPLATES.length + 1,
        name,
        template
    };
    MOCK_PROMPT_TEMPLATES.push(newTemplate);
    return newTemplate;
}

/**
 * Mock update prompt template
 * @param {number} id - template ID
 * @param {Object} data - updated data
 * @returns {Promise<Object>}
 */
export async function mockUpdatePromptTemplate(id, data) {
    await mockDelay(300, 500);
    const index = MOCK_PROMPT_TEMPLATES.findIndex(t => t.id === id);
    if (index >= 0) {
        MOCK_PROMPT_TEMPLATES[index] = { ...MOCK_PROMPT_TEMPLATES[index], ...data };
        return MOCK_PROMPT_TEMPLATES[index];
    }
    throw new Error('Template not found');
}

/**
 * Mock delete prompt template
 * @param {number} id - template ID
 * @returns {Promise<void>}
 */
export async function mockDeletePromptTemplate(id) {
    await mockDelay(200, 400);
    const index = MOCK_PROMPT_TEMPLATES.findIndex(t => t.id === id);
    if (index >= 0) {
        MOCK_PROMPT_TEMPLATES.splice(index, 1);
    }
}

/**
 * Mock backend health check
 * @returns {Promise<boolean>}
 */
export async function mockHealthCheck() {
    await mockDelay(100, 200);
    return true;
}

/**
 * Mock external health check
 * @returns {Promise<{openrouter: boolean}>}
 */
export async function mockExternalHealthCheck() {
    await mockDelay(200, 400);
    return { openrouter: true };
}
