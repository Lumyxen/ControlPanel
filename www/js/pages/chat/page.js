// www/js/chat/chat-page.js
// Top-level initialiser for the AI chat page.
// Wires together the toolbar, generation loop, message action handlers,
// and the copy/clipboard override — but delegates all the heavy lifting.

import {
	branchFromNode, computeThreadNodeIds, createSiblingCopy,
	deleteSubtree, ensureGraph, getNode, recomputeLeafId,
	setSelectedChildId, spliceDeleteNode,
} from './graph.js';
import {
	addChildMessageToChat, addMessageToChat, createNewChat,
	ensureChatLoaded, getChatById, getCurrentChatId, getChatToolScope, isChatLoaded,
	loadChats, saveChatAwaitable, saveChats, setChatModel, setCurrentChatId,
	getLastSelectedModel, setLastSelectedModel, getLastSelectedToolScope,
} from './repository.js';
import { renderChatList } from './sidebar-list.js';
import {
	updateContextUI,
	estimatePreparedMessagesTokens,
	getModelContextInfoFromUI,
	getModelMaxTokens,
	getModelContextLimitFromUI,
	getKnownModelContextLength,
	hasKnownModel,
} from './context.js';
import {
	renderThread,
	showTyping,
	patchMessageEditState,
	getSiblingNavState,
	buildMessageNudgeElement,
	getMessageFileEditRollbacks,
	refreshRenderedMessageNudges,
} from './thread-view.js';
import { InlineAttachmentManager } from './attachments.js';
import {
	submitGenerationTask,
	streamTask,
	getTaskByChat,
	cancelTask,
	generateAiTitle,
	generateResearchPlan,
	approveToolApproval,
	denyToolApproval,
	rollbackFileEdit,
	countChatTokens,
} from '../../core/http.js';
import * as SettingsStore from '../../services/settings.js';
import { initDropdowns, initTools, loadAndPopulateModels } from './model-picker.js';
import { initUpload, initAutoResize } from './composer.js';
import { buildNodeTextForHistory, buildApiMessages, buildApiMessagesFromNodes, buildConversationHistory, parseStreamReasoning } from './payloads.js';
import { buildPartsWithUpdatedText, getNodeRawTextContent, getNodeTextContent } from './message-parts.js';
import { createStreamingMessageController } from './stream-view.js';
import { htmlToMarkdown } from './clipboard.js';
import { createChatSessionState } from './session.js';

let chatPageAbort = null;
const MAX_CONTEXT_COUNT_CACHE_ENTRIES = 128;
const contextCountCache = new Map();
const contextCountScopeCache = new Map();
const contextIndicatorCache = new Map();

function getLruCacheEntry(cache, key) {
	if (!key || !cache.has(key)) return null;
	const value = cache.get(key);
	cache.delete(key);
	cache.set(key, value);
	return value;
}

function setLruCacheEntry(cache, key, value) {
	if (!key) return;
	if (cache.has(key)) {
		cache.delete(key);
	}
	cache.set(key, value);
	while (cache.size > MAX_CONTEXT_COUNT_CACHE_ENTRIES) {
		const oldestKey = cache.keys().next().value;
		if (!oldestKey) break;
		cache.delete(oldestKey);
	}
}

function buildContextScopeKey({ chatId, model }) {
	if (!chatId || !model) return '';
	return `${chatId}::${model}`;
}

function buildContextIndicatorKey({ chatId, model = '' }) {
	if (!chatId) return '';
	return model ? `${chatId}::${model}` : `${chatId}::indicator`;
}

function parseAssistantEditDraft(text) {
	const parsed = parseStreamReasoning(text);
	const hasReasoning = parsed.hasThinkTags && parsed.parts.some((part) => part?.type === 'reasoning');
	if (!hasReasoning) return null;
	return {
		content: parsed.parsedContent,
		reasoning: parsed.parsedReasoning.trim(),
		parts: parsed.parts,
	};
}

function getCachedContextCount(cacheKey) {
	return getLruCacheEntry(contextCountCache, cacheKey);
}

function setCachedContextCount(cacheKey, usedTokens) {
	const nextTokens = Number.parseInt(usedTokens, 10);
	if (!cacheKey || !Number.isFinite(nextTokens) || nextTokens < 0) return;
	setLruCacheEntry(contextCountCache, cacheKey, nextTokens);
}

function rememberExactContextCount({ chatId, model, usedTokens }) {
	const nextTokens = Number.parseInt(usedTokens, 10);
	const scopeKey = buildContextScopeKey({ chatId, model });
	if (!scopeKey || !Number.isFinite(nextTokens) || nextTokens < 0) return;
	setLruCacheEntry(contextCountScopeCache, scopeKey, nextTokens);
}

function getCachedScopeContextCount({ chatId, model }) {
	return getLruCacheEntry(contextCountScopeCache, buildContextScopeKey({ chatId, model }));
}

function rememberContextIndicator({
	chatId,
	model,
	usedTokens,
	contextLimit,
	exactCountUnavailable = false,
	contextLimitKnown = true,
}) {
	const nextTokens = Number.parseInt(usedTokens, 10);
	const nextLimit = Number.parseInt(contextLimit, 10);
	if (!chatId || !model || !Number.isFinite(nextTokens) || nextTokens < 0) return;
	if (!Number.isFinite(nextLimit) || nextLimit <= 0) return;
	const snapshot = {
		usedTokens: nextTokens,
		contextLimit: nextLimit,
		exactCountUnavailable: exactCountUnavailable === true,
		contextLimitKnown: contextLimitKnown === true,
	};
	setLruCacheEntry(contextIndicatorCache, buildContextIndicatorKey({ chatId, model }), snapshot);
	setLruCacheEntry(contextIndicatorCache, buildContextIndicatorKey({ chatId }), snapshot);
}

function getCachedContextIndicator({ chatId, model }) {
	const modelSnapshot = getLruCacheEntry(contextIndicatorCache, buildContextIndicatorKey({ chatId, model }));
	if (modelSnapshot) return { ...modelSnapshot, scope: 'model' };
	const chatSnapshot = getLruCacheEntry(contextIndicatorCache, buildContextIndicatorKey({ chatId }));
	return chatSnapshot ? { ...chatSnapshot, scope: 'chat' } : null;
}

function getRouteChatId(route) {
	try {
		return new URLSearchParams(String(route || '').split('?')[1] || '').get('chat');
	} catch {
		return null;
	}
}

function formatModelDisplayName(modelId) {
	return String(modelId || '')
		.replace('llamacpp::', '')
		.replace('lmstudio::', '')
		.split('/')
		.pop()
		.replace(/-/g, ' ');
}

function resolvePreferredModelId(chatId) {
	const settings = SettingsStore.get();
	const chat = chatId ? getChatById(chatId) : null;
	const candidates = [
		chat?.model || '',
		getLastSelectedModel() || '',
		settings?.defaultModel || '',
	].filter(Boolean);
	const knownCandidate = candidates.find((candidate) => hasKnownModel(candidate));
	return knownCandidate || candidates[0] || '';
}

function seedModelPicker(root, {
	modelId = '',
	contextLimit = null,
	contextLimitKnown = false,
} = {}) {
	if (!modelId) return false;
	const modelDropdown = root?.querySelector?.('[data-dropdown="model"]');
	if (!modelDropdown) return false;

	const label = modelDropdown.querySelector('.chat-dropdown-label');
	if (label) label.textContent = formatModelDisplayName(modelId);

	const menu = modelDropdown.querySelector('.chat-dropdown-menu');
	if (!menu) return true;

	let selectedItem = null;
	for (const item of menu.querySelectorAll('.chat-dropdown-item')) {
		const isMatch = item.dataset.value === modelId;
		item.classList.toggle('selected', isMatch);
		item.setAttribute('aria-selected', String(isMatch));
		if (isMatch) selectedItem = item;
	}

	if (!selectedItem) {
		selectedItem = document.createElement('button');
		selectedItem.type = 'button';
		selectedItem.className = 'chat-dropdown-item selected';
		selectedItem.dataset.seeded = 'true';
		selectedItem.setAttribute('role', 'option');
		selectedItem.setAttribute('aria-selected', 'true');
		menu.prepend(selectedItem);
	}

	selectedItem.dataset.value = modelId;
	if (contextLimitKnown && Number.isFinite(contextLimit) && contextLimit > 0) {
		selectedItem.dataset.contextLength = String(contextLimit);
	} else {
		delete selectedItem.dataset.contextLength;
	}
	selectedItem.textContent = '';
	const labelText = document.createElement('span');
	labelText.className = 'chat-dropdown-item-label';
	labelText.textContent = formatModelDisplayName(modelId);
	selectedItem.appendChild(labelText);
	return true;
}

function seedChatPageShell(root, currentRouteGetter = () => '') {
	const routeChatId = getRouteChatId(currentRouteGetter());
	const activeChatId = routeChatId || getCurrentChatId();
	const model = resolvePreferredModelId(activeChatId);
	if (!activeChatId && !model) return false;
	if (model) setLastSelectedModel(model);
	const cachedIndicator = activeChatId
		? getCachedContextIndicator({ chatId: activeChatId, model })
		: null;
	const knownModelContextLimit = getKnownModelContextLength(model);
	const contextLimitKnown = Boolean(
		(Number.isFinite(knownModelContextLimit) && knownModelContextLimit > 0)
		|| (cachedIndicator?.scope === 'model' && cachedIndicator.contextLimitKnown === true)
	);
	const modelContextLimit = knownModelContextLimit
		|| cachedIndicator?.contextLimit
		|| null;

	seedModelPicker(root, {
		modelId: model,
		contextLimit: modelContextLimit,
		contextLimitKnown,
	});

	if (cachedIndicator) {
		updateContextUI(root, {
			usedTokens: cachedIndicator.usedTokens,
			contextLimit: cachedIndicator.contextLimit,
			contextLimitKnown,
			exactCountUnavailable: cachedIndicator.scope === 'model' && cachedIndicator.exactCountUnavailable === true,
			showUnknownContextWarning: root?._modelPickerPopulated === true,
		});
		return true;
	}
	if (Number.isFinite(modelContextLimit) && modelContextLimit > 0) {
		updateContextUI(root, {
			usedTokens: 0,
			contextLimit: modelContextLimit,
			contextLimitKnown,
			showUnknownContextWarning: root?._modelPickerPopulated === true,
		});
		return true;
	}
	return Boolean(model);
}

function buildSystemPromptForMessages(apiMessages, settings) {
	let systemPrompt = settings?.systemPrompt || '';
	if (apiMessages.some((message) => Array.isArray(message.content))) {
		const hint = '[System Override: You have native multimodal vision capabilities. The user has attached an image. Analyze the visual data directly.]';
		systemPrompt = systemPrompt ? `${systemPrompt}\n\n${hint}` : hint;
	}
	return systemPrompt;
}

const RESEARCH_MAX_TOKENS = 12288;
const RESEARCH_WORKFLOW_STEPS = [
	{ id: 'plan', label: 'Plan', instruction: 'Break the request into answerable research tasks and source targets.' },
	{ id: 'gather', label: 'Gather evidence', instruction: 'Use available retrieval tools and collect source-grounded evidence.' },
	{ id: 'verify', label: 'Verify', instruction: 'Cross-check material claims, dates, numbers, and source quality.' },
	{ id: 'draft', label: 'Draft', instruction: 'Write a user-facing answer from the verified evidence.' },
	{ id: 'review', label: 'Review and refine', instruction: 'Review the draft, revise material issues, and repeat until acceptable or the review budget is exhausted.' },
	{ id: 'final', label: 'Final response', instruction: 'Present only the final answer to the user.' },
];
const RESEARCH_DELIVERABLES = [
	'final_answer',
	'inline_citations',
	'source_list',
	'caveats',
	'conflict_notes',
];

function isResearchEnabled(root) {
	const toggle = root?.querySelector?.('#chatResearchToggle');
	return root?.dataset?.researchEnabled === 'true' ||
		toggle?.getAttribute('aria-pressed') === 'true' ||
		toggle?.dataset?.enabled === 'true';
}

function setResearchEnabled(root, enabled) {
	const active = Boolean(enabled);
	const toggle = root?.querySelector?.('#chatResearchToggle');
	if (root?.dataset) root.dataset.researchEnabled = String(active);
	root?.classList?.toggle('research-enabled', active);
	if (toggle) {
		toggle.dataset.enabled = String(active);
		toggle.setAttribute('aria-pressed', String(active));
	}
}

function truncateResearchText(value, maxLength) {
	const text = String(value || '').trim().replace(/\s+/g, ' ');
	if (text.length <= maxLength) return text;
	return `${text.slice(0, Math.max(0, maxLength - 3))}...`;
}

function buildResearchTitle(query) {
	const text = truncateResearchText(query, 96);
	if (!text) return 'Research Brief';
	return truncateResearchText(`Research: ${text}`, 96);
}

function buildResearchTasks(query) {
	const subject = String(query || '').trim() || 'the request';
	return [
		{ id: 'scope', label: `Clarify the exact question and break ${subject} into researchable parts.` },
		{ id: 'sources', label: 'Find relevant primary or high-quality sources before drafting.' },
		{ id: 'verify', label: 'Cross-check important facts, dates, numbers, and source conflicts.' },
		{ id: 'answer', label: 'Write a concise final answer with citations and caveats.' },
	];
}

function normalizeResearchTaskId(value, index) {
	const id = String(value || '')
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '_')
		.replace(/^_+|_+$/g, '');
	return truncateResearchText(id || `task_${index + 1}`, 48);
}

function normalizeResearchTasks(tasks, query) {
	if (!Array.isArray(tasks) || tasks.length === 0) return buildResearchTasks(query);
	const normalized = tasks
		.map((task, index) => {
			if (typeof task === 'string') {
				const label = truncateResearchText(task, 220);
				return label ? { id: normalizeResearchTaskId(label, index), label } : null;
			}
			if (!task || typeof task !== 'object') return null;
			const label = truncateResearchText(task.label || task.title || task.task || task.step || '', 220);
			if (!label) return null;
			return {
				id: normalizeResearchTaskId(task.id || label, index),
				label,
			};
		})
		.filter(Boolean)
		.slice(0, 8);
	return normalized.length > 0 ? normalized : buildResearchTasks(query);
}

