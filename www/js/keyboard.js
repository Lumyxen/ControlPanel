let legendVisible = false;
let legendEl = null;

const KEYBINDS = {
    navigation: [
        { keys: ["↑", "k"], desc: "Focus previous item" },
        { keys: ["↓", "j"], desc: "Focus next item" },
        { keys: ["←", "h"], desc: "Focus previous (in grid)" },
        { keys: ["→", "l"], desc: "Focus next (in grid)" },
        { keys: ["Enter", "Space"], desc: "Activate focused item" },
        { keys: ["Tab"], desc: "Next focusable element" },
        { keys: ["Shift+Tab"], desc: "Previous focusable" }
    ],
    global: [
        { keys: ["g h"], desc: "Go to home" },
        { keys: ["g w"], desc: "Go to work" },
        { keys: ["g r"], desc: "Go to research" },
        { keys: ["g c"], desc: "Go to code" },
        { keys: ["g p"], desc: "Go to photos" },
        { keys: ["g a"], desc: "Go to about" },
        { keys: ["g x"], desc: "Go to control panel" },
        { keys: ["?"], desc: "Toggle this legend" }
    ],
    photos: [
        { keys: ["←", "h"], desc: "Previous photo" },
        { keys: ["→", "l"], desc: "Next photo" },
        { keys: ["d"], desc: "Download photo" }
    ]
};

function createLegend() {
    const legend = document.createElement("div");
    legend.id = "keyboard-legend";
    legend.className = "keyboard-legend";
    legend.innerHTML = `
		<div class="legend-header" role="toolbar" aria-label="Legend header">
			<span class="legend-title">Keyboard Shortcuts</span>
			<button class="legend-close" type="button" aria-label="Close legend">×</button>
		</div>
		<div class="legend-content">
			<div class="legend-section">
				<h4>Navigation</h4>
				${KEYBINDS.navigation
            .map(
                (k) => `
					<div class="legend-item">
						<span class="legend-keys">${k.keys.join(", ")}</span>
						<span class="legend-desc">${k.desc}</span>
					</div>`
            )
            .join("")}
			</div>
			<div class="legend-section">
				<h4>Global</h4>
				${KEYBINDS.global
            .map(
                (k) => `
					<div class="legend-item">
						<span class="legend-keys">${k.keys.join(", ")}</span>
						<span class="legend-desc">${k.desc}</span>
					</div>`
            )
            .join("")}
			</div>
			<div class="legend-section">
				<h4>Photo Viewer</h4>
				${KEYBINDS.photos
            .map(
                (k) => `
					<div class="legend-item">
						<span class="legend-keys">${k.keys.join(", ")}</span>
						<span class="legend-desc">${k.desc}</span>
					</div>`
            )
            .join("")}
			</div>
		</div>
	`;
    document.body.appendChild(legend);
    legendEl = legend;

    const closeBtn = legend.querySelector(".legend-close");
    closeBtn.addEventListener("click", () => hideLegend());

    enableLegendDragging(legend);
    return legend;
}

function showLegend() {
    if (!legendEl) createLegend();
    legendEl.classList.add("visible");
    legendVisible = true;
}

function hideLegend() {
    if (!legendEl) return;
    legendEl.classList.remove("visible");
    legendVisible = false;
    try {
        localStorage.setItem("keyboard-legend-seen", "true");
    } catch { }
}

function toggleLegend() {
    if (legendVisible) hideLegend();
    else showLegend();
}

function isHardRefresh() {
    try {
        const navEntries = performance.getEntriesByType("navigation");
        if (navEntries.length > 0) return navEntries[0].type === "reload";
        return performance.navigation && performance.navigation.type === 1;
    } catch {
        return false;
    }
}

function checkFirstVisit() {
    try {
        const seen = localStorage.getItem("keyboard-legend-seen");
        const hardRefresh = isHardRefresh();
        if (!seen || hardRefresh) {
            if (hardRefresh) localStorage.removeItem("keyboard-legend-seen");
            setTimeout(() => showLegend(), 800);
        }
    } catch { }
}

