// www/js/settings/page.js
// Settings page initialiser and all supporting helpers (build progress,
// backend selector, AI/llama.cpp save buttons).
// Extracted from theme.js to keep that file focused on theme management.

import * as SettingsStore from '../../services/settings.js';
import {
	splitThemeKey, setTheme, syncSettingsUI, PALETTES, isValidAccent,
	generatePaletteSelector, generateFlavourSelector, generateAccentSelector,
} from './theme-section.js';
import { consumePendingBuild } from '../../services/backend-suggest.js';
import { mountModelManager } from './model-manager-section.js';
import { mountAiSection } from './ai-section.js';
import { mountBackendSection } from './backend-section.js';
import { formatKeepAlive, mountLlamacppSection } from './llamacpp-section.js';
import { mountToolsSection } from './tools-section.js';

const BACKEND_LABELS = { auto: 'Auto', cpu: 'CPU', cuda: 'CUDA', rocm: 'ROCm', vulkan: 'Vulkan' };
const BUILD_LOG_LINES = 120;
const BUILD_LOG_ANSI_REGEX = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;
const APP_BACKEND_RESTART_TIMEOUT_MS = 60000;

const wait = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs));

function sanitizeBuildLogChunk(text) {
	return text.replace(BUILD_LOG_ANSI_REGEX, '').replace(/\r/g, '');
}