function parseResearchTaskEditDraft(text) {
	return String(text || '')
		.split(/\r?\n/)
		.map((line) => line.trim().replace(/^[-*•]\s+/, '').replace(/^\d+[.)]\s+/, '').trim())
		.filter(Boolean);
}

function formatResearchTaskEditDraft(researchPart) {
	return normalizeResearchTasks(researchPart?.tasks || researchPart?.workflow, researchPart?.query)
		.map((task) => task.label)
		.join('\n');
}

function getEditableResearchPart(node) {
	const researchPart = getNodeResearchPart(node);
	const status = researchPart?.status;
	return status === 'pending' || status === 'planning' ? researchPart : null;
}

function buildResearchPartWithEditedTasks(researchPart, draft) {
	const tasks = normalizeResearchTasks(parseResearchTaskEditDraft(draft), researchPart?.query);
	const next = {
		...researchPart,
		tasks,
		workflow: tasks.map((task) => ({ id: task.id, label: task.label })),
	};
	if (next.status === 'planning') {
		next.status = 'pending';
	}
	delete next.autoStartAt;
	return next;
}

function normalizeResearchList(value, fallback) {
	if (!Array.isArray(value)) return [...fallback];
	const normalized = value
		.map((item) => truncateResearchText(typeof item === 'string' ? item : item?.label || item?.id || '', 64))
		.filter(Boolean)
		.slice(0, 8);
	return normalized.length > 0 ? normalized : [...fallback];
}

function buildResearchPart(_root, query, overrides = {}) {
	const normalizedQuery = String(query || '').trim();
	const part = {
		type: 'research',
		query: normalizedQuery,
		title: buildResearchTitle(normalizedQuery),
		tasks: buildResearchTasks(normalizedQuery),
		status: 'pending',
		sourceClasses: ['web', 'academic'],
		deliverables: [...RESEARCH_DELIVERABLES],
		workflow: RESEARCH_WORKFLOW_STEPS.map(({ id, label }) => ({ id, label })),
	};
	const next = { ...part, ...overrides };
	next.tasks = normalizeResearchTasks(next.tasks, normalizedQuery);
	next.sourceClasses = normalizeResearchList(next.sourceClasses, ['web', 'academic']);
	next.deliverables = normalizeResearchList(next.deliverables, RESEARCH_DELIVERABLES);
	if (Array.isArray(next.workflow) && next.workflow.length > 0) {
		next.workflow = normalizeResearchTasks(next.workflow, normalizedQuery);
	} else {
		next.workflow = next.tasks.map((task) => ({ id: task.id, label: task.label }));
	}
	delete next.autoStartAt;
	return next;
}

function buildResearchPlanningPart(root, query) {
	return buildResearchPart(root, query, {
		title: 'Preparing Research Plan',
		tasks: [{ id: 'planning', label: 'Generating a tailored header and task list.' }],
		status: 'planning',
	});
}

function normalizeGeneratedResearchPart(root, query, generated) {
	const fallback = buildResearchPart(root, query);
	const title = truncateResearchText(generated?.title || generated?.header || fallback.title, 96) || fallback.title;
	const tasks = normalizeResearchTasks(generated?.tasks || generated?.steps || generated?.workflow, query);
	const sourceClasses = normalizeResearchList(
		generated?.sourceClasses || generated?.source_classes,
		fallback.sourceClasses,
	);
	const deliverables = normalizeResearchList(generated?.deliverables, fallback.deliverables);
	return {
		...fallback,
		query: String(generated?.query || query || '').trim(),
		title,
		tasks,
		sourceClasses,
		deliverables,
		workflow: tasks.map((task) => ({ id: task.id, label: task.label })),
	};
}

async function buildGeneratedResearchPart(root, query, { signal } = {}) {
	const settings = SettingsStore.get() || {};
	const selectedModel = root.querySelector('[data-dropdown="model"] .chat-dropdown-item.selected')?.dataset?.value || '';
	const model = selectedModel || settings.defaultModel || '';
	if (!model) return buildResearchPart(root, query);

	try {
		const generated = await generateResearchPlan({
			model,
			message: query,
			planner_system_prompt: settings.aiResearchPlannerSystemPrompt || '',
			max_tokens: 768,
		}, { signal });
		return normalizeGeneratedResearchPart(root, query, generated);
	} catch (err) {
		if (signal?.aborted || err?.name === 'AbortError') throw err;
		console.error('[ChatPage] Research plan generation failed:', err);
		return buildResearchPart(root, query);
	}
}

function getNodeResearchPart(node) {
	if (node?.research && typeof node.research === 'object') return node.research;
	if (!Array.isArray(node?.parts)) return null;
	return node.parts.find((part) => part?.type === 'research' && typeof part === 'object') || null;
}

function buildPartsWithResearchPart(parts, researchPart) {
	const nextParts = Array.isArray(parts)
		? parts.filter((part) => part?.type !== 'research').map((part) => ({ ...part }))
		: [];
	if (researchPart && typeof researchPart === 'object') {
		nextParts.push({ ...researchPart });
	}
	return nextParts;
}

function setNodeResearchPart(node, researchPart) {
	if (!node || !researchPart || typeof researchPart !== 'object') return;
	node.research = { ...researchPart };
	node.parts = buildPartsWithResearchPart(node.parts, node.research);
}

function setNodeResearchMetadata(node, researchPart) {
	if (!node || !researchPart || typeof researchPart !== 'object') return;
	node.research = { ...researchPart };
}

function getPendingResearchChild(graph, userNode) {
	if (!graph || !userNode || userNode.role !== 'user') return null;
	for (const childId of userNode.children || []) {
		const child = getNode(graph, childId);
		const status = getNodeResearchPart(child)?.status;
		if (child?.role === 'assistant' && (status === 'pending' || status === 'planning')) {
			return child;
		}
	}
	return null;
}

function buildResearchSystemPrompt(basePrompt, researchPart) {
	if (!researchPart) return basePrompt;
	const previewTasks = normalizeResearchTasks(researchPart.tasks || researchPart.workflow, researchPart.query);
	const researchPrompt = [
		'Research mode is enabled for the latest user message. Use the dedicated research workflow before presenting the final answer.',
		'Task preview generated for this request:',
		...previewTasks.map((step) => `- ${step.label}`),
		'Workflow:',
		...RESEARCH_WORKFLOW_STEPS.map((step) => `- ${step.label}: ${step.instruction}`),
		'Use only tools that are available in this chat turn. If retrieval tools are unavailable, say that research tools are not enabled instead of fabricating sources.',
		'When retrieval tools are available, prefer official, primary, standards, regulator, original dataset, and peer-reviewed sources.',
		'Bind non-trivial claims to inline citations from sources actually retrieved in this chat turn.',
		'Include an executive summary, findings, caveats, timeline when relevant, and a source list in the final answer.',
		'Use evidence confidence, not token confidence. Surface unresolved conflicts instead of hiding them.',
		'Do not present intermediate workflow notes as the final answer.',
	].join('\n');
	return basePrompt ? `${basePrompt}\n\n${researchPrompt}` : researchPrompt;
}

function normalizeContextToolScope(toolScope) {
	return {
		useDefaultPacks: toolScope?.useDefaultPacks === true,
		enabledPackIds: Array.isArray(toolScope?.enabledPackIds)
			? [...new Set(toolScope.enabledPackIds.filter(Boolean).map(String))]
			: [],
	};
}

function getActiveToolScope(chatId) {
	return chatId
		? getChatToolScope(chatId)
		: (getLastSelectedToolScope() || { useDefaultPacks: true, enabledPackIds: [] });
}

function markGraphForReplacement(graph) {
	if (graph && typeof graph === 'object') graph._replace = true;
}

function hasToolContextForCount(toolScope, revisionMode = false) {
	const normalized = normalizeContextToolScope(toolScope);
	return revisionMode === true ||
		normalized.useDefaultPacks === true ||
		normalized.enabledPackIds.length > 0;
}

function buildContextCountCacheKey({ model, messages, systemPrompt, toolScope = null, revisionMode = false }) {
	if (!model) return '';
	return JSON.stringify({
		model,
		system_prompt: systemPrompt || '',
		messages: Array.isArray(messages) ? messages : [],
		tool_scope: normalizeContextToolScope(toolScope),
		revision_mode: revisionMode === true,
	});
}

function buildContextScopeSignature({ model, systemPrompt, toolScope = null, revisionMode = false }) {
	if (!model) return '';
	return JSON.stringify({
		model,
		system_prompt: systemPrompt || '',
		tool_scope: normalizeContextToolScope(toolScope),
		revision_mode: revisionMode === true,
	});
}

async function fetchExactContextCount({ model, messages, systemPrompt, chatId, toolScope = null, revisionMode = false }, options = {}) {
	const normalizedToolScope = normalizeContextToolScope(toolScope);
	const cacheKey = buildContextCountCacheKey({
		model,
		messages,
		systemPrompt,
		toolScope: normalizedToolScope,
		revisionMode,
	});
	const cachedTokens = getCachedContextCount(cacheKey);
	if (Number.isFinite(cachedTokens)) {
		rememberExactContextCount({ chatId, model, usedTokens: cachedTokens });
		return { prompt_tokens: cachedTokens };
	}

	const result = await countChatTokens({
		model,
		messages,
		system_prompt: systemPrompt,
		tool_scope: normalizedToolScope,
		revision_mode: revisionMode === true,
	}, options);
	const promptTokens = Number.parseInt(result?.prompt_tokens, 10);
	if (Number.isFinite(promptTokens) && promptTokens >= 0) {
		setCachedContextCount(cacheKey, promptTokens);
		rememberExactContextCount({ chatId, model, usedTokens: promptTokens });
	}
	return result;
}

function buildStaticContextCountPayload(chatId, settings) {
	const chat = chatId ? getChatById(chatId) : null;
	const chatLoaded = isChatLoaded(chat);
	const model = resolvePreferredModelId(chatId);
	const toolScope = getActiveToolScope(chatId);
	const revisionMode = settings?.chatResponseMode === 'live';
	const cachedIndicator = getCachedContextIndicator({ chatId, model });
	const knownModelContextLimit = getKnownModelContextLength(model);
	const contextLimitKnown = Boolean(
		(Number.isFinite(knownModelContextLimit) && knownModelContextLimit > 0)
		|| (cachedIndicator?.scope === 'model' && cachedIndicator.contextLimitKnown === true)
	);
	const contextLimit = knownModelContextLimit
		|| cachedIndicator?.contextLimit
		|| 65536;
	const effectiveNodes = [];

	if (chatLoaded) {
		const graph = ensureGraph(chat);
		const threadIds = computeThreadNodeIds(graph);
		for (const nodeId of threadIds) {
			const node = getNode(graph, nodeId);
			if (!node || (node.role !== 'user' && node.role !== 'assistant')) continue;
			effectiveNodes.push(node);
		}
	}

	const messages = buildApiMessagesFromNodes(effectiveNodes, settings);
	const systemPrompt = buildSystemPromptForMessages(messages, settings);
	return {
		model,
		messages,
		systemPrompt,
		toolScope,
		revisionMode,
		estimatedUsedTokens: estimatePreparedMessagesTokens(messages, systemPrompt),
		contextLimit,
		contextLimitKnown,
		chatLoaded,
	};
}

async function seedExactContextIndicator(root, chatId) {
	if (!root || !chatId) return false;
	const settings = await SettingsStore.init();
	let payload = buildStaticContextCountPayload(chatId, settings);
	if (!payload.model) return false;

	const cachedIndicator = getCachedContextIndicator({ chatId, model: payload.model });
	if (cachedIndicator) {
		updateContextUI(root, {
			usedTokens: cachedIndicator.usedTokens,
			contextLimit: cachedIndicator.contextLimit,
			contextLimitKnown: payload.contextLimitKnown || (cachedIndicator.scope === 'model' && cachedIndicator.contextLimitKnown === true),
			exactCountUnavailable: cachedIndicator.scope === 'model' && cachedIndicator.exactCountUnavailable === true,
			showUnknownContextWarning: root?._modelPickerPopulated === true,
		});
		return true;
	}

	if (!payload.chatLoaded) {
		await ensureChatLoaded(chatId);
		payload = buildStaticContextCountPayload(chatId, settings);
		if (!payload.model) return false;
	}

	if (!payload.systemPrompt &&
		payload.messages.length === 0 &&
		!hasToolContextForCount(payload.toolScope, payload.revisionMode)) {
		rememberExactContextCount({ chatId, model: payload.model, usedTokens: 0 });
		rememberContextIndicator({
			chatId,
			model: payload.model,
			usedTokens: 0,
			contextLimit: payload.contextLimit,
			exactCountUnavailable: false,
			contextLimitKnown: payload.contextLimitKnown,
		});
		updateContextUI(root, {
			usedTokens: 0,
			contextLimit: payload.contextLimit,
			contextLimitKnown: payload.contextLimitKnown,
			showUnknownContextWarning: root?._modelPickerPopulated === true,
		});
		return true;
	}

	try {
		const result = await fetchExactContextCount({
			model: payload.model,
			messages: payload.messages,
			systemPrompt: payload.systemPrompt,
			chatId,
			toolScope: payload.toolScope,
			revisionMode: payload.revisionMode,
		});
		const promptTokens = Number.parseInt(result?.prompt_tokens, 10);
		if (!Number.isFinite(promptTokens) || promptTokens < 0) {
			const fallbackUsedTokens = payload.estimatedUsedTokens;
			rememberContextIndicator({
				chatId,
				model: payload.model,
				usedTokens: fallbackUsedTokens,
				contextLimit: payload.contextLimit,
				exactCountUnavailable: true,
				contextLimitKnown: payload.contextLimitKnown,
			});
			updateContextUI(root, {
				usedTokens: fallbackUsedTokens,
				contextLimit: payload.contextLimit,
				contextLimitKnown: payload.contextLimitKnown,
				exactCountUnavailable: true,
				showUnknownContextWarning: root?._modelPickerPopulated === true,
			});
			return false;
		}
		rememberContextIndicator({
			chatId,
			model: payload.model,
			usedTokens: promptTokens,
			contextLimit: payload.contextLimit,
			exactCountUnavailable: false,
			contextLimitKnown: payload.contextLimitKnown,
		});
		updateContextUI(root, {
			usedTokens: promptTokens,
			contextLimit: payload.contextLimit,
			contextLimitKnown: payload.contextLimitKnown,
			showUnknownContextWarning: root?._modelPickerPopulated === true,
		});
		return true;
	} catch (err) {
		console.error('[ChatPage] Failed to pre-seed exact context indicator:', err);
		rememberContextIndicator({
			chatId,
			model: payload.model,
			usedTokens: payload.estimatedUsedTokens,
			contextLimit: payload.contextLimit,
			exactCountUnavailable: true,
			contextLimitKnown: payload.contextLimitKnown,
		});
		updateContextUI(root, {
			usedTokens: payload.estimatedUsedTokens,
			contextLimit: payload.contextLimit,
			contextLimitKnown: payload.contextLimitKnown,
			exactCountUnavailable: true,
			showUnknownContextWarning: root?._modelPickerPopulated === true,
		});
		return false;
	}
}

