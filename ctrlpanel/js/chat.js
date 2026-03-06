const CHATS_KEY = "ctrlpanel:chats";
const CURRENT_CHAT_KEY = "ctrlpanel:currentChat";

let chats = [];
let currentChatId = null;

export function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

export function loadChats() {
    try {
        const stored = localStorage.getItem(CHATS_KEY);
        chats = stored ? JSON.parse(stored) : [];
    } catch {
        chats = [];
    }
    try {
        currentChatId = localStorage.getItem(CURRENT_CHAT_KEY) || null;
    } catch {
        currentChatId = null;
    }
}

export function saveChats() {
    try {
        localStorage.setItem(CHATS_KEY, JSON.stringify(chats));
        if (currentChatId) {
            localStorage.setItem(CURRENT_CHAT_KEY, currentChatId);
        } else {
            localStorage.removeItem(CURRENT_CHAT_KEY);
        }
    } catch {}
}

export function getChats() {
    return chats;
}

export function getCurrentChatId() {
    return currentChatId;
}

export function setCurrentChatId(id) {
    currentChatId = id;
}

export function getChatById(id) {
    return chats.find((c) => c.id === id);
}

export function createNewChat() {
    const chat = {
        id: generateId(),
        title: "New Chat",
        messages: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
    };
    chats.unshift(chat);
    currentChatId = chat.id;
    saveChats();
    renderChatList();
    return chat;
}

export function deleteChat(id, onRouteChange) {
    chats = chats.filter((c) => c.id !== id);
    if (currentChatId === id) {
        currentChatId = chats.length > 0 ? chats[0].id : null;
    }
    saveChats();
    renderChatList();
    if (onRouteChange) onRouteChange();
}

export function updateChatTitle(id, firstMessage) {
    const chat = getChatById(id);
    if (chat && chat.title === "New Chat" && firstMessage) {
        chat.title =
            firstMessage.slice(0, 30) +
            (firstMessage.length > 30 ? "..." : "");
        chat.updatedAt = Date.now();
        saveChats();
        renderChatList();
    }
}

export function addMessageToChat(id, role, content) {
    const chat = getChatById(id);
    if (chat) {
        chat.messages.push({ role, content, timestamp: Date.now() });
        chat.updatedAt = Date.now();
        if (chat.messages.length === 1 && role === "user") {
            updateChatTitle(id, content);
        }
        saveChats();
    }
}

export function renderChatList(onDelete) {
    const list = document.getElementById("savedChatsList");
    if (!list) return;

    list.innerHTML = "";

    chats.forEach((chat) => {
        const item = document.createElement("a");
        item.href = `#pages/ai-chat.html?chat=${chat.id}`;
        item.className = "nav-subitem nav-chat-item";
        item.dataset.route = "";
        item.dataset.chatId = chat.id;

        if (chat.id === currentChatId) {
            item.classList.add("active");
        }

        const icon = document.createElement("span");
        icon.className = "nav-subicon";
        icon.setAttribute("aria-hidden", "true");
        icon.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`;

        const label = document.createElement("span");
        label.className = "nav-label";
        label.textContent = chat.title;

        const deleteBtn = document.createElement("button");
        deleteBtn.className = "nav-chat-delete";
        deleteBtn.setAttribute("aria-label", "Delete chat");
        deleteBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>`;
        deleteBtn.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            deleteChat(chat.id, onDelete);
        });

        item.append(icon, label, deleteBtn);
        list.appendChild(item);
    });
}

export function appendMessage(container, role, text, scroll = true) {
    const div = document.createElement("div");
    div.className = `chat-message ${role}`;
    div.setAttribute("role", "article");
    div.setAttribute("aria-label", role === "user" ? "You" : "Assistant");

    const p = document.createElement("p");
    p.textContent = text;
    div.appendChild(p);

    container.appendChild(div);
    if (scroll) {
        container.scrollTop = container.scrollHeight;
    }
}

export function showTyping(container) {
    const div = document.createElement("div");
    div.className = "chat-typing";
    div.setAttribute("aria-label", "Assistant is typing");
    div.innerHTML = "<span></span><span></span><span></span>";
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
    return div;
}

