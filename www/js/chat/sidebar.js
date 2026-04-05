import { deleteChat, getChats, getCurrentChatId, isChatPinned, renameChat, togglePinChat } from "./store.js";

const pinIconSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/></svg>`;

const unpinIconSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5"/><path d="M15 9.34V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H7.89"/><path d="m2 2 20 20"/><path d="M9 9v1.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h11"/></svg>`;

const deleteIconSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>`;
const editIconSvg = `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z"/></svg>`;

// Persist the last onDelete callback so that re-renders triggered internally
// (e.g. from loadCurrentChat, which calls renderChatList with no arguments)
// still fire the correct callback when a chat is deleted.
let _onDelete = null;

export function renderChatList(onDelete) {
	// Update the stored callback only when an explicit one is provided.
	if (onDelete !== undefined) _onDelete = onDelete;
	const effectiveOnDelete = _onDelete;

	const list = document.getElementById("savedChatsList");
	if (!list) return;
	list.innerHTML = "";

	const chats = getChats();
	const currentChatId = getCurrentChatId();
	const pinnedChats = chats.filter((c) => isChatPinned(c.id));
	const regularChats = chats.filter((c) => !isChatPinned(c.id));

	const renderSection = (title, sectionChats) => {
		if (!sectionChats.length) return;
		const h = document.createElement("div");
		h.className = "nav-chat-section-title";
		h.textContent = title;
		list.appendChild(h);

		const section = document.createElement("div");
		section.className = "nav-chat-list";
		list.appendChild(section);

		sectionChats.forEach((chat) => {
			const item = document.createElement("a");
			item.href = `#pages/ai-chat.html?chat=${chat.id}`;
			item.className = "nav-subitem nav-chat-item";
			item.dataset.route = "";
			item.dataset.chatId = chat.id;
			if (chat.id === currentChatId) item.classList.add("active");

			const label = document.createElement("span");
			label.className = "nav-label";
			label.textContent = chat.title;

			const renameBtn = document.createElement("button");
			renameBtn.className = "nav-chat-rename";
			renameBtn.type = "button";
			renameBtn.setAttribute("aria-label", "Rename chat");
			renameBtn.title = "Rename";
			renameBtn.innerHTML = editIconSvg;
			renameBtn.addEventListener("click", (e) => {
				e.preventDefault();
				e.stopPropagation();

				// Mark the item as being edited and temporarily disable anchor behavior
				item.classList.add("editing");
				const originalHref = item.getAttribute("href");
				item.removeAttribute("href");

				// Hide the label (actions are hidden via CSS when editing)
				label.style.display = "none";

				// Create inline input - insert inside the anchor after the icon
				const input = document.createElement("input");
				input.type = "text";
				input.className = "nav-chat-rename-input";
				input.value = chat.title;
				input.setAttribute("aria-label", "Edit chat title");

				// Click-outside handler - strictly checks if click is outside input
				const handleClickOutside = (event) => {
					if (!input.contains(event.target) && !renameBtn.contains(event.target)) {
						commitEdit();
					}
				};

				// Handle commit on Enter or click-outside
				const commitEdit = () => {
					document.removeEventListener("click", handleClickOutside);
					const newTitle = input.value.trim();
					if (newTitle) {
						renameChat(chat.id, newTitle);
						label.textContent = newTitle;
					}
					input.remove();
					label.style.display = "";
					item.classList.remove("editing");
					if (originalHref) item.setAttribute("href", originalHref);
				};

				// Handle cancel on Escape
				const cancelEdit = () => {
					document.removeEventListener("click", handleClickOutside);
					input.remove();
					label.style.display = "";
					item.classList.remove("editing");
					if (originalHref) item.setAttribute("href", originalHref);
				};

				input.addEventListener("keydown", (ke) => {
					if (ke.key === "Enter") {
						ke.preventDefault();
						commitEdit();
					} else if (ke.key === "Escape") {
						ke.preventDefault();
						cancelEdit();
					}
				});

				// Insert input at the beginning of the anchor
				item.prepend(input);
				input.focus();
				input.select();

				// Add click-outside listener with delay to prevent immediate trigger
				setTimeout(() => {
					document.addEventListener("click", handleClickOutside);
				}, 0);
			});

			const pinBtn = document.createElement("button");
			pinBtn.className = "nav-chat-pin";
			pinBtn.type = "button";
			const pinned = isChatPinned(chat.id);
			if (pinned) pinBtn.classList.add("pinned");
			pinBtn.setAttribute("aria-label", pinned ? "Unpin chat" : "Pin chat");
			pinBtn.title = pinned ? "Unpin" : "Pin";
			// Use unpin icon when pinned, pin icon when not pinned
			pinBtn.innerHTML = pinned ? unpinIconSvg : pinIconSvg;
			pinBtn.addEventListener("click", (e) => {
				e.preventDefault();
				e.stopPropagation();
				togglePinChat(chat.id);
				renderChatList();
			});

			const deleteBtn = document.createElement("button");
			deleteBtn.className = "nav-chat-delete";
			deleteBtn.type = "button";
			deleteBtn.setAttribute("aria-label", "Delete chat");
			deleteBtn.title = "Delete";
			deleteBtn.innerHTML = deleteIconSvg;
			deleteBtn.addEventListener("click", (e) => {
				e.preventDefault();
				e.stopPropagation();
				deleteChat(chat.id);
				renderChatList();
				if (effectiveOnDelete) effectiveOnDelete();
			});

			const actionsContainer = document.createElement("span");
			actionsContainer.className = "nav-chat-actions";
			actionsContainer.append(renameBtn, pinBtn, deleteBtn);

			item.append(label, actionsContainer);
			section.appendChild(item);
		});
	};

	renderSection("Pinned", pinnedChats);
	renderSection("Chats", regularChats);
}