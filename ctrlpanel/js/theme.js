export const THEME_KEY = "ctrlpanel:theme";
export const DEFAULT_THEME = "everforest-harddark-green";

import { getModels } from "./api.js";
import * as SettingsStore from "./settings-store.js";

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
		accents: ["red", "orange", "yellow", "green", "aqua", "blue", "purple"],
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
		accents: ["rosewater", "flamingo", "pink", "mauve", "red", "maroon", "peach", "yellow", "green", "teal", "sky", "sapphire", "blue", "lavender"],
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

// ── Helpers for slider ↔ number input sync ────────────────────────────────────

function linkSliderAndNumber(slider, number, min, max) {
	if (!slider || !number) return;
	slider.addEventListener("input", () => { number.value = slider.value; });
	number.addEventListener("input", () => {
		const v = Math.min(max, Math.max(min, parseFloat(number.value) || min));
		slider.value = v;
	});
}

// ── Populate fields from settings object ──────────────────────────────────────

function populateAISettingsFields(root, settings) {
	if (!settings) return;

	const defaultModelInput = root.querySelector("#default-model-input");
	if (defaultModelInput && settings.defaultModel != null) {
		defaultModelInput.value = settings.defaultModel;
	}

	const temperatureSlider = root.querySelector("#temperature-slider");
	const temperatureInput = root.querySelector("#temperature-input");
	if (settings.temperature != null) {
		const t = parseFloat(settings.temperature) || 0.7;
		if (temperatureSlider) temperatureSlider.value = t;
		if (temperatureInput) temperatureInput.value = t;
	}

	const maxTokensInput = root.querySelector("#max-tokens-input");
	if (maxTokensInput && settings.fallbackMaxOutputTokens != null) {
		maxTokensInput.value = settings.fallbackMaxOutputTokens;
	}

	const systemPromptInput = root.querySelector("#system-prompt-input");
	if (systemPromptInput && settings.systemPrompt != null) {
		systemPromptInput.value = settings.systemPrompt;
	}

	const lmStudioUrlInput = root.querySelector("#lmstudio-url-input");
	if (lmStudioUrlInput && settings.lmStudioUrl != null) {
		lmStudioUrlInput.value = settings.lmStudioUrl;
	}
}

function populateLlamaCppFields(root, settings) {
	if (!settings) return;

	const flashAttn = root.querySelector("#llamacpp-flash-attn");
	if (flashAttn && settings.llamacppFlashAttn != null) {
		flashAttn.checked = Boolean(settings.llamacppFlashAttn);
	}

	const evalBatchSize = root.querySelector("#llamacpp-eval-batch-size");
	if (evalBatchSize && settings.llamacppEvalBatchSize != null) {
		evalBatchSize.value = settings.llamacppEvalBatchSize;
	}

	const ctxSize = root.querySelector("#llamacpp-ctx-size");
	if (ctxSize && settings.llamacppCtxSize != null) {
		ctxSize.value = settings.llamacppCtxSize;
	}

	const gpuLayers = root.querySelector("#llamacpp-gpu-layers");
	if (gpuLayers && settings.llamacppGpuLayers != null) {
		gpuLayers.value = settings.llamacppGpuLayers;
	}

	const threads = root.querySelector("#llamacpp-threads");
	if (threads && settings.llamacppThreads != null) {
		threads.value = settings.llamacppThreads;
	}

	const threadsBatch = root.querySelector("#llamacpp-threads-batch");
	if (threadsBatch && settings.llamacppThreadsBatch != null) {
		threadsBatch.value = settings.llamacppThreadsBatch;
	}

	const topPSlider = root.querySelector("#llamacpp-top-p-slider");
	const topP = root.querySelector("#llamacpp-top-p");
	if (settings.llamacppTopP != null) {
		const v = parseFloat(settings.llamacppTopP) ?? 0.9;
		if (topPSlider) topPSlider.value = v;
		if (topP) topP.value = v;
	}

	const minPSlider = root.querySelector("#llamacpp-min-p-slider");
	const minP = root.querySelector("#llamacpp-min-p");
	if (settings.llamacppMinP != null) {
		const v = parseFloat(settings.llamacppMinP) ?? 0.05;
		if (minPSlider) minPSlider.value = v;
		if (minP) minP.value = v;
	}

	const repeatPenaltySlider = root.querySelector("#llamacpp-repeat-penalty-slider");
	const repeatPenalty = root.querySelector("#llamacpp-repeat-penalty");
	if (settings.llamacppRepeatPenalty != null) {
		const v = parseFloat(settings.llamacppRepeatPenalty) ?? 1.15;
		if (repeatPenaltySlider) repeatPenaltySlider.value = v;
		if (repeatPenalty) repeatPenalty.value = v;
	}
}

