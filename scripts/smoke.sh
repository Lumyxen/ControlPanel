#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

echo "[smoke] Checking frontend syntax"
find www/js -path 'www/js/old' -prune -o -name '*.js' -print0 | xargs -0 -n1 node --check >/dev/null

echo "[smoke] Checking frontend structure"
required_paths=(
	www/js/app.js
	www/js/login.js
	www/js/browser-detect.js
	www/js/boot/main.js
	www/js/core/http.js
	www/js/services/auth.js
	www/js/shell/app-shell.js
	www/js/pages/chat/page.js
	www/js/pages/chat/session.js
	www/js/pages/chat/clipboard.js
	www/js/pages/settings/page.js
	www/js/pages/settings/ai-section.js
	www/js/pages/settings/backend-section.js
	www/js/pages/settings/llamacpp-section.js
	www/css/login.css
	www/css/settings.css
)

for path in "${required_paths[@]}"; do
	[[ -f "$path" ]] || { echo "[smoke] Missing required path: $path"; exit 1; }
done

if rg -n "from ['\"].*old/" www/js --glob '!www/js/old/**' >/dev/null; then
	echo "[smoke] New frontend imports from www/js/old"
	exit 1
fi

if rg -n 'style="' www/login.html www/pages/settings.html >/dev/null; then
	echo "[smoke] Inline styles remain in login/settings HTML"
	exit 1
fi

echo "[smoke] Running frontend helper assertions"
node --input-type=module <<'EOF'
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
	appendNode,
	computeThreadNodeIds,
	createEmptyGraph,
	createSiblingCopy,
	getNode,
	spliceDeleteNode,
} from './www/js/pages/chat/graph.js';
import { getNodeRawTextContent, getNodeTextContent, buildPartsWithUpdatedText } from './www/js/pages/chat/message-parts.js';
import { buildApiMessages, buildConversationHistory, parseStreamReasoning, parseStreamReasoningParts } from './www/js/pages/chat/payloads.js';
import { getResolvedReasoningParts } from './www/js/pages/chat/reasoning-parts.js';
import { shouldAutoOpenReasoningPhase } from './www/js/pages/chat/stream-view.js';
import { buildContentContainer, buildReasoningElement, buildToolCallsElement, getMessageFileEditRollbacks } from './www/js/pages/chat/thread-view.js';
import { getModelContextInfo, setModelMetadata, updateContextUI } from './www/js/pages/chat/context.js';
import { coerceTheme } from './www/js/pages/settings/theme-section.js';
import { renderMessageTextHtml } from './www/js/render/message.js';
import { isFormattingOnlyTextContent, mapDomTextToTokenLogprobs } from './www/js/render/token-highlighting.js';

const graph = createEmptyGraph();
const user = appendNode(graph, { role: 'user', content: 'hello' });
const assistant = appendNode(graph, { role: 'assistant', content: 'world' });
assert.deepEqual(computeThreadNodeIds(graph), [user.id, assistant.id]);

const sibling = createSiblingCopy(graph, user.id, { content: 'alternate' });
assert.equal(getNode(graph, sibling.id).content, 'alternate');
assert.deepEqual(computeThreadNodeIds(graph), [sibling.id]);

const spliceGraph = createEmptyGraph();
const first = appendNode(spliceGraph, { role: 'user', content: 'one' });
const second = appendNode(spliceGraph, { role: 'assistant', content: 'two' });
const third = appendNode(spliceGraph, { role: 'user', content: 'three' });
assert.equal(spliceDeleteNode(spliceGraph, second.id), true);
assert.equal(getNode(spliceGraph, third.id).parentId, first.id);
assert.deepEqual(computeThreadNodeIds(spliceGraph), [first.id, third.id]);

assert.equal(getNodeTextContent({ content: 'plain text' }), 'plain text');
assert.equal(
	getNodeTextContent({
		parts: [
			{ type: 'text', content: 'alpha' },
			{ type: 'reasoning', content: 'thinking' },
			{ type: 'attachment', name: 'demo.txt' },
			{ type: 'text', content: 'beta' },
		],
	}),
	'alphabeta'
);
assert.equal(
	getNodeRawTextContent({
		role: 'assistant',
		parts: [
			{ type: 'text', content: 'alpha' },
			{ type: 'reasoning', content: 'thinking' },
			{ type: 'text', content: 'beta' },
		],
		reasoning: 'aggregate',
	}),
	'alpha<think>\nthinking\n</think>beta'
);

assert.deepEqual(
	buildPartsWithUpdatedText(
		{ parts: [{ type: 'text', content: 'old' }, { type: 'attachment', name: 'demo.txt' }] },
		'new'
	),
	[{ type: 'text', content: 'new' }, { type: 'attachment', name: 'demo.txt' }]
);

assert.deepEqual(
	buildPartsWithUpdatedText({ parts: [{ type: 'attachment', name: 'demo.txt' }] }, 'draft'),
	[{ type: 'text', content: 'draft' }, { type: 'attachment', name: 'demo.txt' }]
);

