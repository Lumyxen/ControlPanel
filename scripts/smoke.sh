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
import { getNodeTextContent, buildPartsWithUpdatedText } from './www/js/pages/chat/message-parts.js';
import { buildApiMessages, buildConversationHistory, parseStreamReasoning } from './www/js/pages/chat/payloads.js';
import { getResolvedReasoningParts } from './www/js/pages/chat/reasoning-parts.js';
import { buildReasoningElement, buildToolCallsElement } from './www/js/pages/chat/thread-view.js';
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
			{ type: 'attachment', name: 'demo.txt' },
			{ type: 'text', content: 'beta' },
		],
	}),
	'alphabeta'
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
apiAssistant.reasoning = 'thinking';
assert.deepEqual(buildApiMessages(apiGraph, [apiUser.id, apiAssistant.id]), [
	{ role: 'user', content: 'hi there' },
	{ role: 'assistant', content: '<think>\nthinking\n</think>\n\ngeneral kenobi' },
]);

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

const tokenHighlightingCss = readFileSync('./www/css/components/content/token-highlighting.css', 'utf8');
assert.match(tokenHighlightingCss, /\.token-logprob-tooltip\s*\{/);

class FakeElement {
	constructor(tagName) {
		this.tagName = String(tagName).toUpperCase();
		this.className = '';
		this.children = [];
		this.open = false;
		this._textContent = '';
		this._innerHTML = '';
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
});

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

vault_material="$(python3 - <<'PY'
import hashlib
import json
import secrets

password = "vault-master"
salt = secrets.token_hex(32)
derived = hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt), 600000, dklen=64)
print(json.dumps({
    "kdf": {
        "type": "pbkdf2",
        "hash": "sha256",
        "iterations": 600000,
        "salt": salt,
    },
    "vaultAuthKey": derived[32:].hex(),
    "vault": {
        "version": 1,
        "alg": "AES-256-GCM",
        "revision": 1,
        "createdAt": 1,
        "updatedAt": 1,
        "iv": "smoke-iv",
        "ct": "smoke-ct",
    },
}))
PY
)"
vault_auth_key="$(printf '%s' "$vault_material" | python3 -c 'import json,sys; print(json.load(sys.stdin)["vaultAuthKey"])')"
vault_setup="$(curl -sf -X POST "$base/api/vault/setup" -H "${origin_header[0]}" -H 'Content-Type: application/json' -H "${auth_header[0]}" -d "$vault_material")"
vault_status="$(curl -sf "$base/api/vault/status" -H "${origin_header[0]}" -H "${auth_header[0]}" -H 'X-Vault-Device-Id: smoke-device')"
vault_challenge="$(curl -sf -X POST "$base/api/vault/unlock/challenge" -H "${origin_header[0]}" -H 'Content-Type: application/json' -H "${auth_header[0]}" -d '{"mode":"master"}')"
vault_challenge_id="$(printf '%s' "$vault_challenge" | python3 -c 'import json,sys; print(json.load(sys.stdin)["challenge"])')"
vault_master_proof="$(python3 - <<'PY' "$vault_auth_key" "$vault_challenge_id"
import hashlib
import hmac
import sys

print(hmac.new(bytes.fromhex(sys.argv[1]), f"vault:master:{sys.argv[2]}".encode(), hashlib.sha256).hexdigest())
PY
)"
vault_unlock="$(curl -sf -X POST "$base/api/vault/unlock/master" -H "${origin_header[0]}" -H 'Content-Type: application/json' -H "${auth_header[0]}" -d "{\"challenge\":\"$vault_challenge_id\",\"proof\":\"$vault_master_proof\"}")"
vault_access_token="$(printf '%s' "$vault_unlock" | python3 -c 'import json,sys; print(json.load(sys.stdin)["vaultAccessToken"])')"
vault_save_payload='{"expectedRevision":1,"vault":{"version":1,"alg":"AES-256-GCM","revision":2,"createdAt":1,"updatedAt":2,"iv":"smoke-iv-2","ct":"smoke-ct-2"}}'
vault_save="$(curl -sf -X PUT "$base/api/vault" -H "${origin_header[0]}" -H 'Content-Type: application/json' -H "${auth_header[0]}" -H "X-Vault-Access-Token: $vault_access_token" -d "$vault_save_payload")"
vault_rechallenge="$(curl -sf -X POST "$base/api/vault/unlock/challenge" -H "${origin_header[0]}" -H 'Content-Type: application/json' -H "${auth_header[0]}" -d '{"mode":"master"}')"
vault_rechallenge_id="$(printf '%s' "$vault_rechallenge" | python3 -c 'import json,sys; print(json.load(sys.stdin)["challenge"])')"
vault_reproof="$(python3 - <<'PY' "$vault_auth_key" "$vault_rechallenge_id"
import hashlib
import hmac
import sys

