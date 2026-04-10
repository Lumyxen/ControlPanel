import { createEmptyGraph, ensureGraph } from "./graph.js";
import { generateId } from "./util.js";
import { getChatsData, saveChatsData } from "../api.js";

// localStorage key for the user's last explicitly-chosen model.
const LAST_MODEL_KEY = "ctrlpanel:lastModel";

let chats = [];
let currentChatId = null;
let pins = []; // array of chat ID strings

// ── Load / Save ───────────────────────────────────────────────────────────────

export async function loadChats() {
	try {
		const data = await getChatsData();
		chats         = Array.isArray(data?.chats) ? data.chats : [];
		currentChatId = data?.currentChatId || null;
		pins          = Array.isArray(data?.pins) ? data.pins.map(String) : [];
	} catch (err) {
		console.warn("[Store] Failed to load chats from backend, starting empty:", err);
		chats         = [];
		currentChatId = null;
		pins          = [];
	}
	chats.forEach((c) => ensureGraph(c));
}

function buildSavePayload() {
	return {
		chats,
		currentChatId: currentChatId || "",
		pins,
	};
}

/**
 * Fire-and-forget save to backend.
 * The backend handles encryption automatically.
 */
export function saveChats() {
	(async () => {
		const payload = buildSavePayload();
		await saveChatsData(payload);
	})().catch((err) => {
		console.error("[Store] Failed to save chats:", err);
	});
}

// ── Basic accessors ───────────────────────────────────────────────────────────

export function getChats()          { return chats; }
export function getChatById(id)     { return chats.find((c) => c.id === id); }
export function getCurrentChatId()  { return currentChatId; }
export function setCurrentChatId(id){ currentChatId = id; }

export function clearCurrentChatId() {
	currentChatId = null;
	saveChats();
}

// ── Chat CRUD ─────────────────────────────────────────────────────────────────

export function createNewChat() {
	const chat = {
		id:        generateId(),
		title:     "New Chat",
		createdAt: Date.now(),
		updatedAt: Date.now(),
		graph:     createEmptyGraph(),
	};
	chats.unshift(chat);
	currentChatId = chat.id;
	saveChats();
	return chat;
}

export function updateChatTitle(chatId, firstMessage) {
	const chat = getChatById(chatId);
	if (chat && chat.title === "New Chat" && firstMessage) {
		chat.title     = firstMessage.slice(0, 30) + (firstMessage.length > 30 ? "..." : "");
		chat.updatedAt = Date.now();
		saveChats();
	}
}

export function renameChat(chatId, newTitle) {
	const chat = getChatById(chatId);
	if (chat && typeof newTitle === "string" && newTitle.trim()) {
		chat.title     = newTitle.trim();
		chat.updatedAt = Date.now();
		saveChats();
		return true;
	}
	return false;
}

export function deleteChat(chatId) {
	const id = String(chatId || "");
	if (!id) return;
	chats = chats.filter((c) => c.id !== id);
	if (currentChatId === id) currentChatId = chats.length ? chats[0].id : null;
	const pinIdx = pins.indexOf(id);
	if (pinIdx !== -1) pins.splice(pinIdx, 1);
	saveChats();
}

// ── Pins ──────────────────────────────────────────────────────────────────────

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

// ── Per-chat model ────────────────────────────────────────────────────────────

export function getChatModel(chatId) {
	return getChatById(chatId)?.model || null;
}

export function setChatModel(chatId, model) {
	const chat = getChatById(chatId);
	if (!chat) return;
	if (model) chat.model = model;
	else delete chat.model;
	saveChats();
}

// ── Last explicitly-selected model (localStorage, browser-local) ──────────────

export function getLastSelectedModel() {
	try { return localStorage.getItem(LAST_MODEL_KEY) || null; } catch { return null; }
}

export function setLastSelectedModel(model) {
	try {
		if (model) localStorage.setItem(LAST_MODEL_KEY, model);
		else localStorage.removeItem(LAST_MODEL_KEY);
	} catch {}
}

// ── Messages ──────────────────────────────────────────────────────────────────

export function addMessageToChat(chatId, role, content, attachments = null, parts = null) {
	const chat = getChatById(chatId);
	if (!chat) return null;
	const graph = ensureGraph(chat);

	const parentId = graph.leafId || graph.rootId;
	const node = appendNode(graph, { parentId, role, content, timestamp: Date.now(), attachments, parts });

	chat.updatedAt = Date.now();
	if (computeThreadNodeIds(graph).length === 1 && role === "user") {
		const titleText = parts
			? parts.filter(p => p.type === "text").map(p => p.content).join(" ")
			: String(content || "");
		updateChatTitle(chatId, titleText);
	}
	saveChats();
	return node;
}

export function addChildMessageToChat(chatId, parentId, role, content, attachments = null, parts = null, toolCalls = null) {
	const chat = getChatById(chatId);
	if (!chat) return null;
	const graph = ensureGraph(chat);
	const node = appendNode(graph, { parentId, role, content, timestamp: Date.now(), attachments, parts, toolCalls });
	chat.updatedAt = Date.now();
	return node;
}

import { appendNode, computeThreadNodeIds } from "./graph.js";