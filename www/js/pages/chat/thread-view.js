// www/js/chat/thread-ui.js
// Renders the conversation thread: builds message elements, action menus,
// reasoning blocks, tool call blocks, and inline attachment previews.

import { computeThreadNodeIds, ensureGraph, getNode } from './graph.js';
import { formatBytes, getFileExtension, getFiletypeIcon, getFiletypeName } from './util.js';
import { applyTokenHighlighting } from '../../render/token-highlighting.js';
import { getNodeRawTextContent, getNodeTextContent, getReasoningPartContent, hasInlineReasoningParts } from './message-parts.js';
import { parseStreamReasoning } from './payloads.js';
import { cloneReasoningParts, getResolvedReasoningParts, getResolvedToolCalls } from './reasoning-parts.js';
import { renderMessageTextInto } from '../../render/message.js';
import { formatAiMessageTimestamp, formatUserMessageTimestamp, getMessageTimestampDateTime } from './timestamps.js';

// ─── Action button icons ──────────────────────────────────────────────────────

const stroke = 'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';

const icons = {
	edit:          s => `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" ${s}><path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z"/></svg>`,
	refresh:       s => `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" ${s}><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/></svg>`,
	'chev-left':   s => `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" ${s}><path d="m15 18-6-6 6-6"/></svg>`,
	'chev-right':  s => `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" ${s}><path d="m9 18 6-6-6-6"/></svg>`,
	check:         s => `<svg viewBox="0 0 24 24" fill="none" ${s}><path d="M20 6L9 17l-5-5"/></svg>`,
	x:             s => `<svg viewBox="0 0 24 24" fill="none" ${s}><path d="M18 6L6 18"/><path d="M6 6l12 12"/></svg>`,
	branch:        s => `<svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg" ${s}><path d="M13 22H29C33.4183 22 37 25.5817 37 30V44" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><circle cx="13" cy="8.94365" r="5" transform="rotate(-90 13 8.94365)" stroke="currentColor" stroke-width="4"/><path d="M13 14V43" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M18 39L13 44L8 39" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M42 39L37 44L32 39" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
	trash:         s => `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" ${s}><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>`,
	copy:          s => `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" ${s}><path d="M8 5.00005C7.01165 5.00082 6.49359 5.01338 6.09202 5.21799C5.71569 5.40973 5.40973 5.71569 5.21799 6.09202C5 6.51984 5 7.07989 5 8.2V17.8C5 18.9201 5 19.4802 5.21799 19.908C5.40973 20.2843 5.71569 20.5903 6.09202 20.782C6.51984 21 7.07989 21 8.2 21H15.8C16.9201 21 17.4802 21 17.908 20.782C18.2843 20.5903 18.5903 20.2843 18.782 19.908C19 19.4802 19 18.9201 19 17.8V8.2C19 7.07989 19 6.51984 18.782 6.09202C18.5903 5.71569 18.2843 5.40973 17.908 5.21799C17.5064 5.01338 16.9884 5.00082 16 5.00005M8 5.00005V7H16V5.00005M8 5.00005V4.70711C8 4.25435 8.17986 3.82014 8.5 3.5C8.82014 3.17986 9.25435 3 9.70711 3H14.2929C14.7456 3 15.1799 3.17986 15.5 3.5C15.8201 3.82014 16 4.25435 16 4.70711V5.00005"/></svg>`,
	undo:          s => `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" ${s}><path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13"/></svg>`,
};

export function createActionButton({ action, label, title, iconName, disabled = false }) {
	const btn = document.createElement('button');
	btn.type = 'button';
	btn.className = 'chat-action-btn';
	btn.dataset.action = action;
	btn.setAttribute('aria-label', label);
	btn.title = title || label;
	btn.disabled = Boolean(disabled);
	btn.innerHTML = icons[iconName]?.(stroke) || '';
	return btn;
}

// ─── Sibling navigation state ─────────────────────────────────────────────────

export function getSiblingNavState(graph, nodeId) {
	const node = getNode(graph, nodeId);
	if (!node?.parentId) return { parentId: null, siblings: [], index: -1, canBack: false, canForward: false };
	const parent   = getNode(graph, node.parentId);
	const siblings = parent?.children || [];
	const index    = siblings.indexOf(nodeId);
	return { parentId: node.parentId, siblings, index, canBack: index > 0, canForward: index >= 0 && index < siblings.length - 1 };
}

function getLatestActionNodeIds(graph, nodeIds = computeThreadNodeIds(graph)) {
	const latestByRole = new Map();
	for (const nodeId of nodeIds) {
		const node = getNode(graph, nodeId);
		if (node?.role === 'user' || node?.role === 'assistant') {
			latestByRole.set(node.role, nodeId);
		}
	}
	return new Set([...latestByRole.values()]);
}

// ─── Inline attachment preview (message display) ──────────────────────────────

