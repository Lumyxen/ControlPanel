export const THEME_KEY = "ctrlpanel:theme";
export const DEFAULT_THEME = "everforest-harddark-green";

import { getModels } from "./api.js";
import * as SettingsStore from "./settings-store.js";
import { consumePendingBuild } from "./backend-suggest.js";

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
	return { palette: parts[0], flavour: parts.slice(1, -1).join("-"), accent: parts.at(-1) };
}
export const isValidPalette = (p) => p in PALETTES;
export const isValidFlavour = (p, f) => isValidPalette(p) && f in PALETTES[p].flavours;
export const isValidAccent  = (p, a) => isValidPalette(p) && PALETTES[p].accents.includes(a);

export function coerceTheme(key) {
	const { palette, flavour, accent } = splitThemeKey(key);
	const fp = isValidPalette(palette) ? palette : "everforest";
	const d  = PALETTES[fp];
	return `${fp}-${isValidFlavour(fp, flavour) ? flavour : d.defaultFlavour}-${isValidAccent(fp, accent) ? accent : d.defaultAccent}`;
}

export function setTheme(themeKey, { persist = true, syncUI = true } = {}) {
	const coerced = coerceTheme(themeKey);
	document.documentElement.setAttribute("data-theme", coerced);
	currentTheme = coerced;
	if (persist) { try { localStorage.setItem(THEME_KEY, coerced); } catch {} }
	if (syncUI) { const o = document.querySelector('[data-fragment="main"]'); if (o) syncSettingsUI(o); }
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
	input.type = "radio"; input.name = name; input.value = value;
	const dot = document.createElement("span");
	dot.className = "dot"; dot.setAttribute("aria-hidden", "true");
	const text = document.createElement("span");
	text.textContent = labelText;
	label.append(input, dot, text);
	return label;
}

function generatePaletteSelector(c) {
	c.innerHTML = "";
	PALETTE_ORDER.forEach(id => c.appendChild(createTile("palette", "palette", id, PALETTES[id].label)));
}
function generateFlavourSelector(c, pid) {
	c.innerHTML = "";
	const p = PALETTES[pid]; if (!p) return;
	Object.entries(p.flavours).forEach(([id, d]) => c.appendChild(createTile("flavour", "flavour", id, d.label)));
}
function generateAccentSelector(c, pid) {
	c.innerHTML = "";
	const p = PALETTES[pid]; if (!p) return;
	p.accents.forEach(id => {
		const btn = document.createElement("button");
		btn.type = "button"; btn.className = "accent-chip";
		btn.setAttribute("role", "radio"); btn.dataset.accent = id;
		btn.style.setProperty("--swatch", `var(${p.accentVar}-${id})`);
		btn.setAttribute("aria-label", id.charAt(0).toUpperCase() + id.slice(1));
		btn.setAttribute("aria-checked", "false"); btn.tabIndex = -1;
		c.appendChild(btn);
	});
}

export function syncSettingsUI(root) {
	if (!root || !currentTheme) return;
	const { palette, flavour, accent } = splitThemeKey(currentTheme);
	root.querySelectorAll('input[name="palette"]').forEach(i => {
		const ok = i.value === palette; i.checked = ok;
		const t = i.closest(".palette-tile"); if (t) { t.classList.toggle("selected", ok); t.setAttribute("aria-checked", String(ok)); }
	});
	root.querySelectorAll('input[name="flavour"]').forEach(i => {
		const ok = i.value === flavour; i.checked = ok;
		const t = i.closest(".flavour-tile"); if (t) { t.classList.toggle("selected", ok); t.setAttribute("aria-checked", String(ok)); }
	});
	root.querySelectorAll('button[data-accent][role="radio"]').forEach(b => {
		const ok = b.dataset.accent === accent;
		b.classList.toggle("selected", ok); b.setAttribute("aria-checked", String(ok)); b.tabIndex = ok ? 0 : -1;
	});
}