function getFocusableElements(container = document) {
    return Array.from(
        container.querySelectorAll(
            'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )
    ).filter((el) => {
        const style = getComputedStyle(el);
        return (
            style.display !== "none" &&
            style.visibility !== "hidden" &&
            el.offsetParent !== null
        );
    });
}

function getGridFocusables() {
    const grids = ["#photo-grid", "#code-grid", "#projects-grid"];
    for (const selector of grids) {
        const grid = document.querySelector(selector);
        if (grid) {
            return getFocusableElements(grid).filter(
                (el) => el.classList.contains("card") || el.closest(".card")
            );
        }
    }
    return [];
}

function focusNext(reverse = false) {
    const gridItems = getGridFocusables();
    if (!gridItems.length) return false;
    const currentIndex = gridItems.indexOf(document.activeElement);
    let nextIndex;
    if (currentIndex === -1) {
        nextIndex = reverse ? gridItems.length - 1 : 0;
    } else {
        nextIndex = reverse ? currentIndex - 1 : currentIndex + 1;
        if (nextIndex < 0) nextIndex = gridItems.length - 1;
        if (nextIndex >= gridItems.length) nextIndex = 0;
    }
    gridItems[nextIndex]?.focus();
    return true;
}

function focusHorizontal(reverse = false) {
    const gridItems = getGridFocusables();
    if (!gridItems.length) return false;
    const currentIndex = gridItems.indexOf(document.activeElement);
    if (currentIndex === -1) {
        gridItems[reverse ? gridItems.length - 1 : 0]?.focus();
        return true;
    }
    const nextIndex = reverse ? currentIndex - 1 : currentIndex + 1;
    if (nextIndex >= 0 && nextIndex < gridItems.length) {
        gridItems[nextIndex]?.focus();
    }
    return true;
}

function navigateTo(route) {
    window.location.hash = `#/${route}`;
}

function getBaseDomain(hostname) {
    const parts = hostname.split(".");
    if (hostname.endsWith(".lumyxen.me") || hostname === "lumyxen.me") {
        return "lumyxen.me";
    }
    if (parts.length <= 2) return hostname;
    return parts.slice(-2).join(".");
}

function goToControlPanel() {
    const host = window.location.hostname;
    let url = "https://ctrlpanel.lumyxen.me";
    const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
    if (host && host !== "localhost" && !isIp) {
        const base = getBaseDomain(host);
        url = `https://ctrlpanel.${base}`;
    }
    window.location.href = url;
}

function isViewerOpen() {
    return !!document.querySelector(
        "#photo-viewer:not([hidden]), #code-viewer:not([hidden]), #project-viewer:not([hidden])"
    );
}

let gPressed = false;

export function initKeyboardNavigation() {
    checkFirstVisit();

    document.addEventListener("keydown", (e) => {
        const target = e.target;
        const isInput =
            target.tagName === "INPUT" ||
            target.tagName === "TEXTAREA" ||
            target.tagName === "SELECT";

        // Normalize key for combos
        const k =
            e.key && e.key.length === 1 ? e.key.toLowerCase() : e.key;

        if (k === "?" && !isInput) {
            e.preventDefault();
            toggleLegend();
            return;
        }

        // Do NOT close legend on Escape; viewers handle their own Escape
        if (k === "Escape") {
            return;
        }

        if (k === "g" && !isInput) {
            gPressed = true;
            return;
        }
        if (gPressed && !isInput) {
            switch (k) {
                case "h":
                    e.preventDefault();
                    navigateTo("home");
                    return;
                case "w":
                    e.preventDefault();
                    navigateTo("work");
                    return;
                case "r":
                    e.preventDefault();
                    navigateTo("research");
                    return;
                case "c":
                    e.preventDefault();
                    navigateTo("code");
                    return;
                case "p":
                    e.preventDefault();
                    navigateTo("photos");
                    return;
                case "a":
                    e.preventDefault();
                    navigateTo("about");
                    return;
                case "x":
                    e.preventDefault();
                    goToControlPanel();
                    return;
            }
        }

        // If a viewer is open, let its own key handlers run
        if (isViewerOpen()) {
            if (k === "d") {
                e.preventDefault();
                document.getElementById("photo-viewer-download")?.click();
            }
            return;
        }

        if (isInput) return;

        switch (k) {
            case "ArrowDown":
            case "j":
                e.preventDefault();
                focusNext(false);
                break;
            case "ArrowUp":
            case "k":
                e.preventDefault();
                focusNext(true);
                break;
            case "ArrowRight":
            case "l":
                e.preventDefault();
                focusHorizontal(false);
                break;
            case "ArrowLeft":
            case "h":
                e.preventDefault();
                focusHorizontal(true);
                break;
            case "Enter":
            case " ":
                if (
                    document.activeElement &&
                    document.activeElement !== document.body
                ) {
                    e.preventDefault();
                    const card = document.activeElement.closest
                        ? document.activeElement.closest(".card")
                        : null;
                    if (card?.click) {
                        card.click();
                    } else {
                        document.activeElement.click?.();
                    }
                }
                break;
        }
    });

    document.addEventListener("keyup", (e) => {
        if ((e.key || "").toLowerCase() === "g") gPressed = false;
    });

    window.addEventListener("blur", () => {
        gPressed = false;
    });

    const style = document.createElement("style");
    style.textContent = `
		.keyboard-legend {
			position: fixed;
			bottom: var(--s4);
			left: var(--s4);
			background: var(--surface);
			border: 1px solid var(--hairline);
			box-shadow: 0 8px 28px rgba(0, 0, 0, 0.45);
			z-index: 998;
			max-width: 360px;
			max-height: 40vh;
			overflow: auto;
			opacity: 0;
			transform: translateY(20px);
			pointer-events: none;
			transition: opacity 200ms ease, transform 200ms ease;
		}
		.keyboard-legend.visible {
			opacity: 1;
			transform: translateY(0);
			pointer-events: auto;
		}
		.legend-header {
			padding: var(--s4);
			border-bottom: 1px solid var(--hairline);
			display: flex;
			justify-content: space-between;
			align-items: center;
			background: var(--surface);
			position: sticky;
			top: 0;
			z-index: 1;
			user-select: none;
			touch-action: none;
		}
		.legend-title {
			font-family: var(--font-mono);
			font-size: 13px;
			font-weight: 600;
			text-transform: uppercase;
			letter-spacing: 0.05em;
			color: var(--accent);
		}
		.legend-close {
			appearance: none;
			background: transparent;
			border: 1px solid var(--border);
			color: var(--muted);
			width: 24px;
			height: 24px;
			display: flex;
			align-items: center;
			justify-content: center;
			cursor: pointer;
			font-size: 18px;
			line-height: 1;
			transition: all 120ms ease;
			padding: 0;
			user-select: none;
		}
		.legend-close:hover,
		.legend-close:focus-visible {
			color: var(--accent);
			border-color: var(--accent);
			background: color-mix(in oklab, var(--accent), transparent 92%);
		}
		.legend-content {
			padding: var(--s4);
			display: flex;
			flex-direction: column;
			gap: var(--s5);
		}
		.legend-section h4 {
			margin: 0 0 var(--s3) 0;
			font-size: 12px;
			font-weight: 600;
			color: var(--text);
			text-transform: uppercase;
			letter-spacing: 0.05em;
			font-family: var(--font-mono);
		}
		.legend-item {
			display: grid;
			grid-template-columns: 100px 1fr;
			gap: var(--s3);
			margin-bottom: var(--s2);
			font-size: 13px;
			align-items: start;
		}
		.legend-keys {
			font-family: var(--font-mono);
			font-size: 11px;
			color: var(--accent);
			white-space: nowrap;
		}
		.legend-desc {
			color: var(--muted);
			font-size: 12px;
			line-height: 1.4;
		}
		.keyboard-legend::-webkit-scrollbar {
			width: 6px;
		}
		.keyboard-legend::-webkit-scrollbar-track {
			background: var(--hairline);
		}
		.keyboard-legend::-webkit-scrollbar-thumb {
			background: var(--border);
			border-radius: 3px;
		}
		.keyboard-legend::-webkit-scrollbar-thumb:hover {
			background: var(--muted);
		}
		@media (pointer: fine) {
			.keyboard-legend, .keyboard-legend * {
				cursor: none !important;
			}
		}
		@media (max-width: 768px) {
			.keyboard-legend {
				left: var(--s3);
				bottom: var(--s3);
				right: var(--s3);
				max-width: none;
			}
			.legend-item {
				grid-template-columns: 80px 1fr;
				gap: var(--s2);
			}
		}
		*:focus-visible {
			outline: 2px solid var(--accent);
			outline-offset: 2px;
		}
		.card:focus-visible {
			outline-offset: -2px;
		}
	`;
    document.head.appendChild(style);
}

function enableLegendDragging(legend) {
    const header = legend.querySelector(".legend-header");
    if (!header) return;

    let dragging = false;
    let startX = 0;
    let startY = 0;
    let offsetX = 0;
    let offsetY = 0;

    const onDown = (e) => {
        if (e.button !== 0 && e.pointerType === "mouse") return;
        if (e.target.closest(".legend-close")) return;
        const rect = legend.getBoundingClientRect();
        legend.style.left = `${rect.left}px`;
        legend.style.top = `${rect.top}px`;
        legend.style.right = "";
        legend.style.bottom = "";
        legend.style.transform = "none";
        startX = e.clientX;
        startY = e.clientY;
        offsetX = e.clientX - rect.left;
        offsetY = e.clientY - rect.top;
        dragging = false;
    };

    const onMove = (e) => {
        if (startX === 0 && startY === 0) return;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        if (!dragging) {
            if (Math.abs(dx) + Math.abs(dy) < 3) return;
            dragging = true;
        }
        let x = e.clientX - offsetX;
        let y = e.clientY - offsetY;
        const maxX = window.innerWidth - legend.offsetWidth;
        const maxY = window.innerHeight - legend.offsetHeight;
        if (x < 0) x = 0;
        if (y < 0) y = 0;
        if (x > maxX) x = maxX;
        if (y > maxY) y = maxY;
        legend.style.left = `${x}px`;
        legend.style.top = `${y}px`;
    };

    const onUp = () => {
        startX = 0;
        startY = 0;
        dragging = false;
    };

    header.addEventListener("pointerdown", onDown);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
}