function buildInlineAttachment(attachment) {
	const wrap = document.createElement('span');
	wrap.className = 'chat-message-inline-attachment';

	if (attachment.isImage && attachment.data) {
		wrap.classList.add('chat-message-inline-attachment-image');
		wrap.innerHTML = `
			<span class="chat-message-inline-preview"><img src="${attachment.data}" alt="${attachment.name}" /></span>
			<span class="chat-message-inline-info">
				<span class="chat-message-inline-name">${attachment.name}</span>
				<span class="chat-message-inline-size">${formatBytes(attachment.size)}</span>
			</span>`;
	} else {
		wrap.classList.add('chat-message-inline-attachment-file');
		const ext = getFileExtension(attachment.name);
		wrap.innerHTML = `
			<span class="chat-message-inline-icon">
				${getFiletypeIcon(attachment.name)}
				<span class="chat-message-inline-type">${ext.toUpperCase()}</span>
			</span>
			<span class="chat-message-inline-info">
				<span class="chat-message-inline-name">${attachment.name}</span>
				<span class="chat-message-inline-type-name">${getFiletypeName(attachment.name)}</span>
				<span class="chat-message-inline-size">${formatBytes(attachment.size)}</span>
			</span>`;
	}
	return wrap;
}

// ─── Tool call element ────────────────────────────────────────────────────────

function formatToolName(name) {
	return name.replace(/__/g, ' › ').replace(/_/g, ' ');
}

function getEditedFilesFromToolCall(tc) {
	const output = tc?.output;
	if (!output || typeof output !== 'object' || Array.isArray(output)) return [];
	if (Array.isArray(output.edited_files)) {
		return output.edited_files.filter((file) => file && typeof file === 'object');
	}
	if (output.rollback_available && output.checkpoint && typeof output.checkpoint === 'object') {
		return [output];
	}
	return [];
}

function getFileRollbackDescriptor(file, toolCallId = '') {
	if (!file || typeof file !== 'object' || file.rollback_available === false) return null;
	const checkpoint = file.checkpoint || {};
	const checkpointId = String(checkpoint.id || file.checkpoint_id || '');
	const workspaceDirectory = String(file.workspace_directory || '');
	const path = String(file.path || '');
	if (!checkpointId || !workspaceDirectory || !path) return null;
	return {
		checkpointId,
		workspaceDirectory,
		path,
		operation: file.operation ? String(file.operation) : '',
		createdFile: Boolean(file.created_file),
		toolCallId: String(toolCallId || ''),
	};
}

export function getMessageFileEditRollbacks(node) {
	if (!node || node.role !== 'assistant') return [];
	const toolCalls = getResolvedToolCalls({
		reasoningParts: node.reasoningParts,
		toolCalls: node.toolCalls,
	});
	const rollbacks = [];
	const seen = new Set();

	for (const toolCall of toolCalls) {
		for (const file of getEditedFilesFromToolCall(toolCall)) {
			const rollback = getFileRollbackDescriptor(file, toolCall?.id);
			if (!rollback) continue;
			const key = `${rollback.workspaceDirectory}\n${rollback.path}\n${rollback.checkpointId}`;
			if (seen.has(key)) continue;
			seen.add(key);
			rollbacks.push(rollback);
		}
	}

	return rollbacks;
}

function buildEditedFilesElement(editedFiles) {
	if (!editedFiles.length) return null;
	const wrap = document.createElement('div');
	wrap.className = 'tool-call-edited-files';

	for (const file of editedFiles) {
		const checkpoint = file.checkpoint || {};
		const checkpointId = String(checkpoint.id || file.checkpoint_id || '');
		const path = String(file.path || '');

		const row = document.createElement('div');
		row.className = 'tool-call-edited-file';

		const info = document.createElement('div');
		info.className = 'tool-call-edited-file-info';
		const name = document.createElement('span');
		name.className = 'tool-call-edited-file-path';
		name.textContent = path || String(file.resolved_path || 'Edited file');
		const meta = document.createElement('span');
		meta.className = 'tool-call-edited-file-meta';
		meta.textContent = [
			file.operation ? String(file.operation) : '',
			file.created_file ? 'created' : '',
			checkpointId ? `checkpoint ${checkpointId}` : '',
		].filter(Boolean).join(' • ');
		info.append(name, meta);
		row.appendChild(info);

		wrap.appendChild(row);
	}

	return wrap;
}