const apiGraph = createEmptyGraph();
const apiUser = appendNode(apiGraph, { role: 'user', content: 'hi there' });
const apiAssistant = appendNode(apiGraph, { role: 'assistant', content: 'general kenobi' });
apiUser.timestamp = 0;
apiAssistant.timestamp = 0;
apiAssistant.reasoning = 'thinking';
assert.deepEqual(buildApiMessages(apiGraph, [apiUser.id, apiAssistant.id]), [
	{ role: 'user', content: 'hi there' },
	{ role: 'assistant', content: '<think>\nthinking\n</think>\n\ngeneral kenobi' },
]);

const researchGraph = createEmptyGraph();
const researchUser = appendNode(researchGraph, { role: 'user', content: 'research how code is impacted by AI' });
const researchAssistant = appendNode(researchGraph, {
	role: 'assistant',
	parts: [{
		type: 'research',
		status: 'pending',
		title: 'AI coding impact',
		query: 'how AI affects code',
		tasks: [
			{ id: 'adoption', label: 'Check adoption rates' },
			{ id: 'security', label: 'Review security implications' },
		],
		sourceClasses: ['web', 'academic'],
		deliverables: ['final_answer'],
	}],
});
researchUser.timestamp = 0;
researchAssistant.timestamp = 0;
const expectedResearchBlock = [
	'<research_block>',
	'Status: pending',
	'Title: AI coding impact',
	'Query: how AI affects code',
	'Tasks:',
	'- Check adoption rates',
	'- Review security implications',
	'Source classes: web, academic',
	'Deliverables: final_answer',
	'</research_block>',
].join('\n');
assert.deepEqual(buildApiMessages(researchGraph, [researchUser.id, researchAssistant.id]), [
	{ role: 'user', content: 'research how code is impacted by AI' },
	{ role: 'assistant', content: expectedResearchBlock },
]);
assert.equal(buildConversationHistory(researchGraph, [researchUser.id, researchAssistant.id]).includes(expectedResearchBlock), true);

apiAssistant.parts = [
	{ type: 'text', content: 'Visible first. ' },
	{ type: 'reasoning', content: 'Thinking again.' },
	{ type: 'text', content: 'Visible second.' },
];
assert.deepEqual(buildApiMessages(apiGraph, [apiUser.id, apiAssistant.id]), [
	{ role: 'user', content: 'hi there' },
	{ role: 'assistant', content: 'Visible first. <think>\nThinking again.\n</think>Visible second.' },
]);
delete apiAssistant.parts;

apiAssistant.reasoningParts = [
	{ type: 'text', content: 'Thinking...' },
	{ type: 'tool_call', toolCallId: 'tool_1' },
	{ type: 'text', content: '\nDone.' },
];
apiAssistant.toolCalls = [
	{ id: 'tool_1', name: 'diag_tool', status: 'completed', output: { ok: true } },
];
assert.deepEqual(getResolvedReasoningParts({
	reasoning: apiAssistant.reasoning,
	reasoningParts: apiAssistant.reasoningParts,
	toolCalls: apiAssistant.toolCalls,
}), [
	{ type: 'text', content: 'Thinking...' },
	{
		type: 'tool_call',
		toolCallId: 'tool_1',
		toolCall: { id: 'tool_1', name: 'diag_tool', status: 'completed', output: { ok: true } },
	},
	{ type: 'text', content: '\nDone.' },
]);

apiAssistant.toolCalls[0].modelOutput = 'tool says ok';
assert.deepEqual(buildApiMessages(apiGraph, [apiUser.id, apiAssistant.id]), [
	{ role: 'user', content: 'hi there' },
	{
		role: 'assistant',
		content: null,
		tool_calls: [
			{
				id: 'tool_1',
				type: 'function',
				function: { name: 'diag_tool', arguments: '{}' },
			},
		],
	},
	{ role: 'tool', tool_call_id: 'tool_1', content: 'tool says ok' },
	{ role: 'assistant', content: '<think>\nthinking\n</think>\n\ngeneral kenobi' },
]);

assert.deepEqual(
	getMessageFileEditRollbacks({
		role: 'assistant',
		reasoningParts: [{ type: 'tool_call', toolCallId: 'edit_1' }],
		toolCalls: [{
			id: 'edit_1',
			name: 'filesystem__edit_file',
			output: {
				edited_files: [{
					path: 'src/app.js',
					workspace_directory: '/tmp/project',
					checkpoint: { id: 'checkpoint-1' },
					rollback_available: true,
				}],
			},
		}],
	}),
	[{
		checkpointId: 'checkpoint-1',
		workspaceDirectory: '/tmp/project',
		path: 'src/app.js',
		operation: '',
		createdFile: false,
		toolCallId: 'edit_1',
	}]
);

const assistantSiblingCopy = createSiblingCopy(apiGraph, apiAssistant.id);
assert.deepEqual(getNode(apiGraph, assistantSiblingCopy.id).reasoningParts, apiAssistant.reasoningParts);