function linkSliderAndNumber(sl, num, min, max) {
	if (!sl || !num) return;
	sl.addEventListener("input", () => { num.value = sl.value; });
	num.addEventListener("input", () => { sl.value = Math.min(max, Math.max(min, parseFloat(num.value) || min)); });
}

function populateAISettingsFields(root, s) {
	if (!s) return;
	const set = (id, v) => { const el = root.querySelector(id); if (el && v != null) el.value = v; };
	set("#default-model-input",  s.defaultModel);
	set("#max-tokens-input",     s.fallbackMaxOutputTokens);
	set("#system-prompt-input",  s.systemPrompt);
	set("#lmstudio-url-input",   s.lmStudioUrl);
	if (s.temperature != null) {
		const t = parseFloat(s.temperature) || 0.7;
		const sl = root.querySelector("#temperature-slider"), num = root.querySelector("#temperature-input");
		if (sl) sl.value = t; if (num) num.value = t;
	}
}

function populateLlamaCppFields(root, s) {
	if (!s) return;
	const fa = root.querySelector("#llamacpp-flash-attn");
	if (fa && s.llamacppFlashAttn != null) fa.checked = Boolean(s.llamacppFlashAttn);
	const set = (id, v) => { const el = root.querySelector(id); if (el && v != null) el.value = v; };
	set("#llamacpp-eval-batch-size", s.llamacppEvalBatchSize);
	set("#llamacpp-ctx-size",        s.llamacppCtxSize);
	set("#llamacpp-gpu-layers",      s.llamacppGpuLayers);
	set("#llamacpp-threads",         s.llamacppThreads);
	set("#llamacpp-threads-batch",   s.llamacppThreadsBatch);
	const setSl = (sid, nid, v) => {
		const sl = root.querySelector(sid), num = root.querySelector(nid);
		if (v == null) return; if (sl) sl.value = v; if (num) num.value = v;
	};
	setSl("#llamacpp-top-p-slider",          "#llamacpp-top-p",          s.llamacppTopP);
	setSl("#llamacpp-min-p-slider",          "#llamacpp-min-p",          s.llamacppMinP);
	setSl("#llamacpp-repeat-penalty-slider", "#llamacpp-repeat-penalty", s.llamacppRepeatPenalty);
	if (s.llamacppBackend != null) selectBackendRadio(root, s.llamacppBackend);
	if (s.llamacppTag    != null) {
		const ti = root.querySelector("#llamacpp-tag-input"); if (ti) ti.value = s.llamacppTag;
	}
}

function selectBackendRadio(root, value) {
	const valid = ["auto","cpu","cuda","rocm","vulkan"];
	const v = valid.includes(value) ? value : "auto";
	root.querySelectorAll('input[name="llamacpp-backend"]').forEach(r => {
		const ok = r.value === v; r.checked = ok;
		const t = r.closest(".flavour-tile"); if (t) { t.classList.toggle("selected", ok); t.setAttribute("aria-checked", String(ok)); }
	});
}

// ── Backend labels / descriptions ─────────────────────────────────────────────
const BACKEND_LABELS = { auto: "Auto", cpu: "CPU", cuda: "CUDA", rocm: "ROCm", vulkan: "Vulkan" };
const BACKEND_DESCS  = {
	auto:   "Use the best available backend automatically",
	cpu:    "CPU-only inference — no GPU required",
	cuda:   "NVIDIA GPU (CUDA)",
	rocm:   "AMD GPU (ROCm/HIP)",
	vulkan: "Cross-vendor GPU (Vulkan)",
};

// ── Build progress driver ─────────────────────────────────────────────────────

let _buildPollId   = null;
let _buildPulseRaf = null;

function stopBuildPulse() {
	if (_buildPulseRaf) { cancelAnimationFrame(_buildPulseRaf); _buildPulseRaf = null; }
}