export function buildToolCallElement(tc) {
	const details = document.createElement('details');
	details.className = 'message-tool-call';
	const toolCallId = String(tc?.id ?? '');
	if (toolCallId) details.setAttribute('data-tool-call-id', toolCallId);

	const summary = document.createElement('summary');
	summary.className = 'tool-call-summary';

	const iconEl = document.createElement('span');
	iconEl.className = 'tool-call-icon';
	iconEl.innerHTML = `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 17H5"/><path d="M19 7h-9"/><circle cx="17" cy="17" r="3"/><circle cx="7" cy="7" r="3"/></svg>`;

	const nameEl = document.createElement('span');
	nameEl.className = 'tool-call-name';
	nameEl.textContent = formatToolName(tc.title || tc.name || 'Tool');

	summary.append(iconEl, nameEl);

	if (tc.status || tc.executor) {
		const meta = document.createElement('span');
		meta.className = 'tool-call-meta';
		const bits = [];
		if (tc.status) bits.push(String(tc.status).replace(/_/g, ' '));
		if (tc.executor) bits.push(tc.executor);
		if (tc.riskTier) bits.push(tc.riskTier);
		meta.textContent = bits.join(' • ');
		summary.appendChild(meta);
	}
	details.appendChild(summary);

	const body = document.createElement('div');
	body.className = 'tool-call-body';
	const inputValue = tc.input ?? tc.arguments ?? null;
	if (inputValue != null) {
		const label = document.createElement('div'); label.className = 'tool-call-section-label'; label.textContent = 'Input';
		const code  = document.createElement('pre');  code.className  = 'tool-call-code';
		code.textContent = typeof inputValue === 'object' ? JSON.stringify(inputValue, null, 2) : String(inputValue);
		body.append(label, code);
	}
	const editedFilesEl = buildEditedFilesElement(getEditedFilesFromToolCall(tc));
	if (editedFilesEl) {
		const label = document.createElement('div'); label.className = 'tool-call-section-label'; label.textContent = 'Edited files';
		body.append(label, editedFilesEl);
	}
	if (tc.output != null) {
		const label = document.createElement('div'); label.className = 'tool-call-section-label'; label.textContent = 'Output';
		const code  = document.createElement('pre');  code.className  = 'tool-call-code';
		code.textContent = typeof tc.output === 'object' ? JSON.stringify(tc.output, null, 2) : String(tc.output);
		body.append(label, code);
	}
	if (tc.error) {
		const label = document.createElement('div'); label.className = 'tool-call-section-label'; label.textContent = 'Error';
		const code  = document.createElement('pre');  code.className  = 'tool-call-code';
		code.textContent = String(tc.error);
		body.append(label, code);
	}
	details.appendChild(body);
	return details;
}

// ─── Reasoning block ──────────────────────────────────────────────────────────

function buildReasoningTextPart(text) {
	const content = document.createElement('div');
	content.className = 'reasoning-text';
	renderMessageTextInto(content, text);
	return content;
}

function getInlineRenderableParts(node, isEditing) {
	if (isEditing || node?.role !== 'assistant') return null;
	if (hasInlineReasoningParts(node.parts)) return node.parts;
	if (Array.isArray(node?.parts)) return null;

	const content = String(node?.content ?? '');
	if (!content) return null;
	const parsed = parseStreamReasoning(content);
	return parsed.hasThinkTags && hasInlineReasoningParts(parsed.parts) ? parsed.parts : null;
}

function getInlineReasoningPartCount(parts) {
	if (!Array.isArray(parts)) return 0;
	return parts.reduce((count, part) => part?.type === 'reasoning' ? count + 1 : count, 0);
}

function hasReasoningToolParts(reasoningParts) {
	return cloneReasoningParts(reasoningParts).some((part) => part?.type === 'tool_call');
}

function buildInlineRenderParts(node, renderParts) {
	if (!Array.isArray(renderParts)) return [];
	const clonedParts = renderParts.map((part) => {
		if (!part || typeof part !== 'object') return part;
		if (part.type === 'reasoning') {
			const nextPart = { ...part };
			const reasoningParts = cloneReasoningParts(part.reasoningParts);
			if (reasoningParts.length > 0) nextPart.reasoningParts = reasoningParts;
			return nextPart;
		}
		if (part.type === 'tool_call') {
			return cloneReasoningParts([part])[0] || part;
		}
		return { ...part };
	});

	const fallbackReasoningParts = cloneReasoningParts(node?.reasoningParts);
	if (!hasReasoningToolParts(fallbackReasoningParts)) return clonedParts;
	if (clonedParts.some((part) => part?.type === 'tool_call')) return clonedParts;
	if (clonedParts.some((part) => part?.type === 'reasoning' && hasReasoningToolParts(part.reasoningParts))) {
		return clonedParts;
	}

	const reasoningCount = getInlineReasoningPartCount(clonedParts);
	const fallbackPartsForTarget = reasoningCount > 1
		? fallbackReasoningParts.filter((part) => part?.type === 'tool_call')
		: fallbackReasoningParts;
	let targetReasoningIndex = -1;
	let seenReasoning = 0;
	for (let index = 0; index < clonedParts.length; index++) {
		if (clonedParts[index]?.type !== 'reasoning') continue;
		seenReasoning += 1;
		if (reasoningCount === 1 || seenReasoning === reasoningCount) {
			targetReasoningIndex = index;
		}
	}
	if (targetReasoningIndex !== -1) {
		clonedParts[targetReasoningIndex] = {
			...clonedParts[targetReasoningIndex],
			reasoningParts: fallbackPartsForTarget,
		};
	}
	return clonedParts;
}

function getReferencedReasoningPartsFromInlineParts(parts) {
	const referencedParts = [];
	for (const part of Array.isArray(parts) ? parts : []) {
		if (part?.type === 'tool_call') {
			const toolPart = cloneReasoningParts([part])[0];
			if (toolPart) referencedParts.push(toolPart);
			continue;
		}
		if (part?.type !== 'reasoning') continue;
		for (const reasoningPart of cloneReasoningParts(part.reasoningParts)) {
			if (reasoningPart?.type === 'tool_call') referencedParts.push(reasoningPart);
		}
	}
	return referencedParts;
}

