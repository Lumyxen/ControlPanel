function getChatIdFromRoute(route) {
	try {
		return new URLSearchParams(route.split("?")[1] || "").get("chat");
	} catch {
		return null;
	}
}

export function setActive(url, currentChatId) {
	const isChat = url.includes("ai-chat.html");
	const urlChatId = isChat ? getChatIdFromRoute(url) : null;
	const effectiveChatId = urlChatId || currentChatId || null;

	document.body.classList.toggle("is-chat-page", isChat);

	document.querySelectorAll("a[data-route]").forEach((a) => {
		const href = a.getAttribute("href") || "";
		const isChatLink = href.includes("ai-chat.html");

		if (isChatLink && isChat) {
			const linkChatId = a.dataset.chatId || null;
			const isNewChatLink = a.hasAttribute("data-new-chat");

			if (linkChatId) {
				a.classList.toggle("active", linkChatId === effectiveChatId);
			} else if (isNewChatLink) {
				a.classList.toggle("active", !effectiveChatId);
			} else {
				a.classList.remove("active");
			}
			return;
		}
		a.classList.toggle("active", href === "#" + url.split("?")[0]);
	});

	const navGroup = document.querySelector('[data-nav-group="ai-chat"]');
	if (navGroup) navGroup.classList.toggle("has-active", isChat);
}

export function initNavGroups() {
	document.querySelectorAll(".nav-group-toggle").forEach((toggle) => {
		toggle.addEventListener("click", () => {
			const group = toggle.closest(".nav-group");
			const expanded = toggle.getAttribute("aria-expanded") === "true";
			toggle.setAttribute("aria-expanded", String(!expanded));
			group.classList.toggle("collapsed", expanded);
		});
	});
}

export function initSidebarToggle() {
	const toggleBtn = document.getElementById("sidebarToggle");
	if (!toggleBtn) return;
	toggleBtn.addEventListener("click", () => {
		const collapsed = document.body.classList.toggle("sidebar-collapsed");
		toggleBtn.setAttribute("aria-expanded", String(!collapsed));
	});
	toggleBtn.setAttribute("aria-expanded", String(!document.body.classList.contains("sidebar-collapsed")));
}
