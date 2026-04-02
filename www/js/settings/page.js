// www/js/settings/page.js
// Settings page initialiser and all supporting helpers (build progress,
// backend selector, AI/llama.cpp save buttons).
// Extracted from theme.js to keep that file focused on theme management.

import { getModels } from '../api.js';
import * as SettingsStore from '../settings-store.js';
import {
	splitThemeKey, setTheme, syncSettingsUI, PALETTES, isValidAccent,
	generatePaletteSelector, generateFlavourSelector, generateAccentSelector,
} from '../theme.js';
import { consumePendingBuild } from '../backend-suggest.js';

const BACKEND_LABELS = { auto: 'Auto', cpu: 'CPU', cuda: 'CUDA', rocm: 'ROCm', vulkan: 'Vulkan' };

function showRemoveConfirmation(root, backend, onConfirm) {
	const overlay = document.createElement('div');
	overlay.className = 'modal-overlay';
	const dialog = document.createElement('div');
	dialog.className = 'modal-dialog';
	dialog.innerHTML = `
		<h3 class="modal-title">Remove ${BACKEND_LABELS[backend] || backend} Backend</h3>
		<p class="modal-message">This will delete the built library for the ${BACKEND_LABELS[backend] || backend} backend. This action cannot be undone.</p>
		<div class="modal-actions">
			<button class="btn modal-cancel">Cancel</button>
			<button class="btn btn-danger modal-confirm">Remove</button>
		</div>
	`;
	overlay.appendChild(dialog);
	document.body.appendChild(overlay);

	const cancelBtn = dialog.querySelector('.modal-cancel');
	const confirmBtn = dialog.querySelector('.modal-confirm');

	const close = () => overlay.remove();

	cancelBtn.addEventListener('click', close);
	overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

	confirmBtn.addEventListener('click', () => {
		close();
		onConfirm();
	});

	dialog.addEventListener('keydown', (e) => {
		if (e.key === 'Escape') close();
	});

	requestAnimationFrame(() => overlay.classList.add('visible'));
}

function linkSliderAndNumber(sl, num, min, max) {
	if (!sl || !num) return;
	sl.addEventListener('input',  () => { num.value = sl.value; });
	num.addEventListener('input', () => { sl.value = Math.min(max, Math.max(min, parseFloat(num.value) || min)); });
}

function populateAISettingsFields(root, s) {
	if (!s) return;
	const set = (id, v) => { const el = root.querySelector(id); if (el && v != null) el.value = v; };
	set('#default-model-input',  s.defaultModel);
	set('#max-tokens-input',     s.fallbackMaxOutputTokens);
	set('#system-prompt-input',  s.systemPrompt);
	set('#lmstudio-url-input',   s.lmStudioUrl);
	if (s.temperature != null) {
		const t = parseFloat(s.temperature) || 0.7;
		const sl = root.querySelector('#temperature-slider'), nm = root.querySelector('#temperature-input');
		if (sl) sl.value = t; if (nm) nm.value = t;
	}
}

function populateLlamaCppFields(root, s) {
	if (!s) return;
	const fa = root.querySelector('#llamacpp-flash-attn');
	if (fa && s.llamacppFlashAttn != null) fa.checked = Boolean(s.llamacppFlashAttn);
	const set = (id, v) => { const el = root.querySelector(id); if (el && v != null) el.value = v; };
	set('#llamacpp-eval-batch-size', s.llamacppEvalBatchSize);
	set('#llamacpp-ctx-size',        s.llamacppCtxSize);
	set('#llamacpp-gpu-layers',      s.llamacppGpuLayers);
	set('#llamacpp-threads',         s.llamacppThreads);
	set('#llamacpp-threads-batch',   s.llamacppThreadsBatch);
	const setSl = (sid, nid, v) => {
		const sl = root.querySelector(sid), num = root.querySelector(nid);
		if (v == null) return; if (sl) sl.value = v; if (num) num.value = v;
	};
	setSl('#llamacpp-top-p-slider',          '#llamacpp-top-p',          s.llamacppTopP);
	setSl('#llamacpp-min-p-slider',          '#llamacpp-min-p',          s.llamacppMinP);
	setSl('#llamacpp-repeat-penalty-slider', '#llamacpp-repeat-penalty', s.llamacppRepeatPenalty);
	if (s.llamacppBackend != null) selectBackendRadio(root, s.llamacppBackend);
	if (s.llamacppTag != null) { const ti = root.querySelector('#llamacpp-tag-input'); if (ti) ti.value = s.llamacppTag; }
}

