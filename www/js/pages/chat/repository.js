import { appendNode, createEmptyGraph, ensureGraph } from "./graph.js";
import { deleteChatData, getChatData, getChatsData, saveChatData, saveChatsData } from "../../core/http.js";

const LAST_MODEL_KEY = "ctrlpanel:lastModel";
const LAST_TOOL_SCOPE_KEY = "ctrlpanel:lastToolScope";
const DEFAULT_TOOL_SCOPE = Object.freeze({ useDefaultPacks: true, enabledPackIds: [] });

let chats = [];
let currentChatId = null;
let pins = [];
let chatWriteQueue = Promise.resolve();

function isValidTimestamp(value) {
	const num = Number(value);
	return Number.isFinite(num) && num > 0;
}

function normalizeTimestamp(value, fallback = Date.now()) {
	return isValidTimestamp(value) ? Number(value) : fallback;
}

function isChatLoaded(chat) {
	return Boolean(chat?.graph && typeof chat.graph === "object");
}

function buildChatSummary(chat) {
	const createdAt = normalizeTimestamp(chat?.createdAt);
	const updatedAt = Math.max(normalizeTimestamp(chat?.updatedAt, createdAt), createdAt);
	const summary = {
		id: String(chat?.id || ""),
		title: typeof chat?.title === "string" && chat.title ? chat.title : "New Chat",
		createdAt,
		updatedAt,
	};
	if (chat?.model) summary.model = chat.model;
	if (chat?.toolScope && typeof chat.toolScope === 'object') summary.toolScope = normalizeToolScope(chat.toolScope);
	return summary;
}

function getChatSortTime(chat) {
	const createdAt = normalizeTimestamp(chat?.createdAt, 0);
	const updatedAt = normalizeTimestamp(chat?.updatedAt, createdAt);
	return Math.max(updatedAt, createdAt);
}

function compareChatsByRecentActivity(a, b) {
	const timeDiff = getChatSortTime(b) - getChatSortTime(a);
	if (timeDiff !== 0) return timeDiff;
	return normalizeTimestamp(b?.createdAt, 0) - normalizeTimestamp(a?.createdAt, 0);
}

function sortChatsByRecentActivity() {
	chats.sort(compareChatsByRecentActivity);
}

function normalizeEnabledPackIds(enabledPackIds) {
	return Array.isArray(enabledPackIds)
		? [...new Set(enabledPackIds.filter(Boolean).map(String))]
		: [];
}

function normalizeToolScope(toolScope, fallback = DEFAULT_TOOL_SCOPE) {
	const source = toolScope && typeof toolScope === 'object' ? toolScope : fallback;
	return {
		useDefaultPacks: source?.useDefaultPacks === true,
		enabledPackIds: normalizeEnabledPackIds(source?.enabledPackIds),
	};
}

function replaceChatAt(index, chat) {
	if (index < 0) return;
	chats.splice(index, 1, chat);
}

function getChatIndexById(id) {
	return chats.findIndex((chat) => chat.id === id);
}

function getLoadedChatIds() {
	return chats.filter(isChatLoaded).map((chat) => chat.id);
}

function buildSavePayload() {
	sortChatsByRecentActivity();
	return {
		chats: chats.map(buildChatSummary),
		currentChatId: currentChatId || "",
		pins,
	};
}

async function saveLoadedChatAwaitable(chatId) {
	const chat = getChatById(chatId);
	if (!chat || !isChatLoaded(chat)) return null;
	const saved = await saveChatData(chatId, chat);
	const index = getChatIndexById(chatId);
	if (index !== -1) {
		chats[index] = { ...chat, ...saved };
	}
	return saved;
}

function enqueueChatWrite(operation) {
	const run = chatWriteQueue.then(operation, operation);
	chatWriteQueue = run.catch(() => {});
	return run;
}