export function loadCurrentChat(setActiveCallback) {
    const messages = document.getElementById("chatMessages");
    const empty = document.getElementById("chatEmpty");
    if (!messages) return;

    messages
        .querySelectorAll(".chat-message, .chat-typing")
        .forEach((el) => el.remove());

    const chat = getChatById(currentChatId);
    if (chat && chat.messages.length > 0) {
        if (empty) empty.hidden = true;
        chat.messages.forEach((msg) => {
            appendMessage(messages, msg.role, msg.content, false);
        });
    } else {
        if (empty) empty.hidden = false;
    }

    renderChatList();
    if (setActiveCallback) setActiveCallback();
}

function initChatDropdowns(root) {
    const dropdowns = root.querySelectorAll(".chat-dropdown");

    dropdowns.forEach((dropdown) => {
        const toggle = dropdown.querySelector(".chat-dropdown-toggle");
        const menu = dropdown.querySelector(".chat-dropdown-menu");
        const isMulti = dropdown.hasAttribute("data-multi");

        toggle?.addEventListener("click", (e) => {
            e.preventDefault();
            const isOpen = dropdown.classList.contains("open");

            root.querySelectorAll(".chat-dropdown.open").forEach((d) => {
                if (d !== dropdown) {
                    d.classList.remove("open");
                    d.querySelector(".chat-dropdown-toggle")?.setAttribute(
                        "aria-expanded",
                        "false"
                    );
                }
            });

            dropdown.classList.toggle("open", !isOpen);
            toggle.setAttribute("aria-expanded", String(!isOpen));
        });

        if (!isMulti) {
            const items = dropdown.querySelectorAll(".chat-dropdown-item");
            const label = dropdown.querySelector(".chat-dropdown-label");

            items.forEach((item) => {
                item.addEventListener("click", () => {
                    items.forEach((i) => {
                        i.classList.remove("selected");
                        i.setAttribute("aria-selected", "false");
                    });
                    item.classList.add("selected");
                    item.setAttribute("aria-selected", "true");

                    if (label) {
                        label.textContent = item.textContent;
                    }

                    dropdown.classList.remove("open");
                    toggle?.setAttribute("aria-expanded", "false");
                });
            });
        }

        if (isMulti) {
            menu?.addEventListener("click", (e) => {
                e.stopPropagation();
            });
        }
    });

    document.addEventListener("click", (e) => {
        if (!e.target.closest(".chat-dropdown")) {
            root.querySelectorAll(".chat-dropdown.open").forEach((d) => {
                d.classList.remove("open");
                d.querySelector(".chat-dropdown-toggle")?.setAttribute(
                    "aria-expanded",
                    "false"
                );
            });
        }
    });
}

export function initChatPage(root, currentRouteGetter, setActiveCallback) {
    if (!root) return;

    const form = root.querySelector("#chatForm");
    const input = root.querySelector("#chatInput");
    const messages = root.querySelector("#chatMessages");
    const empty = root.querySelector("#chatEmpty");
    if (!form || !input || !messages) return;

    initChatDropdowns(root);

    const urlParams = new URLSearchParams(
        location.hash.split("?")[1] || ""
    );
    const chatIdFromUrl = urlParams.get("chat");

    if (chatIdFromUrl && getChatById(chatIdFromUrl)) {
        currentChatId = chatIdFromUrl;
        saveChats();
    }

    loadCurrentChat(setActiveCallback);

    const resizeInput = () => {
        input.style.height = "auto";
        input.style.height = Math.min(input.scrollHeight, 150) + "px";
    };

    input.addEventListener("input", resizeInput);

    input.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            form.requestSubmit();
        }
    });

    form.addEventListener("submit", (e) => {
        e.preventDefault();
        const text = input.value.trim();
        if (!text) return;

        if (!currentChatId || !getChatById(currentChatId)) {
            createNewChat();
        }

        if (empty) empty.hidden = true;
        appendMessage(messages, "user", text);
        addMessageToChat(currentChatId, "user", text);
        input.value = "";
        input.style.height = "auto";

        const typing = showTyping(messages);
        setTimeout(() => {
            typing.remove();
            const response =
                "This is a placeholder response. Connect your AI backend to enable real conversations.";
            appendMessage(messages, "assistant", response);
            addMessageToChat(currentChatId, "assistant", response);
        }, 1000 + Math.random() * 500);
    });

    input.focus();
}

export function clearCurrentChatId() {
    currentChatId = null;
    localStorage.removeItem(CURRENT_CHAT_KEY);
}