function getToolCallFromPart(part, toolCalls) {
	const toolPart = cloneReasoningParts([part])[0];
	if (!toolPart) return null;
	const toolCallId = String(toolPart.toolCallId ?? toolPart.toolCall?.id ?? '');
	if (toolCallId && Array.isArray(toolCalls)) {
		const matched = toolCalls.find((toolCall) => String(toolCall?.id ?? '') === toolCallId);
		if (matched) return matched;
	}
	return toolPart.toolCall || null;
}

export function buildReasoningElement({
	reasoning = '',
	reasoningParts = null,
	toolCalls = null,
	open = false,
	summaryText = 'Thinking',
} = {}) {
	const resolvedParts = getResolvedReasoningParts({ reasoning, reasoningParts, toolCalls });
	if (!resolvedParts.length) return null;
	const details = document.createElement('details');
	details.className = 'message-reasoning';
	details.open = Boolean(open);
	const summary = document.createElement('summary');
	summary.textContent = summaryText;
	const content = document.createElement('div');
	content.className = 'reasoning-content';

	for (const part of resolvedParts) {
		if (part.type === 'text' && part.content) {
			content.appendChild(buildReasoningTextPart(part.content));
			continue;
		}
		if (part.type === 'tool_call' && part.toolCall) {
			content.appendChild(buildToolCallElement(part.toolCall));
		}
	}
	details.append(summary, content);
	return details;
}

function formatRevisionModelPhaseLabel(stage, index) {
	if (stage === 'review') return 'Review output';
	if (stage === 'revise' || stage === 'commit') return 'Final answer output';
	if (stage === 'draft') return 'First draft';
	return `Model output ${index + 1}`;
}

function normalizeRevisionModelOutputs(trace) {
	const source = Array.isArray(trace?.modelOutputs) ? trace.modelOutputs : [];
	return source
		.map((item, index) => {
			if (!item || typeof item !== 'object') return null;
			const content = String(item.content ?? '');
			const reasoning = String(item.reasoning ?? '');
			const toolCalls = Array.isArray(item.toolCalls)
				? item.toolCalls.filter((toolCall) => toolCall && typeof toolCall === 'object')
				: [];
			const status = String(item.status || (item.completedAt ? 'completed' : 'streaming'));
			if (!content && !reasoning && toolCalls.length === 0 && status !== 'streaming') return null;
			const stage = String(item.stage || 'draft');
			return {
				id: String(item.id || item.phase_id || `phase_${index + 1}`),
				stage,
				label: String(item.label || formatRevisionModelPhaseLabel(stage, index)),
				status,
				content,
				reasoning,
				toolCalls,
			};
		})
		.filter(Boolean);
}

function isRevisionModelOutputComplete(output) {
	return ['completed', 'failed', 'cancelled'].includes(String(output?.status || '').toLowerCase());
}

function formatRevisionModelOutputStatus(output) {
	const status = String(output?.status || '').replace(/_/g, ' ');
	return status || (isRevisionModelOutputComplete(output) ? 'completed' : 'streaming');
}

function buildRevisionModelTextElement(text) {
	const content = document.createElement('div');
	content.className = 'revision-model-rendered-text';
	renderMessageTextInto(content, text);
	return content;
}

function buildRevisionModelOutputElement(modelOutputs, { live = false } = {}) {
	if (!Array.isArray(modelOutputs) || modelOutputs.length === 0) return null;

	const wrap = document.createElement('details');
	wrap.className = 'revision-model-output';
	wrap.open = live && modelOutputs.some((output) => !isRevisionModelOutputComplete(output));

	const summary = document.createElement('summary');
	summary.textContent = modelOutputs.length === 1
		? 'Model output'
		: `Model output (${modelOutputs.length} phases)`;
	const body = document.createElement('div');
	body.className = 'revision-model-output-body';

	modelOutputs.forEach((output, index) => {
		const phase = document.createElement('details');
		phase.className = 'revision-model-phase';
		phase.open = live && (!isRevisionModelOutputComplete(output) || index === modelOutputs.length - 1);

		const phaseSummary = document.createElement('summary');
		const label = document.createElement('span');
		label.className = 'revision-model-phase-label';
		label.textContent = output.label;
		const meta = document.createElement('span');
		meta.className = 'revision-model-phase-meta';
		meta.textContent = formatRevisionModelOutputStatus(output);
		phaseSummary.append(label, meta);
		phase.appendChild(phaseSummary);

		const phaseBody = document.createElement('div');
		phaseBody.className = 'revision-model-phase-body';
		if (output.toolCalls.length > 0) {
			const labelEl = document.createElement('div');
			labelEl.className = 'revision-model-section-label';
			labelEl.textContent = output.toolCalls.length === 1 ? 'Tool call' : 'Tool calls';
			const toolWrap = document.createElement('div');
			toolWrap.className = 'revision-model-tool-calls';
			output.toolCalls.forEach((toolCall) => {
				toolWrap.appendChild(buildToolCallElement(toolCall));
			});
			phaseBody.append(labelEl, toolWrap);
		}
		if (output.reasoning) {
			const labelEl = document.createElement('div');
			labelEl.className = 'revision-model-section-label';
			labelEl.textContent = 'Reasoning';
			phaseBody.append(labelEl, buildRevisionModelTextElement(output.reasoning));
		}
		if (output.content) {
			const labelEl = document.createElement('div');
			labelEl.className = 'revision-model-section-label';
			labelEl.textContent = 'Output';
			phaseBody.append(labelEl, buildRevisionModelTextElement(output.content));
		}
		if (!output.reasoning && !output.content && output.toolCalls.length === 0) {
			const empty = document.createElement('div');
			empty.className = 'revision-model-empty';
			empty.textContent = 'Waiting for tokens...';
			phaseBody.appendChild(empty);
		}
		phase.appendChild(phaseBody);
		body.appendChild(phase);
	});

	wrap.append(summary, body);
	return wrap;
}