export async function loadChats() {
	const previousCurrentChatId = currentChatId;
	const previousById = new Map(chats.map((chat) => [chat.id, chat]));

	try {
		const data = await getChatsData();
		const summaries = Array.isArray(data?.chats) ? data.chats : [];
		chats = summaries.map((summary) => {
			const normalized = buildChatSummary(summary);
			const previous = previousById.get(normalized.id);
			if (previous && isChatLoaded(previous)) {
				return { ...previous, ...normalized };
			}
			return normalized;
		});
		sortChatsByRecentActivity();

		const backendCurrentChatId = data?.currentChatId || null;
		const hasPreviousCurrentChat = previousCurrentChatId &&
			chats.some((chat) => chat.id === previousCurrentChatId);
		currentChatId = hasPreviousCurrentChat ? previousCurrentChatId : backendCurrentChatId;
		pins = Array.isArray(data?.pins) ? data.pins.map(String) : [];
	} catch (err) {
		console.warn("[Store] Failed to load chats from backend, starting empty:", err);
		chats = [];
		currentChatId = null;
		pins = [];
	}
}

export async function ensureChatLoaded(chatId, options = {}) {
	const { force = false } = options;
	if (!chatId) return null;

	const index = getChatIndexById(chatId);
	if (index === -1) return null;

	const existing = chats[index];
	if (!force && isChatLoaded(existing)) {
		return existing;
	}

	const loaded = await getChatData(chatId);
	const merged = {
		...existing,
		...loaded,
		createdAt: normalizeTimestamp(loaded?.createdAt, normalizeTimestamp(existing?.createdAt)),
		updatedAt: normalizeTimestamp(loaded?.updatedAt, normalizeTimestamp(existing?.updatedAt, Date.now())),
	};
	if (!merged.model && existing?.model) merged.model = existing.model;
	if (!merged.toolScope && existing?.toolScope) merged.toolScope = existing.toolScope;
	if (typeof merged.researchEnabled !== 'boolean' && typeof existing?.researchEnabled === 'boolean') {
		merged.researchEnabled = existing.researchEnabled;
	}
	replaceChatAt(index, merged);
	return chats[index];
}

export function saveChats() {
	saveChatsAwaitable().catch((err) => {
		console.error("[Store] Failed to save chats:", err);
	});
}

async function persistChatsAwaitable(chatIds = null) {
	await saveChatsData(buildSavePayload());

	const idsToSave = Array.isArray(chatIds) ? chatIds : getLoadedChatIds();
	const uniqueIds = [...new Set(idsToSave.filter(Boolean))];
	await Promise.all(uniqueIds.map((chatId) => saveLoadedChatAwaitable(chatId)));
}

export async function saveChatsAwaitable(chatIds = null) {
	return enqueueChatWrite(() => persistChatsAwaitable(chatIds));
}

export async function saveChatAwaitable(chatId) {
	return enqueueChatWrite(async () => {
		await saveChatsData(buildSavePayload());
		return saveLoadedChatAwaitable(chatId);
	});
}

export function getChats()          { sortChatsByRecentActivity(); return chats; }
export function getChatById(id)     { return chats.find((chat) => chat.id === id); }
export function getCurrentChatId()  { return currentChatId; }
export function setCurrentChatId(id){ currentChatId = id; }

export function clearCurrentChatId() {
	currentChatId = null;
}

export function createNewChat() {
	let createdAt = Date.now();
	while (chats.some((chat) => chat.id === String(createdAt) || normalizeTimestamp(chat.createdAt, 0) === createdAt)) {
		createdAt += 1;
	}

	const chat = {
		id: String(createdAt),
		title: "New Chat",
		createdAt,
		updatedAt: createdAt,
		graph: createEmptyGraph(),
		toolScope: normalizeToolScope(getLastSelectedToolScope() || DEFAULT_TOOL_SCOPE),
		researchEnabled: false,
	};

	chats.unshift(chat);
	sortChatsByRecentActivity();
	currentChatId = chat.id;
	saveChats();
	return chat;
}

export function updateChatTitle(chatId, firstMessage) {
	const chat = getChatById(chatId);
	if (chat && chat.title === "New Chat" && firstMessage) {
		chat.title = firstMessage.slice(0, 30) + (firstMessage.length > 30 ? "..." : "");
		chat.updatedAt = Date.now();
		sortChatsByRecentActivity();
		saveChats();
	}
}

export function renameChat(chatId, newTitle) {
	const chat = getChatById(chatId);
	if (chat && typeof newTitle === "string" && newTitle.trim()) {
		chat.title = newTitle.trim();
		chat.updatedAt = Date.now();
		sortChatsByRecentActivity();
		saveChats();
		return true;
	}
	return false;
}