apiAssistant.tokenLogprobs = [
	{ text: 'general ', logprob: -0.1 },
	{ text: 'kenobi', logprob: -0.8 },
];
const historyWithLogprobs = buildConversationHistory(apiGraph, [apiUser.id, apiAssistant.id], {
	logprobHistoryHigh: true,
	logprobHistoryMedium: false,
	logprobHistoryLow: false,
});
assert.equal(historyWithLogprobs.includes('<logprob_confidence total_tokens=2 flagged=1>'), true);
assert.equal(historyWithLogprobs.includes('[general ](HIGH=93%)'), true);
assert.equal(historyWithLogprobs.includes('MEDIUM='), false);

const markdownCss = readFileSync('./www/css/pages/chat/markdown.css', 'utf8');
assert.match(markdownCss, /\.md-link\s*\{[^}]*border-bottom:\s*none;/s);
assert.match(markdownCss, /\.md-link:hover\s*\{[^}]*border-bottom:\s*none;/s);
assert.match(markdownCss, /\.md-table-wrapper\s*\{[^}]*overflow-x:\s*auto;/s);

const composerCss = readFileSync('./www/css/pages/chat/composer.css', 'utf8');
assert.match(composerCss, /\.chat-context\s*\{[^}]*min-width:\s*5ch;/s);

const adjacentTableHtml = renderMessageTextHtml('Daily Outlook:\n| Date | Conditions |\n| :--- | :--- |\n| May 11 | Clear |');
assert.match(adjacentTableHtml, /<p class="md-paragraph">Daily Outlook:<\/p>/);
assert.match(adjacentTableHtml, /<table class="md-table">/);
assert.match(adjacentTableHtml, /<th class="md-table-header" align="left">Date<\/th>/);
assert.match(adjacentTableHtml, /<td class="md-table-cell" align="left">Clear<\/td>/);