function selectBackendRadio(root, value) {
	const valid = ['auto','cpu','cuda','rocm','vulkan'];
	const v = valid.includes(value) ? value : 'auto';
	root.querySelectorAll('input[name="llamacpp-backend"]').forEach(r => {
		r.checked = false;
		const t = r.closest('.flavour-tile');
		if (t) {
			t.classList.remove('selected');
			t.setAttribute('aria-checked', 'false');
		}
	});
	root.querySelectorAll('input[name="llamacpp-backend"]').forEach(r => {
		const ok = r.value === v; r.checked = ok;
		const t = r.closest('.flavour-tile'); if (t) { t.classList.toggle('selected', ok); t.setAttribute('aria-checked', String(ok)); }
	});
}

let _buildPollId = null, _buildPulseRaf = null;
function stopBuildPulse() { if (_buildPulseRaf) { cancelAnimationFrame(_buildPulseRaf); _buildPulseRaf = null; } }

async function startBuildInSettings(root, backend, tag, btn) {
	const progressArea = root.querySelector('#llamacpp-build-progress');
	const labelEl      = root.querySelector('#llamacpp-build-progress-label');
	const pctEl        = root.querySelector('#llamacpp-build-progress-pct');
	const barEl        = root.querySelector('#llamacpp-build-progress-bar');
	const logTail      = root.querySelector('#llamacpp-build-log-tail');

	root.querySelector('#llamacpp-backend-title')?.closest('.card')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
	if (barEl) { barEl.style.transition = 'none'; barEl.style.width = '0%'; barEl.style.background = 'var(--accent)'; }
	if (pctEl) pctEl.textContent = '';
	if (labelEl) labelEl.textContent = `Starting ${BACKEND_LABELS[backend] || backend} build...`;
	if (logTail) logTail.textContent = '';
	if (progressArea) progressArea.hidden = false;
	requestAnimationFrame(() => requestAnimationFrame(() => { if (barEl) barEl.style.transition = 'width 0.4s ease'; }));

	const buildStart = Date.now();
	let firstPctTime = null, firstPctValue = null, lastPercent = -1;
	const formatEta = s => {
		if (!isFinite(s) || s < 0) return '';
		if (s < 60) return `~${Math.round(s)}s remaining`;
		if (s < 3600) return `~${Math.floor(s/60)}m ${Math.round(s%60)}s remaining`;
		return `~${(s/3600).toFixed(1)}h remaining`;
	};
	const pulse = () => {
		if (!barEl || lastPercent >= 0) return;
		barEl.style.transition = 'none';
		barEl.style.width = (3 + 25 * (0.5 + 0.5 * Math.sin(Date.now() / 700))) + '%';
		_buildPulseRaf = requestAnimationFrame(pulse);
	};

	try {
		const r = await fetch('/api/llamacpp/build', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ backend, tag }) });
		const d = await r.json();
		if (!r.ok || d.error) {
			if (labelEl) labelEl.textContent = `Could not start: ${d.error || `HTTP ${r.status}`}`;
			if (btn) { btn.disabled = false; btn.textContent = btn._origText || 'Build'; }
			return;
		}
	} catch (err) {
		if (labelEl) labelEl.textContent = `Error: ${err.message}`;
		if (btn) { btn.disabled = false; btn.textContent = btn._origText || 'Build'; }
		return;
	}

	if (labelEl) labelEl.textContent = `Building ${BACKEND_LABELS[backend] || backend}...`;
	_buildPulseRaf = requestAnimationFrame(pulse);
	if (_buildPollId) { clearInterval(_buildPollId); _buildPollId = null; }

	_buildPollId = setInterval(async () => {
		try {
			const lr = await fetch('/api/llamacpp/build/log?lines=60');
			const ld = await lr.json();
			const pct = typeof ld.percent === 'number' ? ld.percent : -1;
			const lines = Array.isArray(ld.lines) ? ld.lines : [];
			if (logTail) { logTail.textContent = lines.filter(l => l.trim()).slice(-12).join('\n'); logTail.scrollTop = logTail.scrollHeight; }

			let dlPct = -1;
			for (const line of lines) {
				const dlM = line.match(/\[download\s+(\d+)%\s+complete\]/i);
				if (dlM) { dlPct = parseInt(dlM[1], 10); }
				else { const cM = line.match(/Receiving objects:\s+(\d+)%/); if (cM) dlPct = parseInt(cM[1], 10); }
			}
			const activePct = pct >= 0 ? pct : dlPct;
			const allLog = lines.join('\n');
			let phase = '';
			if (pct >= 0 || allLog.match(/Building C(?:XX)? object/)) phase = 'Compiling...';
			else if (allLog.includes('Configuring done')) phase = 'Configuring...';
			else if (dlPct >= 0 || allLog.includes('Cloning into') || allLog.includes('FetchContent')) phase = 'Downloading source...';

			let etaStr = '';
			if (activePct > 0 && activePct < 100) {
				const now = Date.now();
				if (firstPctTime === null || activePct < firstPctValue) { firstPctTime = now; firstPctValue = activePct; }
				else if (activePct > firstPctValue) { const rate = (activePct - firstPctValue) / ((now - firstPctTime) / 1000); etaStr = formatEta((100 - activePct) / rate); }
			} else { firstPctTime = null; firstPctValue = null; }

			if (phase && labelEl) labelEl.textContent = etaStr ? `${phase} ${etaStr}` : phase;

			if (activePct >= 0) {
				if (_buildPulseRaf) { stopBuildPulse(); if (barEl) barEl.style.transition = 'width 0.4s ease'; }
				lastPercent = activePct;
				if (barEl) barEl.style.width = Math.max(2, activePct) + '%';
				if (pctEl) pctEl.textContent = activePct + '%';
			} else if (!_buildPulseRaf && pct < 0) {
				lastPercent = -1;
				if (barEl) barEl.style.transition = 'none';
				if (pctEl) pctEl.textContent = '';
				_buildPulseRaf = requestAnimationFrame(pulse);
			}

			const sr = await fetch('/api/llamacpp/build/status');
			const st = await sr.json();
			if (!st.running && st.done) {
				clearInterval(_buildPollId); _buildPollId = null; stopBuildPulse();
				if (st.success) {
					try {
						await fetch('/api/llamacpp/backend', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ backend }) });
						await fetch('/api/config/settings', { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ llamacppBackend: backend }) }).catch(()=>{});
						await fetch('/api/llamacpp/reload-model', { method: 'POST' }).catch(()=>{});
					} catch {}
					if (barEl) { barEl.style.transition = 'width 0.4s ease'; barEl.style.width = '100%'; }
					if (pctEl) pctEl.textContent = '100%';
					const totalSec = Math.round((Date.now() - buildStart) / 1000);
					const totalStr = totalSec < 60 ? `${totalSec}s` : `${Math.floor(totalSec/60)}m ${totalSec%60}s`;
					if (labelEl) labelEl.textContent = `Built ${BACKEND_LABELS[backend] || backend} in ${totalStr}. Backend activated.`;
					if (btn) { btn.textContent = 'Done'; btn.style.color = 'var(--green,green)'; btn.style.opacity = ''; }
					const container = root.querySelector('#llamacpp-backend-selector');
					if (container) {
						const rows = [...container.children];
						const targetRow = rows.find(row => {
							const radio = row.querySelector(`input[value="${backend}"]`);
							return radio;
						});
						if (targetRow) {
							container.querySelectorAll('.flavour-tile').forEach(tile => {
								tile.classList.remove('selected');
								tile.setAttribute('aria-checked', 'false');
							});
							container.querySelectorAll('input[name="llamacpp-backend"]').forEach(radio => {
								radio.checked = false;
							});
							const radio = targetRow.querySelector(`input[value="${backend}"]`);
							if (radio) {
								radio.disabled = false;
								radio.checked = true;
								const tile = radio.closest('.flavour-tile');
								if (tile) {
									tile.style.opacity = '1';
									tile.classList.add('selected');
									tile.setAttribute('aria-checked', 'true');
								}
							}
							const existingRemove = targetRow.querySelector('.btn-remove');
							if (existingRemove) existingRemove.remove();
						}
					}
					const activeLabel = root.querySelector('#llamacpp-active-backend-label');
					if (activeLabel) activeLabel.textContent = BACKEND_LABELS[backend] || backend.toUpperCase();
					setTimeout(() => {
						if (btn) { btn.disabled = false; btn.textContent = 'Rebuild'; btn.style.color = ''; btn.style.opacity = ''; }
						const container = root.querySelector('#llamacpp-backend-selector');
						if (container) {
							const rows = [...container.children];
							const targetRow = rows.find(row => {
								const radio = row.querySelector(`input[value="${backend}"]`);
								return radio;
							});
							if (targetRow && !targetRow.querySelector('.btn-remove')) {
								const removeBtn = document.createElement('button');
								removeBtn.type = 'button';
								removeBtn.className = 'btn btn-danger-sm btn-remove';
								removeBtn.textContent = 'Remove';
								removeBtn.addEventListener('click', () => {
									showRemoveConfirmation(root, backend, async () => {
										removeBtn.disabled = true; removeBtn.textContent = 'Removing...';
										try {
											const res = await fetch(`/api/llamacpp/backend/${backend}`, { method: 'DELETE' });
											const d = await res.json();
											if (res.ok && d.success) {
												removeBtn.textContent = 'Removed';
												removeBtn.style.opacity = '0.3';
												await initBackendSelector(root);
											} else {
												removeBtn.textContent = 'Failed';
												removeBtn.disabled = false;
											}
										} catch (err) {
											removeBtn.textContent = 'Error';
											removeBtn.disabled = false;
										}
									});
								});
								const buildBtn = targetRow.querySelector('.btn-build');
								if (buildBtn) buildBtn.insertAdjacentElement('afterend', removeBtn);
							}
						}
					}, 1000);
				} else {
					if (barEl) { barEl.style.background = 'var(--red,red)'; barEl.style.width = '100%'; }
					if (labelEl) labelEl.textContent = `Build failed. Check data/logs/build_${backend}.log`;
					if (btn) { btn.disabled = false; btn.textContent = btn._origText || 'Build'; btn.style.color = ''; }
				}
			}
		} catch {}
	}, 1500);
}