// ── AI Title Generation (reusable) ────────────────────────────────────────────
async function triggerAiTitleGeneration(root, chatId, onStateChange, preferredModel = '') {
	const chat = getChatById(chatId);
	if (!chat || chat.title !== "New Chat") return;
	const graph = ensureGraph(chat);
	const threadIds = computeThreadNodeIds(graph);

	// Only on first message (exactly 1 user message)
	const userCount = threadIds.reduce((count, nodeId) => {
		const node = getNode(graph, nodeId);
		return count + (node?.role === 'user' ? 1 : 0);
	}, 0);
	if (userCount !== 1) return;

	const settings = await SettingsStore.init();
	if (settings?.aiTitleEnabled === false) return;

	const modelSelect = root?.querySelector?.('[data-dropdown="model"] .chat-dropdown-item.selected');
	const currentModel = preferredModel || chat.model || modelSelect?.dataset?.value || '';
	const titleModel = settings?.aiTitleModel || currentModel;
	if (!titleModel) return;

	const conversationText = buildConversationHistory(graph, threadIds);
	if (!conversationText.trim()) return;

	if (onStateChange) onStateChange(true);
	try {
		const data = await generateAiTitle({
			message: conversationText,
			model: titleModel,
			title_system_prompt: settings?.aiTitleSystemPrompt || '',
		});

		if (!data?.title) return;

		await loadChats();
		const refreshedChat = getChatById(chatId);
		if (!refreshedChat || refreshedChat.title !== "New Chat") return;

		const { renameChat } = await import('./repository.js');
		renameChat(chatId, data.title);
		renderChatList();
	} catch (err) {
		console.error('[ChatPage] AI title generation failed:', err);
	} finally {
		if (onStateChange) onStateChange(false);
	}
}

function ensureChatExists(setActiveCallback) {
	if (!getCurrentChatId() || !getChatById(getCurrentChatId())) {
		createNewChat(); renderChatList(); setActiveCallback?.();
	}
}

export function loadCurrentChat(setActiveCallback) {
	(async () => {
		const messages = document.getElementById('chatMessages');
		const empty = document.getElementById('chatEmpty');
		if (!messages) return;
		await SettingsStore.init();
		const activeChatId = getCurrentChatId();
		const chat = activeChatId ? await ensureChatLoaded(activeChatId) : null;
		const graph = chat ? ensureGraph(chat) : null;
		const hasMessages = Boolean(graph && computeThreadNodeIds(graph).length > 0);
		if (empty) empty.hidden = hasMessages;
		if (chat) renderThread(messages, chat, { editingNodeId: null, editingDraft: '' }, SettingsStore.get());
		else messages.querySelectorAll('.chat-message-group, .chat-message, .chat-typing').forEach((el) => el.remove());
		document.querySelector('.chat-page')?._syncToolPackPicker?.();
		renderChatList();
		setActiveCallback?.();
	})().catch((err) => {
		console.error('[ChatPage] Failed to load current chat:', err);
	});
}