const tokenHighlightingCss = readFileSync('./www/css/components/content/token-highlighting.css', 'utf8');
assert.match(tokenHighlightingCss, /\.token-logprob-tooltip\s*\{/);

setModelMetadata([{ id: 'lmstudio::route-model', context_length: 32768 }]);
assert.deepEqual(getModelContextInfo('lmstudio::route-model'), {
	contextLimit: 32768,
	isKnown: true,
});
assert.deepEqual(getModelContextInfo('lmstudio::missing-model'), {
	contextLimit: 65536,
	isKnown: false,
});

function fakeClassList(initial = []) {
	const values = new Set(initial);
	return {
		add(...names) {
			names.forEach((name) => values.add(name));
		},
		remove(...names) {
			names.forEach((name) => values.delete(name));
		},
		contains(name) {
			return values.has(name);
		},
		toggle(name, force) {
			if (force === undefined) {
				if (values.has(name)) values.delete(name);
				else values.add(name);
				return values.has(name);
			}
			if (force) values.add(name);
			else values.delete(name);
			return Boolean(force);
		},
	};
}

setModelMetadata([{ id: 'lmstudio::stale-window-model', context_length: 32768 }]);
const selectedContextModel = {
	dataset: { value: 'lmstudio::stale-window-model' },
	classList: fakeClassList(['selected']),
};
const contextEl = {
	dataset: {},
	classList: fakeClassList(),
	style: { setProperty() {} },
	textContent: '',
	title: '',
};
const warningEl = {
	hidden: false,
	setAttribute(name, value) {
		this[name] = String(value);
	},
	removeAttribute(name) {
		delete this[name];
	},
};
const contextRoot = {
	querySelector(selector) {
		if (selector === '#chatContext') return contextEl;
		if (selector === '#chatContextWarningIcon') return warningEl;
		return null;
	},
	querySelectorAll(selector) {
		return selector === '[data-dropdown="model"] .chat-dropdown-item'
			? [selectedContextModel]
			: [];
	},
};
updateContextUI(contextRoot, {
	usedTokens: 2162,
	contextLimit: 65536,
	contextLimitKnown: false,
	showUnknownContextWarning: true,
});
assert.equal(contextEl.textContent, '2162/32768');
assert.equal(warningEl.hidden, true);

class FakeElement {
	constructor(tagName) {
		this.tagName = String(tagName).toUpperCase();
		this.className = '';
		this.children = [];
		this.attributes = {};
		this.open = false;
		this._textContent = '';
		this._innerHTML = '';
	}

	setAttribute(name, value) {
		this.attributes[String(name)] = String(value ?? '');
	}

	append(...nodes) {
		nodes.forEach((node) => this.appendChild(node));
	}

	appendChild(node) {
		this.children.push(node);
		return node;
	}

	set textContent(value) {
		this._textContent = String(value ?? '');
		this._innerHTML = '';
		this.children = [];
	}

	get textContent() {
		if (this.children.length > 0) {
			return this.children.map((child) => child.textContent ?? '').join('');
		}
		return this._textContent;
	}

	set innerHTML(value) {
		this._innerHTML = String(value ?? '');
		this._textContent = '';
		this.children = [];
	}

	get innerHTML() {
		return this._innerHTML;
	}
}

const previousDocument = globalThis.document;
globalThis.document = {
	createElement(tagName) {
		return new FakeElement(tagName);
	},
};

try {
	const reasoningEl = buildReasoningElement({
		reasoning: '**bold**\n\n- item',
		open: true,
	});
	assert.equal(reasoningEl.className, 'message-reasoning');
	assert.equal(reasoningEl.open, true);
	assert.equal(reasoningEl.children[0].textContent, 'Thinking');
	assert.equal(reasoningEl.children[1].className, 'reasoning-content');
	assert.equal(reasoningEl.children[1].children[0].className, 'reasoning-text');
	assert.match(reasoningEl.children[1].children[0].innerHTML, /<strong>bold<\/strong>/);
	assert.match(reasoningEl.children[1].children[0].innerHTML, /<ul class="md-list md-list-unordered">/);

	const splitReasoningEl = buildReasoningElement({
		reasoning: 'Reasoning text',
		reasoningParts: [{ type: 'text', content: 'Reasoning text' }],
		toolCalls: [{ id: 'tool_1', name: 'fetch_url', status: 'completed', output: { ok: true } }],
		open: true,
	});
	assert.equal(splitReasoningEl.children[1].children.length, 1);
	assert.equal(splitReasoningEl.children[1].children[0].className, 'reasoning-text');

	const toolCallsEl = buildToolCallsElement({
		reasoning: 'Reasoning text',
		reasoningParts: [{ type: 'text', content: 'Reasoning text' }],
		toolCalls: [{ id: 'tool_1', name: 'fetch_url', status: 'completed', output: { ok: true } }],
	});
	assert.equal(toolCallsEl.className, 'message-tool-calls');
	assert.equal(toolCallsEl.children.length, 1);
	assert.equal(toolCallsEl.children[0].className, 'message-tool-call');

	const inlineContainer = buildContentContainer({
		role: 'assistant',
		parts: [
			{ type: 'text', content: 'Before' },
			{ type: 'reasoning', content: 'Inline thought' },
			{ type: 'text', content: 'After' },
		],
		reasoning: 'Aggregate thought',
		reasoningParts: [{ type: 'text', content: 'Aggregate thought' }],
	}, false, null);
	assert.equal(inlineContainer.children.length, 3);
	assert.equal(inlineContainer.children[0].className, 'chat-message-text');
	assert.equal(inlineContainer.children[1].className, 'message-reasoning');
	assert.equal(inlineContainer.children[2].className, 'chat-message-text');

	const inlineToolContainer = buildContentContainer({
		role: 'assistant',
		parts: [
			{ type: 'text', content: 'Before' },
			{ type: 'reasoning', content: 'Inline thought' },
			{ type: 'text', content: 'After' },
		],
		reasoningParts: [{ type: 'tool_call', toolCallId: 'tool_inline' }],
		toolCalls: [{ id: 'tool_inline', name: 'diag_tool', status: 'completed', output: { ok: true } }],
	}, false, null);
	assert.equal(inlineToolContainer.children.length, 3);
	assert.equal(inlineToolContainer.children[1].className, 'message-reasoning');
	assert.equal(inlineToolContainer.children[1].children[1].children.length, 2);
	assert.equal(inlineToolContainer.children[1].children[1].children[1].className, 'message-tool-call');

	const contentFallbackContainer = buildContentContainer({
		role: 'assistant',
		content: '<think>First</think>Visible<think>Second</think>Done',
	}, false, null);
	assert.equal(contentFallbackContainer.children.length, 4);
	assert.equal(contentFallbackContainer.children[0].className, 'message-reasoning');
	assert.equal(contentFallbackContainer.children[1].className, 'chat-message-text');
	assert.match(contentFallbackContainer.children[1].innerHTML, /Visible/);
	assert.equal(contentFallbackContainer.children[2].className, 'message-reasoning');
	assert.equal(contentFallbackContainer.children[3].className, 'chat-message-text');
	assert.match(contentFallbackContainer.children[3].innerHTML, /Done/);

	const editRawContainer = buildContentContainer({
		role: 'assistant',
		parts: [
			{ type: 'reasoning', content: 'First' },
			{ type: 'text', content: 'Visible' },
			{ type: 'reasoning', content: 'Second' },
		],
	}, true, null);
	assert.equal(editRawContainer.children[0].className, 'chat-edit-input');
	assert.equal(editRawContainer.children[0].innerText, '<think>\nFirst\n</think>Visible<think>\nSecond\n</think>');
} finally {
	if (previousDocument === undefined) {
		delete globalThis.document;
	} else {
		globalThis.document = previousDocument;
	}
}

assert.equal(isFormattingOnlyTextContent('\n    '), true);
assert.equal(isFormattingOnlyTextContent(' '), false);

const mapped = mapDomTextToTokenLogprobs('abc', [
	{ text: 'a', logprob: -0.25 },
	{ text: 'xc', logprob: -1.75 },
]);
assert.deepEqual(mapped.domToTokenLogprob, [-0.25, null, null]);
assert.equal(mapped.matched, 1);

const tableMapped = mapDomTextToTokenLogprobs(
	'Column 1Column 2Column 3Item AValue XDescription 1',
	[{ text: '| Column 1 | Column 2 | Column 3 |\n| --- | --- | --- |\n| Item A | Value X | Description 1 |', logprob: -0.4 }],
);
assert.equal(tableMapped.matched, 'Column 1Column 2Column 3Item AValue XDescription 1'.length);

assert.deepEqual(parseStreamReasoning('alpha<think>beta</think>gamma'), {
	parsedContent: 'alphagamma',
	parsedReasoning: 'beta\n\n',
	hasThinkTags: true,
	isThinkingActive: false,
	closedThinkBlocks: 1,
	parts: [
		{ type: 'text', content: 'alpha' },
		{ type: 'reasoning', content: 'beta', reasoningParts: [{ type: 'text', content: 'beta' }] },
		{ type: 'text', content: 'gamma' },
	],
});
assert.deepEqual(parseStreamReasoning('a<think>b</think>c<think>d</think>e').parts, [
	{ type: 'text', content: 'a' },
	{ type: 'reasoning', content: 'b', reasoningParts: [{ type: 'text', content: 'b' }] },
	{ type: 'text', content: 'c' },
	{ type: 'reasoning', content: 'd', reasoningParts: [{ type: 'text', content: 'd' }] },
	{ type: 'text', content: 'e' },
]);
assert.deepEqual(parseStreamReasoning('a<reasoning>b</reasoning>c').parts, [
	{ type: 'text', content: 'a' },
	{ type: 'reasoning', content: 'b', reasoningParts: [{ type: 'text', content: 'b' }] },
	{ type: 'text', content: 'c' },
]);
assert.deepEqual(parseStreamReasoningParts([
	{ type: 'reasoning', content: 'native one' },
	{ type: 'text', content: 'visible' },
	{ type: 'reasoning', content: 'native two' },
	{ type: 'text', content: '<think>tagged</think>done' },
]), {
	parsedContent: 'visibledone',
	parsedReasoning: 'native onenative twotagged\n\n',
	hasThinkTags: true,
	isThinkingActive: false,
	closedThinkBlocks: 1,
	parts: [
		{ type: 'reasoning', content: 'native one', reasoningParts: [{ type: 'text', content: 'native one' }] },
		{ type: 'text', content: 'visible' },
		{
			type: 'reasoning',
			content: 'native twotagged',
			reasoningParts: [{ type: 'text', content: 'native twotagged' }],
		},
		{ type: 'text', content: 'done' },
	],
});

assert.deepEqual(parseStreamReasoningParts([
	{ type: 'text', content: '<think>before ' },
	{ type: 'tool_call', toolCallId: 'tool_inline', toolCall: { id: 'tool_inline', name: 'diag_tool' } },
	{ type: 'text', content: 'after</think>done' },
]).parts, [
	{
		type: 'reasoning',
		content: 'before after',
		reasoningParts: [
			{ type: 'text', content: 'before ' },
			{ type: 'tool_call', toolCallId: 'tool_inline', toolCall: { id: 'tool_inline', name: 'diag_tool' } },
			{ type: 'text', content: 'after' },
		],
	},
	{ type: 'text', content: 'done' },
]);

assert.equal(shouldAutoOpenReasoningPhase({
	previousDisplayState: { parsedContent: '', isThinkingActive: false },
	nextDisplayState: { parsedContent: '', isThinkingActive: false, hasThinkTags: false },
	chunkHasLiveReasoning: true,
	reasoningPhaseActive: false,
	visibleOutputHasStarted: false,
}), true);
assert.equal(shouldAutoOpenReasoningPhase({
	previousDisplayState: { parsedContent: 'answer started', isThinkingActive: false },
	nextDisplayState: { parsedContent: 'answer started', isThinkingActive: false, hasThinkTags: false },
	chunkHasLiveReasoning: true,
	reasoningPhaseActive: false,
	visibleOutputHasStarted: true,
}), false);
assert.equal(shouldAutoOpenReasoningPhase({
	previousDisplayState: { parsedContent: '', isThinkingActive: false },
	nextDisplayState: { parsedContent: '', isThinkingActive: true, hasThinkTags: true },
	chunkHasLiveReasoning: false,
	reasoningPhaseActive: false,
	visibleOutputHasStarted: false,
}), true);

assert.equal(coerceTheme('bogus'), 'everforest-harddark-green');
assert.equal(coerceTheme('catppuccin-invalid-red'), 'catppuccin-mocha-red');
const rawMath = renderMessageTextHtml('Inline math stays literal: $x^2$ and $$y = mx + b$$');
assert.equal(rawMath, '<p class="md-paragraph">Inline math stays literal: $x^2$ and $$y = mx + b$$</p>\n');
EOF

echo "[smoke] Validating bundled web-search manifests"
node --input-type=module <<'EOF'
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const files = [
	'backend/toolpacks/websearch/tools/search_web.json',
	'backend/toolpacks/websearch/tools/open_result.json',
	'backend/toolpacks/websearch/tools/fetch_url.json',
	'backend/toolpacks/websearch/tools/related_results.json',
	'backend/toolpacks/websearch/tools/search_status.json',
];

const expectedHandlers = new Map([
	['search_web.json', 'websearch_search'],
	['open_result.json', 'websearch_open_result'],
	['fetch_url.json', 'websearch_fetch_url'],
	['related_results.json', 'websearch_related_results'],
	['search_status.json', 'websearch_status'],
]);

for (const file of files) {
	const json = JSON.parse(readFileSync(file, 'utf8'));
	const name = file.split('/').at(-1);
	assert.equal(json.executor, 'native', `${file} must use the native executor`);
	assert.equal(json.native?.handler, expectedHandlers.get(name), `${file} has the wrong native handler`);
	assert.equal(JSON.stringify(json).includes('example.com'), false, `${file} still references example.com`);
	assert.equal(JSON.stringify(json).includes('"http"'), false, `${file} should not define an HTTP executor payload`);
}
EOF

binary="${1:-backend/build/ctrlpanel}"
if [[ ! -x "$binary" ]]; then
	echo "[smoke] Skipping backend smoke: binary not found at $binary"
	exit 0
fi

port="$(
	python3 - <<'EOF'
import socket
s = socket.socket()
s.bind(('127.0.0.1', 0))
print(s.getsockname()[1])
s.close()
EOF
)"

