import { appendNode, createEmptyGraph, ensureGraph } from "./graph.js";
import { deleteChatData, getChatData, getChatsData, saveChatData, saveChatsData } from "../../core/http.js";

const LAST_MODEL_KEY = "ctrlpanel:lastModel";

let chats = [];
let currentChatId = null;
let pins = [];

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
	if (chat?.toolScope && typeof chat.toolScope === 'object') summary.toolScope = chat.toolScope;
	return summary;
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
	replaceChatAt(index, merged);
	return chats[index];
}

export function saveChats() {
	(async () => {
		await saveChatsAwaitable();
	})().catch((err) => {
		console.error("[Store] Failed to save chats:", err);
	});
}

export async function saveChatsAwaitable(chatIds = null) {
	await saveChatsData(buildSavePayload());

	const idsToSave = Array.isArray(chatIds) ? chatIds : getLoadedChatIds();
	const uniqueIds = [...new Set(idsToSave.filter(Boolean))];
	await Promise.all(uniqueIds.map((chatId) => saveLoadedChatAwaitable(chatId)));
}

export async function saveChatAwaitable(chatId) {
	await saveChatsData(buildSavePayload());
	return saveLoadedChatAwaitable(chatId);
}

export function getChats()          { return chats; }
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
		toolScope: { enabledPackIds: [] },
	};

	chats.unshift(chat);
	currentChatId = chat.id;
	saveChats();
	return chat;
}

export function updateChatTitle(chatId, firstMessage) {
	const chat = getChatById(chatId);
	if (chat && chat.title === "New Chat" && firstMessage) {
		chat.title = firstMessage.slice(0, 30) + (firstMessage.length > 30 ? "..." : "");
		chat.updatedAt = Date.now();
		saveChats();
	}
}

export function renameChat(chatId, newTitle) {
	const chat = getChatById(chatId);
	if (chat && typeof newTitle === "string" && newTitle.trim()) {
		chat.title = newTitle.trim();
		chat.updatedAt = Date.now();
		saveChats();
		return true;
	}
	return false;
}

export function deleteChat(chatId) {
	const id = String(chatId || "");
	if (!id) return;

	chats = chats.filter((chat) => chat.id !== id);
	if (currentChatId === id) currentChatId = chats.length ? chats[0].id : null;
	pins = pins.filter((pinId) => pinId !== id);

	(async () => {
		await deleteChatData(id);
		await saveChatsData(buildSavePayload());
	})().catch((err) => {
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
	return toolScope && typeof toolScope === 'object'
		? { enabledPackIds: Array.isArray(toolScope.enabledPackIds) ? [...toolScope.enabledPackIds] : [] }
		: { enabledPackIds: [] };
}

export function setChatModel(chatId, model) {
	const chat = getChatById(chatId);
	if (!chat) return;
	if (model) chat.model = model;
	else delete chat.model;
	saveChats();
}

export function setChatToolScope(chatId, enabledPackIds) {
	const chat = getChatById(chatId);
	if (!chat) return;
	chat.toolScope = {
		enabledPackIds: Array.isArray(enabledPackIds)
			? [...new Set(enabledPackIds.filter(Boolean).map(String))]
			: [],
	};
	chat.updatedAt = Date.now();
	saveChats();
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

export async function addMessageToChat(chatId, role, content, attachments = null, parts = null) {
	const chat = await ensureChatLoaded(chatId);
	if (!chat) return null;

	const graph = ensureGraph(chat);
	const parentId = graph.leafId || graph.rootId;
	const node = appendNode(graph, { parentId, role, content, timestamp: Date.now(), attachments, parts });

	chat.updatedAt = Date.now();
	await saveChatAwaitable(chatId);
	return node;
}

export function addChildMessageToChat(chatId, parentId, role, content, attachments = null, parts = null, toolCalls = null, revisionTrace = null) {
	const chat = getChatById(chatId);
	if (!chat || !isChatLoaded(chat)) return null;

	const graph = ensureGraph(chat);
	const node = appendNode(graph, { parentId, role, content, timestamp: Date.now(), attachments, parts, toolCalls, revisionTrace });
	chat.updatedAt = Date.now();
	return node;
}

export { isChatLoaded };
