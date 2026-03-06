import { deleteChat, getChats, getCurrentChatId, isChatPinned, renameChat, togglePinChat } from "./store.js";

const pinIconSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.579 14.579L11.6316 17.5264L10.7683 16.6631C10.3775 16.2723 10.1579 15.7422 10.1579 15.1894V13.1053L7.21052 10.158L5 9.42111L9.42111 5L10.158 7.21052L13.1053 10.1579L15.1894 10.1579C15.7422 10.1579 16.2722 10.3775 16.6631 10.7683L17.5264 11.6316L14.579 14.579ZM14.579 14.579L19 19"/></svg>`;

const unpinIconSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.579 14.579L11.6316 17.5264L11.0526 16.9474M14.579 14.579L17.5264 11.6316L16.9474 11.0526M14.579 14.579L19 19M5 19L10.1579 13.8421M19 5L13.8421 10.1579M13.8421 10.1579L13.1053 10.1579L10.158 7.21052L9.42111 5L5 9.42111L7.21052 10.158L10.1579 13.1053V13.8421M13.8421 10.1579L10.1579 13.8421"/></svg>`;

const deleteIconSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6H20L18.4199 20.2209C18.3074 21.2337 17.4512 22 16.4321 22H7.56786C6.54876 22 5.69264 21.2337 5.5801 20.2209L4 6Z"/><path d="M7.34491 3.14716C7.67506 2.44685 8.37973 2 9.15396 2H14.846C15.6203 2 16.3249 2.44685 16.6551 3.14716L18 6H6L7.34491 3.14716Z"/><path d="M2 6H22"/><path d="M10 11V16"/><path d="M14 11V16"/></svg>`;
const editIconSvg = `<svg viewBox="0 -0.5 21 21" version="1.1" xmlns="http://www.w3.org/2000/svg"><g stroke="none" stroke-width="1" fill="none" fill-rule="evenodd"><g fill="currentColor"><path d="M3.15,14 C2.5704,14 2.1,13.552 2.1,13 L2.1,7 C2.1,6.448 2.5704,6 3.15,6 C3.7296,6 4.2,5.552 4.2,5 C4.2,4.448 3.7296,4 3.15,4 L2.1,4 C0.93975,4 0,4.895 0,6 L0,14 C0,15.105 0.93975,16 2.1,16 L3.15,16 C3.7296,16 4.2,15.552 4.2,15 C4.2,14.448 3.7296,14 3.15,14 M18.9,4 L11.55,4 C10.9704,4 10.5,4.448 10.5,5 C10.5,5.552 10.9704,6 11.55,6 L17.85,6 C18.4296,6 18.9,6.448 18.9,7 L18.9,13 C18.9,13.552 18.4296,14 17.85,14 L11.55,14 C10.9704,14 10.5,14.448 10.5,15 C10.5,15.552 10.9704,16 11.55,16 L18.9,16 C20.06025,16 21,15.105 21,14 L21,6 C21,4.895 20.06025,4 18.9,4 M10.5,19 C10.5,19.552 10.0296,20 9.45,20 L5.25,20 C4.6704,20 4.2,19.552 4.2,19 C4.2,18.448 4.6704,18 5.25,18 L6.3,18 L6.3,2 L5.25,2 C4.6704,2 4.2,1.552 4.2,1 C4.2,0.448 4.6704,0 5.25,0 L9.45,0 C10.0296,0 10.5,0.448 10.5,1 C10.5,1.552 10.0296,2 9.45,2 L8.4,2 L8.4,18 L9.45,18 C10.0296,18 10.5,18.448 10.5,19"/></g></g></svg>`;

export function renderChatList(onDelete) {
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
				renderChatList(onDelete);
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
				renderChatList(onDelete);
				if (onDelete) onDelete();
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