async function startBuildInSettings(root, backend, tag, btn) {
	const progressArea = root.querySelector("#llamacpp-build-progress");
	const labelEl      = root.querySelector("#llamacpp-build-progress-label");
	const pctEl        = root.querySelector("#llamacpp-build-progress-pct");
	const barEl        = root.querySelector("#llamacpp-build-progress-bar");
	const logTail      = root.querySelector("#llamacpp-build-log-tail");

	// Scroll section into view
	root.querySelector("#llamacpp-backend-title")?.closest(".card")
	    ?.scrollIntoView({ behavior: "smooth", block: "start" });

	// Reset bar: disable transition, set to 0%, then re-enable after paint
	if (barEl) {
		barEl.style.transition = "none";
		barEl.style.width      = "0%";
		barEl.style.background = "";
	}
	if (pctEl)   pctEl.textContent  = "";
	if (labelEl) labelEl.textContent = `Starting ${BACKEND_LABELS[backend] || backend} build…`;
	if (logTail) logTail.textContent = "";
	if (progressArea) progressArea.hidden = false;

	// Re-enable transitions after the 0% reset has been painted
	requestAnimationFrame(() => requestAnimationFrame(() => {
		if (barEl) barEl.style.transition = "width 0.4s ease";
	}));

	const buildStart   = Date.now();
	let firstPctTime   = null;
	let firstPctValue  = null;
	let lastPercent    = -1;

	const formatEta = s => {
		if (!isFinite(s) || s < 0) return "";
		if (s < 60)   return `~${Math.round(s)}s remaining`;
		if (s < 3600) return `~${Math.floor(s/60)}m ${Math.round(s%60)}s remaining`;
		return `~${(s/3600).toFixed(1)}h remaining`;
	};

	// Indeterminate pulse using rAF (smooth, no conflicts with transition)
	const pulse = () => {
		if (!barEl || lastPercent >= 0) return;
		barEl.style.transition = "none";
		barEl.style.width = (3 + 25 * (0.5 + 0.5 * Math.sin(Date.now() / 700))) + "%";
		_buildPulseRaf = requestAnimationFrame(pulse);
	};

	// Start the build
	try {
		const r = await fetch("/api/llamacpp/build", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ backend, tag }),
		});
		const d = await r.json();
		if (!r.ok || d.error) {
			if (labelEl) labelEl.textContent = `✗ Could not start: ${d.error || `HTTP ${r.status}`}`;
			if (btn) { btn.disabled = false; btn.textContent = btn._origText || "Build"; }
			return;
		}
	} catch (err) {
		if (labelEl) labelEl.textContent = `✗ Error: ${err.message}`;
		if (btn) { btn.disabled = false; btn.textContent = btn._origText || "Build"; }
		return;
	}

	if (labelEl) labelEl.textContent = `Building ${BACKEND_LABELS[backend] || backend}…`;
	_buildPulseRaf = requestAnimationFrame(pulse);

	if (_buildPollId) { clearInterval(_buildPollId); _buildPollId = null; }

	_buildPollId = setInterval(async () => {
		try {
			const lr    = await fetch("/api/llamacpp/build/log?lines=60");
			const ld    = await lr.json();
			const pct   = typeof ld.percent === "number" ? ld.percent : -1;
			const lines = Array.isArray(ld.lines) ? ld.lines : [];
			const allLog = lines.join("\n");

			// Log tail
			if (logTail) {
				logTail.textContent = lines.filter(l => l.trim()).slice(-12).join("\n");
				logTail.scrollTop   = logTail.scrollHeight;
			}

			// Phase + ETA
			let phase = "";
			if (allLog.includes("Cloning into") || allLog.includes("git clone"))
				phase = "Downloading source…";
			else if (allLog.includes("FetchContent") && pct < 0)
				phase = "Fetching dependencies…";
			else if (pct >= 0)
				phase = "Compiling…";
			else if (allLog.match(/Building C(?:XX)? object/))
				phase = "Compiling…";
			else if (allLog.includes("Configuring done"))
				phase = "Configuring…";

			let etaStr = "";
			if (pct > 0 && pct < 100) {
				const now = Date.now();
				if (firstPctTime === null) { firstPctTime = now; firstPctValue = pct; }
				else if (pct > firstPctValue) {
					const rate = (pct - firstPctValue) / ((now - firstPctTime) / 1000);
					etaStr = formatEta((100 - pct) / rate);
				}
			}
			if (phase && labelEl)
				labelEl.textContent = etaStr ? `${phase} ${etaStr}` : phase;

			// Progress bar — only update when we have a real cmake %
			if (pct >= 0) {
				if (lastPercent < 0) {
					// Transition from indeterminate to determinate
					stopBuildPulse();
					if (barEl) barEl.style.transition = "width 0.4s ease";
				}
				lastPercent = pct;
				if (barEl)  barEl.style.width = Math.max(2, pct) + "%";
				if (pctEl)  pctEl.textContent  = pct + "%";
			}

			// Check completion
			const sr = await fetch("/api/llamacpp/build/status");
			const st = await sr.json();
			if (!st.running && st.done) {
				clearInterval(_buildPollId); _buildPollId = null;
				stopBuildPulse();

				if (st.success) {
					// ── Auto-switch to the newly built backend ────────────────
					try {
						await fetch("/api/llamacpp/backend", {
							method: "POST",
							headers: { "Content-Type": "application/json" },
							body: JSON.stringify({ backend }),
						});
						// Save preference
						await fetch("/api/config/settings", {
							method: "PUT",
							headers: { "Content-Type": "application/json" },
							body: JSON.stringify({ llamacppBackend: backend }),
						}).catch(() => {});
						// Trigger model load
						await fetch("/api/llamacpp/reload-model", { method: "POST" }).catch(() => {});
					} catch { /* non-fatal */ }

					if (barEl)  { barEl.style.transition = "width 0.4s ease"; barEl.style.width = "100%"; }
					if (pctEl)  pctEl.textContent = "100%";
					const totalSec = Math.round((Date.now() - buildStart) / 1000);
					const totalStr = totalSec < 60 ? `${totalSec}s` : `${Math.floor(totalSec/60)}m ${totalSec%60}s`;
					if (labelEl) labelEl.textContent =
						`✓ ${BACKEND_LABELS[backend] || backend} built in ${totalStr}. Backend activated.`;
					if (btn) {
						btn.textContent = "✓ Done"; btn.style.color = "var(--green,green)";
						setTimeout(() => { btn.disabled = false; btn.textContent = "Rebuild"; btn.style.color = ""; }, 4000);
					}
					setTimeout(() => initBackendSelector(root).catch(() => {}), 1500);
				} else {
					if (barEl) { barEl.style.background = "var(--red,red)"; barEl.style.width = "100%"; }
					if (labelEl) labelEl.textContent = `✗ Build failed — check data/logs/build_${backend}.log`;
					if (btn) { btn.disabled = false; btn.textContent = btn._origText || "Build"; btn.style.color = ""; }
				}
			}
		} catch { /* keep polling */ }
	}, 1500);
}