function showActionConfirmation({ title, message, confirmLabel = 'Confirm', confirmClassName = 'btn-primary' }, onConfirm) {
	const overlay = document.createElement('div');
	overlay.className = 'modal-overlay';
	const dialog = document.createElement('div');
	dialog.className = 'modal-dialog';
	dialog.innerHTML = `
		<h3 class="modal-title">${title}</h3>
		<p class="modal-message">${message}</p>
		<div class="modal-actions">
			<button class="btn modal-cancel">Cancel</button>
			<button class="btn modal-confirm ${confirmClassName}">${confirmLabel}</button>
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

function showRemoveConfirmation(root, backend, onConfirm) {
	showActionConfirmation(
		{
			title: `Remove ${BACKEND_LABELS[backend] || backend} Backend`,
			message: `This will delete the built library for the ${BACKEND_LABELS[backend] || backend} backend. This action cannot be undone.`,
			confirmLabel: 'Remove',
			confirmClassName: 'btn-danger',
		},
		onConfirm,
	);
}

function renderAppBackendStatus(root, data) {
	const statusEl = root.querySelector('#app-backend-status');
	const restartBtn = root.querySelector('#restart-app-backend');
	const stopBtn = root.querySelector('#stop-app-backend');
	const busy = root.dataset.appBackendBusy === 'true';
	if (!statusEl) return;

	if (!data || typeof data !== 'object') {
		statusEl.textContent = 'Backend status unavailable.';
		if (restartBtn) restartBtn.disabled = true;
		if (stopBtn) stopBtn.disabled = true;
		return;
	}

	const appState = data.shutdownRequested
		? 'Backend shutting down'
		: data.restartPending
			? 'Backend restart queued'
			: data.running
				? 'Backend running'
				: 'Backend stopped';

	const routerLabel = data.routerBackend ? (BACKEND_LABELS[data.routerBackend] || data.routerBackend.toUpperCase()) : 'none';
	const routerState = data.routerRunning
		? `llama.cpp ${data.routerReady ? 'ready' : 'starting'} on ${routerLabel}`
		: 'llama.cpp stopped';

	const details = [appState];
	if (Number.isFinite(data.pid) && data.pid > 0) details.push(`PID ${data.pid}`);
	details.push(routerState);
	if (Number.isFinite(data.routerLoadedModels) && data.routerLoadedModels > 0) {
		details.push(`${data.routerLoadedModels} model${data.routerLoadedModels === 1 ? '' : 's'} loaded`);
	}
	if (data.buildRunning) details.push('build in progress');
	statusEl.textContent = details.join(' · ');

	const lifecycleLocked = busy || data.shutdownRequested || data.restartPending || data.buildRunning;
	if (restartBtn) restartBtn.disabled = lifecycleLocked || data.restartSupported === false;
	if (stopBtn) stopBtn.disabled = lifecycleLocked;
}

async function loadAppBackendStatus(root) {
	try {
		const response = await fetch('/api/app/backend/status');
		const data = await response.json();
		if (!response.ok) throw new Error(data?.error || `HTTP ${response.status}`);
		renderAppBackendStatus(root, data);
		return data;
	} catch (err) {
		const statusEl = root.querySelector('#app-backend-status');
		const restartBtn = root.querySelector('#restart-app-backend');
		const stopBtn = root.querySelector('#stop-app-backend');
		if (statusEl) statusEl.textContent = `Could not load backend status: ${err.message}`;
		if (restartBtn) restartBtn.disabled = true;
		if (stopBtn) stopBtn.disabled = true;
		throw err;
	}
}

async function probeBackendHealth() {
	try {
		const response = await fetch('/health', { cache: 'no-store' });
		return response.ok;
	} catch {
		return false;
	}
}

async function waitForBackendRestartCycle() {
	const startedAt = Date.now();
	const deadline = startedAt + APP_BACKEND_RESTART_TIMEOUT_MS;
	let sawDisconnect = false;

	await wait(700);

	while (Date.now() < deadline) {
		const healthy = await probeBackendHealth();
		if (!healthy) sawDisconnect = true;
		if (healthy && (sawDisconnect || (Date.now() - startedAt) >= 5000)) {
			return true;
		}
		await wait(1000);
	}

	return false;
}

function linkSliderAndNumber(sl, num, min, max) {
	if (!sl || !num) return;
	sl.addEventListener('input',  () => { num.value = sl.value; });
	num.addEventListener('input', () => { sl.value = Math.min(max, Math.max(min, parseFloat(num.value) || min)); });
}

let _buildPollId = null, _buildLogOffset = 0;

async function startBuildInSettings(root, backend, tag, btn) {
	const progressArea = root.querySelector('#llamacpp-build-progress');
	const labelEl      = root.querySelector('#llamacpp-build-progress-label');
	const pctEl        = root.querySelector('#llamacpp-build-progress-pct');
	const barEl        = root.querySelector('#llamacpp-build-progress-bar');
	const logTail      = root.querySelector('#llamacpp-build-log-tail');

	root.querySelector('#llamacpp-backend-title')?.closest('.card')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
	if (barEl) { barEl.style.transition = 'none'; barEl.style.width = '0%'; barEl.style.background = 'var(--accent)'; }
	if (pctEl) pctEl.textContent = '0%';
	if (labelEl) labelEl.textContent = 'Preparing build (1/7)';
	_buildLogOffset = 0;
	if (logTail) logTail.textContent = '';
	if (progressArea) progressArea.hidden = false;
	requestAnimationFrame(() => requestAnimationFrame(() => { if (barEl) barEl.style.transition = 'width 0.4s ease'; }));

	const buildStart = Date.now();
	let firstPctTime = null, firstPctValue = null;
	const formatEta = s => {
		if (!isFinite(s) || s < 0) return '';
		if (s < 60) return `~${Math.round(s)}s remaining`;
		if (s < 3600) return `~${Math.floor(s/60)}m ${Math.round(s%60)}s remaining`;
		return `~${(s/3600).toFixed(1)}h remaining`;
	};
	const clampPercent = value => Math.max(0, Math.min(100, Math.trunc(value)));
	const updateProgressUi = status => {
		const rawOverall = Number.isFinite(status?.overallPercent) ? status.overallPercent : 0;
		const overallPercent = clampPercent(rawOverall);
		const stageLabel = typeof status?.stageLabel === 'string' && status.stageLabel
			? status.stageLabel
			: 'Building';
		const stageIndex = Number.isFinite(status?.stageIndex) ? Math.max(0, Math.trunc(status.stageIndex)) : 0;
		const stageCount = Number.isFinite(status?.stageCount) ? Math.max(0, Math.trunc(status.stageCount)) : 0;

		let etaStr = '';
		if (overallPercent > 0 && overallPercent < 100) {
			const now = Date.now();
			if (firstPctTime === null || overallPercent < firstPctValue) {
				firstPctTime = now;
				firstPctValue = overallPercent;
			} else if (overallPercent > firstPctValue) {
				const elapsedSeconds = (now - firstPctTime) / 1000;
				const rate = elapsedSeconds > 0 ? (overallPercent - firstPctValue) / elapsedSeconds : 0;
				if (rate > 0) etaStr = formatEta((100 - overallPercent) / rate);
			}
		} else {
			firstPctTime = null;
			firstPctValue = null;
		}

		const stageText = stageIndex > 0 && stageCount > 0
			? `${stageLabel} (${stageIndex}/${stageCount})`
			: stageLabel;
		if (labelEl) labelEl.textContent = etaStr ? `${stageText} ${etaStr}` : stageText;
		if (pctEl) pctEl.textContent = `${overallPercent}%`;
		if (barEl) {
			barEl.style.transition = 'width 0.4s ease';
			barEl.style.width = `${Math.max(2, overallPercent)}%`;
		}
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

	if (_buildPollId) { clearInterval(_buildPollId); _buildPollId = null; }

	_buildPollId = setInterval(async () => {
		try {
			const [lr, sr] = await Promise.all([
				fetch(`/api/llamacpp/build/log?lines=${BUILD_LOG_LINES}&offset=${_buildLogOffset}`),
				fetch('/api/llamacpp/build/status'),
			]);
			const [ld, st] = await Promise.all([lr.json(), sr.json()]);
			const chunk = typeof ld.chunk === 'string' ? ld.chunk : '';
			const resetLog = ld.reset === true;

			if (resetLog) {
				_buildLogOffset = 0;
				if (logTail) logTail.textContent = '';
			}
			if (typeof ld.nextOffset === 'number' && Number.isFinite(ld.nextOffset)) {
				_buildLogOffset = Math.max(0, Math.trunc(ld.nextOffset));
			}
			if (logTail && chunk) {
				logTail.textContent += sanitizeBuildLogChunk(chunk);
				logTail.scrollTop = logTail.scrollHeight;
			}

			updateProgressUi(st);
			if (!st.running && st.done) {
				clearInterval(_buildPollId); _buildPollId = null;
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
						const rows =[...container.children];
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
												await initBackendSelector(root, backendSection);
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

async function initBackendSelector(root, backendSection) {
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

	const allBackends = Array.isArray(data.all) ? data.all :['cpu','cuda','rocm','vulkan'];
	const available   = Array.isArray(data.available) ? data.available :[];
	const hardware    = Array.isArray(data.hardware)  ? data.hardware  :[];
	const prereqs     = (data.prereqs && typeof data.prereqs === 'object') ? data.prereqs : {};
	const active = data.active || 'none', setting = data.setting || 'auto', tag = data.tag || 'b8846';

	if (tagInput)    tagInput.value = tag;
	if (activeLabel) activeLabel.textContent = active === 'none' ? 'None' : (BACKEND_LABELS[active] || active.toUpperCase());

	for (const backend of['auto', ...allBackends]) {
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
			btn.style.cssText = 'font-size:0.85rem;padding:6px 12px;';
			btn.addEventListener('click', () => {
				btn.disabled = true; btn.textContent = 'Building...'; btn.style.color = '';
				startBuildInSettings(root, backend, tagInput?.value?.trim() || tag, btn).catch(() => { btn.disabled = false; btn.textContent = btn._origText; });
			});
			row.appendChild(btn);

			if (isBuilt) {
				const removeBtn = document.createElement('button');
				removeBtn.type = 'button'; removeBtn.className = 'btn btn-danger-sm btn-remove';
				removeBtn.textContent = 'Remove';
				removeBtn.style.cssText = 'font-size:0.85rem;padding:6px 12px;';
				removeBtn.addEventListener('click', () => {
					showRemoveConfirmation(root, backend, async () => {
						removeBtn.disabled = true; removeBtn.textContent = 'Removing...';
						try {
							const res = await fetch(`/api/llamacpp/backend/${backend}`, { method: 'DELETE' });
							const d = await res.json();
							if (res.ok && d.success) {
								removeBtn.textContent = 'Removed';
								removeBtn.style.opacity = '0.3';
								await initBackendSelector(root, backendSection);
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
				warn.style.cssText =['width:100%','margin-top:4px','padding:6px 10px','font-size:0.78rem','line-height:1.5','color:color-mix(in srgb,var(--text) 85%,transparent)','background:color-mix(in srgb,var(--accent) 8%,transparent)','border-left:3px solid color-mix(in srgb,var(--accent) 60%,transparent)','white-space:pre-wrap','word-break:break-word','font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace'].join(';');
				warn.innerHTML = 'Warning: ' + prereqMsg.replace(/(https?:\/\/[^\s)]+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer" style="color:var(--accent);text-decoration:underline;">$1</a>');
				row.appendChild(warn);
			}
		}
		container.appendChild(row);
	}

	backendSection.select(setting);
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
		const p = consumePendingBuild(); if (p) await initBackendSelector(root, backendSection);
	}, { once: true });
	return data;
}

function initSettingsPage(root) {
	if (!root) return;
	root.dataset.appBackendBusy = 'false';

	const aiSection = mountAiSection(root);
	const toolsSection = mountToolsSection(root);
	const backendSection = mountBackendSection(root);
	const llamacppSection = mountLlamacppSection(root, backendSection);

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
			const nav =['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'];
			if (!nav.includes(e.key) && e.key !== ' ' && e.key !== 'Enter') return;
			const items =[...accentGrid.querySelectorAll('button[data-accent][role="radio"]')]; if (!items.length) return;
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

	const kaSl = root.querySelector('#llamacpp-keep-alive-slider');
	const kaDisp = root.querySelector('#llamacpp-keep-alive-display');
	if (kaSl && kaDisp) {
		kaSl.addEventListener('input', () => {
			kaDisp.textContent = formatKeepAlive(parseInt(kaSl.value, 10));
		});
	}

	const cached = SettingsStore.get();
	if (cached) {
		aiSection.populate(cached);
		llamacppSection.populate(cached);
	}

	initBackendSelector(root, backendSection).catch(console.warn);
	loadAppBackendStatus(root).catch(() => {});

	const restartBackendBtn = root.querySelector('#restart-app-backend');
	const stopBackendBtn = root.querySelector('#stop-app-backend');
	const appBackendActionStatus = root.querySelector('#app-backend-action-status');

	const setAppBackendBusy = (busy) => {
		root.dataset.appBackendBusy = busy ? 'true' : 'false';
		if (!busy) {
			loadAppBackendStatus(root).catch(() => {});
		}
	};

	const runAppBackendAction = async (action) => {
		const isRestart = action === 'restart';
		setAppBackendBusy(true);
		if (appBackendActionStatus) {
			appBackendActionStatus.textContent = isRestart ? 'Restarting…' : 'Stopping…';
			appBackendActionStatus.style.color = '';
		}

		try {
			const response = await fetch(`/api/app/backend/${action}`, { method: 'POST' });
			const data = await response.json().catch(() => ({}));
			if (!response.ok || data?.success !== true) {
				throw new Error(data?.error || `HTTP ${response.status}`);
			}

			if (isRestart) {
				if (appBackendActionStatus) {
					appBackendActionStatus.textContent = 'Restart scheduled. Waiting for backend…';
				}
				const ready = await waitForBackendRestartCycle();
				if (ready) {
					if (appBackendActionStatus) {
						appBackendActionStatus.textContent = 'Backend restarted. Reloading…';
						appBackendActionStatus.style.color = 'var(--green,green)';
					}
					window.location.reload();
					return;
				}

				if (appBackendActionStatus) {
					appBackendActionStatus.textContent = 'Restart requested. Waiting for the backend to come back…';
					appBackendActionStatus.style.color = '';
				}
				return;
			}

			if (appBackendActionStatus) {
				appBackendActionStatus.textContent = 'Backend stopping…';
				appBackendActionStatus.style.color = '';
			}
		} catch (err) {
			if (appBackendActionStatus) {
				appBackendActionStatus.textContent = 'Error: ' + err.message;
				appBackendActionStatus.style.color = 'var(--red,red)';
			}
			setAppBackendBusy(false);
		}
	};

	if (restartBackendBtn) {
		restartBackendBtn.addEventListener('click', () => {
			showActionConfirmation(
				{
					title: 'Restart Application Backend',
					message: 'This will restart the entire backend process, stop active tasks, and send you back through login when it comes back.',
					confirmLabel: 'Restart',
					confirmClassName: 'btn-primary',
				},
				() => { runAppBackendAction('restart').catch(console.warn); },
			);
		});
	}

	if (stopBackendBtn) {
		stopBackendBtn.addEventListener('click', () => {
			showActionConfirmation(
				{
					title: 'Stop Application Backend',
					message: 'This will stop the entire backend process, including llama.cpp. You will need to launch the app again to use it.',
					confirmLabel: 'Stop Backend',
					confirmClassName: 'btn-danger',
				},
				() => { runAppBackendAction('stop').catch(console.warn); },
			);
		});
	}

	const appBackendStatusPollId = window.setInterval(() => {
		if (!document.body.contains(root)) return;
		if (root.dataset.appBackendBusy === 'true') return;
		loadAppBackendStatus(root).catch(() => {});
	}, 5000);

	const watchedFields =['#default-model-input','#temperature-slider','#temperature-input','#max-tokens-input','#system-prompt-input','#lmstudio-url-input','#llamacpp-flash-attn','#llamacpp-kv-cache-reuse','#llamacpp-eval-batch-size','#llamacpp-ctx-size','#llamacpp-gpu-layers','#llamacpp-threads','#llamacpp-threads-batch','#llamacpp-parallel-slots','#llamacpp-max-loaded-models','#llamacpp-top-p-slider','#llamacpp-top-p','#llamacpp-min-p-slider','#llamacpp-min-p','#llamacpp-repeat-penalty-slider','#llamacpp-repeat-penalty','#llamacpp-keep-alive-slider','#llamacpp-kv-cache-type','#llamacpp-concurrent-generation','#ai-title-enabled','#ai-title-model-input','#ai-title-system-prompt-input'];
	const unsub = SettingsStore.subscribe((s) => {
		const focused = document.activeElement;
		if (!watchedFields.some(sel => root.querySelector(sel) === focused)) {
			aiSection.populate(s);
			llamacppSection.populate(s);
		}
	});
	const obs = new MutationObserver(() => {
		if (!document.body.contains(root)) {
			unsub();
			obs.disconnect();
			window.clearInterval(appBackendStatusPollId);
		}
	});
	obs.observe(document.body, { childList: true, subtree: true });

	const saveBtn  = root.querySelector('#save-ai-settings'), statusEl = root.querySelector('#ai-settings-status');
	if (saveBtn) {
		saveBtn.addEventListener('click', async () => {
			saveBtn.disabled = true;
			if (statusEl) { statusEl.textContent = 'Saving...'; statusEl.style.color = ''; }
			try {
				await SettingsStore.save(aiSection.read());
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
				const { backend, tag: tagVal } = backendSection.read();
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
					await SettingsStore.save(llamacppSection.read());
					try {
						const response = await fetch('/api/llamacpp/reload-model', { method: 'POST' });
						const data = await response.json().catch(() => ({}));
						if (!response.ok || data?.success === false) {
							throw new Error(data?.error || `HTTP ${response.status}`);
						}
						if (lcppStatus) {
							lcppStatus.textContent = data?.deferred
								? 'Saved. Changes will apply on next inference.'
								: 'Saved & reloaded.';
							lcppStatus.style.color = 'var(--green,green)';
							setTimeout(() => { lcppStatus.textContent = ''; }, 3000);
						}
					} catch {
						if (lcppStatus) { lcppStatus.textContent = 'Saved.'; lcppStatus.style.color = 'var(--green,green)'; setTimeout(() => { lcppStatus.textContent = ''; }, 3000); }
					}
				} catch (err) {
				if (lcppStatus) { lcppStatus.textContent = 'Error: ' + err.message; lcppStatus.style.color = 'var(--red,red)'; }
			} finally { saveLCppBtn.disabled = false; }
		});
	}

	if (!SettingsStore.get()) {
		SettingsStore.init().then((s) => {
			aiSection.populate(s);
			llamacppSection.populate(s);
			toolsSection.refresh();
		}).catch(console.warn);
	}

	return () => {
		unsub();
		obs.disconnect();
		window.clearInterval(appBackendStatusPollId);
	};
}

export function mountSettingsPage(root) {
	const cleanupSettings = initSettingsPage(root);
	const cleanupModelManager = mountModelManager(root);
	return () => {
		cleanupSettings?.();
		cleanupModelManager?.();
	};
}