async function initBackendSelector(root) {
	const container   = root.querySelector('#llamacpp-backend-selector');
	const activeLabel = root.querySelector('#llamacpp-active-backend-label');
	const tagInput    = root.querySelector('#llamacpp-tag-input');
	if (!container) return;

	container.innerHTML = '';
	const loading = document.createElement('span');
	loading.style.cssText = 'color:var(--muted);font-size:0.85rem;';
	loading.textContent = 'Loading...';
	container.appendChild(loading);

	let data = null;
	try {
		const res = await fetch('/api/llamacpp/backend');
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		data = await res.json();
	} catch (err) {
		loading.textContent = `Could not load backend info: ${err.message}`;
		if (activeLabel) activeLabel.textContent = 'unknown';
		return;
	}
	loading.remove();

	const allBackends = Array.isArray(data.all) ? data.all : ['cpu','cuda','rocm','vulkan'];
	const available   = Array.isArray(data.available) ? data.available : [];
	const hardware    = Array.isArray(data.hardware)  ? data.hardware  : [];
	const prereqs     = (data.prereqs && typeof data.prereqs === 'object') ? data.prereqs : {};
	const active = data.active || 'none', setting = data.setting || 'auto', tag = data.tag || 'b8337';

	if (tagInput)    tagInput.value = tag;
	if (activeLabel) activeLabel.textContent = active === 'none' ? 'None' : (BACKEND_LABELS[active] || active.toUpperCase());

	for (const backend of ['auto', ...allBackends]) {
		const isBuilt     = backend === 'auto' || available.includes(backend);
		const hasHardware = backend === 'auto' || hardware.includes(backend);
		const row = document.createElement('div');
		row.style.cssText = 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;';
		const tileLabel = document.createElement('label');
		tileLabel.className = 'flavour-tile'; tileLabel.style.width = 'fit-content';
		tileLabel.setAttribute('aria-checked', 'false');
		if (!isBuilt) {
			tileLabel.style.opacity = '0.5';
			tileLabel.classList.remove('selected');
			tileLabel.setAttribute('aria-checked', 'false');
		}
		const radio = document.createElement('input');
		radio.type = 'radio'; radio.name = 'llamacpp-backend'; radio.value = backend; radio.disabled = !isBuilt;
		const dot = document.createElement('span'); dot.className = 'dot'; dot.setAttribute('aria-hidden', 'true');
		const text = document.createElement('span'); text.innerHTML = BACKEND_LABELS[backend] || backend;
		tileLabel.append(radio, dot, text);
		row.appendChild(tileLabel);

		if (backend !== 'auto') {
			const btn = document.createElement('button');
			btn.type = 'button'; btn.className = 'btn btn-build';
			btn._origText = isBuilt ? 'Rebuild' : 'Build'; btn.textContent = btn._origText;
			btn.style.cssText = isBuilt ? 'font-size:0.75rem;padding:2px 8px;' : 'font-size:0.78rem;padding:3px 10px;';
			btn.addEventListener('click', () => {
				btn.disabled = true; btn.textContent = 'Building...'; btn.style.color = '';
				startBuildInSettings(root, backend, tagInput?.value?.trim() || tag, btn).catch(() => { btn.disabled = false; btn.textContent = btn._origText; });
			});
			row.appendChild(btn);

			if (isBuilt) {
				const removeBtn = document.createElement('button');
				removeBtn.type = 'button'; removeBtn.className = 'btn btn-danger-sm btn-remove';
				removeBtn.textContent = 'Remove';
				removeBtn.addEventListener('click', () => {
					showRemoveConfirmation(root, backend, async () => {
						removeBtn.disabled = true; removeBtn.textContent = 'Removing...';
						try {
							const res = await fetch(`/api/llamacpp/backend/${backend}`, { method: 'DELETE' });
							const d = await res.json();
							if (res.ok && d.success) {
								removeBtn.textContent = 'Removed';
								removeBtn.style.opacity = '0.3';
								await initBackendSelector(root);
							} else {
								removeBtn.textContent = 'Failed';
								removeBtn.disabled = false;
							}
						} catch (err) {
							removeBtn.textContent = 'Error';
							removeBtn.disabled = false;
						}
					});
				});
				row.appendChild(removeBtn);
			}

			const prereqMsg = prereqs[backend];
			if (prereqMsg && !isBuilt) {
				const warn = document.createElement('div');
				warn.style.cssText = ['width:100%','margin-top:4px','padding:6px 10px','font-size:0.78rem','line-height:1.5','color:color-mix(in srgb,var(--text) 85%,transparent)','background:color-mix(in srgb,var(--accent) 8%,transparent)','border-left:3px solid color-mix(in srgb,var(--accent) 60%,transparent)','white-space:pre-wrap','word-break:break-word','font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace'].join(';');
				warn.innerHTML = 'Warning: ' + prereqMsg.replace(/(https?:\/\/[^\s)]+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer" style="color:var(--accent);text-decoration:underline;">$1</a>');
				row.appendChild(warn);
			}
		}
		container.appendChild(row);
	}

	selectBackendRadio(root, setting);
	container.addEventListener('change', (e) => {
		if (e.target.name !== 'llamacpp-backend') return;
		container.querySelectorAll('input[name="llamacpp-backend"]').forEach(r => {
			r.checked = false;
			const t = r.closest('.flavour-tile');
			if (t) {
				t.classList.remove('selected');
				t.setAttribute('aria-checked', 'false');
			}
		});
		const target = e.target;
		target.checked = true;
		const t = target.closest('.flavour-tile');
		if (t) {
			t.classList.add('selected');
			t.setAttribute('aria-checked', 'true');
		}
	});

	const pending = consumePendingBuild();
	if (pending) {
		const { backend: pb, tag: pt } = pending;
		const matchBtn = [...container.children].map(row => ({ radio: row.querySelector(`input[value="${pb}"]`), btn: row.querySelector('button') })).filter(x => x.radio && x.btn).map(x => x.btn)[0];
		if (matchBtn) { matchBtn.disabled = true; matchBtn.textContent = 'Building...'; await startBuildInSettings(root, pb, pt, matchBtn); }
		else await startBuildInSettings(root, pb, pt, null);
	}

	window.addEventListener('ctrlpanel:checkPendingBuild', async () => {
		const p = consumePendingBuild(); if (p) await initBackendSelector(root);
	}, { once: true });
	return data;
}

export function initSettingsPage(root) {
	if (!root) return;

	const paletteList = root.querySelector('[data-palette-list]');
	const flavourList = root.querySelector('[data-flavour-list]');
	const accentGrid  = root.querySelector('[data-accent-grid]');

	if (paletteList && flavourList && accentGrid) {
		const { palette: cp } = splitThemeKey(document.documentElement.getAttribute('data-theme') || '');
		generatePaletteSelector(paletteList);
		generateFlavourSelector(flavourList, cp);
		generateAccentSelector(accentGrid, cp);

		paletteList.addEventListener('change', (e) => {
			if (e.target.name !== 'palette') return;
			const p = e.target.value, d = PALETTES[p]; if (!d) return;
			generateFlavourSelector(flavourList, p); generateAccentSelector(accentGrid, p);
			setTheme(`${p}-${d.defaultFlavour}-${d.defaultAccent}`);
		});
		flavourList.addEventListener('change', (e) => {
			if (e.target.name !== 'flavour') return;
			const { palette, accent } = splitThemeKey(document.documentElement.getAttribute('data-theme') || '');
			setTheme(`${palette}-${e.target.value}-${isValidAccent(palette, accent) ? accent : PALETTES[palette].defaultAccent}`);
		});
		accentGrid.addEventListener('click', (e) => {
			const btn = e.target.closest('button[data-accent]'); if (!btn) return;
			const { palette, flavour } = splitThemeKey(document.documentElement.getAttribute('data-theme') || '');
			if (isValidAccent(palette, btn.dataset.accent)) setTheme(`${palette}-${flavour}-${btn.dataset.accent}`);
		});
		accentGrid.addEventListener('keydown', (e) => {
			const nav = ['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'];
			if (!nav.includes(e.key) && e.key !== ' ' && e.key !== 'Enter') return;
			const items = [...accentGrid.querySelectorAll('button[data-accent][role="radio"]')]; if (!items.length) return;
			const cur = items.findIndex(el => el.classList.contains('selected'));
			if (nav.includes(e.key)) {
				e.preventDefault();
				const cols = parseInt(getComputedStyle(accentGrid).getPropertyValue('--cols') || '7', 10);
				const moves = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -cols, ArrowDown: cols };
				items[(cur + moves[e.key] + items.length) % items.length]?.focus();
			} else { e.preventDefault(); (document.activeElement?.closest('button[data-accent][role="radio"]') || items[cur])?.click(); }
		});
		syncSettingsUI(root);
	}

	const lmStatusEl = root.querySelector('#lmstudio-status'), lmTestBtn = root.querySelector('#refresh-lmstudio-status');
	if (lmStatusEl && lmTestBtn) {
		lmTestBtn.addEventListener('click', async () => {
			lmStatusEl.textContent = 'Testing...'; lmStatusEl.className = 'badge';
			try {
				const r = await fetch('/api/lmstudio/models');
				const d = await r.json();
				if (r.ok && d?.data?.length > 0) { lmStatusEl.textContent = `${d.data.length} model${d.data.length===1?'':'s'}`; lmStatusEl.className = 'badge badge-success'; }
				else { lmStatusEl.textContent = 'Unreachable'; lmStatusEl.className = 'badge badge-error'; }
			} catch { lmStatusEl.textContent = 'Unreachable'; lmStatusEl.className = 'badge badge-error'; }
		});
	}

	const tempSl = root.querySelector('#temperature-slider'), tempNum = root.querySelector('#temperature-input');
	if (tempSl && tempNum) {
		tempSl.addEventListener('input',  () => { tempNum.value = tempSl.value; });
		tempNum.addEventListener('input', () => { tempSl.value = Math.min(2, Math.max(0, parseFloat(tempNum.value) || 0)); });
	}
	linkSliderAndNumber(root.querySelector('#llamacpp-top-p-slider'),          root.querySelector('#llamacpp-top-p'),          0, 1);
	linkSliderAndNumber(root.querySelector('#llamacpp-min-p-slider'),          root.querySelector('#llamacpp-min-p'),          0, 1);
	linkSliderAndNumber(root.querySelector('#llamacpp-repeat-penalty-slider'), root.querySelector('#llamacpp-repeat-penalty'), 1, 2);

	const cached = SettingsStore.get();
	if (cached) { populateAISettingsFields(root, cached); populateLlamaCppFields(root, cached); }

	initBackendSelector(root).catch(console.warn);

	const watchedFields = ['#default-model-input','#temperature-slider','#temperature-input','#max-tokens-input','#system-prompt-input','#lmstudio-url-input','#llamacpp-flash-attn','#llamacpp-eval-batch-size','#llamacpp-ctx-size','#llamacpp-gpu-layers','#llamacpp-threads','#llamacpp-threads-batch','#llamacpp-top-p-slider','#llamacpp-top-p','#llamacpp-min-p-slider','#llamacpp-min-p','#llamacpp-repeat-penalty-slider','#llamacpp-repeat-penalty'];
	const unsub = SettingsStore.subscribe((s) => {
		const focused = document.activeElement;
		if (!watchedFields.some(sel => root.querySelector(sel) === focused)) { populateAISettingsFields(root, s); populateLlamaCppFields(root, s); }
	});
	const obs = new MutationObserver(() => { if (!document.body.contains(root)) { unsub(); obs.disconnect(); } });
	obs.observe(document.body, { childList: true, subtree: true });

	const saveBtn  = root.querySelector('#save-ai-settings'), statusEl = root.querySelector('#ai-settings-status');
	if (saveBtn) {
		saveBtn.addEventListener('click', async () => {
			saveBtn.disabled = true;
			if (statusEl) { statusEl.textContent = 'Saving...'; statusEl.style.color = ''; }
			try {
				await SettingsStore.save({
					systemPrompt:            root.querySelector('#system-prompt-input')?.value ?? '',
					defaultModel:            root.querySelector('#default-model-input')?.value?.trim() ?? '',
					temperature:             parseFloat(tempNum?.value ?? tempSl?.value ?? '0.7') || 0.7,
					fallbackMaxOutputTokens: parseInt(root.querySelector('#max-tokens-input')?.value ?? '8192', 10) || 8192,
					lmStudioUrl:             root.querySelector('#lmstudio-url-input')?.value?.trim() || 'http://localhost:1234',
				});
				if (statusEl) { statusEl.textContent = 'Saved.'; statusEl.style.color = 'var(--green,green)'; setTimeout(() => { statusEl.textContent = ''; }, 3000); }
			} catch (err) {
				if (statusEl) { statusEl.textContent = 'Error: ' + err.message; statusEl.style.color = 'var(--red,red)'; }
			} finally { saveBtn.disabled = false; }
		});
	}

	const saveBackendBtn = root.querySelector('#save-llamacpp-backend'), backendStatus = root.querySelector('#llamacpp-backend-save-status');
	if (saveBackendBtn) {
		saveBackendBtn.addEventListener('click', async () => {
			saveBackendBtn.disabled = true;
			if (backendStatus) { backendStatus.textContent = 'Applying...'; backendStatus.style.color = ''; }
			try {
				const selected = root.querySelector('input[name="llamacpp-backend"]:checked');
				const backend  = selected?.value || 'auto';
				const tagVal   = root.querySelector('#llamacpp-tag-input')?.value?.trim() || 'b8337';
				const res = await fetch('/api/llamacpp/backend', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ backend }) });
				const d = await res.json();
				await SettingsStore.save({ llamacppBackend: backend, llamacppTag: tagVal });
				if (d.success || d.active) {
					const al = root.querySelector('#llamacpp-active-backend-label');
					if (al && d.active) al.textContent = BACKEND_LABELS[d.active] || d.active;
					if (backendStatus) { backendStatus.textContent = 'Applied.'; backendStatus.style.color = 'var(--green,green)'; setTimeout(() => { backendStatus.textContent = ''; }, 4000); }
				} else throw new Error(d.error || 'Backend switch failed');
			} catch (err) {
				if (backendStatus) { backendStatus.textContent = 'Error: ' + err.message; backendStatus.style.color = 'var(--red,red)'; }
			} finally { saveBackendBtn.disabled = false; }
		});
	}

	const saveLCppBtn = root.querySelector('#save-llamacpp-settings'), lcppStatus = root.querySelector('#llamacpp-settings-status');
	if (saveLCppBtn) {
		saveLCppBtn.addEventListener('click', async () => {
			saveLCppBtn.disabled = true;
			if (lcppStatus) { lcppStatus.textContent = 'Saving...'; lcppStatus.style.color = ''; }
			try {
				await SettingsStore.save({
					llamacppFlashAttn:     root.querySelector('#llamacpp-flash-attn')?.checked ?? true,
					llamacppEvalBatchSize: parseInt(root.querySelector('#llamacpp-eval-batch-size')?.value ?? '2048', 10) || 2048,
					llamacppCtxSize:       parseInt(root.querySelector('#llamacpp-ctx-size')?.value ?? '0',    10) || 0,
					llamacppGpuLayers:     parseInt(root.querySelector('#llamacpp-gpu-layers')?.value ?? '0',  10) || 0,
					llamacppThreads:       parseInt(root.querySelector('#llamacpp-threads')?.value ?? '0',     10) || 0,
					llamacppThreadsBatch:  parseInt(root.querySelector('#llamacpp-threads-batch')?.value ?? '0', 10) || 0,
					llamacppTopP:          parseFloat(root.querySelector('#llamacpp-top-p')?.value ?? '0.9')   || 0.9,
					llamacppMinP:          parseFloat(root.querySelector('#llamacpp-min-p')?.value ?? '0.05')  || 0.05,
					llamacppRepeatPenalty: parseFloat(root.querySelector('#llamacpp-repeat-penalty')?.value ?? '1.15') || 1.15,
				});
				try {
					await fetch('/api/llamacpp/reload-model', { method: 'POST' });
					if (lcppStatus) { lcppStatus.textContent = 'Saved & reloaded.'; lcppStatus.style.color = 'var(--green,green)'; setTimeout(() => { lcppStatus.textContent = ''; }, 3000); }
				} catch {
					if (lcppStatus) { lcppStatus.textContent = 'Saved.'; lcppStatus.style.color = 'var(--green,green)'; setTimeout(() => { lcppStatus.textContent = ''; }, 3000); }
				}
			} catch (err) {
				if (lcppStatus) { lcppStatus.textContent = 'Error: ' + err.message; lcppStatus.style.color = 'var(--red,red)'; }
			} finally { saveLCppBtn.disabled = false; }
		});
	}

	if (!SettingsStore.get()) {
		SettingsStore.init().then(s => { populateAISettingsFields(root, s); populateLlamaCppFields(root, s); }).catch(console.warn);
	}
}
