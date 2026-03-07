export const THEME_KEY = "ctrlpanel:theme";
export const DEFAULT_THEME = "everforest-harddark-green";

import { getModels } from "./api.js";

export const PALETTES = {
	everforest: {
		label: "Everforest",
		flavours: {
			harddark: { label: "Hard Dark", dark: true },
			dark: { label: "Dark", dark: true },
			softdark: { label: "Soft Dark", dark: true },
			hardlight: { label: "Hard Light", dark: false },
			light: { label: "Light", dark: false },
			softlight: { label: "Soft Light", dark: false },
		},
		accents:["red", "orange", "yellow", "green", "aqua", "blue", "purple"],
		defaultFlavour: "harddark",
		defaultAccent: "green",
		accentVar: "--ef",
	},
	catppuccin: {
		label: "Catppuccin",
		flavours: {
			latte: { label: "Latte", dark: false },
			frappe: { label: "Frappé", dark: true },
			macchiato: { label: "Macchiato", dark: true },
			mocha: { label: "Mocha", dark: true },
		},
		accents:["rosewater", "flamingo", "pink", "mauve", "red", "maroon", "peach", "yellow", "green", "teal", "sky", "sapphire", "blue", "lavender"],
		defaultFlavour: "mocha",
		defaultAccent: "green",
		accentVar: "--ctp",
	},
};

export const PALETTE_ORDER = ["everforest", "catppuccin"];

let currentTheme = null;

export function splitThemeKey(key) {
	const parts = String(key || "").split("-");
	if (parts.length < 3) return { palette: null, flavour: null, accent: null };
	return {
		palette: parts[0],
		flavour: parts.slice(1, -1).join("-"),
		accent: parts.at(-1),
	};
}

export const isValidPalette = (p) => p in PALETTES;
export const isValidFlavour = (p, f) => isValidPalette(p) && f in PALETTES[p].flavours;
export const isValidAccent = (p, a) => isValidPalette(p) && PALETTES[p].accents.includes(a);

export function coerceTheme(key) {
	const { palette, flavour, accent } = splitThemeKey(key);
	const fixedPalette = isValidPalette(palette) ? palette : "everforest";
	const data = PALETTES[fixedPalette];
	const fixedFlavour = isValidFlavour(fixedPalette, flavour) ? flavour : data.defaultFlavour;
	const fixedAccent = isValidAccent(fixedPalette, accent) ? accent : data.defaultAccent;
	return `${fixedPalette}-${fixedFlavour}-${fixedAccent}`;
}

export function getCurrentTheme() { return currentTheme; }

export function setTheme(themeKey, { persist = true, syncUI = true } = {}) {
	const coerced = coerceTheme(themeKey);
	document.documentElement.setAttribute("data-theme", coerced);
	currentTheme = coerced;
	if (persist) {
		try { localStorage.setItem(THEME_KEY, coerced); } catch {}
	}
	if (syncUI) {
		const outlet = document.querySelector('[data-fragment="main"]');
		if (outlet) syncSettingsUI(outlet);
	}
}

export function initTheme() {
	let initial;
	try { initial = localStorage.getItem(THEME_KEY); } catch {}
	initial ||= document.documentElement.getAttribute("data-theme") || DEFAULT_THEME;
	setTheme(initial, { persist: false, syncUI: false });
}

function createTile(type, name, value, labelText) {
	const label = document.createElement("label");
	label.className = `${type}-tile`;
	label.setAttribute("aria-checked", "false");
	const input = document.createElement("input");
	input.type = "radio";
	input.name = name;
	input.value = value;
	const dot = document.createElement("span");
	dot.className = "dot";
	dot.setAttribute("aria-hidden", "true");
	const text = document.createElement("span");
	text.textContent = labelText;
	label.append(input, dot, text);
	return label;
}

function generatePaletteSelector(container) {
	container.innerHTML = "";
	PALETTE_ORDER.forEach((id) => {
		container.appendChild(createTile("palette", "palette", id, PALETTES[id].label));
	});
}

function generateFlavourSelector(container, paletteId) {
	container.innerHTML = "";
	const palette = PALETTES[paletteId];
	if (!palette) return;
	Object.entries(palette.flavours).forEach(([id, data]) => {
		container.appendChild(createTile("flavour", "flavour", id, data.label));
	});
}

function generateAccentSelector(container, paletteId) {
	container.innerHTML = "";
	const palette = PALETTES[paletteId];
	if (!palette) return;
	palette.accents.forEach((id) => {
		const btn = document.createElement("button");
		btn.type = "button";
		btn.className = "accent-chip";
		btn.setAttribute("role", "radio");
		btn.dataset.accent = id;
		btn.style.setProperty("--swatch", `var(${palette.accentVar}-${id})`);
		btn.setAttribute("aria-label", id.charAt(0).toUpperCase() + id.slice(1));
		btn.setAttribute("aria-checked", "false");
		btn.tabIndex = -1;
		container.appendChild(btn);
	});
}