lm_port="$(
	python3 - <<'EOF'
import socket
s = socket.socket()
s.bind(('127.0.0.1', 0))
print(s.getsockname()[1])
s.close()
EOF
)"

tmpdir="$(mktemp -d /tmp/ctrlpanel-smoke-XXXXXX)"
cleanup() {
	if [[ -n "${lm_stub_pid:-}" ]] && kill -0 "$lm_stub_pid" 2>/dev/null; then
		kill "$lm_stub_pid" 2>/dev/null || true
		wait "$lm_stub_pid" 2>/dev/null || true
	fi
	if [[ -n "${server_pid:-}" ]] && kill -0 "$server_pid" 2>/dev/null; then
		kill "$server_pid" 2>/dev/null || true
		wait "$server_pid" 2>/dev/null || true
	fi
	rm -rf "$tmpdir"
}
trap cleanup EXIT

cp "$binary" "$tmpdir/ctrlpanel"
mkdir -p "$tmpdir/data"
cat > "$tmpdir/lmstudio_stub.py" <<'PY'
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import sys

PORT = int(sys.argv[1])


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, format, *args):
        return

    def do_GET(self):
        if self.path != "/v1/models":
            self.send_response(404)
            self.send_header("Connection", "close")
            self.end_headers()
            return

        body = json.dumps({"data": [{"id": "stub-model"}]}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)
        self.wfile.flush()

    def do_POST(self):
        if self.path != "/v1/chat/completions":
            self.send_response(404)
            self.send_header("Connection", "close")
            self.end_headers()
            return

        length = int(self.headers.get("Content-Length", "0") or 0)
        payload = {}
        if length:
            raw = self.rfile.read(length)
            try:
                payload = json.loads(raw)
            except Exception:
                payload = {}

        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self.end_headers()

        messages = payload.get("messages") or []
        user_prompt = ""
        for message in reversed(messages):
            if isinstance(message, dict) and message.get("role") == "user":
                user_prompt = str(message.get("content", ""))
                break

        wants_calculator = "6 * 7" in user_prompt or "6*7" in user_prompt
        tool_result_count = sum(
            isinstance(message, dict) and message.get("role") == "tool"
            for message in messages
        )

        if wants_calculator and tool_result_count == 0:
            events = [
                {
                    "choices": [
                        {
                            "delta": {
                                "tool_calls": [
                                    {
                                        "index": 0,
                                        "id": "call_search_calculator",
                                        "function": {
                                            "name": "search_tool_catalog",
                                            "arguments": "{\"query\":\"math calculator arithmetic\",\"limit\":4}",
                                        },
                                    }
                                ]
                            }
                        }
                    ]
                },
                {"choices": [{"finish_reason": "tool_calls", "delta": {}}]},
            ]
        elif wants_calculator and tool_result_count == 1:
            events = [
                {
                    "choices": [
                        {
                            "delta": {
                                "tool_calls": [
                                    {
                                        "index": 0,
                                        "id": "call_load_calculator",
                                        "function": {
                                            "name": "load_tool_definitions",
                                            "arguments": "{\"tool_ids\":[\"calculator/calculate\"]}",
                                        },
                                    }
                                ]
                            }
                        }
                    ]
                },
                {"choices": [{"finish_reason": "tool_calls", "delta": {}}]},
            ]
        elif wants_calculator and tool_result_count == 2:
            events = [
                {
                    "choices": [
                        {
                            "delta": {
                                "tool_calls": [
                                    {
                                        "index": 0,
                                        "id": "call_calculate",
                                        "function": {
                                            "name": "calculator__calculate",
                                            "arguments": "{\"op\":\"multiply\",\"args\":[6,7]}",
                                        },
                                    }
                                ]
                            }
                        }
                    ]
                },
                {"choices": [{"finish_reason": "tool_calls", "delta": {}}]},
            ]
        elif wants_calculator and tool_result_count >= 3:
            events = [
                {
                    "choices": [
                        {
                            "delta": {"content": "42"}
                        }
                    ]
                },
                {"choices": [{"finish_reason": "stop", "delta": {}}]},
            ]
        else:
            events = [
                {
                    "choices": [
                        {
                            "delta": {"reasoning": "Thinking Process:"},
                            "logprobs": {
                                "content": [
                                    {"token": "Thinking Process:", "logprob": -0.3},
                                ]
                            },
                        }
                    ]
                },
                {
                    "choices": [
                        {
                            "delta": {"content": "Hello world"},
                            "logprobs": {
                                "content": [
                                    {"token": "Hello", "logprob": -0.1},
                                    {"token": " world", "logprob": -1.2},
                                ]
                            },
                        }
                    ]
                },
                {"choices": [{"finish_reason": "stop", "delta": {}}]},
            ]

        for event in events:
            payload = json.dumps(event, separators=(",", ":")).encode()
            self.wfile.write(b"data: " + payload + b"\n\n")
            self.wfile.flush()

        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()
        self.close_connection = True


ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
PY
python3 -u "$tmpdir/lmstudio_stub.py" "$lm_port" >"$tmpdir/lmstudio_stub.log" 2>&1 &
lm_stub_pid="$!"

