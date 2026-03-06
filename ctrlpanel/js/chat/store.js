import { createEmptyGraph, ensureGraph } from "./graph.js";
import { generateId } from "./util.js";

const CHATS_KEY = "ctrlpanel:chats";
const CURRENT_CHAT_KEY = "ctrlpanel:currentChat";
const PINS_KEY = "ctrlpanel:pins";

let chats =[];
let currentChatId = null;

export function loadChats() {
	try {
		const stored = localStorage.getItem(CHATS_KEY);
		chats = stored ? JSON.parse(stored) : [];
		if (!Array.isArray(chats)) chats =[];
	} catch {
		chats =[];
	}
	chats.forEach((c) => ensureGraph(c));
	try {
		currentChatId = localStorage.getItem(CURRENT_CHAT_KEY) || null;
	} catch {
		currentChatId = null;
	}
}

export function saveChats() {
	try {
		localStorage.setItem(CHATS_KEY, JSON.stringify(chats));
		if (currentChatId) localStorage.setItem(CURRENT_CHAT_KEY, currentChatId);
		else localStorage.removeItem(CURRENT_CHAT_KEY);
	} catch {}
}

export function getChats() { return chats; }
export function getChatById(id) { return chats.find((c) => c.id === id); }
export function getCurrentChatId() { return currentChatId; }
export function setCurrentChatId(id) { currentChatId = id; }

export function clearCurrentChatId() {
	currentChatId = null;
	try { localStorage.removeItem(CURRENT_CHAT_KEY); } catch {}
}

export function createNewChat() {
	const chat = {
		id: generateId(),
		title: "New Chat",
		createdAt: Date.now(),
		updatedAt: Date.now(),
		graph: createEmptyGraph(),
		modelId: localStorage.getItem("ctrlpanel:lastSelectedModel") || null,
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

function loadPinnedChatIds() {
	try {
		const raw = localStorage.getItem(PINS_KEY);
		const parsed = raw ? JSON.parse(raw) :[];
		return Array.isArray(parsed) ? parsed.map(String) : [];
	} catch {
		return[];
	}
}

function savePinnedChatIds(ids) {
	try { localStorage.setItem(PINS_KEY, JSON.stringify(ids)); } catch {}
}

export function isChatPinned(chatId) {
	return new Set(loadPinnedChatIds()).has(String(chatId));
}

export function togglePinChat(chatId) {
	const id = String(chatId || "");
	if (!id) return;
	const pinned = new Set(loadPinnedChatIds());
	if (pinned.has(id)) pinned.delete(id);
	else pinned.add(id);
	savePinnedChatIds([...pinned]);
}

export function deleteChat(chatId) {
	const id = String(chatId || "");
	if (!id) return;
	chats = chats.filter((c) => c.id !== id);
	if (currentChatId === id) currentChatId = chats.length ? chats[0].id : null;
	const pinned = new Set(loadPinnedChatIds());
	if (pinned.has(id)) {
		pinned.delete(id);
		savePinnedChatIds([...pinned]);
	}
	saveChats();
}

export function addMessageToChat(chatId, role, content, attachments = null, parts = null) {
	const chat = getChatById(chatId);
	if (!chat) return null;
	const graph = ensureGraph(chat);
	
	// Just get the current end of the thread
	const parentId = graph.leafId || graph.rootId;
	
	// Append directly as a child of the current leaf
	const node = appendNode(graph, { parentId, role, content, timestamp: Date.now(), attachments, parts });
	
	chat.updatedAt = Date.now();
	if (computeThreadNodeIds(graph).length === 1 && role === "user") {
		// For title, use text content from parts or content string
		const titleText = parts
			? parts.filter(p => p.type === "text").map(p => p.content).join(" ")
			: String(content || "");
		updateChatTitle(chatId, titleText);
	}
	saveChats();
	return node;
}

export function addChildMessageToChat(chatId, parentId, role, content, attachments = null, parts = null) {
	const chat = getChatById(chatId);
	if (!chat) return null;
	const graph = ensureGraph(chat);
	const node = appendNode(graph, { parentId, role, content, timestamp: Date.now(), attachments, parts });
	chat.updatedAt = Date.now();
	saveChats();
	return node;
}

// Re-imported here to avoid circular dependency issues at module load time
import { appendNode, computeThreadNodeIds } from "./graph.js";