function normalizeRevisionTrace(trace) {
	if (!trace || typeof trace !== 'object') return null;
	const events = Array.isArray(trace.events) ? trace.events : [];
	const issues = Array.isArray(trace.issues) ? trace.issues : [];
	const modelOutputs = normalizeRevisionModelOutputs(trace);
	const currentDraft = String(trace.currentDraft ?? trace.finalContent ?? '');
	const startedAt = Number(trace.startedAt || events[0]?.timestamp || trace.updatedAt || 0);
	if (!events.length && !issues.length && !currentDraft && !modelOutputs.length) return null;
	return {
		...trace,
		events,
		issues,
		modelOutputs,
		currentDraft,
		startedAt: Number.isFinite(startedAt) ? startedAt : 0,
		committed: Boolean(trace.committed || trace.finalContent),
		stage: String(trace.stage || (trace.committed ? 'commit' : 'draft')),
	};
}

function formatRevisionStage(trace) {
	if (trace.committed) return 'Committed';
	if (trace.stage === 'review') return 'Reviewing';
	if (trace.stage === 'revise') return 'Revising';
	if (trace.stage === 'commit') return 'Committing';
	return 'Drafting';
}

function formatRevisionElapsed(trace) {
	const started = Number(trace.startedAt || 0);
	const updated = trace.committed ? Number(trace.updatedAt || Date.now()) : Date.now();
	if (!Number.isFinite(started) || started <= 0) return '';
	const seconds = Math.max(0, Math.round((updated - started) / 1000));
	return `${seconds}s`;
}

export function buildRevisionTraceElement(traceValue, { live = false } = {}) {
	const trace = normalizeRevisionTrace(traceValue);
	if (!trace) return null;

	const wrap = document.createElement('div');
	wrap.className = 'message-revision-trace';
	if (trace.committed) wrap.classList.add('committed');
	if (live) wrap.classList.add('live');

	const header = document.createElement('div');
	header.className = 'revision-header';
	const label = document.createElement('span');
	label.className = 'revision-stage';
	label.textContent = formatRevisionStage(trace);
	const meta = document.createElement('span');
	meta.className = 'revision-meta';
	const editLabel = trace.events.length === 1 ? '1 edit' : `${trace.events.length} edits`;
	meta.textContent = [formatRevisionElapsed(trace), editLabel].filter(Boolean).join(' • ');
	header.append(label, meta);
	wrap.appendChild(header);

	const modelOutputEl = buildRevisionModelOutputElement(trace.modelOutputs, { live });
	if (modelOutputEl) {
		wrap.appendChild(modelOutputEl);
	}

	if (trace.issues.length > 0) {
		const notes = document.createElement('details');
		notes.className = 'revision-notes';
		notes.open = live && !trace.committed;
		const summary = document.createElement('summary');
		summary.textContent = `Review notes (${trace.issues.length})`;
		const list = document.createElement('div');
		list.className = 'revision-note-list';
		for (const issue of trace.issues) {
			const item = document.createElement('div');
			item.className = 'revision-note';
			const title = document.createElement('div');
			title.className = 'revision-note-title';
			title.textContent = [issue.label, issue.severity].filter(Boolean).join(' • ') || 'Review note';
			const note = document.createElement('div');
			note.className = 'revision-note-text';
			note.textContent = String(issue.note || issue.recommended_action || '');
			item.append(title, note);
			list.appendChild(item);
		}
		notes.append(summary, list);
		wrap.appendChild(notes);
	}

	const detail = document.createElement('details');
	detail.className = 'revision-draft';
	detail.open = live && !trace.committed;
	const detailSummary = document.createElement('summary');
	detailSummary.textContent = trace.committed ? 'Changes made' : 'Working draft';
	const body = document.createElement('div');
	body.className = 'revision-draft-body';
	if (trace.committed && trace.changeSummary) {
		const changeSummary = document.createElement('div');
		changeSummary.className = 'revision-change-summary';
		changeSummary.textContent = String(trace.changeSummary);
		body.appendChild(changeSummary);
	}
	const visibleEvents = trace.events.filter((event) => {
		const summary = String(event?.changeSummary || event?.summary || '').trim();
		return summary && event?.operation !== 'commit_final';
	});
	if (visibleEvents.length > 0) {
		const eventList = document.createElement('div');
		eventList.className = 'revision-event-list';
		for (const event of visibleEvents) {
			const item = document.createElement('div');
			item.className = 'revision-event';
			item.textContent = String(event.changeSummary || event.summary || '');
			eventList.appendChild(item);
		}
		body.appendChild(eventList);
	}
	if (trace.currentDraft && !trace.committed) {
		const draftText = document.createElement('div');
		draftText.className = 'revision-draft-text';
		renderMessageTextInto(draftText, trace.currentDraft);
		body.appendChild(draftText);
	}
	detail.append(detailSummary, body);
	wrap.appendChild(detail);

	return wrap;
}