export function syncSettingsUI(root) {
	if (!root || !currentTheme) return;
	const { palette, flavour, accent } = splitThemeKey(currentTheme);

	root.querySelectorAll('input[name="palette"]').forEach((input) => {
		const checked = input.value === palette;
		input.checked = checked;
		const tile = input.closest(".palette-tile");
		if (tile) {
			tile.classList.toggle("selected", checked);
			tile.setAttribute("aria-checked", String(checked));
		}
	});

	root.querySelectorAll('input[name="flavour"]').forEach((input) => {
		const checked = input.value === flavour;
		input.checked = checked;
		const tile = input.closest(".flavour-tile");
		if (tile) {
			tile.classList.toggle("selected", checked);
			tile.setAttribute("aria-checked", String(checked));
		}
	});

	root.querySelectorAll('button[data-accent][role="radio"]').forEach((btn) => {
		const active = btn.dataset.accent === accent;
		btn.classList.toggle("selected", active);
		btn.setAttribute("aria-checked", String(active));
		btn.tabIndex = active ? 0 : -1;
	});
}

export function initSettingsPage(root) {
	if (!root) return;
	const paletteList = root.querySelector("[data-palette-list]");
	const flavourList = root.querySelector("[data-flavour-list]");
	const accentGrid = root.querySelector("[data-accent-grid]");
	if (!paletteList || !flavourList || !accentGrid) return;

	const { palette: currentPalette } = splitThemeKey(currentTheme);

	generatePaletteSelector(paletteList);
	generateFlavourSelector(flavourList, currentPalette);
	generateAccentSelector(accentGrid, currentPalette);

	paletteList.addEventListener("change", (e) => {
		if (e.target.name !== "palette") return;
		const newPalette = e.target.value;
		const data = PALETTES[newPalette];
		if (!data) return;
		generateFlavourSelector(flavourList, newPalette);
		generateAccentSelector(accentGrid, newPalette);
		setTheme(`${newPalette}-${data.defaultFlavour}-${data.defaultAccent}`);
	});

	flavourList.addEventListener("change", (e) => {
		if (e.target.name !== "flavour") return;
		const { palette, accent } = splitThemeKey(currentTheme);
		const fixedAccent = isValidAccent(palette, accent) ? accent : PALETTES[palette].defaultAccent;
		setTheme(`${palette}-${e.target.value}-${fixedAccent}`);
	});

	accentGrid.addEventListener("click", (e) => {
		const btn = e.target.closest("button[data-accent]");
		if (!btn) return;
		const { palette, flavour } = splitThemeKey(currentTheme);
		const accent = btn.dataset.accent;
		if (isValidAccent(palette, accent)) setTheme(`${palette}-${flavour}-${accent}`);
	});

	accentGrid.addEventListener("keydown", (e) => {
		const navKeys = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"];
		if (!navKeys.includes(e.key) && e.key !== " " && e.key !== "Enter") return;
		const items = [...accentGrid.querySelectorAll('button[data-accent][role="radio"]')];
		if (!items.length) return;
		const currentIdx = items.findIndex((el) => el.classList.contains("selected"));
		let nextIdx = currentIdx;

		if (navKeys.includes(e.key)) {
			e.preventDefault();
			const cols = parseInt(getComputedStyle(accentGrid).getPropertyValue("--cols") || "7", 10);
			const moves = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -cols, ArrowDown: cols };
			nextIdx = (currentIdx + moves[e.key] + items.length) % items.length;
			items[nextIdx]?.focus();
		} else {
			e.preventDefault();
			(document.activeElement?.closest('button[data-accent][role="radio"]') || items[currentIdx])?.click();
		}
	});

	syncSettingsUI(root);

	// API Status configuration
	const apiStatus = root.querySelector("#api-status");
	const refreshApiBtn = root.querySelector("#refresh-api-status");

	if (apiStatus) {
		const updateStatus = async () => {
			apiStatus.textContent = "Checking...";
			apiStatus.className = "badge";
			try {
				const res = await getModels();
				if (res && !res.error && res.data && res.data.length > 0) {
					apiStatus.textContent = "Connected";
					apiStatus.className = "badge badge-success";
				} else {
					apiStatus.textContent = "Error: " + (res?.error || "Unable to fetch models");
					apiStatus.className = "badge badge-error";
				}
			} catch (err) {
				apiStatus.textContent = "Error: " + err.message;
				apiStatus.className = "badge badge-error";
			}
		};

		if (refreshApiBtn) {
			refreshApiBtn.addEventListener("click", updateStatus);
		}

		// Check status on load
		updateStatus();
	}
}