for _ in $(seq 1 50); do
	if curl -sf "http://127.0.0.1:$lm_port/v1/models" >/dev/null; then
		break
	fi
	sleep 0.1
done

cat > "$tmpdir/data/settings.json" <<JSON
{
  "host": "127.0.0.1",
  "port": $port,
  "lmStudioUrl": "http://127.0.0.1:$lm_port",
  "fallbackMaxOutputTokens": 2048,
  "temperature": 0.7,
  "systemPrompt": "",
  "defaultModel": "",
  "aiTitleEnabled": false,
  "llamacppBackend": "auto",
  "llamacppTag": "b8846"
}
JSON

echo "[smoke] Starting backend on 127.0.0.1:$port"
(
	cd "$tmpdir"
	./ctrlpanel >"$tmpdir/server.log" 2>&1
) &
server_pid="$!"

for _ in $(seq 1 50); do
	if curl -sf "http://127.0.0.1:$port/health" >/dev/null; then
		break
	fi
	sleep 0.2
done

base="http://127.0.0.1:$port"
health="$(curl -sf "$base/health")"
origin_header=("Origin: http://127.0.0.1:8080")
auth_before="$(curl -sf "$base/api/auth" -H "${origin_header[0]}")"
setup="$(curl -sf -X POST "$base/api/auth/setup" -H "${origin_header[0]}" -H 'Content-Type: application/json' -d '{"password":"smoke-pass"}')"
token="$(printf '%s' "$setup" | python3 -c 'import json,sys; print(json.load(sys.stdin)["sessionToken"])')"
auth_header=("Authorization: Bearer $token")
validate="$(curl -sf "$base/api/auth/validate" -H "${origin_header[0]}" -H "${auth_header[0]}")"
put_chats="$(curl -sf -X PUT "$base/api/chats" -H "${origin_header[0]}" -H 'Content-Type: application/json' -H "${auth_header[0]}" -d '{"chats":[],"currentChatId":"","pins":[]}')"
get_chats="$(curl -sf "$base/api/chats" -H "${origin_header[0]}" -H "${auth_header[0]}")"
mcp_tools="$(curl -sf "$base/api/mcp/tools" -H "${origin_header[0]}" -H "${auth_header[0]}")"
tool_packs="$(curl -sf "$base/api/tools/packs" -H "${origin_header[0]}" -H "${auth_header[0]}")"
llama_backend="$(curl -sf "$base/api/llamacpp/backend" -H "${origin_header[0]}" -H "${auth_header[0]}")"
put_chat="$(curl -sf -X PUT "$base/api/chats/smoke-logprobs" -H "${origin_header[0]}" -H 'Content-Type: application/json' -H "${auth_header[0]}" -d '{"title":"Smoke Logprobs"}')"
task_submit="$(curl -sf -X POST "$base/api/tasks/generate" -H "${origin_header[0]}" -H 'Content-Type: application/json' -H "${auth_header[0]}" -d '{"model":"stub-model","prompt":"User: hello","max_tokens":32,"logprobs":true,"chat_id":"smoke-logprobs"}')"
task_id="$(printf '%s' "$task_submit" | python3 -c 'import json,sys; print(json.load(sys.stdin)["task_id"])')"
task_wait="$(curl -sf "$base/api/tasks/$task_id/wait" -H "${origin_header[0]}" -H "${auth_header[0]}")"
task_status="$(curl -sf "$base/api/tasks/$task_id" -H "${origin_header[0]}" -H "${auth_header[0]}")"
saved_chat="$(curl -sf "$base/api/chats/smoke-logprobs" -H "${origin_header[0]}" -H "${auth_header[0]}")"
put_tool_chat="$(curl -sf -X PUT "$base/api/chats/smoke-tool-call" -H "${origin_header[0]}" -H 'Content-Type: application/json' -H "${auth_header[0]}" -d '{"title":"Smoke Tool Call","toolScope":{"enabledPackIds":["calculator"]}}')"
tool_task_submit="$(curl -sf -X POST "$base/api/tasks/generate" -H "${origin_header[0]}" -H 'Content-Type: application/json' -H "${auth_header[0]}" -d '{"model":"stub-model","prompt":"User: use tools to work out 6 * 7","max_tokens":64,"chat_id":"smoke-tool-call","tool_scope":{"enabledPackIds":["calculator"]}}')"
tool_task_id="$(printf '%s' "$tool_task_submit" | python3 -c 'import json,sys; print(json.load(sys.stdin)["task_id"])')"
tool_task_wait="$(curl -sf "$base/api/tasks/$tool_task_id/wait" -H "${origin_header[0]}" -H "${auth_header[0]}")"
tool_task_status="$(curl -sf "$base/api/tasks/$tool_task_id" -H "${origin_header[0]}" -H "${auth_header[0]}")"
saved_tool_chat="$(curl -sf "$base/api/chats/smoke-tool-call" -H "${origin_header[0]}" -H "${auth_header[0]}")"