async function initChatPage(root, currentRouteGetter, setActiveCallback) {
	if (!root) return;
	chatPageAbort?.abort();
	const controller = new AbortController();
	chatPageAbort = controller;
	const { signal } = controller;

	const form     = root.querySelector('#chatForm');
	const input    = root.querySelector('#chatInput');
	const messages = root.querySelector('#chatMessages');
	const empty    = root.querySelector('#chatEmpty');
	if (!form || !input || !messages) return;
	root._modelPickerPopulated = false;
	seedChatPageShell(root, currentRouteGetter);
	await SettingsStore.init();

	const attachmentManager = new InlineAttachmentManager(input);

	const uiState = createChatSessionState();
	const approvalPanel = root.querySelector('#toolApprovalPanel');
	let pendingApprovals = [];
	const resolvingApprovalIds = new Set();

	const formatToolApprovalName = (approval) => String(
		approval?.title ||
		approval?.name ||
		approval?.toolName ||
		approval?.canonicalId ||
		'Tool'
	).replace(/__/g, ' › ').replace(/_/g, ' ');

	const formatApprovalInput = (approval) => {
		const value = approval?.input ?? approval?.arguments ?? {};
		if (value && typeof value === 'object') {
			try { return JSON.stringify(value, null, 2); } catch {}
		}
		return String(value ?? '');
	};

	const extractPendingApprovals = (toolCalls = []) => {
		if (!Array.isArray(toolCalls)) return [];
		const seen = new Set();
		const approvals = [];
		for (const toolCall of toolCalls) {
			const approval = toolCall?.approval;
			const approvalId = approval?.id;
			const toolStatus = String(toolCall?.status || '').toLowerCase();
			if (toolStatus && toolStatus !== 'waiting_approval') continue;
			if (!approvalId || approval?.status !== 'pending' || seen.has(approvalId)) continue;
			seen.add(approvalId);
			approvals.push({
				id: approvalId,
				title: toolCall.title || approval.title || toolCall.name || approval.toolName || '',
				name: toolCall.name || approval.toolName || '',
				canonicalId: toolCall.canonicalId || approval.canonicalToolId || '',
				executor: toolCall.executor || approval.executor || '',
				riskTier: toolCall.riskTier || approval.riskTier || '',
				status: toolCall.status || 'waiting_approval',
				input: toolCall.input ?? toolCall.arguments ?? approval.input ?? {},
			});
		}
		return approvals;
	};

	const renderApprovalPanel = () => {
		if (!approvalPanel) return;
		approvalPanel.innerHTML = '';
		if (pendingApprovals.length === 0) {
			approvalPanel.hidden = true;
			return;
		}

		approvalPanel.hidden = false;
		for (const approval of pendingApprovals) {
			const card = document.createElement('div');
			card.className = 'tool-approval-card';

			const header = document.createElement('div');
			header.className = 'tool-approval-header';

			const titleWrap = document.createElement('div');
			titleWrap.className = 'tool-approval-title';

			const label = document.createElement('div');
			label.className = 'tool-approval-label';
			label.textContent = 'Tool approval';

			const name = document.createElement('div');
			name.className = 'tool-approval-name';
			name.textContent = formatToolApprovalName(approval);

			const meta = document.createElement('div');
			meta.className = 'tool-approval-meta';
			const metaBits = [
				approval.status ? String(approval.status).replace(/_/g, ' ') : '',
				approval.executor || '',
				approval.riskTier || '',
				approval.canonicalId || '',
			].filter(Boolean);
			meta.textContent = metaBits.join(' • ');
			titleWrap.append(label, name, meta);

			const actions = document.createElement('div');
			actions.className = 'tool-approval-actions';

			const approveBtn = document.createElement('button');
			approveBtn.type = 'button';
			approveBtn.className = 'btn btn-primary';
			approveBtn.dataset.approvalAction = 'approve';
			approveBtn.dataset.approvalId = approval.id;
			approveBtn.textContent = resolvingApprovalIds.has(approval.id) ? 'Approving...' : 'Approve';
			approveBtn.disabled = resolvingApprovalIds.has(approval.id);

			const denyBtn = document.createElement('button');
			denyBtn.type = 'button';
			denyBtn.className = 'btn';
			denyBtn.dataset.approvalAction = 'deny';
			denyBtn.dataset.approvalId = approval.id;
			denyBtn.textContent = resolvingApprovalIds.has(approval.id) ? 'Resolving...' : 'Deny';
			denyBtn.disabled = resolvingApprovalIds.has(approval.id);

			actions.append(approveBtn, denyBtn);
			header.append(titleWrap, actions);

			const details = document.createElement('details');
			details.className = 'tool-approval-details';
			details.open = true;
			const summary = document.createElement('summary');
			summary.textContent = 'Arguments';
			const args = document.createElement('pre');
			args.className = 'tool-approval-args';
			args.textContent = formatApprovalInput(approval);
			details.append(summary, args);

			card.append(header, details);
			approvalPanel.appendChild(card);
		}
	};

	const updateApprovalPanelFromToolCalls = (toolCalls = []) => {
		pendingApprovals = extractPendingApprovals(toolCalls);
		for (const id of [...resolvingApprovalIds]) {
			if (!pendingApprovals.some((approval) => approval.id === id)) {
				resolvingApprovalIds.delete(id);
			}
		}
		renderApprovalPanel();
	};

	const clearApprovalPanel = () => {
		pendingApprovals = [];
		resolvingApprovalIds.clear();
		renderApprovalPanel();
	};

	const handleApprovalAction = async (button) => {
		const approvalId = button?.dataset?.approvalId;
		const action = button?.dataset?.approvalAction;
		if (!approvalId || !action || resolvingApprovalIds.has(approvalId)) return;
		resolvingApprovalIds.add(approvalId);
		renderApprovalPanel();

		try {
			if (action === 'approve') await approveToolApproval(approvalId);
			else await denyToolApproval(approvalId);
			pendingApprovals = pendingApprovals.filter((approval) => approval.id !== approvalId);
			renderApprovalPanel();
		} catch (err) {
			console.error('[ChatPage] Tool approval action failed:', err);
			resolvingApprovalIds.delete(approvalId);
			renderApprovalPanel();
		}
	};

	const showConfirmationDialog = ({ title, message, confirmLabel = 'Confirm', confirmClassName = 'btn-primary' }) => (
		new Promise((resolve) => {
			const overlay = document.createElement('div');
			overlay.className = 'modal-overlay';

			const dialog = document.createElement('div');
			dialog.className = 'modal-dialog';
			dialog.setAttribute('role', 'dialog');
			dialog.setAttribute('aria-modal', 'true');

			const titleEl = document.createElement('h3');
			titleEl.className = 'modal-title';
			titleEl.textContent = title;
			const messageEl = document.createElement('p');
			messageEl.className = 'modal-message';
			messageEl.textContent = message;

			const actions = document.createElement('div');
			actions.className = 'modal-actions';
			const cancelBtn = document.createElement('button');
			cancelBtn.type = 'button';
			cancelBtn.className = 'btn modal-cancel';
			cancelBtn.textContent = 'Cancel';
			const confirmBtn = document.createElement('button');
			confirmBtn.type = 'button';
			confirmBtn.className = `btn modal-confirm ${confirmClassName}`;
			confirmBtn.textContent = confirmLabel;
			actions.append(cancelBtn, confirmBtn);
			dialog.append(titleEl, messageEl, actions);
			overlay.appendChild(dialog);
			document.body.appendChild(overlay);

			let settled = false;
			const close = (confirmed) => {
				if (settled) return;
				settled = true;
				overlay.remove();
				resolve(Boolean(confirmed));
			};

			cancelBtn.addEventListener('click', () => close(false));
			confirmBtn.addEventListener('click', () => close(true));
			overlay.addEventListener('click', (event) => {
				if (event.target === overlay) close(false);
			});
			dialog.addEventListener('keydown', (event) => {
				if (event.key === 'Escape') {
					event.preventDefault();
					close(false);
				}
			});

			requestAnimationFrame(() => {
				overlay.classList.add('visible');
				cancelBtn.focus();
			});
		})
	);

	const handleMessageFileEditRollback = async (node, button) => {
		const rollbacks = getMessageFileEditRollbacks(node);
		if (!rollbacks.length || !button || button.disabled) return;

		const plural = rollbacks.length === 1 ? '' : 's';
		const confirmed = await showConfirmationDialog({
			title: 'Roll Back File Edits?',
			message: `This will restore ${rollbacks.length} file edit${plural} from this message. Later changes to those files may be overwritten.`,
			confirmLabel: 'Roll Back',
			confirmClassName: 'btn-danger',
		});
		if (!confirmed) return;

		const previousHtml = button.innerHTML;
		const previousTitle = button.title;
		button.disabled = true;
		button.dataset.rollbackState = 'running';
		button.title = 'Rolling back file edits...';
		button.setAttribute('aria-label', 'Rolling back file edits');

		try {
			for (const rollback of [...rollbacks].reverse()) {
				await rollbackFileEdit({
					checkpoint_id: rollback.checkpointId,
					workspace_directory: rollback.workspaceDirectory,
					path: rollback.path,
				});
			}

			node.fileEditsRolledBackAt = Date.now();
			node.fileEditsRolledBackCount = rollbacks.length;
			const chat = getCurrentChatId() ? getChatById(getCurrentChatId()) : null;
			if (chat) {
				chat.updatedAt = Date.now();
				saveChats();
			}

			button.dataset.rollbackState = 'done';
			button.title = `Rolled back ${rollbacks.length} file edit${plural}`;
			button.setAttribute('aria-label', 'File edits rolled back');
		} catch (err) {
			console.error('[ChatPage] Message file edit rollback failed:', err);
			button.dataset.rollbackState = 'failed';
			button.disabled = false;
			button.innerHTML = previousHtml;
			button.title = err?.message ? `Rollback failed: ${err.message}` : previousTitle;
			button.setAttribute('aria-label', `Roll back ${rollbacks.length} file edit${plural} from this message`);
		}
	};

	const contentEl = messages.closest('.content') || messages;
	const scrollToBottomBtn = root.querySelector('#scrollToBottomBtn');

	let lastScrollTop = contentEl.scrollTop;
	let lastScrollSampleAt = 0;
	let recentScrollTravelPx = 0;
	let scrollRefreshFrame = 0;
	let nudgePlacementFrame = 0;
	let pendingNudgePlacementAnimation = false;
	const nudgePlacementAnimations = new WeakMap();
	const nudgePlacementAnimationMs = 180;
	const compactToolbarAnimationMs = 180;
	const getMaxScrollTop = () => Math.max(0, contentEl.scrollHeight - contentEl.clientHeight);
	const nowMs = () => window.performance?.now?.() ?? Date.now();

	const prefersReducedMotion = () => {
		try {
			return window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true;
		} catch {
			return false;
		}
	};

	const stopMessageNudgePlacementAnimation = (groupEl) => {
		const cleanup = nudgePlacementAnimations.get(groupEl);
		if (cleanup) cleanup();
	};

	const getNextMessageGroup = (groupEl) => {
		let nextEl = groupEl?.nextElementSibling || null;
		while (nextEl && !nextEl.matches?.('.chat-message-group[data-node-id]')) {
			nextEl = nextEl.nextElementSibling;
		}
		return nextEl;
	};

	const getRecentScrollTravel = () => {
		return nowMs() - lastScrollSampleAt <= 140 ? recentScrollTravelPx : 0;
	};

	const getMessageNudgePlacementAnimationMs = (groupEl, nudgeHeight) => {
		if (getNextMessageGroup(groupEl)) return nudgePlacementAnimationMs;

		const scrollBottom = Math.max(0, getMaxScrollTop() - contentEl.scrollTop);
		const recentTravel = getRecentScrollTravel();
		const edgeTravel = recentTravel > 0 && scrollBottom > 0
			? Math.min(recentTravel, scrollBottom)
			: recentTravel || scrollBottom;
		if (edgeTravel <= 0) return Math.round(nudgePlacementAnimationMs * 0.55);

		const fullTravel = Math.max(48, nudgeHeight * 1.75);
		const ratio = Math.max(0, Math.min(1, edgeTravel / fullTravel));
		return Math.round(90 + (nudgePlacementAnimationMs - 90) * ratio);
	};

	const animateMessageNudgePlacement = (groupEl, messageEl, nudgeEl, shouldMoveTop, nudgeHeight, durationMs) => {
		const height = Math.max(0, Number(nudgeHeight) || 0);
		if (height <= 0) return;

		const duration = Math.max(80, Math.min(nudgePlacementAnimationMs, Number(durationMs) || nudgePlacementAnimationMs));
		const messageStartY = shouldMoveTop ? -height : height;
		const nudgeStartY = shouldMoveTop ? height : -height;
		const transformTransition = `transform ${duration}ms cubic-bezier(0.2, 0, 0, 1)`;
		const nudgeTransition = `${transformTransition}, opacity ${Math.min(140, duration)}ms ease`;
		let frameId = 0;
		let timeoutId = 0;
		let cleaned = false;

		const cleanup = () => {
			if (cleaned) return;
			cleaned = true;
			if (frameId) cancelAnimationFrame(frameId);
			if (timeoutId) window.clearTimeout(timeoutId);
			groupEl.classList.remove('nudge-placement-animating');
			messageEl.style.transition = '';
			messageEl.style.transform = '';
			nudgeEl.style.transition = '';
			nudgeEl.style.transform = '';
			nudgeEl.style.opacity = '';
			if (nudgePlacementAnimations.get(groupEl) === cleanup) {
				nudgePlacementAnimations.delete(groupEl);
			}
		};

		nudgePlacementAnimations.set(groupEl, cleanup);
		groupEl.classList.add('nudge-placement-animating');
		messageEl.style.transition = 'none';
		messageEl.style.transform = `translate3d(0, ${messageStartY}px, 0)`;
		nudgeEl.style.transition = 'none';
		nudgeEl.style.transform = `translate3d(0, ${nudgeStartY}px, 0)`;
		nudgeEl.style.opacity = '0';

		messageEl.getBoundingClientRect();
		frameId = requestAnimationFrame(() => {
			frameId = 0;
			messageEl.style.transition = transformTransition;
			nudgeEl.style.transition = nudgeTransition;
			messageEl.style.transform = 'translate3d(0, 0, 0)';
			nudgeEl.style.transform = 'translate3d(0, 0, 0)';
			nudgeEl.style.opacity = '1';
			timeoutId = window.setTimeout(cleanup, duration + 40);
		});
	};

	const setMessageNudgePlacement = (groupEl, shouldMoveTop, { animate = true } = {}) => {
		const currentlyTop = groupEl.classList.contains('nudge-top');
		if (currentlyTop === shouldMoveTop) return;

		const messageEl = groupEl.querySelector(':scope > .chat-message');
		const nudgeEl = groupEl.querySelector(':scope > .chat-message-nudge');
		const canAnimate = animate && messageEl && nudgeEl && !prefersReducedMotion();
		const nudgeHeight = canAnimate ? nudgeEl.getBoundingClientRect().height : 0;

		stopMessageNudgePlacementAnimation(groupEl);
		groupEl.classList.toggle('nudge-top', shouldMoveTop);

		if (canAnimate) {
			animateMessageNudgePlacement(
				groupEl,
				messageEl,
				nudgeEl,
				shouldMoveTop,
				nudgeHeight,
				getMessageNudgePlacementAnimationMs(groupEl, nudgeHeight)
			);
		}
	};

	const refreshMessageNudgePlacement = ({ animate = false } = {}) => {
		const viewportRect = contentEl.getBoundingClientRect();
		let visibleTop = viewportRect.top;
		let visibleBottom = viewportRect.bottom;
		const formRect = form.getBoundingClientRect();
		const formOverlapsViewport = formRect.top < visibleBottom && formRect.bottom > visibleTop;
		if (formOverlapsViewport) {
			visibleBottom = Math.min(visibleBottom, Math.max(visibleTop, formRect.top));
		}

		const visibleHeight = visibleBottom - visibleTop;
		if (!Number.isFinite(visibleHeight) || visibleHeight <= 0) return;

		const enterTopOffset = 8;
		const exitTopOffset = 48;

		for (const groupEl of messages.querySelectorAll('.chat-message-group[data-node-id]')) {
			const rect = groupEl.getBoundingClientRect();
			const intersectsVisibleArea = rect.bottom > visibleTop && rect.top < visibleBottom;
			if (!intersectsVisibleArea) {
				setMessageNudgePlacement(groupEl, false, { animate: false });
				continue;
			}

			const nudgeEl = groupEl.querySelector(':scope > .chat-message-nudge');
			const nudgeHeight = nudgeEl?.getBoundingClientRect().height || 30;
			const bottomNudgeBottom = rect.bottom;
			const bottomNudgeTop = bottomNudgeBottom - nudgeHeight;
			const longerThanVisibleArea = rect.height > visibleHeight + 1;
			const bottomNudgeIsVisible = bottomNudgeTop >= visibleTop && bottomNudgeBottom <= visibleBottom;
			const currentlyTop = groupEl.classList.contains('nudge-top');
			const bottomNudgeIsObscured = bottomNudgeBottom > visibleBottom - enterTopOffset;
			const bottomNudgeIsComfortablyVisible = bottomNudgeBottom <= visibleBottom - exitTopOffset;
			const shouldMoveTop = currentlyTop
				? !bottomNudgeIsComfortablyVisible
				: bottomNudgeIsObscured && (longerThanVisibleArea || !bottomNudgeIsVisible);

			setMessageNudgePlacement(groupEl, shouldMoveTop, { animate });
		}
	};
	const scheduleMessageNudgePlacementRefresh = ({ animate = false } = {}) => {
		pendingNudgePlacementAnimation = pendingNudgePlacementAnimation || Boolean(animate);
		if (nudgePlacementFrame) return;
		nudgePlacementFrame = requestAnimationFrame(() => {
			nudgePlacementFrame = 0;
			const shouldAnimate = pendingNudgePlacementAnimation;
			pendingNudgePlacementAnimation = false;
			refreshMessageNudgePlacement({ animate: shouldAnimate });
		});
	};
	const setScrolledUp = (isScrolledUp) => {
		uiState.isScrolledUp = Boolean(isScrolledUp);
		scrollToBottomBtn?.classList.toggle('visible', uiState.isScrolledUp);
	};
	const checkScroll = () => {
		const currentScrollTop = contentEl.scrollTop;
		const scrollBottom = getMaxScrollTop() - currentScrollTop;
		const scrollDelta = currentScrollTop - lastScrollTop;
		if (scrollDelta !== 0) {
			const now = nowMs();
			if (now - lastScrollSampleAt > 140) {
				recentScrollTravelPx = 0;
			}
			recentScrollTravelPx = Math.min(240, recentScrollTravelPx + Math.abs(scrollDelta));
			lastScrollSampleAt = now;
		}
		
		if (scrollBottom <= 10) {
			setScrolledUp(false);
		} else if (currentScrollTop < lastScrollTop) {
			setScrolledUp(true);
		}
		
		lastScrollTop = currentScrollTop;
	};

	const scheduleScrollStateRefresh = () => {
		if (scrollRefreshFrame) return;
		scrollRefreshFrame = requestAnimationFrame(() => {
			scrollRefreshFrame = 0;
			const maxScrollTop = getMaxScrollTop();
			if (!uiState.isScrolledUp) {
				contentEl.scrollTop = maxScrollTop;
			} else if (contentEl.scrollTop > maxScrollTop) {
				contentEl.scrollTop = maxScrollTop;
			}
			checkScroll();
			refreshMessageNudgePlacement({ animate: false });
		});
	};

	contentEl.addEventListener('scroll', checkScroll, { signal });
	contentEl.addEventListener('scroll', () => {
		scheduleMessageNudgePlacementRefresh({ animate: true });
	}, { signal, passive: true });
	window.addEventListener('resize', () => {
		if (!uiState.isScrolledUp) {
			contentEl.scrollTop = getMaxScrollTop();
		}
		checkScroll();
		scheduleMessageNudgePlacementRefresh({ animate: false });
	}, { signal });

	if (scrollToBottomBtn) {
		scrollToBottomBtn.addEventListener('click', () => {
			setScrolledUp(false);
			contentEl.scrollTo({
				top: getMaxScrollTop(),
				behavior: 'smooth'
			});
			scheduleScrollStateRefresh();
		}, { signal });
	}

	if (typeof ResizeObserver !== 'undefined') {
		const scrollResizeObserver = new ResizeObserver(scheduleScrollStateRefresh);
		scrollResizeObserver.observe(messages);
		scrollResizeObserver.observe(form);
		signal.addEventListener('abort', () => scrollResizeObserver.disconnect(), { once: true });
	}
	signal.addEventListener('abort', () => {
		if (nudgePlacementFrame) cancelAnimationFrame(nudgePlacementFrame);
		nudgePlacementFrame = 0;
	}, { once: true });

	const buildContextCountPayload = () => {
		const settings = SettingsStore.get();
		const activeChatId = getCurrentChatId();
		const chat = activeChatId ? getChatById(activeChatId) : null;
		const chatLoaded = isChatLoaded(chat);
		const modelSelect = root.querySelector('[data-dropdown="model"] .chat-dropdown-item.selected');
		const model = modelSelect?.dataset?.value
			|| resolvePreferredModelId(activeChatId)
			|| '';
		const contextInfo = getModelContextInfoFromUI(root);
		let toolScope = getActiveToolScope(activeChatId);
		const revisionMode = settings?.chatResponseMode === 'live';
		const effectiveNodes = [];
		let draftResearchPart = null;

		if (chatLoaded) {
			const graph = ensureGraph(chat);
			const threadIds = computeThreadNodeIds(graph);
			for (const nodeId of threadIds) {
				const node = getNode(graph, nodeId);
				if (!node || (node.role !== 'user' && node.role !== 'assistant')) continue;

				if (uiState.editingNodeId === node.id && uiState.editingMode === 'research-tasks') {
					const researchPart = getEditableResearchPart(node);
					const editedResearchPart = researchPart
						? buildResearchPartWithEditedTasks(researchPart, uiState.editingDraft)
						: null;
					effectiveNodes.push({
						...node,
						research: editedResearchPart || node.research,
						parts: editedResearchPart ? buildPartsWithResearchPart(node.parts, editedResearchPart) : node.parts,
					});
				} else if (uiState.editingNodeId === node.id) {
					const assistantDraft = node.role === 'assistant'
						? parseAssistantEditDraft(uiState.editingDraft)
						: null;
					if (assistantDraft) {
						effectiveNodes.push({
							...node,
							content: assistantDraft.content,
							reasoning: assistantDraft.reasoning,
							parts: assistantDraft.parts,
							reasoningParts: [],
						});
					} else {
						effectiveNodes.push({
							...node,
							content: uiState.editingDraft,
							parts: node.role === 'assistant'
								? undefined
								: buildPartsWithUpdatedText(node, uiState.editingDraft),
							reasoning: node.role === 'assistant' ? '' : node.reasoning,
							reasoningParts: node.role === 'assistant' ? [] : node.reasoningParts,
						});
					}
				} else {
					effectiveNodes.push(node);
				}
			}
		}

		if (!uiState.editingNodeId) {
			const draftParts = attachmentManager.extractParts();
			const draftText = draftParts
				.filter((part) => part?.type === 'text')
				.map((part) => String(part.content || ''))
				.join('')
				.trim();
			if (isResearchEnabled(root) && draftText) {
				draftResearchPart = buildResearchPart(root, draftText);
			}
			if (draftParts?.length > 0) {
				effectiveNodes.push({ role: 'user', parts: draftParts });
			}
		}

		if (uiState.isGenerating && uiState.liveGeneratingNode) {
			effectiveNodes.push(uiState.liveGeneratingNode);
		}

		const messages = buildApiMessagesFromNodes(effectiveNodes, settings);
		let systemPrompt = buildSystemPromptForMessages(messages, settings);
		if (draftResearchPart) {
			systemPrompt = buildResearchSystemPrompt(systemPrompt, draftResearchPart);
		}
		return {
			model,
			messages,
			systemPrompt,
			toolScope,
			revisionMode,
			estimatedUsedTokens: estimatePreparedMessagesTokens(messages, systemPrompt),
			contextLimit: contextInfo.contextLimit,
			contextLimitKnown: contextInfo.isKnown,
			chatLoaded,
		};
	};

	let contextCountTimer = null;
	let contextCountAbort = null;
	let contextCountRequestId = 0;
	let contextCountScheduledKey = '';
	let contextCountPendingKey = '';
	let lastRenderedContextScope = {
		chatId: '',
		model: '',
		cacheKey: '',
		scopeSignature: '',
		exactCountUnavailable: false,
	};

	const clearScheduledContextCount = () => {
		if (contextCountTimer) {
			clearTimeout(contextCountTimer);
			contextCountTimer = null;
		}
		contextCountScheduledKey = '';
	};

	const abortPendingContextCount = () => {
		if (contextCountAbort) {
			contextCountAbort.abort();
			contextCountAbort = null;
		}
		contextCountPendingKey = '';
	};

	const getDisplayScopeKey = (chatId, model) => `${chatId || ''}::${model || ''}`;

	const readDisplayedUsedTokens = () => {
		const usedTokens = Number.parseInt(root?.querySelector?.('#chatContext')?.dataset?.usedTokens ?? '', 10);
		return Number.isFinite(usedTokens) && usedTokens >= 0 ? usedTokens : null;
	};

	const recordRenderedContextScope = ({
		chatId,
		model,
		cacheKey = '',
		scopeSignature = '',
		exactCountUnavailable = false,
	} = {}) => {
		lastRenderedContextScope = {
			chatId: chatId || '',
			model: model || '',
			cacheKey: cacheKey || '',
			scopeSignature: scopeSignature || '',
			exactCountUnavailable: exactCountUnavailable === true,
		};
	};

	const shouldShowUnknownContextWarning = () => root?._modelPickerPopulated === true;

	const updateLiveContext = (delayMs = 120) => {
		const activeChatId = getCurrentChatId();
		const payload = buildContextCountPayload();
		const {
			model,
			messages: apiMessages,
			systemPrompt,
			toolScope,
			revisionMode,
			estimatedUsedTokens,
			contextLimit,
			contextLimitKnown,
			chatLoaded,
		} = payload;
		const cacheKey = buildContextCountCacheKey({
			model,
			messages: apiMessages,
			systemPrompt,
			toolScope,
			revisionMode,
		});
		const scopeSignature = buildContextScopeSignature({
			model,
			systemPrompt,
			toolScope,
			revisionMode,
		});
		const cachedIndicator = getCachedContextIndicator({ chatId: activeChatId, model });
		const staleTokens = getCachedScopeContextCount({ chatId: activeChatId, model });
		const displayedUsedTokens = readDisplayedUsedTokens();
		const canReuseScopeTokens = (
			getDisplayScopeKey(lastRenderedContextScope.chatId, lastRenderedContextScope.model)
			=== getDisplayScopeKey(activeChatId, model)
			&& lastRenderedContextScope.scopeSignature === scopeSignature
		) && lastRenderedContextScope.exactCountUnavailable !== true;
		const canReuseDisplayedTokens = canReuseScopeTokens
			&& Number.isFinite(displayedUsedTokens);
		const fallbackUsedTokens = canReuseDisplayedTokens
			? displayedUsedTokens
			: canReuseScopeTokens && Number.isFinite(staleTokens)
			? staleTokens
			: Number.isFinite(estimatedUsedTokens)
			? estimatedUsedTokens
			: Number.isFinite(cachedIndicator?.usedTokens)
				? cachedIndicator.usedTokens
				: 0;
		const fallbackContextLimit = Number.isFinite(cachedIndicator?.contextLimit) && cachedIndicator.contextLimit > 0
			? cachedIndicator.contextLimit
			: contextLimit;
		let exactCountUnavailable = cachedIndicator?.scope === 'model' && cachedIndicator.exactCountUnavailable === true;
		let resolvedContextLimitKnown = Boolean(
			contextLimitKnown || (cachedIndicator?.scope === 'model' && cachedIndicator.contextLimitKnown === true)
		);

		const renderContextIndicator = (
			usedTokens,
			nextContextLimit = contextLimit,
			{
				nextExactCountUnavailable = exactCountUnavailable,
				nextContextLimitKnown = resolvedContextLimitKnown,
				persistIndicator = true,
			} = {},
		) => {
			exactCountUnavailable = nextExactCountUnavailable === true;
			resolvedContextLimitKnown = nextContextLimitKnown === true;
			const resolvedContextLimit = Number.isFinite(nextContextLimit) && nextContextLimit > 0
				? nextContextLimit
				: fallbackContextLimit;
			if (persistIndicator && activeChatId && model) {
				rememberContextIndicator({
					chatId: activeChatId,
					model,
					usedTokens,
					contextLimit: resolvedContextLimit,
					exactCountUnavailable,
					contextLimitKnown: resolvedContextLimitKnown,
				});
			}
			updateContextUI(root, {
				usedTokens,
				contextLimit: resolvedContextLimit,
				contextLimitKnown: resolvedContextLimitKnown,
				exactCountUnavailable,
				showUnknownContextWarning: shouldShowUnknownContextWarning(),
			});
			recordRenderedContextScope({
				chatId: activeChatId,
				model,
				cacheKey,
				scopeSignature,
				exactCountUnavailable,
			});
		};

		if (!model) {
			clearScheduledContextCount();
			abortPendingContextCount();
			updateContextUI(root, {
				usedTokens: fallbackUsedTokens,
				contextLimit: fallbackContextLimit,
				contextLimitKnown: false,
				exactCountUnavailable: false,
				showUnknownContextWarning: shouldShowUnknownContextWarning(),
			});
			recordRenderedContextScope({ chatId: activeChatId, model: '', exactCountUnavailable: false });
			return;
		}
		if (activeChatId && !chatLoaded) {
			clearScheduledContextCount();
			abortPendingContextCount();
			renderContextIndicator(fallbackUsedTokens, fallbackContextLimit, { persistIndicator: false });
			return;
		}
		if (!systemPrompt &&
			apiMessages.length === 0 &&
			!hasToolContextForCount(toolScope, revisionMode)) {
			clearScheduledContextCount();
			abortPendingContextCount();
			setCachedContextCount(cacheKey, 0);
			rememberExactContextCount({ chatId: activeChatId, model, usedTokens: 0 });
			renderContextIndicator(0, contextLimit, {
				nextExactCountUnavailable: false,
				nextContextLimitKnown: contextLimitKnown,
			});
			return;
		}

		const cachedTokens = getCachedContextCount(cacheKey);
		if (Number.isFinite(cachedTokens)) {
			clearScheduledContextCount();
			if (contextCountPendingKey && contextCountPendingKey !== cacheKey) {
				abortPendingContextCount();
			}
			rememberExactContextCount({ chatId: activeChatId, model, usedTokens: cachedTokens });
			renderContextIndicator(cachedTokens, contextLimit, {
				nextExactCountUnavailable: false,
				nextContextLimitKnown: contextLimitKnown,
			});
			return;
		}

		if (contextCountScheduledKey === cacheKey || contextCountPendingKey === cacheKey) {
			renderContextIndicator(fallbackUsedTokens, fallbackContextLimit, { persistIndicator: false });
			return;
		}

		clearScheduledContextCount();
		abortPendingContextCount();
		renderContextIndicator(fallbackUsedTokens, fallbackContextLimit, { persistIndicator: false });

		const requestId = ++contextCountRequestId;
		contextCountScheduledKey = cacheKey;
		contextCountTimer = setTimeout(async () => {
			contextCountTimer = null;
			contextCountScheduledKey = '';
			const abortController = new AbortController();
			contextCountAbort = abortController;
			contextCountPendingKey = cacheKey;
			try {
				const result = await fetchExactContextCount({
					model,
					messages: apiMessages,
					systemPrompt,
					chatId: activeChatId,
					toolScope,
					revisionMode,
				}, { signal: abortController.signal });

				if (signal.aborted || requestId !== contextCountRequestId) return;
				const promptTokens = Number.parseInt(result?.prompt_tokens, 10);
				if (Number.isFinite(promptTokens) && promptTokens >= 0) {
					renderContextIndicator(promptTokens, contextLimit, {
						nextExactCountUnavailable: false,
						nextContextLimitKnown: contextLimitKnown,
					});
					return;
				}
				console.error('[ChatPage] Exact token count response did not include prompt_tokens:', result);
				renderContextIndicator(fallbackUsedTokens, fallbackContextLimit, {
					nextExactCountUnavailable: true,
					nextContextLimitKnown: contextLimitKnown,
				});
			} catch (err) {
				if (abortController.signal.aborted || err?.name === 'AbortError') return;
				if (signal.aborted || requestId !== contextCountRequestId) return;
				console.error('[ChatPage] Exact token count failed:', err);
				renderContextIndicator(fallbackUsedTokens, fallbackContextLimit, {
					nextExactCountUnavailable: true,
					nextContextLimitKnown: contextLimitKnown,
				});
			} finally {
				if (contextCountAbort === abortController) {
					contextCountAbort = null;
				}
				if (contextCountPendingKey === cacheKey) {
					contextCountPendingKey = '';
				}
			}
		}, Math.max(0, delayMs));
	};
	root._updateLiveContext = () => updateLiveContext(120);

	signal.addEventListener('abort', () => {
		clearScheduledContextCount();
		abortPendingContextCount();
	}, { once: true });

	loadAndPopulateModels(root, signal).catch((err) => {
		console.error('Failed to populate models:', err);
	});
	initDropdowns(root, signal);
	initTools(root, signal);
	initUpload(root, input, attachmentManager, signal);
	const researchToggle = root.querySelector('#chatResearchToggle');
	const syncResearchComposerState = () => {
		const enabled = isResearchEnabled(root);
		setResearchEnabled(root, enabled);
		root._updateLiveContext?.();
	};
	setResearchEnabled(root, false);
	researchToggle?.addEventListener('click', (event) => {
		event.preventDefault();
		event.stopPropagation();
		setResearchEnabled(root, !isResearchEnabled(root));
		syncResearchComposerState();
	}, { capture: true, signal });
	syncResearchComposerState();
	const resizeInput = initAutoResize(input, signal);
	input.addEventListener('input', () => updateLiveContext(120), { signal });
	approvalPanel?.addEventListener('click', (e) => {
		const approvalBtn = e.target.closest('[data-approval-action][data-approval-id]');
		if (!approvalBtn) return;
		handleApprovalAction(approvalBtn);
	}, { signal });
	// Show initial context UI (includes system prompt tokens)
	updateLiveContext(0);
	input.addEventListener('keydown', (e) => {
		if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
			e.preventDefault();
			// Block during generation — no canceling
			if (uiState.isGenerating) return;
			// Debounce: prevent rapid-fire duplicate submissions
			if (uiState.isSubmitting) return;
			if (e.shiftKey) form.dataset.sendNoReply = '1';
			form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
		}
	}, { signal });

	const urlParams = new URLSearchParams(location.hash.split('?')[1] || '');
	const chatIdFromUrl = urlParams.get('chat');
	if (chatIdFromUrl && getChatById(chatIdFromUrl)) { setCurrentChatId(chatIdFromUrl); }
	if (getCurrentChatId()) {
		try {
			await ensureChatLoaded(getCurrentChatId());
		} catch (err) {
			console.error('[ChatPage] Failed to load chat:', err);
		}
	}

	const rerender = () => {
		const chat = getCurrentChatId() ? getChatById(getCurrentChatId()) : null;
		if (!chat || !isChatLoaded(chat)) {
			messages.querySelectorAll('.chat-message-group, .chat-message, .chat-typing').forEach(el => el.remove());
			if (empty) empty.hidden = false;
			root._syncToolPackPicker?.();
			updateLiveContext(0);
			scheduleMessageNudgePlacementRefresh();
			return;
		}
		renderThread(messages, chat, { editingNodeId: uiState.editingNodeId, editingDraft: uiState.editingDraft }, SettingsStore.get());
		if (empty) empty.hidden = computeThreadNodeIds(ensureGraph(chat)).length > 0;
		root._syncToolPackPicker?.();
		updateLiveContext(0);
		scheduleMessageNudgePlacementRefresh();
	};

	const unsubscribeSettings = SettingsStore.subscribe(() => {
		if (signal.aborted) return;
		if (uiState.isGenerating || uiState.isSubmitting) return;
		rerender();
	});
	signal.addEventListener('abort', unsubscribeSettings, { once: true });

	const setGeneratingState = (gen) => {
		uiState.isGenerating = gen;
		if (!gen) uiState.liveGeneratingNode = null;
		const btn = form.querySelector('.chat-send-btn');
		if (!btn) return;
		if (gen) {
			btn.classList.add('generating');
			btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-square-icon lucide-square" aria-hidden="true"><rect width="18" height="18" x="3" y="3" rx="2"/></svg>`;
			btn.title = 'Stop generating'; btn.setAttribute('aria-label', 'Stop generating');
		} else {
			btn.classList.remove('generating');
			btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-send-horizontal-icon lucide-send-horizontal" aria-hidden="true"><path d="M3.714 3.048a.498.498 0 0 0-.683.627l2.843 7.627a2 2 0 0 1 0 1.396l-2.842 7.627a.498.498 0 0 0 .682.627l18-8.5a.5.5 0 0 0 0-.904z"/><path d="M6 12h16"/></svg>`;
			btn.title = 'Send'; btn.setAttribute('aria-label', 'Send message');
		}
	};

	const createTaskId = () => {
		const uuid = globalThis.crypto?.randomUUID?.();
		if (uuid) return `task_${uuid}`;
		return `task_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
	};

	const applyGeneratedResearchPlan = async (chatId, researchNodeId, query) => {
		let generatedPart;
		try {
			generatedPart = await buildGeneratedResearchPart(root, query, { signal });
		} catch (err) {
			if (signal.aborted || err?.name === 'AbortError') return;
			generatedPart = buildResearchPart(root, query);
		}
		if (signal.aborted) return;

		const chat = chatId ? getChatById(chatId) : null;
		const graph = chat ? ensureGraph(chat) : null;
		const node = graph ? getNode(graph, researchNodeId) : null;
		const currentPart = getNodeResearchPart(node);
		if (!chat || !graph || !node || currentPart?.status !== 'planning') return;

		const pendingPart = {
			...generatedPart,
			status: 'pending',
		};
		setNodeResearchPart(node, pendingPart);
		chat.updatedAt = Date.now();
		await saveChatAwaitable(chat.id).catch((err) => {
			console.error('[Chat] Failed to save generated research plan:', err);
		});
		rerender();
		renderChatList();
		setActiveCallback?.();
	};

	const addResearchPlanningNode = (chat, userNode, query) => {
		if (!chat || !userNode || !query) return null;
		const planningPart = buildResearchPlanningPart(root, query);
		const researchNode = addChildMessageToChat(
			chat.id,
			userNode.id,
			'assistant',
			'',
			null,
			buildPartsWithResearchPart([], planningPart),
		);
		if (researchNode?.id) {
			applyGeneratedResearchPlan(chat.id, researchNode.id, query);
		}
		return researchNode;
	};

	const createStreamController = (typingEl) => createStreamingMessageController({
		typingEl,
		getSettings: () => SettingsStore.get(),
		onLiveNodeChange: (node) => {
			uiState.liveGeneratingNode = node;
			updateApprovalPanelFromToolCalls(node.toolCalls);
			updateLiveContext(120);
		},
		afterRender: () => {
			if (!uiState.isScrolledUp) contentEl.scrollTop = getMaxScrollTop();
			else checkScroll();
			scheduleMessageNudgePlacementRefresh();
		},
	});

	const getAbortReason = (signalLike) => {
		if (!signalLike) return '';
		if (typeof signalLike.ctrlpanelReason === 'string' && signalLike.ctrlpanelReason) return signalLike.ctrlpanelReason;
		if (typeof signalLike.reason === 'string' && signalLike.reason) return signalLike.reason;
		return '';
	};

	const abortStreamController = (controllerToAbort, reason) => {
		if (!controllerToAbort?.signal || controllerToAbort.signal.aborted) return;
		controllerToAbort.signal.ctrlpanelReason = reason;
		controllerToAbort.abort(reason);
	};

	const detachFromRunningTask = () => {
		uiState.flushResponse = null;
		if (uiState.typingTimeout) {
			clearTimeout(uiState.typingTimeout);
			uiState.typingTimeout = null;
		}
		abortStreamController(uiState.streamAbort, 'detach');
		uiState.streamAbort = null;
		uiState.activeTaskId = null;
		uiState.liveGeneratingNode = null;
		uiState.typingEl = null;
		clearApprovalPanel();
		setGeneratingState(false);
	};

	const requestTaskCancellation = async ({ unload = false, abortStream = true, discardPartial = true } = {}) => {
		const taskId = uiState.activeTaskId;
		if (discardPartial) {
			uiState.flushResponse = null;
		}
		if (abortStream) abortStreamController(uiState.streamAbort, 'cancel-requested');
		if (!taskId) return false;
		try {
			await cancelTask(taskId, { unload });
			return true;
		} catch (err) {
			if (!unload) {
				console.error('[ChatPage] Failed to cancel task:', err);
			}
			return false;
		}
	};

	const stopTyping = (preserveElement = false) => {
		if (uiState.flushResponse)  { uiState.flushResponse(); uiState.flushResponse = null; }
		if (uiState.streamAbort)    { uiState.streamAbort.abort(); uiState.streamAbort = null; }
		if (uiState.typingTimeout)  { clearTimeout(uiState.typingTimeout); uiState.typingTimeout = null; }
		if (uiState.typingEl) {
			if (!preserveElement) {
				uiState.typingEl.remove();
				uiState.typingEl = null;
			}
			// When preserveElement is true, keep uiState.typingEl so finalizeGeneratedMessage can use it
		}
		clearApprovalPanel();
		setGeneratingState(false);
	};

	/**
	 * Smoothly finalize the preserved typing element into a proper message.
	 * Finds the newly generated node in the graph and patches the element
	 * with the correct node ID and menu, avoiding a full re-render flicker.
	 */
	const finalizeGeneratedMessage = () => {
		const preservedEl = uiState.typingEl;
		if (!preservedEl) return null;

		const chatId = getCurrentChatId();
		const chat = getChatById(chatId);
		if (!chat) return null;

		const graph = ensureGraph(chat);
		const threadIds = computeThreadNodeIds(graph);
		// The generated node is the last assistant node in the thread
		let generatedNode = null;
		for (let i = threadIds.length - 1; i >= 0; i--) {
			const node = getNode(graph, threadIds[i]);
			if (node && node.role === 'assistant') {
				generatedNode = node;
				break;
			}
		}
		if (!generatedNode) return null;

		// Patch the element with proper attributes
		preservedEl.dataset.nodeId = generatedNode.id;

		// Add the nudge row with timestamp and message actions.
		const nav = getSiblingNavState(graph, generatedNode.id);
		const canResend = Boolean(generatedNode.parentId) && generatedNode.role !== 'system';
		const nudge = buildMessageNudgeElement({
			node: generatedNode,
			settings: SettingsStore.get(),
			isEditing: false,
			canBranchBack: nav.canBack,
			canBranchForward: nav.canForward,
			canResend,
			showFullToolbar: true,
		});
		const content = preservedEl.querySelector(':scope > .chat-message-content');
		preservedEl.querySelector(':scope > .chat-message-nudge')?.remove();
		let group = preservedEl.closest('.chat-message-group');
		if (!group) {
			group = document.createElement('div');
			group.className = `chat-message-group ${generatedNode.role}`;
			group.dataset.nodeId = generatedNode.id;
			preservedEl.before(group);
			group.appendChild(preservedEl);
		}
		group.dataset.nodeId = generatedNode.id;
		group.className = `chat-message-group ${generatedNode.role}`;
		if (content) preservedEl.after(nudge);
		else group.appendChild(nudge);
		refreshRenderedMessageNudges(messages, graph, {
			editingNodeId: uiState.editingNodeId,
			editingDraft: uiState.editingDraft,
		}, SettingsStore.get());
		scheduleMessageNudgePlacementRefresh();

		// Clear the reference so stopTyping doesn't try to remove it
		uiState.typingEl = null;
		return preservedEl;
	};

	signal.addEventListener('abort', detachFromRunningTask);

	const startReply = async (replyChatId, parentUserNodeId) => {
		const pendingChat = replyChatId ? getChatById(replyChatId) : null;
		const pendingGraph = pendingChat ? ensureGraph(pendingChat) : null;
		const pendingParentNode = pendingGraph && parentUserNodeId ? getNode(pendingGraph, parentUserNodeId) : null;
		const parentResearchStatus = getNodeResearchPart(pendingParentNode)?.status;
		const childResearchStatus = getNodeResearchPart(getPendingResearchChild(pendingGraph, pendingParentNode))?.status;
		if (parentResearchStatus === 'pending' || parentResearchStatus === 'planning' ||
			childResearchStatus === 'pending' || childResearchStatus === 'planning') {
			return;
		}
		clearApprovalPanel();
		stopTyping();
		uiState.typingEl = showTyping(messages);
		checkScroll();
		setGeneratingState(true);

		const activeChatId    = replyChatId;
		uiState.streamAbort   = new AbortController();
		const currentSignal   = uiState.streamAbort.signal;
		let taskId            = createTaskId();
		uiState.activeTaskId  = taskId;

		const modelSelect = root.querySelector('[data-dropdown="model"] .chat-dropdown-item.selected');
		const model = modelSelect?.dataset?.value || '';
		if (activeChatId && model) setChatModel(activeChatId, model);

		let maxTokens      = getModelMaxTokens(model);
		const contextLimit = getModelContextLimitFromUI(root);
		const chat  = getChatById(activeChatId);
		if (!chat) { stopTyping(); return; }
		const graph = ensureGraph(chat);
		const threadIds = computeThreadNodeIds(graph);

		const settings = SettingsStore.get();
		let conversationHistory = buildConversationHistory(graph, threadIds, settings);
		if (!conversationHistory.trim() && parentUserNodeId) {
			const pn = getNode(graph, parentUserNodeId);
			if (pn) conversationHistory = buildNodeTextForHistory(pn) || 'Hello';
		}
		if (!conversationHistory.trim()) conversationHistory = 'Hello';

		let apiMessages = buildApiMessages(graph, threadIds, settings);
		if (apiMessages.length === 0 && parentUserNodeId) apiMessages = buildApiMessages(graph, [parentUserNodeId], settings);
		const parentUserNode = parentUserNodeId ? getNode(graph, parentUserNodeId) : null;
		const researchPart = getNodeResearchPart(parentUserNode);

		const streamController = createStreamController(uiState.typingEl);
		let isSaved = false;

		let systemPrompt = buildSystemPromptForMessages(apiMessages, settings);
		let temperature = settings?.temperature ?? 1.0;
		let toolScope = getChatToolScope(activeChatId);
		if (researchPart) {
			systemPrompt = buildResearchSystemPrompt(systemPrompt, researchPart);
			maxTokens = Math.max(maxTokens, RESEARCH_MAX_TOKENS);
		}
		const revisionMode = settings?.chatResponseMode === 'live';
		const hasActiveToolPacks = toolScope.useDefaultPacks === true ||
			(Array.isArray(toolScope?.enabledPackIds) && toolScope.enabledPackIds.length > 0);

		try {
			const countResult = await fetchExactContextCount({
				model,
				messages: apiMessages,
				systemPrompt,
				chatId: activeChatId,
				toolScope,
				revisionMode,
			}, { signal: currentSignal });
			const promptTokens = Number.parseInt(countResult?.prompt_tokens, 10);
			if (Number.isFinite(promptTokens) && contextLimit > 0 && promptTokens + maxTokens > contextLimit) {
				maxTokens = Math.max(256, contextLimit - promptTokens);
			}
		} catch (err) {
			if (currentSignal.aborted || err?.name === 'AbortError') {
				throw new DOMException('Aborted', 'AbortError');
			}
			console.error('[ChatPage] Exact submit token count failed:', err);
		}

		uiState.flushResponse = () => {
			if (isSaved) return;
			isSaved = true;
			const {
				finalContent,
				finalReasoning,
				finalReasoningParts,
				finalParts,
				activeToolCalls,
				tokenLogprobs,
				finalRevisionTrace,
				errorFromStream,
			} = streamController.buildFinalResult();
			if (finalContent || finalReasoning || activeToolCalls.length > 0) {
				let assistantParts = finalParts.length > 0 ? finalParts : null;
				if (researchPart) {
					assistantParts = [
						{ ...researchPart },
						...(assistantParts || (finalContent ? [{ type: 'text', content: finalContent }] : [])),
					];
				}
				const node = addChildMessageToChat(
					activeChatId,
					parentUserNodeId,
					'assistant',
					finalContent,
					null,
					assistantParts,
					activeToolCalls.length > 0 ? activeToolCalls : null,
					finalRevisionTrace,
				);
				if (node) {
					if (finalReasoning)             node.reasoning  = finalReasoning;
					if (finalReasoningParts.length > 0) node.reasoningParts = finalReasoningParts;
					if (tokenLogprobs.length > 0) {
						node.tokenLogprobs = tokenLogprobs;
					}
					// Don't saveChats() — the backend saves independently via
					// appendAssistantMessage. We only update the local graph for
					// immediate display; on next reload, loadChats() gets the truth.
				}
			} else if (errorFromStream) {
				addChildMessageToChat(activeChatId, parentUserNodeId, 'assistant', `**Error:** ${errorFromStream}`);
			}
			uiState.liveGeneratingNode = null;
			uiState.activeTaskId = null;
		};
		const chunkHandler = (chunk) => {
			if (currentSignal.aborted) return;
			streamController.queueChunk(chunk);
		};

		// ── Submit the generation task to the backend ─────────────────────────
		const taskPayload = {
			task_id: taskId,
			model, prompt: conversationHistory, max_tokens: maxTokens,
			system_prompt: systemPrompt, temperature, context_window: contextLimit,
			logprobs: !hasActiveToolPacks && !revisionMode,
			revision_mode: revisionMode,
			chat_id: activeChatId,
			parent_user_node_id: parentUserNodeId || '',
			tool_scope: toolScope,
		};
		if (researchPart) {
			taskPayload.job_type = 'research';
			taskPayload.research = {
				query: researchPart.query || '',
				title: researchPart.title || '',
				status: 'running',
				tasks: researchPart.tasks || [],
				source_classes: researchPart.sourceClasses || ['web', 'academic'],
				deliverables: researchPart.deliverables || [],
				workflow: researchPart.workflow || researchPart.tasks || [],
			};
		}
		if (apiMessages.length > 0) taskPayload.messages = apiMessages;

		try {
			const submitResult = await submitGenerationTask(taskPayload, { signal: currentSignal });
			if (submitResult?.task_id) {
				taskId = submitResult.task_id;
			}
			uiState.activeTaskId = taskId;

			if (currentSignal.aborted) {
				const abortReason = getAbortReason(currentSignal);
				if (abortReason !== 'detach' && abortReason !== 'cancel-requested') {
					await cancelTask(taskId).catch(() => {});
				}
				throw new DOMException('Aborted', 'AbortError');
			}

			// ── Stream chunks from the task ─────────────────────────────────
			await streamTask(taskId, 0, chunkHandler, currentSignal, () => {
				streamController.flushAllPending();
				streamController.closeReasoning();
				setGeneratingState(false);
			});

			const streamState = streamController.getState();
			const {
				rawStreamText,
				officialReasoningText,
				activeToolCalls,
				revisionTrace,
				errorFromStream,
			} = streamState;
			if (!rawStreamText && !officialReasoningText && activeToolCalls.length === 0 && !revisionTrace && !errorFromStream) {
				stopTyping();
				setGeneratingState(false);
				rerender();
				renderChatList();
				setActiveCallback?.();
				return;
			}

			streamController.renderNow();
			streamController.closeReasoning();
			clearApprovalPanel();
			stopTyping(true);
			// Reload from backend (source of truth) instead of using stale local state
			await loadChats();
			await ensureChatLoaded(activeChatId, { force: true });
			// Smoothly finalize the preserved element with proper node ID and menu
			const finalized = finalizeGeneratedMessage();
			if (!finalized) {
				// Fallback to full re-render if we couldn't finalize
				rerender();
			}
			renderChatList();
			setActiveCallback?.();
		} catch (err) {
			if (err.name === 'AbortError') {
				uiState.flushResponse = null;
				if (getAbortReason(currentSignal) === 'detach') {
					return;
				}
				stopTyping();
				rerender();
				renderChatList();
				setActiveCallback?.();
				return;
			}
			console.error('[ChatPage] Stream error:', err);
			const {
				rawStreamText,
				officialReasoningText,
				activeToolCalls,
				revisionTrace,
				errorFromStream,
			} = streamController.getState();
			const hadPartialResponse =
				Boolean(rawStreamText) ||
				Boolean(officialReasoningText) ||
				activeToolCalls.length > 0 ||
				Boolean(revisionTrace) ||
				Boolean(errorFromStream);
			if (hadPartialResponse) {
				if (!errorFromStream) {
					streamController.queueChunk({
						error: err?.message || 'Generation failed',
					});
					streamController.flushAllPending();
				}
				stopTyping();
			} else {
				uiState.flushResponse = null;
				stopTyping();
				if (activeChatId && parentUserNodeId) {
					const errorText = err?.message ? `**Error:** ${err.message}` : '**Error:** Generation failed';
					addChildMessageToChat(activeChatId, parentUserNodeId, 'assistant', errorText);
				}
			}
			rerender();
			renderChatList();
			setActiveCallback?.();
		} finally {
			streamController.dispose?.();
			if (uiState.activeTaskId === taskId) uiState.activeTaskId = null;
			if (uiState.streamAbort?.signal === currentSignal) uiState.streamAbort = null;
		}
	};

	const startPendingResearch = async (nodeId) => {
		const chatId = getCurrentChatId();
		const chat = chatId ? getChatById(chatId) : null;
		const graph = chat ? ensureGraph(chat) : null;
		const node = graph ? getNode(graph, nodeId) : null;
		if (!chat || !graph || !node || node.role !== 'assistant') return;
		const researchPart = getNodeResearchPart(node);
		if (researchPart?.status !== 'pending') return;
		if (uiState.isGenerating || uiState.isSubmitting) return;
		const userNode = node.parentId ? getNode(graph, node.parentId) : null;
		if (!userNode || userNode.role !== 'user') return;

		const runningResearch = {
			...researchPart,
			status: 'running',
			startedAt: Date.now(),
		};
		delete runningResearch.autoStartAt;
		setNodeResearchMetadata(userNode, runningResearch);
		deleteSubtree(graph, node.id);
		setSelectedChildId(graph, userNode.parentId, userNode.id);
		recomputeLeafId(graph);
		chat.updatedAt = Date.now();
		await saveChatAwaitable(chat.id);
		rerender();
		if (empty) empty.hidden = true;
		startReply(chat.id, userNode.id);
	};

	// ── Reconnect: check backend for any running/completed task on this chat ──
	const reconnectCheck = async () => {
		const chatId = getCurrentChatId();
		if (!chatId) return;

		const shouldSkipReconnect = () => {
			if (signal.aborted) return true;
			if (getCurrentChatId() !== chatId) return true;
			// This page is already starting or streaming a task locally, so do not
			// attach a second EventSource to the same chat generation.
			if (uiState.isSubmitting || uiState.isGenerating) return true;
			if (uiState.activeTaskId || uiState.streamAbort) return true;
			return false;
		};

		if (shouldSkipReconnect()) return;

		try {
			const task = await getTaskByChat(chatId);
			if (shouldSkipReconnect()) return;
			if (!task || task.error) return;

			if (task.status === 'completed') {
				// Backend already saved the result — just reload chats
				await loadChats();
				const chat = await ensureChatLoaded(chatId, { force: true });
				if (chat) renderThread(messages, chat, { editingNodeId: uiState.editingNodeId, editingDraft: uiState.editingDraft }, SettingsStore.get());
				renderChatList();
				setActiveCallback?.();
				return;
			}

			if (task.status === 'running' || task.status === 'pending' || task.status === 'waiting_approval') {
				const reconnectAbort = new AbortController();
				uiState.activeTaskId = task.id;
				uiState.streamAbort = reconnectAbort;
				const currentSignal = reconnectAbort.signal;

				// Don't render existing messages — just show the typing indicator.
				// The streamTask will replay ALL chunks from the backend, rebuilding
				// the full content. On completion, reload from the backend (the source
				// of truth) instead of saving frontend state to it.
				const typingEl = showTyping(messages);
				uiState.typingEl = typingEl;
				// No flushResponse — backend already saved the result independently.
				// Do NOT call saveChats() — it would overwrite the backend truth.
				const streamController = createStreamController(typingEl);
				const chunkHandler = (chunk) => {
					if (currentSignal.aborted) return;
					streamController.queueChunk(chunk);
				};

				setGeneratingState(true);
				checkScroll();

				try {
					await streamTask(task.id, 0, chunkHandler, currentSignal, () => {
						streamController.flushAllPending();
						streamController.closeReasoning();
						setGeneratingState(false);
					});
					// Reload from backend (source of truth) — don't save frontend state
					await loadChats();
					const chat = await ensureChatLoaded(chatId, { force: true });
					if (chat) renderThread(messages, chat, { editingNodeId: uiState.editingNodeId, editingDraft: uiState.editingDraft }, SettingsStore.get());
					renderChatList();
					setActiveCallback?.();
				} catch (e) {
					if (e.name === 'AbortError' && getAbortReason(currentSignal) === 'detach') {
						return;
					}
					if (e.name !== 'AbortError') console.error('[ChatPage] Reconnect stream error:', e);
					await loadChats();
					const chat = await ensureChatLoaded(chatId, { force: true });
					if (chat) renderThread(messages, chat, { editingNodeId: uiState.editingNodeId, editingDraft: uiState.editingDraft }, SettingsStore.get());
					renderChatList();
					setActiveCallback?.();
				} finally {
					streamController.dispose?.();
					if (uiState.activeTaskId === task.id) uiState.activeTaskId = null;
					if (uiState.streamAbort === reconnectAbort) uiState.streamAbort = null;
				}
			}
		} catch (e) {
			// ignore
		}
	};

	// Delay reconnect to let the page fully settle and avoid EventSource interruption during navigation
	requestAnimationFrame(() => {
		requestAnimationFrame(reconnectCheck);
	});

	document.addEventListener('keydown', (e) => {
		if ((e.key === 'Escape' || e.key === 'Esc') && uiState.editingNodeId) {
			e.preventDefault();
			uiState.editingNodeId = null; uiState.editingDraft = ''; uiState.editingMode = null; uiState.editingSaveMode = null;
			rerender();
		}
	}, { capture: true, signal });

	document.addEventListener('keyup', (e) => {
		if ((e.key === 'Escape' || e.key === 'Esc') && uiState.editingNodeId) {
			uiState.editingNodeId = null; uiState.editingDraft = ''; uiState.editingMode = null; uiState.editingSaveMode = null;
			rerender();
		}
	}, { signal });

	messages.addEventListener('click', (e) => {
		const approvalBtn = e.target.closest('[data-approval-action][data-approval-id]');
		if (approvalBtn) {
			handleApprovalAction(approvalBtn);
			return;
		}

		const codeCopyBtn = e.target.closest('.md-code-copy');
		if (codeCopyBtn) {
			const wrapper = codeCopyBtn.closest('.md-code-wrapper');
			if (wrapper) {
				const codeBlock = wrapper.querySelector('.md-code-block code');
				if (codeBlock) {
					const text = codeBlock.textContent;
					navigator.clipboard.writeText(text).then(() => {
						const old = codeCopyBtn.innerHTML;
						codeCopyBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><path d="M20 6L9 17l-5-5"/></svg>`;
						setTimeout(() => { codeCopyBtn.innerHTML = old; }, 2000);
					}).catch(err => console.error('Failed to copy code:', err));
				}
			}
			return;
		}

		const codeHeader = e.target.closest('.md-code-header');
		if (codeHeader) {
			const wrapper = codeHeader.closest('.md-code-wrapper');
			if (wrapper) {
				wrapper.classList.toggle('collapsed');
				scheduleScrollStateRefresh();
			}
			return;
		}

		const btn = e.target.closest('[data-action]');
		const nudgeToggle = e.target.closest('[data-message-nudge-toggle]');
		if (nudgeToggle) {
			const nudge = nudgeToggle.closest('.chat-message-nudge.compact');
			if (!nudge) return;
			const expanded = nudge.classList.contains('expanded');
			if (expanded) {
				nudge.classList.remove('expanded');
				nudge.classList.add('closing');
				nudgeToggle.setAttribute('aria-expanded', 'false');
				window.setTimeout(() => {
					nudge.classList.remove('closing');
					scheduleScrollStateRefresh();
					scheduleMessageNudgePlacementRefresh({ animate: false });
				}, compactToolbarAnimationMs + 20);
			} else {
				nudge.classList.remove('closing');
				nudge.classList.add('expanded');
				nudgeToggle.setAttribute('aria-expanded', 'true');
			}
			scheduleScrollStateRefresh();
			scheduleMessageNudgePlacementRefresh({ animate: false });
			return;
		}

		if (!btn) return;
		const action  = btn.dataset.action;
		const groupEl = btn.closest('.chat-message-group[data-node-id]');
		const msgEl   = groupEl?.querySelector(':scope > .chat-message') || btn.closest('.chat-message[data-node-id]');
		const nodeId  = groupEl?.dataset?.nodeId || msgEl?.dataset?.nodeId;
		if (!nodeId) return;
		const chat  = getCurrentChatId() ? getChatById(getCurrentChatId()) : null;
		if (!chat) return;
		const graph = ensureGraph(chat);
		const node  = getNode(graph, nodeId);
		if (!node) return;

		const resetEdit = () => { uiState.editingNodeId = null; uiState.editingDraft = ''; uiState.editingMode = null; uiState.editingSaveMode = null; };
		const focusEditInput = (targetNodeId) => {
			setTimeout(() => {
				const el = messages.querySelector(`[data-node-id="${targetNodeId}"] [data-research-task-edit], [data-node-id="${targetNodeId}"] .chat-edit-input`);
				if (el) {
					el.focus();
					const s = window.getSelection();
					const r = document.createRange();
					r.selectNodeContents(el);
					r.collapse(false);
					s.removeAllRanges();
					s.addRange(r);
				}
			}, 0);
		};
		const startResearchTaskEdit = (researchNode) => {
			const researchPart = getEditableResearchPart(researchNode);
			if (!researchPart) return;
			uiState.editingNodeId = researchNode.id;
			uiState.editingDraft = formatResearchTaskEditDraft(researchPart);
			uiState.editingMode = 'research-tasks';
			uiState.editingSaveMode = null;
			const patched = patchMessageEditState(messages, graph, researchNode, true, uiState.editingDraft, SettingsStore.get(), uiState.editingMode);
			if (!patched) rerender();
			updateLiveContext();
			focusEditInput(researchNode.id);
		};

		const handlers = {
			edit: () => {
				if (getEditableResearchPart(node)) {
					startResearchTaskEdit(node);
					return;
				}
				uiState.editingNodeId = nodeId;
				uiState.editingDraft  = node.role === 'assistant' ? getNodeRawTextContent(node) : getNodeTextContent(node);
				uiState.editingMode = null;
				uiState.editingSaveMode = null;
				const patched = patchMessageEditState(messages, graph, node, true, uiState.editingDraft, SettingsStore.get());
				if (!patched) rerender();
				updateLiveContext();
				focusEditInput(nodeId);
			},
			cancel: () => {
				const escNode = uiState.editingNodeId ? getNode(graph, uiState.editingNodeId) : null;
				resetEdit();
				const patched = escNode ? patchMessageEditState(messages, graph, escNode, false, null, SettingsStore.get()) : false;
				if (!patched) rerender();
			},
			save: () => {
				if (!uiState.editingNodeId) return;
				const taskEditEls = [...msgEl.querySelectorAll('[data-research-task-edit]')];
				const editEl = msgEl.querySelector('.chat-edit-input');
				const next = taskEditEls.length > 0
					? taskEditEls.map((el) => (el.innerText ?? '').replace(/\n/g, ' ').trim()).filter(Boolean).join('\n')
					: (editEl?.innerText ?? '').replace(/\n$/, '');
				const saveMode = uiState.editingSaveMode;
				if (uiState.editingMode === 'research-tasks') {
					const researchNode = getNode(graph, uiState.editingNodeId);
					const researchPart = getEditableResearchPart(researchNode);
					if (!researchNode || !researchPart) return;
					setNodeResearchPart(researchNode, buildResearchPartWithEditedTasks(researchPart, next));
					researchNode.editedAt = Date.now();
					chat.updatedAt = Date.now();
					saveChats();
					resetEdit();
					rerender();
					renderChatList();
					setActiveCallback?.();
					checkScroll();
					return;
				}

				const assistantDraft = node.role === 'assistant' ? parseAssistantEditDraft(next) : null;
				const siblingOptions = {
					content: assistantDraft ? assistantDraft.content : next,
					timestamp: Date.now(),
				};
				if (node.role === 'assistant') {
					siblingOptions.parts = assistantDraft ? assistantDraft.parts : null;
					siblingOptions.reasoning = assistantDraft ? assistantDraft.reasoning : '';
					siblingOptions.reasoningParts = null;
				}

				const sibling = createSiblingCopy(graph, nodeId, siblingOptions);
				if (!sibling) return;
				if (node.role === 'assistant') {
					sibling.content = assistantDraft ? assistantDraft.content : next;
					if (assistantDraft) {
						sibling.parts = assistantDraft.parts;
						if (assistantDraft.reasoning) sibling.reasoning = assistantDraft.reasoning;
						else delete sibling.reasoning;
					} else {
						delete sibling.parts;
						delete sibling.reasoning;
					}
					delete sibling.reasoningParts;
				} else if (sibling.parts) {
					sibling.parts = buildPartsWithUpdatedText(sibling, next);
				} else { sibling.content = next; }
				const editedResearchPart = node.role === 'user'
					? (getNodeResearchPart(node) || getNodeResearchPart(getPendingResearchChild(graph, node)))
					: null;
				let editedPendingResearchNode = null;
				if (node.role === 'user' && (editedResearchPart?.status === 'pending' || editedResearchPart?.status === 'planning')) {
					[...(sibling.children || [])].forEach((childId) => deleteSubtree(graph, childId));
					editedPendingResearchNode = addResearchPlanningNode(chat, sibling, next);
				}
				sibling.editedAt = Date.now();
				recomputeLeafId(graph);
				chat.updatedAt = Date.now();
				saveChats();
				resetEdit();
				rerender();
				setActiveCallback?.();
				// Only auto-regenerate when editing a user message (to get a new AI response).
				// Editing an assistant message should just update the text, not trigger a new generation.
				if (!editedPendingResearchNode && saveMode !== 'preserve' && sibling.role === 'user') {
					if (empty) empty.hidden = true;
					startReply(chat.id, sibling.id);
				}
				checkScroll();
			},
			thread: () => {
				const newNode = branchFromNode(graph, nodeId, { preserveSelectedTail: true });
				if (!newNode) return;
				recomputeLeafId(graph); chat.updatedAt = Date.now(); saveChats();
				rerender(); setActiveCallback?.();
				checkScroll();
			},
			'branch-back': () => {
				const siblings = getNode(graph, node.parentId)?.children || [];
				const idx = siblings.indexOf(nodeId);
				if (idx <= 0) return;
				setSelectedChildId(graph, node.parentId, siblings[idx - 1]);
				recomputeLeafId(graph); chat.updatedAt = Date.now(); saveChats();
				resetEdit(); rerender(); setActiveCallback?.();
			},
			'branch-forward': () => {
				const siblings = getNode(graph, node.parentId)?.children || [];
				const idx = siblings.indexOf(nodeId);
				if (idx < 0 || idx >= siblings.length - 1) return;
				setSelectedChildId(graph, node.parentId, siblings[idx + 1]);
				recomputeLeafId(graph); chat.updatedAt = Date.now(); saveChats();
				resetEdit(); rerender(); setActiveCallback?.();
			},
			resend: () => {
				stopTyping();
				const userNodeId = node.role==='user' ? node.id : node.parentId;
				const userNode   = getNode(graph, userNodeId);
				if (!userNode) return;
				[...(userNode.children||[])].forEach(cid => deleteSubtree(graph, cid));
				delete graph.selections[userNodeId];
				if (userNode.parentId) setSelectedChildId(graph, userNode.parentId, userNodeId);
				const shouldPrepareResearch = isResearchEnabled(root) || Boolean(userNode.research);
				let pendingResearchNode = null;
				if (shouldPrepareResearch) {
					const query = getNodeTextContent(userNode).trim();
					if (query) {
						pendingResearchNode = addResearchPlanningNode(chat, userNode, query);
					}
				}
				markGraphForReplacement(graph);
				recomputeLeafId(graph); chat.updatedAt = Date.now(); saveChats();
				resetEdit(); rerender(); setActiveCallback?.();
				if (empty) empty.hidden = true;
				if (!pendingResearchNode) {
					startReply(chat.id, userNodeId);
				}
				checkScroll();
			},
			'rollback-files': () => {
				handleMessageFileEditRollback(node, btn);
			},
			'research-edit': () => {
				startResearchTaskEdit(node);
			},
			'research-cancel': () => {
				const status = getNodeResearchPart(node)?.status;
				if (status !== 'pending' && status !== 'planning') return;
				stopTyping();
				deleteSubtree(graph, nodeId);
				markGraphForReplacement(graph);
				recomputeLeafId(graph);
				chat.updatedAt = Date.now();
				saveChatAwaitable(chat.id).catch((err) => {
					console.error('[Chat] Failed to cancel research message:', err);
				});
				resetEdit();
				rerender();
				renderChatList();
				setActiveCallback?.();
			},
			'research-start': () => {
				startPendingResearch(nodeId);
			},
			copy: async () => {
				const rawText = getNodeRawTextContent(node);
				try {
					await navigator.clipboard.writeText(rawText);
					const old = btn.innerHTML;
					btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>`;
					setTimeout(()=>{ if(btn) btn.innerHTML=old; }, 2000);
				} catch(err) { console.error('Failed to copy:', err); }
			},
			delete: () => {
				stopTyping();
				const didDelete = e.shiftKey ? spliceDeleteNode(graph, nodeId) : (deleteSubtree(graph, nodeId), true);
				if (!didDelete) return;
				markGraphForReplacement(graph);
				recomputeLeafId(graph); chat.updatedAt = Date.now();
				saveChatAwaitable(chat.id).catch((err) => {
					console.error('[Chat] Failed to save message deletion:', err);
				});
				resetEdit(); rerender(); renderChatList(); setActiveCallback?.();
			},
		};
		handlers[action]?.();
	}, { signal });

	messages.addEventListener('toggle', (e) => {
		if (e.target?.matches?.('details')) {
			scheduleScrollStateRefresh();
		}
	}, { capture: true, signal });

	messages.addEventListener('keydown', (e) => {
		const editEl = e.target.closest('.chat-edit-input, [data-research-task-edit]');
		if (!editEl) return;
		const msgEl  = editEl.closest('.chat-message');
		const nodeId = msgEl?.dataset.nodeId;
		if (!nodeId) return;
		if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
			e.preventDefault();
			uiState.editingSaveMode = e.shiftKey ? 'preserve' : 'reset';
			msgEl.querySelector('button[data-action="save"]')?.click();
		} else if (e.key === 'Enter' && editEl.matches('[data-research-task-edit]')) {
			e.preventDefault();
			const taskEditEls = [...msgEl.querySelectorAll('[data-research-task-edit]')];
			const index = taskEditEls.indexOf(editEl);
			(taskEditEls[index + 1] || editEl).focus();
		} else if (e.key === 'Enter') {
			e.preventDefault();
			document.execCommand('insertText', false, '\n');
		} else if (e.key === 'Escape' || e.key === 'Esc') {
			e.preventDefault();
			const escNodeId = uiState.editingNodeId;
			uiState.editingNodeId = null; uiState.editingDraft = ''; uiState.editingMode = null; uiState.editingSaveMode = null;
			const chat2 = getChatById(getCurrentChatId());
			const g2    = chat2 ? ensureGraph(chat2) : null;
			const escNode = (escNodeId && g2) ? getNode(g2, escNodeId) : null;
			const patched = escNode ? patchMessageEditState(messages, g2, escNode, false, null, SettingsStore.get()) : false;
			if (!patched) rerender();
		}
	}, { signal });

	messages.addEventListener('input', (e) => {
		const editEl = e.target.closest('.chat-edit-input, [data-research-task-edit]');
		if (!editEl) return;
		const nodeId = editEl.closest('.chat-message')?.dataset?.nodeId;
		if (nodeId && uiState.editingNodeId === nodeId) {
			const taskEditEls = [...editEl.closest('.chat-message')?.querySelectorAll('[data-research-task-edit]') || []];
			uiState.editingDraft = taskEditEls.length > 0
				? taskEditEls.map((el) => (el.innerText ?? '').replace(/\n/g, ' ').trim()).filter(Boolean).join('\n')
				: (editEl.innerText ?? '').replace(/\n$/, '');
			updateLiveContext();
		}
	}, { signal });

	document.addEventListener('copy', (e) => {
		const sel = window.getSelection();
		if (!sel || sel.isCollapsed || !sel.rangeCount) return;
		const range = sel.getRangeAt(0);
		if (!messages.contains(range.commonAncestorContainer)) return;

		const chat  = getCurrentChatId() ? getChatById(getCurrentChatId()) : null;
		const graph = chat ? ensureGraph(chat) : null;
		const nodeRawText = (node) => {
			if (!node) return '';
			return getNodeTextContent(node);
		};

		const msgEls =[...messages.querySelectorAll('.chat-message[data-node-id]')];
		const selMsgEls = msgEls.filter(el => range.intersectsNode(el));
		if (selMsgEls.length === 0) return;

		// Determine if selection covers entire message content (not just part of it)
		const isFullMessageSelection = selMsgEls.every(msgEl => {
			const content = msgEl.querySelector('.chat-message-content');
			if (!content) return false;
			const contentRange = document.createRange();
			contentRange.selectNodeContents(content);
			return range.compareBoundaryPoints(Range.START_TO_START, contentRange) <= 0 &&
			       range.compareBoundaryPoints(Range.END_TO_END, contentRange) >= 0;
		});

		let plain = '';

		if (isFullMessageSelection) {
			// Full message(s) selected — use raw stored content including reasoning
			const parts =[];
			for (const m of selMsgEls) {
				const node = graph ? getNode(graph, m.dataset.nodeId) : null;
				if (!node) continue;
				const rawText = getNodeRawTextContent(node);
				if (rawText) parts.push(rawText);
			}
			plain = parts.join('\n\n');
		}

		if (!plain) {
			// Partial selection — convert rendered HTML back to markdown
			const selectedRange = range.cloneRange();
			const fragment = selectedRange.cloneContents();
			const tempDiv = document.createElement('div');
			tempDiv.appendChild(fragment);
			plain = htmlToMarkdown(tempDiv);
		}

		const htmlContainer = document.createElement('div');
		htmlContainer.appendChild(range.cloneContents());
		htmlContainer.querySelectorAll('.chat-message-menu, .md-code-header, .chat-typing, .chat-message-inline-attachment').forEach(el => el.remove());
		htmlContainer.querySelectorAll('.message-tool-call').forEach(el => { const s = el.querySelector('summary'); el.replaceWith(document.createTextNode(s ? s.textContent.trim() : '')); });
		const htmlPayload = `<!DOCTYPE html><html><body>${htmlContainer.innerHTML}</body></html>`;
		e.preventDefault();
		if (!e.clipboardData) return;
		e.clipboardData.setData('text/plain', plain);
		try { e.clipboardData.setData('text/html', htmlPayload); } catch {}
	}, { signal });

	form.addEventListener('submit', async (e) => {
		e.preventDefault();
		if (uiState.isGenerating) {
			await requestTaskCancellation({ abortStream: false, discardPartial: false });
			return;
		}

		const parts = attachmentManager.extractParts();
		if (!parts || parts.length === 0) return;
		// Debounce: prevent rapid-fire duplicate submissions
		if (uiState.isSubmitting) return;
		const submittedText = parts
			.filter((part) => part?.type === 'text')
			.map((part) => String(part.content || ''))
			.join('')
			.trim();
		const shouldPrepareResearch = isResearchEnabled(root) && Boolean(submittedText);
		uiState.isSubmitting = true;
		ensureChatExists(setActiveCallback);
		if (empty) empty.hidden = true;
		stopTyping();
		uiState.editingNodeId = null; uiState.editingDraft = ''; uiState.editingMode = null; uiState.editingSaveMode = null;

		// Check if this is the first message (for AI title generation after chat completes)
		const submittedChatId = getCurrentChatId();
		const currentChat = getChatById(submittedChatId);
		const isFirstMessage = currentChat && currentChat.graph && currentChat.graph.nodes &&
			Object.values(currentChat.graph.nodes).filter(n => n.role === 'user').length === 0;
		const submittedModel = root.querySelector('[data-dropdown="model"] .chat-dropdown-item.selected')?.dataset?.value || currentChat?.model || '';

		// Add user message immediately (shows in UI)
		const userNode = await addMessageToChat(submittedChatId, 'user', '', null, parts);
		if (userNode && shouldPrepareResearch) {
			addResearchPlanningNode(getChatById(submittedChatId), userNode, submittedText);
			saveChatAwaitable(submittedChatId).catch((err) => {
				console.error('[Chat] Failed to save pending research message:', err);
			});
		}
		attachmentManager.clear();
		const uploadBtn = root.querySelector('#chatUploadBtn');
		if (uploadBtn) delete uploadBtn.dataset.count;
		if (resizeInput) resizeInput();
		rerender(); renderChatList(); setActiveCallback?.();

		const sendNoReply = form.dataset.sendNoReply === '1';
		delete form.dataset.sendNoReply;
		if (shouldPrepareResearch && userNode?.id) {
			uiState.isSubmitting = false;
		} else if (!sendNoReply && userNode?.id) {
			startReply(submittedChatId, userNode.id).finally(() => {
				// Release the submit debounce guard once the reply completes
				uiState.isSubmitting = false;
				// Fire AI title generation after first message completes
				if (isFirstMessage) {
					triggerAiTitleGeneration(root, submittedChatId, null, submittedModel);
				}
			});
		} else {
			// No reply to generate — release the guard immediately
			uiState.isSubmitting = false;
		}
		checkScroll();
	}, { signal });

	rerender();
	input.focus();
}

export function mountChatPage(root, context = {}) {
	initChatPage(root, context.currentRouteGetter || (() => ''), context.setActiveCallback);
	return () => {
		chatPageAbort?.abort();
	};
}

export async function prepareChatPageFragment(root, context = {}) {
	if (!root) return;
	const route = typeof context.route === 'string' ? context.route : '';
	const chatId = getRouteChatId(route) || getCurrentChatId();
	seedChatPageShell(root, () => route);
	if (!chatId) return;
	await seedExactContextIndicator(root, chatId);
}