// ── Backend selector ──────────────────────────────────────────────────────────

async function initBackendSelector(root) {
	const container   = root.querySelector("#llamacpp-backend-selector");
	const activeLabel = root.querySelector("#llamacpp-active-backend-label");
	const extraLabel  = root.querySelector("#llamacpp-backend-status-extra");
	const tagInput    = root.querySelector("#llamacpp-tag-input");
	if (!container) return;

	container.innerHTML = "";
	const loading = document.createElement("span");
	loading.style.cssText = "color:var(--muted);font-size:0.85rem;";
	loading.textContent = "Loading…";
	container.appendChild(loading);

	let data = null;
	try {
		const res = await fetch("/api/llamacpp/backend");
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		data = await res.json();
	} catch (err) {
		loading.textContent = `Could not load backend info: ${err.message}`;
		if (activeLabel) activeLabel.textContent = "unknown";
		return;
	}
	loading.remove();

	const allBackends = Array.isArray(data.all) ? data.all : ["cpu","cuda","rocm","vulkan"];
	const available   = Array.isArray(data.available) ? data.available : [];
	const hardware    = Array.isArray(data.hardware)  ? data.hardware  : [];
	const active      = data.active  || "none";
	const setting     = data.setting || "auto";
	const tag         = data.tag     || "b8337";

	if (tagInput) tagInput.value = tag;
	if (activeLabel) {
		activeLabel.textContent = active === "none"
			? "none (no backend loaded)"
			: (BACKEND_LABELS[active] || active.toUpperCase());
	}
	if (extraLabel) extraLabel.textContent = "";

	for (const backend of ["auto", ...allBackends]) {
		const isBuilt    = backend === "auto" || available.includes(backend);
		const hasHardware = backend === "auto" || hardware.includes(backend);

		const row = document.createElement("div");
		row.style.cssText = "display:flex;align-items:center;gap:8px;flex-wrap:wrap;";

		const tileLabel = document.createElement("label");
		tileLabel.className = "flavour-tile";
		tileLabel.style.width = "fit-content";
		tileLabel.setAttribute("aria-checked", "false");
		if (!isBuilt) {
			tileLabel.style.opacity = "0.5";
			tileLabel.title = `${BACKEND_LABELS[backend] || backend}: not yet built — click Build`;
		} else if (!hasHardware) {
			tileLabel.style.opacity = "0.45";
			tileLabel.title = `${BACKEND_LABELS[backend] || backend}: built but no hardware detected`;
		}

		const radio = document.createElement("input");
		radio.type = "radio"; radio.name = "llamacpp-backend"; radio.value = backend;
		radio.disabled = !isBuilt;

		const dot = document.createElement("span");
		dot.className = "dot"; dot.setAttribute("aria-hidden", "true");

		const text = document.createElement("span");
		const desc = BACKEND_DESCS[backend] || "";
		text.innerHTML = `${BACKEND_LABELS[backend] || backend}` +
			(desc ? ` <span style="font-size:0.8rem;opacity:0.65;">(${desc})</span>` : "");

		tileLabel.append(radio, dot, text);
		row.appendChild(tileLabel);

		if (backend !== "auto") {
			const isRebuild = isBuilt;
			const btn = document.createElement("button");
			btn.type = "button"; btn.className = "btn";
			btn._origText   = isRebuild ? "Rebuild" : "Build";
			btn.textContent = btn._origText;
			btn.style.cssText = isRebuild
				? "font-size:0.75rem;padding:2px 8px;opacity:0.6;"
				: "font-size:0.78rem;padding:3px 10px;";
			if (isRebuild) btn.title = "Recompile with current tag";

			btn.addEventListener("click", () => {
				btn.disabled = true; btn.textContent = "Building…"; btn.style.color = "";
				startBuildInSettings(root, backend, tagInput?.value?.trim() || tag, btn)
					.catch(() => { btn.disabled = false; btn.textContent = btn._origText; });
			});
			row.appendChild(btn);
		}

		container.appendChild(row);
	}

	selectBackendRadio(root, setting);

	container.addEventListener("change", (e) => {
		if (e.target.name !== "llamacpp-backend") return;
		container.querySelectorAll('input[name="llamacpp-backend"]').forEach(r => {
			const t = r.closest(".flavour-tile");
			if (t) { t.classList.toggle("selected", r.checked); t.setAttribute("aria-checked", String(r.checked)); }
		});
	});

	// ── Auto-trigger pending build from the suggestion banner ─────────────────
	const pending = consumePendingBuild();
	if (pending) {
		const { backend: pb, tag: pt } = pending;
		// Find the row that matches this backend and click its build button
		const rows = [...container.children];
		const matchBtn = rows
			.map(row => ({ row, radio: row.querySelector(`input[value="${pb}"]`), btn: row.querySelector("button") }))
			.filter(x => x.radio && x.btn)
			.map(x => x.btn)[0];

		if (matchBtn) {
			matchBtn.disabled = true; matchBtn.textContent = "Building…"; matchBtn.style.color = "";
			await startBuildInSettings(root, pb, pt, matchBtn);
		} else {
			await startBuildInSettings(root, pb, pt, null);
		}
	}

	// Handle the case where the user is already on settings when the banner fires
	const pendingListener = async () => {
		const p = consumePendingBuild();
		if (p) await initBackendSelector(root); // re-init picks up the pending build
	};
	window.addEventListener("ctrlpanel:checkPendingBuild", pendingListener, { once: true });

	return data;
}