print(hmac.new(bytes.fromhex(sys.argv[1]), f"vault:master:{sys.argv[2]}".encode(), hashlib.sha256).hexdigest())
PY
)"
vault_unlock_after_save="$(curl -sf -X POST "$base/api/vault/unlock/master" -H "${origin_header[0]}" -H 'Content-Type: application/json' -H "${auth_header[0]}" -d "{\"challenge\":\"$vault_rechallenge_id\",\"proof\":\"$vault_reproof\"}")"
vault_reauth_challenge="$(curl -sf -X POST "$base/api/vault/unlock/challenge" -H "${origin_header[0]}" -H 'Content-Type: application/json' -H "${auth_header[0]}" -d '{"mode":"master"}')"
vault_reauth_challenge_id="$(printf '%s' "$vault_reauth_challenge" | python3 -c 'import json,sys; print(json.load(sys.stdin)["challenge"])')"
vault_reauth_proof="$(python3 - <<'PY' "$vault_auth_key" "$vault_reauth_challenge_id"
import hashlib
import hmac
import sys

print(hmac.new(bytes.fromhex(sys.argv[1]), f"vault:master:{sys.argv[2]}".encode(), hashlib.sha256).hexdigest())
PY
)"
vault_reauth="$(curl -sf -X POST "$base/api/vault/reauth" -H "${origin_header[0]}" -H 'Content-Type: application/json' -H "${auth_header[0]}" -d "{\"challenge\":\"$vault_reauth_challenge_id\",\"proof\":\"$vault_reauth_proof\"}")"
vault_fresh_token="$(printf '%s' "$vault_reauth" | python3 -c 'import json,sys; print(json.load(sys.stdin)["vaultAccessToken"])')"
pin_payload="$(python3 - <<'PY'
import hashlib
import json
import secrets

pin = "2468"
salt = secrets.token_hex(16)
verifier = hashlib.pbkdf2_hmac("sha256", pin.encode(), bytes.fromhex(salt), 310000, dklen=32).hex()
print(json.dumps({
    "deviceId": "smoke-device",
    "pinAuthKdf": {
        "type": "pbkdf2",
        "hash": "sha256",
        "iterations": 310000,
        "salt": salt,
    },
    "pinAuthVerifier": verifier,
}))
PY
)"
pin_verifier="$(printf '%s' "$pin_payload" | python3 -c 'import json,sys; print(json.load(sys.stdin)["pinAuthVerifier"])')"
pin_setup="$(curl -sf -X POST "$base/api/vault/pin/setup" -H "${origin_header[0]}" -H 'Content-Type: application/json' -H "${auth_header[0]}" -H "X-Vault-Access-Token: $vault_fresh_token" -d "$pin_payload")"
vault_status_with_pin="$(curl -sf "$base/api/vault/status" -H "${origin_header[0]}" -H "${auth_header[0]}" -H 'X-Vault-Device-Id: smoke-device')"
pin_challenge="$(curl -sf -X POST "$base/api/vault/unlock/challenge" -H "${origin_header[0]}" -H 'Content-Type: application/json' -H "${auth_header[0]}" -d '{"mode":"pin","deviceId":"smoke-device"}')"
pin_challenge_id="$(printf '%s' "$pin_challenge" | python3 -c 'import json,sys; print(json.load(sys.stdin)["challenge"])')"
pin_proof="$(python3 - <<'PY' "$pin_verifier" "$pin_challenge_id"
import hashlib
import hmac
import sys

print(hmac.new(bytes.fromhex(sys.argv[1]), f"vault:pin:{sys.argv[2]}".encode(), hashlib.sha256).hexdigest())
PY
)"
pin_unlock="$(curl -sf -X POST "$base/api/vault/unlock/pin" -H "${origin_header[0]}" -H 'Content-Type: application/json' -H "${auth_header[0]}" -d "{\"deviceId\":\"smoke-device\",\"challenge\":\"$pin_challenge_id\",\"proof\":\"$pin_proof\"}")"
pin_fail_last=''
for _ in $(seq 1 5); do
	fail_challenge="$(curl -sf -X POST "$base/api/vault/unlock/challenge" -H "${origin_header[0]}" -H 'Content-Type: application/json' -H "${auth_header[0]}" -d '{"mode":"pin","deviceId":"smoke-device"}')"
	fail_challenge_id="$(printf '%s' "$fail_challenge" | python3 -c 'import json,sys; print(json.load(sys.stdin)["challenge"])')"
	pin_fail_last="$(curl -s -X POST "$base/api/vault/unlock/pin" -H "${origin_header[0]}" -H 'Content-Type: application/json' -H "${auth_header[0]}" -d "{\"deviceId\":\"smoke-device\",\"challenge\":\"$fail_challenge_id\",\"proof\":\"$(printf 'f%.0s' $(seq 1 64))\"}")"
done
vault_status_after_lockout="$(curl -sf "$base/api/vault/status" -H "${origin_header[0]}" -H "${auth_header[0]}" -H 'X-Vault-Device-Id: smoke-device')"

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
[[ "$vault_setup" == *'"success":true'* ]]
[[ "$vault_status" == *'"setup":true'* ]]
[[ "$vault_unlock" == *'"revision":1'* ]]
[[ "$vault_save" == *'"revision":2'* ]]
[[ "$vault_unlock_after_save" == *'"revision":2'* ]]
[[ "$pin_setup" == *'"success":true'* ]]
[[ "$vault_status_with_pin" == *'"configured":true'* ]]
[[ "$pin_unlock" == *'"vaultAccessToken":'* ]]
[[ "$pin_fail_last" == *'"pinDisabled":true'* ]]
[[ "$vault_status_after_lockout" == *'"configured":false'* ]]
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