export function deleteChat(chatId) {
	const id = String(chatId || "");
	if (!id) return;

	chats = chats.filter((chat) => chat.id !== id);
	sortChatsByRecentActivity();
	if (currentChatId === id) currentChatId = chats.length ? chats[0].id : null;
	pins = pins.filter((pinId) => pinId !== id);

	enqueueChatWrite(async () => {
		await deleteChatData(id);
		await saveChatsData(buildSavePayload());
	}).catch((err) => {
		console.error("[Store] Failed to delete chat:", err);
	});
}

export function isChatPinned(chatId) {
	return pins.includes(String(chatId));
}

export function togglePinChat(chatId) {
	const id = String(chatId || "");
	if (!id) return;
	const idx = pins.indexOf(id);
	if (idx !== -1) pins.splice(idx, 1);
	else pins.push(id);
	saveChats();
}

export function getChatModel(chatId) {
	return getChatById(chatId)?.model || null;
}

export function getChatToolScope(chatId) {
	const toolScope = getChatById(chatId)?.toolScope;
	return normalizeToolScope(toolScope);
}

export function getChatResearchEnabled(chatId) {
	return getChatById(chatId)?.researchEnabled === true;
}

export function setChatModel(chatId, model) {
	const chat = getChatById(chatId);
	if (!chat) return;
	if (model) chat.model = model;
	else delete chat.model;
	saveChats();
}

export function setChatToolScope(chatId, enabledPackIds, options = {}) {
	const chat = getChatById(chatId);
	if (!chat) return;
	chat.toolScope = normalizeToolScope({
		useDefaultPacks: options.useDefaultPacks === true,
		enabledPackIds,
	});
	setLastSelectedToolScope(chat.toolScope);
	saveChats();
}

export function setChatResearchEnabled(chatId, enabled) {
	const chat = getChatById(chatId);
	if (!chat) return;
	const nextEnabled = enabled === true;
	chat.researchEnabled = nextEnabled;
	(async () => {
		const loaded = await ensureChatLoaded(chat.id);
		if (!loaded) return;
		loaded.researchEnabled = nextEnabled;
		await saveChatAwaitable(chat.id);
	})().catch((err) => {
		console.error("[Store] Failed to save chat research state:", err);
	});
}

export function getLastSelectedModel() {
	try { return localStorage.getItem(LAST_MODEL_KEY) || null; } catch { return null; }
}

export function setLastSelectedModel(model) {
	try {
		if (model) localStorage.setItem(LAST_MODEL_KEY, model);
		else localStorage.removeItem(LAST_MODEL_KEY);
	} catch {}
}

export function getLastSelectedToolScope() {
	try {
		const raw = localStorage.getItem(LAST_TOOL_SCOPE_KEY);
		if (!raw) return null;
		const parsed = JSON.parse(raw);
		if (Array.isArray(parsed)) {
			return { useDefaultPacks: false, enabledPackIds: normalizeEnabledPackIds(parsed) };
		}
		if (!parsed || typeof parsed !== 'object') return null;
		return normalizeToolScope(parsed);
	} catch {
		return null;
	}
}

export function setLastSelectedToolScope(toolScope) {
	try {
		if (!toolScope) {
			localStorage.removeItem(LAST_TOOL_SCOPE_KEY);
			return;
		}
		localStorage.setItem(LAST_TOOL_SCOPE_KEY, JSON.stringify(normalizeToolScope(toolScope)));
	} catch {}
}

export async function addMessageToChat(chatId, role, content, attachments = null, parts = null) {
	const chat = await ensureChatLoaded(chatId);
	if (!chat) return null;

	const graph = ensureGraph(chat);
	const parentId = graph.leafId || graph.rootId;
	const node = appendNode(graph, { parentId, role, content, timestamp: Date.now(), attachments, parts });

	chat.updatedAt = Date.now();
	sortChatsByRecentActivity();
	await saveChatAwaitable(chatId);
	return node;
}

export function addChildMessageToChat(chatId, parentId, role, content, attachments = null, parts = null, toolCalls = null, revisionTrace = null) {
	const chat = getChatById(chatId);
	if (!chat || !isChatLoaded(chat)) return null;

	const graph = ensureGraph(chat);
	const node = appendNode(graph, { parentId, role, content, timestamp: Date.now(), attachments, parts, toolCalls, revisionTrace });
	chat.updatedAt = Date.now();
	sortChatsByRecentActivity();
	return node;
}

export { isChatLoaded };