export function buildToolCallsElement({
	reasoning = '',
	reasoningParts = null,
	toolCalls = null,
} = {}) {
	const resolvedToolCalls = getResolvedToolCalls({
		reasoningParts,
		toolCalls,
		includeReferenced: false,
	});
	if (!resolvedToolCalls.length) return null;

	const container = document.createElement('div');
	container.className = 'message-tool-calls';
	for (const toolCall of resolvedToolCalls) {
		container.appendChild(buildToolCallElement(toolCall));
	}
	return container;
}

// ─── Content container ────────────────────────────────────────────────────────

export function buildContentContainer(node, isEditing, editingDraft, settings = null) {
	const container = document.createElement('div');
	container.className = 'chat-message-content';
	const inlineRenderableParts = getInlineRenderableParts(node, isEditing);
	const hasInlineReasoning = Boolean(inlineRenderableParts);
	const inlineRenderParts = hasInlineReasoning
		? buildInlineRenderParts(node, inlineRenderableParts)
		: null;

	if (!isEditing && node.role === 'assistant') {
		const revisionEl = buildRevisionTraceElement(node.revisionTrace);
		if (revisionEl) container.appendChild(revisionEl);
	}

	if (!isEditing && node.role === 'assistant' && !hasInlineReasoning) {
		const reasoningEl = buildReasoningElement({
			reasoning: node.reasoning,
			reasoningParts: node.reasoningParts,
			toolCalls: node.toolCalls,
		});
		if (reasoningEl) container.appendChild(reasoningEl);

		const referencedParts = [
			...cloneReasoningParts(node.reasoningParts),
			...getReferencedReasoningPartsFromInlineParts(node.parts),
		];
		const toolCallsEl = buildToolCallsElement({
			reasoning: node.reasoning,
			reasoningParts: referencedParts,
			toolCalls: node.toolCalls,
		});
		if (toolCallsEl) container.appendChild(toolCallsEl);
	}

	if (!isEditing && node.role === 'assistant' && hasInlineReasoning) {
		const toolCallsEl = buildToolCallsElement({
			reasoning: '',
			reasoningParts: getReferencedReasoningPartsFromInlineParts(inlineRenderParts),
			toolCalls: node.toolCalls,
		});
		if (toolCallsEl) container.appendChild(toolCallsEl);
	}

	if (isEditing) {
		// Using contenteditable avoids Firefox's native ESC interception on <textarea>
		const editEl = document.createElement('div');
		editEl.className = 'chat-edit-input';
		editEl.contentEditable = 'true';
		editEl.setAttribute('role', 'textbox');
		editEl.setAttribute('aria-multiline', 'true');
		editEl.setAttribute('aria-label', 'Edit message');
		editEl.spellcheck = true;
		editEl.innerText = editingDraft ?? (node.role === 'assistant' ? getNodeRawTextContent(node) : getNodeTextContent(node));
		container.appendChild(editEl);
	} else if (inlineRenderParts || (node.parts && Array.isArray(node.parts))) {
		const renderParts = inlineRenderParts || node.parts;
		renderParts.forEach((part) => {
			if (part.type === 'text' && part.content) {
				const wrapper = document.createElement('div');
				wrapper.className = 'chat-message-text';
				renderMessageTextInto(wrapper, part.content);
				container.appendChild(wrapper);
			} else if (node.role === 'assistant' && part.type === 'reasoning') {
				const reasoningEl = buildReasoningElement({
					reasoning: getReasoningPartContent(part),
					reasoningParts: part.reasoningParts,
					toolCalls: node.toolCalls,
				});
				if (reasoningEl) container.appendChild(reasoningEl);
			} else if (node.role === 'assistant' && part.type === 'tool_call') {
				const toolCall = getToolCallFromPart(part, node.toolCalls);
				if (toolCall) container.appendChild(buildToolCallElement(toolCall));
			} else if (part.type === 'attachment') {
				container.appendChild(buildInlineAttachment(part));
			}
		});
	} else {
		// Legacy: plain content string
		const wrapper = document.createElement('div');
		wrapper.className = 'chat-message-text';
		renderMessageTextInto(wrapper, getNodeTextContent(node));
		container.appendChild(wrapper);
		if (node.attachments?.length > 0) node.attachments.forEach(a => container.appendChild(buildInlineAttachment(a)));
	}

	// Apply token highlighting if this node has logprob data
	if (!isEditing && node.role === 'assistant' && node.tokenLogprobs && node.tokenLogprobs.length > 0) {
		const textEl = container.querySelector('.chat-message-text');
		if (textEl) {
			applyTokenHighlighting(textEl, node.tokenLogprobs, settings);
		}
	}

	return container;
}