// ── Main settings page initialiser ───────────────────────────────────────────

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

	// ── LM Studio status test ─────────────────────────────────────────────────

	const lmStudioStatusEl = root.querySelector("#lmstudio-status");
	const refreshLmStudioBtn = root.querySelector("#refresh-lmstudio-status");

	if (lmStudioStatusEl && refreshLmStudioBtn) {
		const testLmStudio = async () => {
			lmStudioStatusEl.textContent = "Testing…";
			lmStudioStatusEl.className = "badge";
			try {
				const res = await getModels();
				if (res && !res.error && res.data && res.data.length > 0) {
					lmStudioStatusEl.textContent = `${res.data.length} model${res.data.length === 1 ? '' : 's'} found`;
					lmStudioStatusEl.className = "badge badge-success";
				} else if (res?.error) {
					lmStudioStatusEl.textContent = "Unreachable";
					lmStudioStatusEl.className = "badge badge-error";
				} else {
					lmStudioStatusEl.textContent = "No models";
					lmStudioStatusEl.className = "badge badge-error";
				}
			} catch {
				lmStudioStatusEl.textContent = "Unreachable";
				lmStudioStatusEl.className = "badge badge-error";
			}
		};
		refreshLmStudioBtn.addEventListener("click", testLmStudio);
	}

	// ── Temperature slider ↔ number sync ──────────────────────────────────────

	const temperatureSlider = root.querySelector("#temperature-slider");
	const temperatureInput  = root.querySelector("#temperature-input");

	if (temperatureSlider && temperatureInput) {
		temperatureSlider.addEventListener("input", () => {
			temperatureInput.value = temperatureSlider.value;
		});
		temperatureInput.addEventListener("input", () => {
			const v = Math.min(2, Math.max(0, parseFloat(temperatureInput.value) || 0));
			temperatureSlider.value = v;
		});
	}

	// ── llama.cpp slider ↔ number sync ───────────────────────────────────────

	linkSliderAndNumber(root.querySelector("#llamacpp-top-p-slider"),         root.querySelector("#llamacpp-top-p"),         0, 1);
	linkSliderAndNumber(root.querySelector("#llamacpp-min-p-slider"),         root.querySelector("#llamacpp-min-p"),         0, 1);
	linkSliderAndNumber(root.querySelector("#llamacpp-repeat-penalty-slider"), root.querySelector("#llamacpp-repeat-penalty"), 1, 2);

	// ── Populate from cached settings ─────────────────────────────────────────

	const cached = SettingsStore.get();
	if (cached) {
		populateAISettingsFields(root, cached);
		populateLlamaCppFields(root, cached);
	}

	// ── Subscribe to live settings changes ───────────────────────────────────

	const allAIFields = [
		"#default-model-input", "#temperature-slider", "#temperature-input",
		"#max-tokens-input", "#system-prompt-input", "#lmstudio-url-input",
	];
	const allLlamaCppFields = [
		"#llamacpp-flash-attn", "#llamacpp-eval-batch-size", "#llamacpp-ctx-size",
		"#llamacpp-gpu-layers", "#llamacpp-threads", "#llamacpp-threads-batch",
		"#llamacpp-top-p-slider", "#llamacpp-top-p",
		"#llamacpp-min-p-slider", "#llamacpp-min-p",
		"#llamacpp-repeat-penalty-slider", "#llamacpp-repeat-penalty",
	];
	const allWatchedFields = [...allAIFields, ...allLlamaCppFields];

	const unsubscribe = SettingsStore.subscribe((settings) => {
		const focused = document.activeElement;
		const userIsEditing = allWatchedFields.some((sel) => root.querySelector(sel) === focused);
		if (!userIsEditing) {
			populateAISettingsFields(root, settings);
			populateLlamaCppFields(root, settings);
		}
	});

	const observer = new MutationObserver(() => {
		if (!document.body.contains(root)) {
			unsubscribe();
			observer.disconnect();
		}
	});
	observer.observe(document.body, { childList: true, subtree: true });

	// ── AI Behaviour save button ──────────────────────────────────────────────

	const saveBtn  = root.querySelector("#save-ai-settings");
	const statusEl = root.querySelector("#ai-settings-status");

	if (saveBtn) {
		saveBtn.addEventListener("click", async () => {
			saveBtn.disabled = true;
			if (statusEl) { statusEl.textContent = "Saving…"; statusEl.style.color = ""; }

			try {
				const defaultModelInput = root.querySelector("#default-model-input");
				const maxTokensInput    = root.querySelector("#max-tokens-input");
				const systemPromptInput = root.querySelector("#system-prompt-input");
				const lmStudioUrlInput  = root.querySelector("#lmstudio-url-input");

				const patch = {
					systemPrompt:            systemPromptInput?.value ?? "",
					defaultModel:            defaultModelInput?.value?.trim() ?? "",
					temperature:             parseFloat(temperatureInput?.value ?? temperatureSlider?.value ?? "0.7") || 0.7,
					fallbackMaxOutputTokens: parseInt(maxTokensInput?.value ?? "8192", 10) || 8192,
					lmStudioUrl:             lmStudioUrlInput?.value?.trim() || "http://localhost:1234",
				};

				await SettingsStore.save(patch);

				if (statusEl) {
					statusEl.textContent = "Saved.";
					statusEl.style.color = "var(--green, green)";
					setTimeout(() => { statusEl.textContent = ""; }, 3000);
				}
			} catch (err) {
				if (statusEl) {
					statusEl.textContent = "Error: " + err.message;
					statusEl.style.color = "var(--red, red)";
				}
			} finally {
				saveBtn.disabled = false;
			}
		});
	}

	// ── llama.cpp save button ─────────────────────────────────────────────────

	const saveLlamaCppBtn  = root.querySelector("#save-llamacpp-settings");
	const llamaCppStatusEl = root.querySelector("#llamacpp-settings-status");

	if (saveLlamaCppBtn) {
		saveLlamaCppBtn.addEventListener("click", async () => {
			saveLlamaCppBtn.disabled = true;
			if (llamaCppStatusEl) { llamaCppStatusEl.textContent = "Saving…"; llamaCppStatusEl.style.color = ""; }

			try {
				const flashAttn      = root.querySelector("#llamacpp-flash-attn");
				const evalBatchSize  = root.querySelector("#llamacpp-eval-batch-size");
				const ctxSize        = root.querySelector("#llamacpp-ctx-size");
				const gpuLayers      = root.querySelector("#llamacpp-gpu-layers");
				const threads        = root.querySelector("#llamacpp-threads");
				const threadsBatch   = root.querySelector("#llamacpp-threads-batch");
				const topP           = root.querySelector("#llamacpp-top-p");
				const minP           = root.querySelector("#llamacpp-min-p");
				const repeatPenalty  = root.querySelector("#llamacpp-repeat-penalty");

				const patch = {
					llamacppFlashAttn:      flashAttn?.checked ?? true,
					llamacppEvalBatchSize:  parseInt(evalBatchSize?.value ?? "2048", 10) || 2048,
					llamacppCtxSize:        parseInt(ctxSize?.value ?? "0", 10) || 0,
					llamacppGpuLayers:      parseInt(gpuLayers?.value ?? "0", 10) || 0,
					llamacppThreads:        parseInt(threads?.value ?? "0", 10) || 0,
					llamacppThreadsBatch:   parseInt(threadsBatch?.value ?? "0", 10) || 0,
					llamacppTopP:           parseFloat(topP?.value ?? "0.9") || 0.9,
					llamacppMinP:           parseFloat(minP?.value ?? "0.05") || 0.05,
					llamacppRepeatPenalty:  parseFloat(repeatPenalty?.value ?? "1.15") || 1.15,
				};

				await SettingsStore.save(patch);

				if (llamaCppStatusEl) {
					llamaCppStatusEl.textContent = "Saved. Restart backend for model-load settings (↻) to take effect.";
					llamaCppStatusEl.style.color = "var(--green, green)";
					setTimeout(() => { llamaCppStatusEl.textContent = ""; }, 6000);
				}
			} catch (err) {
				if (llamaCppStatusEl) {
					llamaCppStatusEl.textContent = "Error: " + err.message;
					llamaCppStatusEl.style.color = "var(--red, red)";
				}
			} finally {
				saveLlamaCppBtn.disabled = false;
			}
		});
	}

	// ── Initial load if cache is cold ─────────────────────────────────────────

	if (!SettingsStore.get()) {
		SettingsStore.init().then((settings) => {
			populateAISettingsFields(root, settings);
			populateLlamaCppFields(root, settings);
		}).catch(console.warn);
	}
}