// ── Main settings page initialiser ───────────────────────────────────────────

export function initSettingsPage(root) {
	if (!root) return;
	const paletteList = root.querySelector("[data-palette-list]");
	const flavourList = root.querySelector("[data-flavour-list]");
	const accentGrid  = root.querySelector("[data-accent-grid]");
	if (!paletteList || !flavourList || !accentGrid) return;

	const { palette: cp } = splitThemeKey(currentTheme);
	generatePaletteSelector(paletteList);
	generateFlavourSelector(flavourList, cp);
	generateAccentSelector(accentGrid, cp);

	paletteList.addEventListener("change", (e) => {
		if (e.target.name !== "palette") return;
		const p = e.target.value, d = PALETTES[p]; if (!d) return;
		generateFlavourSelector(flavourList, p);
		generateAccentSelector(accentGrid, p);
		setTheme(`${p}-${d.defaultFlavour}-${d.defaultAccent}`);
	});
	flavourList.addEventListener("change", (e) => {
		if (e.target.name !== "flavour") return;
		const { palette, accent } = splitThemeKey(currentTheme);
		setTheme(`${palette}-${e.target.value}-${isValidAccent(palette, accent) ? accent : PALETTES[palette].defaultAccent}`);
	});
	accentGrid.addEventListener("click", (e) => {
		const btn = e.target.closest("button[data-accent]"); if (!btn) return;
		const { palette, flavour } = splitThemeKey(currentTheme);
		if (isValidAccent(palette, btn.dataset.accent)) setTheme(`${palette}-${flavour}-${btn.dataset.accent}`);
	});
	accentGrid.addEventListener("keydown", (e) => {
		const navKeys = ["ArrowLeft","ArrowRight","ArrowUp","ArrowDown"];
		if (!navKeys.includes(e.key) && e.key !== " " && e.key !== "Enter") return;
		const items = [...accentGrid.querySelectorAll('button[data-accent][role="radio"]')];
		if (!items.length) return;
		const cur = items.findIndex(el => el.classList.contains("selected"));
		if (navKeys.includes(e.key)) {
			e.preventDefault();
			const cols = parseInt(getComputedStyle(accentGrid).getPropertyValue("--cols") || "7", 10);
			const moves = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -cols, ArrowDown: cols };
			items[(cur + moves[e.key] + items.length) % items.length]?.focus();
		} else {
			e.preventDefault();
			(document.activeElement?.closest('button[data-accent][role="radio"]') || items[cur])?.click();
		}
	});
	syncSettingsUI(root);

	// ── LM Studio test ────────────────────────────────────────────────────────
	const lmStatusEl = root.querySelector("#lmstudio-status");
	const lmTestBtn  = root.querySelector("#refresh-lmstudio-status");
	if (lmStatusEl && lmTestBtn) {
		lmTestBtn.addEventListener("click", async () => {
			lmStatusEl.textContent = "Testing…"; lmStatusEl.className = "badge";
			try {
				const r = await getModels();
				if (r?.data?.length > 0) { lmStatusEl.textContent = `${r.data.length} model${r.data.length===1?"":"s"} found`; lmStatusEl.className = "badge badge-success"; }
				else { lmStatusEl.textContent = "Unreachable"; lmStatusEl.className = "badge badge-error"; }
			} catch { lmStatusEl.textContent = "Unreachable"; lmStatusEl.className = "badge badge-error"; }
		});
	}

	// ── Slider sync ───────────────────────────────────────────────────────────
	const tempSl = root.querySelector("#temperature-slider"), tempNum = root.querySelector("#temperature-input");
	if (tempSl && tempNum) {
		tempSl.addEventListener("input", () => { tempNum.value = tempSl.value; });
		tempNum.addEventListener("input", () => { tempSl.value = Math.min(2, Math.max(0, parseFloat(tempNum.value) || 0)); });
	}
	linkSliderAndNumber(root.querySelector("#llamacpp-top-p-slider"),          root.querySelector("#llamacpp-top-p"),          0, 1);
	linkSliderAndNumber(root.querySelector("#llamacpp-min-p-slider"),          root.querySelector("#llamacpp-min-p"),          0, 1);
	linkSliderAndNumber(root.querySelector("#llamacpp-repeat-penalty-slider"), root.querySelector("#llamacpp-repeat-penalty"), 1, 2);

	// ── Populate fields ───────────────────────────────────────────────────────
	const cached = SettingsStore.get();
	if (cached) { populateAISettingsFields(root, cached); populateLlamaCppFields(root, cached); }

	// ── Backend selector ──────────────────────────────────────────────────────
	initBackendSelector(root).catch(console.warn);

	// ── Live settings subscription ────────────────────────────────────────────
	const watchedFields = [
		"#default-model-input","#temperature-slider","#temperature-input",
		"#max-tokens-input","#system-prompt-input","#lmstudio-url-input",
		"#llamacpp-flash-attn","#llamacpp-eval-batch-size","#llamacpp-ctx-size",
		"#llamacpp-gpu-layers","#llamacpp-threads","#llamacpp-threads-batch",
		"#llamacpp-top-p-slider","#llamacpp-top-p",
		"#llamacpp-min-p-slider","#llamacpp-min-p",
		"#llamacpp-repeat-penalty-slider","#llamacpp-repeat-penalty",
	];
	const unsub = SettingsStore.subscribe((s) => {
		const focused = document.activeElement;
		if (!watchedFields.some(sel => root.querySelector(sel) === focused)) {
			populateAISettingsFields(root, s);
			populateLlamaCppFields(root, s);
		}
	});
	const obs = new MutationObserver(() => {
		if (!document.body.contains(root)) { unsub(); obs.disconnect(); }
	});
	obs.observe(document.body, { childList: true, subtree: true });

	// ── AI Behaviour save ─────────────────────────────────────────────────────
	const saveBtn = root.querySelector("#save-ai-settings"), statusEl = root.querySelector("#ai-settings-status");
	if (saveBtn) {
		saveBtn.addEventListener("click", async () => {
			saveBtn.disabled = true;
			if (statusEl) { statusEl.textContent = "Saving…"; statusEl.style.color = ""; }
			try {
				await SettingsStore.save({
					systemPrompt:            root.querySelector("#system-prompt-input")?.value ?? "",
					defaultModel:            root.querySelector("#default-model-input")?.value?.trim() ?? "",
					temperature:             parseFloat(tempNum?.value ?? tempSl?.value ?? "0.7") || 0.7,
					fallbackMaxOutputTokens: parseInt(root.querySelector("#max-tokens-input")?.value ?? "8192", 10) || 8192,
					lmStudioUrl:             root.querySelector("#lmstudio-url-input")?.value?.trim() || "http://localhost:1234",
				});
				if (statusEl) { statusEl.textContent = "Saved."; statusEl.style.color = "var(--green,green)"; setTimeout(() => { statusEl.textContent = ""; }, 3000); }
			} catch (err) {
				if (statusEl) { statusEl.textContent = "Error: " + err.message; statusEl.style.color = "var(--red,red)"; }
			} finally { saveBtn.disabled = false; }
		});
	}

	// ── Backend switch + save ─────────────────────────────────────────────────
	const saveBackendBtn = root.querySelector("#save-llamacpp-backend"), backendStatus = root.querySelector("#llamacpp-backend-save-status");
	if (saveBackendBtn) {
		saveBackendBtn.addEventListener("click", async () => {
			saveBackendBtn.disabled = true;
			if (backendStatus) { backendStatus.textContent = "Switching…"; backendStatus.style.color = ""; }
			try {
				const selected = root.querySelector('input[name="llamacpp-backend"]:checked');
				const backend  = selected?.value || "auto";
				const tagVal   = root.querySelector("#llamacpp-tag-input")?.value?.trim() || "b8337";

				const res = await fetch("/api/llamacpp/backend", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ backend }),
				});
				const d = await res.json();
				await SettingsStore.save({ llamacppBackend: backend, llamacppTag: tagVal });

				if (d.success || d.active) {
					const al = root.querySelector("#llamacpp-active-backend-label");
					if (al && d.active) al.textContent = BACKEND_LABELS[d.active] || d.active;
					if (backendStatus) {
						backendStatus.textContent = `Switched to ${BACKEND_LABELS[d.active || backend] || backend}.`;
						backendStatus.style.color = "var(--green,green)";
						setTimeout(() => { backendStatus.textContent = ""; }, 4000);
					}
				} else {
					throw new Error(d.error || "Backend switch failed");
				}
			} catch (err) {
				if (backendStatus) { backendStatus.textContent = "Error: " + err.message; backendStatus.style.color = "var(--red,red)"; }
			} finally { saveBackendBtn.disabled = false; }
		});
	}

	// ── llama.cpp settings save — auto-reloads model (#4) ────────────────────
	const saveLCppBtn = root.querySelector("#save-llamacpp-settings"), lcppStatus = root.querySelector("#llamacpp-settings-status");
	if (saveLCppBtn) {
		saveLCppBtn.addEventListener("click", async () => {
			saveLCppBtn.disabled = true;
			if (lcppStatus) { lcppStatus.textContent = "Saving…"; lcppStatus.style.color = ""; }
			try {
				await SettingsStore.save({
					llamacppFlashAttn:     root.querySelector("#llamacpp-flash-attn")?.checked ?? true,
					llamacppEvalBatchSize: parseInt(root.querySelector("#llamacpp-eval-batch-size")?.value ?? "2048", 10) || 2048,
					llamacppCtxSize:       parseInt(root.querySelector("#llamacpp-ctx-size")?.value ?? "0",    10) || 0,
					llamacppGpuLayers:     parseInt(root.querySelector("#llamacpp-gpu-layers")?.value ?? "0",  10) || 0,
					llamacppThreads:       parseInt(root.querySelector("#llamacpp-threads")?.value ?? "0",     10) || 0,
					llamacppThreadsBatch:  parseInt(root.querySelector("#llamacpp-threads-batch")?.value ?? "0", 10) || 0,
					llamacppTopP:          parseFloat(root.querySelector("#llamacpp-top-p")?.value ?? "0.9")   || 0.9,
					llamacppMinP:          parseFloat(root.querySelector("#llamacpp-min-p")?.value ?? "0.05")  || 0.05,
					llamacppRepeatPenalty: parseFloat(root.querySelector("#llamacpp-repeat-penalty")?.value ?? "1.15") || 1.15,
				});

				// Auto-reload model so settings take effect immediately (#4)
				if (lcppStatus) { lcppStatus.textContent = "Reloading model…"; lcppStatus.style.color = ""; }
				try {
					const rr = await fetch("/api/llamacpp/reload-model", { method: "POST" });
					const rd = await rr.json();
					if (lcppStatus) {
						lcppStatus.textContent = rd.ready
							? `Saved & reloaded (${rd.modelId || "no model"}).`
							: "Saved. No model to reload — place a .gguf in data/models/.";
						lcppStatus.style.color = "var(--green,green)";
						setTimeout(() => { lcppStatus.textContent = ""; }, 6000);
					}
				} catch {
					if (lcppStatus) { lcppStatus.textContent = "Saved."; lcppStatus.style.color = "var(--green,green)"; setTimeout(() => { lcppStatus.textContent = ""; }, 3000); }
				}
			} catch (err) {
				if (lcppStatus) { lcppStatus.textContent = "Error: " + err.message; lcppStatus.style.color = "var(--red,red)"; }
			} finally { saveLCppBtn.disabled = false; }
		});
	}

	if (!SettingsStore.get()) {
		SettingsStore.init().then(s => {
			populateAISettingsFields(root, s);
			populateLlamaCppFields(root, s);
		}).catch(console.warn);
	}
}