export function buildMessageActionMenu({ node, isEditing, canBranchBack, canBranchForward, canResend }) {
	const menu = document.createElement('div');
	menu.className = 'chat-message-menu';
	menu.setAttribute('role', 'toolbar');
	menu.setAttribute('aria-label', 'Message actions');

	if (isEditing) {
		menu.append(
			createActionButton({ action: 'save',   label: 'Save edit',   title: 'Save',   iconName: 'check' }),
			createActionButton({ action: 'cancel', label: 'Cancel edit', title: 'Cancel', iconName: 'x' })
		);
		return menu;
	}

	const rollbackCount = getMessageFileEditRollbacks(node).length;
	const rollbackDone = Boolean(node?.fileEditsRolledBackAt);
	const buttons = [
		createActionButton({ action: 'branch-back',    label: 'Previous thread',                           title: 'Previous thread',                          iconName: 'chev-left',  disabled: !canBranchBack }),
		createActionButton({ action: 'branch-forward', label: 'Next thread',                               title: 'Next thread',                              iconName: 'chev-right', disabled: !canBranchForward }),
		createActionButton({ action: 'thread',         label: 'Create new thread from this message',       title: 'New thread',                               iconName: 'branch' }),
		createActionButton({ action: 'edit',           label: 'Edit message',                              title: 'Edit',                                     iconName: 'edit' }),
		createActionButton({ action: 'resend',         label: 'Regenerate from here',                      title: 'Regenerate',                               iconName: 'refresh',    disabled: !canResend }),
	];

	if (rollbackCount > 0) {
		const plural = rollbackCount === 1 ? '' : 's';
		buttons.push(createActionButton({
			action: 'rollback-files',
			label: rollbackDone ? 'File edits already rolled back' : `Roll back ${rollbackCount} file edit${plural} from this message`,
			title: rollbackDone ? 'File edits rolled back' : 'Roll back file edits',
			iconName: 'undo',
			disabled: rollbackDone,
		}));
	}

	buttons.push(
		createActionButton({ action: 'delete', label: 'Delete message',   title: 'Delete (shift+click to delete only this)', iconName: 'trash' }),
		createActionButton({ action: 'copy',   label: 'Copy raw message', title: 'Copy',                                     iconName: 'copy' })
	);
	menu.append(...buttons);
	return menu;
}

// ─── Full message element ─────────────────────────────────────────────────────

export function buildMessageTimestampElement(node, settings = null) {
	const text = formatUserMessageTimestamp(node?.timestamp, {
		use24Hour: settings?.messageTimestamps24Hour !== false,
	});
	if (!text) return null;

	const time = document.createElement('time');
	time.className = 'chat-message-timestamp';
	time.dateTime = getMessageTimestampDateTime(node.timestamp);
	time.textContent = text;

	const fullTimestamp = formatAiMessageTimestamp(node.timestamp);
	if (fullTimestamp) time.title = fullTimestamp;
	return time;
}

function buildMessageNudgeToggle(timestampEl, node) {
	const toggle = document.createElement('button');
	toggle.type = 'button';
	toggle.className = 'chat-message-nudge-toggle';
	toggle.dataset.messageNudgeToggle = 'true';
	toggle.setAttribute('aria-expanded', 'false');
	toggle.setAttribute('aria-label', node?.role === 'user' ? 'Show user message actions' : 'Show assistant message actions');
	if (timestampEl) {
		toggle.appendChild(timestampEl);
	} else {
		const label = document.createElement('span');
		label.className = 'chat-message-timestamp empty';
		label.textContent = 'Message actions';
		toggle.appendChild(label);
	}
	const iconWrap = document.createElement('span');
	iconWrap.className = 'chat-message-nudge-toggle-icon';
	iconWrap.setAttribute('aria-hidden', 'true');
	iconWrap.innerHTML = icons['chev-right']?.(stroke) || '';
	toggle.appendChild(iconWrap);
	return toggle;
}

export function buildMessageNudgeElement({
	node,
	settings,
	isEditing,
	canBranchBack,
	canBranchForward,
	canResend,
	showFullToolbar = false,
}) {
	const nudge = document.createElement('div');
	nudge.className = 'chat-message-nudge';
	const isCompact = !showFullToolbar && !isEditing;
	if (isCompact) nudge.classList.add('compact');

	const timestampEl = buildMessageTimestampElement(node, settings);
	if (isCompact) {
		nudge.appendChild(buildMessageNudgeToggle(timestampEl, node));
	} else if (timestampEl) {
		nudge.appendChild(timestampEl);
	} else {
		const spacer = document.createElement('span');
		spacer.className = 'chat-message-timestamp empty';
		nudge.appendChild(spacer);
	}

	nudge.appendChild(buildMessageActionMenu({
		node,
		isEditing,
		canBranchBack,
		canBranchForward,
		canResend,
	}));
	return nudge;
}

