// www/js/theme.js
// Theme data, palette/flavour/accent selectors, and UI sync.
// All settings page logic has been moved to ./settings/page.js.

export const THEME_KEY    = "ctrlpanel:theme";
export const DEFAULT_THEME = "everforest-harddark-green";

export const PALETTES = {
	everforest: {
		label: "Everforest",
		flavours: {
			harddark:  { label: "Hard Dark",  dark: true  },
			dark:      { label: "Dark",       dark: true  },
			softdark:  { label: "Soft Dark",  dark: true  },
			hardlight: { label: "Hard Light", dark: false },
			light:     { label: "Light",      dark: false },
			softlight: { label: "Soft Light", dark: false },
		},
		accents: ["red", "orange", "yellow", "green", "aqua", "blue", "purple"],
		defaultFlavour: "harddark",
		defaultAccent:  "green",
		accentVar: "--ef",
	},
	catppuccin: {
		label: "Catppuccin",
		flavours: {
			latte:     { label: "Latte",     dark: false },
			frappe:    { label: "Frappé",    dark: true  },
			macchiato: { label: "Macchiato", dark: true  },
			mocha:     { label: "Mocha",     dark: true  },
		},
		accents: ["rosewater", "flamingo", "pink", "mauve", "red", "maroon", "peach", "yellow", "green", "teal", "sky", "sapphire", "blue", "lavender"],
		defaultFlavour: "mocha",
		defaultAccent:  "green",
		accentVar: "--ctp",
	},
};

export const PALETTE_ORDER = ["everforest", "catppuccin"];

let currentTheme = null;

// ─── Theme key helpers ────────────────────────────────────────────────────────

export function splitThemeKey(key) {
	const parts = String(key || "").split("-");
	if (parts.length < 3) return { palette: null, flavour: null, accent: null };
	return { palette: parts[0], flavour: parts.slice(1, -1).join("-"), accent: parts.at(-1) };
}

export const isValidPalette = (p)    => p in PALETTES;
export const isValidFlavour  = (p, f) => isValidPalette(p) && f in PALETTES[p].flavours;
export const isValidAccent   = (p, a) => isValidPalette(p) && PALETTES[p].accents.includes(a);

export function coerceTheme(key) {
	const { palette, flavour, accent } = splitThemeKey(key);
	const fp = isValidPalette(palette) ? palette : "everforest";
	const d  = PALETTES[fp];
	return `${fp}-${isValidFlavour(fp, flavour) ? flavour : d.defaultFlavour}-${isValidAccent(fp, accent) ? accent : d.defaultAccent}`;
}

// ─── Theme application ────────────────────────────────────────────────────────

export function setTheme(themeKey, { persist = true, syncUI = true } = {}) {
	const coerced = coerceTheme(themeKey);
	document.documentElement.setAttribute("data-theme", coerced);
	currentTheme = coerced;
	if (persist) { try { localStorage.setItem(THEME_KEY, coerced); } catch {} }
	if (syncUI) {
		const root = document.querySelector('[data-fragment="main"]');
		if (root) syncSettingsUI(root);
	}
}

export function initTheme() {
	let initial;
	try { initial = localStorage.getItem(THEME_KEY); } catch {}
	initial ||= document.documentElement.getAttribute("data-theme") || DEFAULT_THEME;
	setTheme(initial, { persist: false, syncUI: false });
}

// ─── Tile factory (shared by all selector builders) ──────────────────────────

function createTile(type, name, value, labelText) {
	const label = document.createElement("label");
	label.className = `${type}-tile`;
	label.setAttribute("aria-checked", "false");
	const input = document.createElement("input");
	input.type = "radio"; input.name = name; input.value = value;
	const dot = document.createElement("span");
	dot.className = "dot"; dot.setAttribute("aria-hidden", "true");
	const text = document.createElement("span");
	text.textContent = labelText;
	label.append(input, dot, text);
	return label;
}

// ─── Selector builders (exported for settings/page.js) ───────────────────────

export function generatePaletteSelector(c) {
	c.innerHTML = "";
	PALETTE_ORDER.forEach(id => c.appendChild(createTile("palette", "palette", id, PALETTES[id].label)));
}

export function generateFlavourSelector(c, pid) {
	c.innerHTML = "";
	const p = PALETTES[pid]; if (!p) return;
	Object.entries(p.flavours).forEach(([id, d]) => c.appendChild(createTile("flavour", "flavour", id, d.label)));
}

export function generateAccentSelector(c, pid) {
	c.innerHTML = "";
	const p = PALETTES[pid]; if (!p) return;
	p.accents.forEach(id => {
		const btn = document.createElement("button");
		btn.type = "button";
		btn.className = "accent-chip";
		btn.setAttribute("role", "radio");
		btn.dataset.accent = id;
		btn.style.setProperty("--swatch", `var(${p.accentVar}-${id})`);
		btn.setAttribute("aria-label", id.charAt(0).toUpperCase() + id.slice(1));
		btn.setAttribute("aria-checked", "false");
		btn.tabIndex = -1;
		c.appendChild(btn);
	});
}

// ─── Sync UI to current theme ─────────────────────────────────────────────────
// Marks the correct palette/flavour/accent tiles as selected.

export function syncSettingsUI(root) {
	if (!root || !currentTheme) return;
	const { palette, flavour, accent } = splitThemeKey(currentTheme);

	root.querySelectorAll('input[name="palette"]').forEach(i => {
		const ok = i.value === palette; i.checked = ok;
		const t = i.closest(".palette-tile");
		if (t) { t.classList.toggle("selected", ok); t.setAttribute("aria-checked", String(ok)); }
	});
	root.querySelectorAll('input[name="flavour"]').forEach(i => {
		const ok = i.value === flavour; i.checked = ok;
		const t = i.closest(".flavour-tile");
		if (t) { t.classList.toggle("selected", ok); t.setAttribute("aria-checked", String(ok)); }
	});
	root.querySelectorAll('button[data-accent][role="radio"]').forEach(b => {
		const ok = b.dataset.accent === accent;
		b.classList.toggle("selected", ok);
		b.setAttribute("aria-checked", String(ok));
		b.tabIndex = ok ? 0 : -1;
	});
}