[[ "$health" == *'"status":"ok"'* ]]
[[ "$auth_before" == *'"setup":false'* ]]
[[ "$validate" == *'"valid":true'* ]]
[[ "$put_chats" == *'"chats":['* ]]
[[ "$get_chats" == *'"chats":['* ]]
[[ "$mcp_tools" == *'"tools":['* ]]
[[ "$tool_packs" == *'"id":"calculator"'* ]]
[[ "$tool_packs" != *'diagnostic-test-tools'* ]]
[[ "$llama_backend" == *'"available":['* ]]
[[ "$put_chat" == *'"id":"smoke-logprobs"'* ]]
[[ "$put_tool_chat" == *'"id":"smoke-tool-call"'* ]]
[[ "$task_wait" == *'"status":"completed"'* ]]
[[ "$task_status" == *'"id":"'"$task_id"'"'* ]]
[[ "$tool_task_wait" == *'"status":"completed"'* ]]
[[ "$tool_task_status" == *'"id":"'"$tool_task_id"'"'* ]]
SAVED_CHAT_JSON="$saved_chat" python3 - <<'PY'
import json
import math
import os
import sys

chat = json.loads(os.environ["SAVED_CHAT_JSON"])
nodes = chat["graph"]["nodes"]
assistant_nodes = [node for node in nodes.values() if node.get("role") == "assistant"]
assert assistant_nodes, chat
assert assistant_nodes[-1]["content"] == "Hello world", assistant_nodes[-1]
assert assistant_nodes[-1]["reasoning"] == "Thinking Process:", assistant_nodes[-1]
logprobs = assistant_nodes[-1].get("tokenLogprobs")
assert isinstance(logprobs, list) and len(logprobs) == 2, logprobs
assert logprobs[0]["text"] == "Hello", logprobs
assert math.isclose(logprobs[0]["logprob"], -0.1, rel_tol=0, abs_tol=1e-9), logprobs
assert logprobs[1]["text"] == " world", logprobs
assert math.isclose(logprobs[1]["logprob"], -1.2, rel_tol=0, abs_tol=1e-9), logprobs
PY

SAVED_TOOL_CHAT_JSON="$saved_tool_chat" python3 - <<'PY'
import json
import os

chat = json.loads(os.environ["SAVED_TOOL_CHAT_JSON"])
nodes = chat["graph"]["nodes"]
assistant_nodes = [node for node in nodes.values() if node.get("role") == "assistant"]
assert assistant_nodes, chat
assistant = assistant_nodes[-1]
assert assistant["content"] == "42", assistant
tool_calls = assistant.get("toolCalls")
assert isinstance(tool_calls, list) and len(tool_calls) == 3, tool_calls
assert [tool_call["name"] for tool_call in tool_calls] == [
    "search_tool_catalog",
    "load_tool_definitions",
    "calculator__calculate",
], tool_calls
assert all(tool_call["status"] == "completed" for tool_call in tool_calls), tool_calls
assert tool_calls[-1]["output"]["value"] == 42, tool_calls[-1]
assert tool_calls[-1]["output"]["output"] == "42", tool_calls[-1]
PY

echo "[smoke] Backend smoke passed"