function buildMessageGroupElement({
	node,
	isEditing,
	editingDraft,
	canBranchBack,
	canBranchForward,
	canResend,
	settings,
	showFullToolbar = false,
}) {
	const group = document.createElement('div');
	group.className = `chat-message-group ${node.role}`;
	group.dataset.nodeId = node.id;

	const div = document.createElement('div');
	div.className = `chat-message ${node.role}`;
	div.setAttribute('role', 'article');
	div.setAttribute('aria-label', node.role === 'user' ? 'You' : 'Assistant');
	div.dataset.nodeId = node.id;

	div.appendChild(buildContentContainer(node, isEditing, editingDraft, settings));
	group.append(
		div,
		buildMessageNudgeElement({
			node,
			settings,
			isEditing,
			canBranchBack,
			canBranchForward,
			canResend,
			showFullToolbar,
		}),
	);
	return group;
}

// ─── Scroll helper ────────────────────────────────────────────────────────────

function scrollToBottom(messagesEl) {
	const scrollEl = messagesEl.closest('.content') || messagesEl;
	scrollEl.scrollTop = scrollEl.scrollHeight;
}

// ─── Public rendering functions ───────────────────────────────────────────────

export function showTyping(container) {
	const div = document.createElement('div');
	div.className = 'chat-typing';
	div.setAttribute('aria-label', 'Assistant is typing');
	div.innerHTML = '<span></span><span></span><span></span>';
	container.appendChild(div);
	scrollToBottom(container);
	return div;
}

export function renderThread(messagesEl, chat, uiState, settings = null) {
	if (!messagesEl || !chat) return;
	const graph = ensureGraph(chat);
	messagesEl.querySelectorAll('.chat-message-group, .chat-message, .chat-typing').forEach(el => el.remove());

	const threadIds = computeThreadNodeIds(graph);
	const latestActionNodeIds = getLatestActionNodeIds(graph, threadIds);

	threadIds.forEach((id) => {
		const node = getNode(graph, id);
		if (!node) return;
		const nav = getSiblingNavState(graph, id);
		messagesEl.appendChild(buildMessageGroupElement({
			node,
			isEditing:        uiState?.editingNodeId === node.id,
			editingDraft:     uiState?.editingDraft,
			canBranchBack:    nav.canBack,
			canBranchForward: nav.canForward,
			canResend:        Boolean(node.parentId) && node.role !== 'system',
			showFullToolbar:  uiState?.editingNodeId === node.id || latestActionNodeIds.has(id),
			settings,
		}));
	});
	scrollToBottom(messagesEl);
}

export function refreshRenderedMessageNudges(messagesEl, graph, uiState = null, settings = null) {
	if (!messagesEl || !graph) return;
	const threadIds = computeThreadNodeIds(graph);
	const visibleThreadIds = new Set(threadIds);
	const latestActionNodeIds = getLatestActionNodeIds(graph, threadIds);

	for (const groupEl of messagesEl.querySelectorAll('.chat-message-group[data-node-id]')) {
		const nodeId = groupEl.dataset.nodeId;
		if (!visibleThreadIds.has(nodeId)) continue;
		const node = getNode(graph, nodeId);
		if (!node) continue;

		const nav = getSiblingNavState(graph, nodeId);
		const isEditing = uiState?.editingNodeId === node.id;
		const oldNudge = groupEl.querySelector(':scope > .chat-message-nudge');
		const newNudge = buildMessageNudgeElement({
			node,
			settings,
			isEditing,
			canBranchBack: nav.canBack,
			canBranchForward: nav.canForward,
			canResend: Boolean(node.parentId) && node.role !== 'system',
			showFullToolbar: isEditing || latestActionNodeIds.has(nodeId),
		});

		if (oldNudge) oldNudge.replaceWith(newNudge);
		else groupEl.appendChild(newNudge);
	}
}

/**
 * Swap a single message element between normal and editing state without
 * rebuilding the entire thread. Avoids the Chromium flash during full re-renders.
 * Returns false if the element wasn't found — caller should fall back to renderThread.
 */
export function patchMessageEditState(messagesEl, graph, node, isEditing, editingDraft, settings = null) {
	const groupEl = messagesEl.querySelector(`.chat-message-group[data-node-id="${node.id}"]`);
	const msgEl = groupEl?.querySelector(':scope > .chat-message') || messagesEl.querySelector(`.chat-message[data-node-id="${node.id}"]`);
	if (!msgEl) return false;

	const oldContent = msgEl.querySelector('.chat-message-content');
	const newContent = buildContentContainer(node, isEditing, editingDraft, settings);
	if (oldContent) msgEl.replaceChild(newContent, oldContent);
	else {
		const nudge = msgEl.querySelector('.chat-message-nudge');
		msgEl.insertBefore(newContent, nudge || null);
	}

	const nav = getSiblingNavState(graph, node.id);
	const canResend = Boolean(node.parentId) && node.role !== 'system';
	const oldNudge = groupEl?.querySelector(':scope > .chat-message-nudge') || msgEl.querySelector('.chat-message-nudge');
	const newNudge = buildMessageNudgeElement({
		node,
		settings,
		isEditing,
		canBranchBack: nav.canBack,
		canBranchForward: nav.canForward,
		canResend,
		showFullToolbar: isEditing || getLatestActionNodeIds(graph).has(node.id),
	});

	if (oldNudge) oldNudge.replaceWith(newNudge);
	else if (groupEl) groupEl.appendChild(newNudge);
	else msgEl.after(newNudge);
	return true;
}
