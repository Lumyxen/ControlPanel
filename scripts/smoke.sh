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
});

assert.equal(coerceTheme('bogus'), 'everforest-harddark-green');
assert.equal(coerceTheme('catppuccin-invalid-red'), 'catppuccin-mocha-red');
const rawMath = renderMessageTextHtml('Inline math stays literal: $x^2$ and $$y = mx + b$$');
assert.equal(rawMath, '<p class="md-paragraph">Inline math stays literal: $x^2$ and $$y = mx + b$$</p>\n');
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

        wants_test_tool = "test_return_true" in user_prompt
        has_tool_result = any(
            isinstance(message, dict) and message.get("role") == "tool"
            for message in messages
        )

        if wants_test_tool and not has_tool_result:
            events = [
                {
                    "choices": [
                        {
                            "delta": {
                                "tool_calls": [
                                    {
                                        "index": 0,
                                        "id": "call_test_true",
                                        "function": {
                                            "name": "test_return_true",
                                            "arguments": "{}",
                                        },
                                    }
                                ]
                            }
                        }
                    ]
                },
                {"choices": [{"finish_reason": "tool_calls", "delta": {}}]},
            ]
        elif wants_test_tool and has_tool_result:
            events = [
                {
                    "choices": [
                        {
                            "delta": {"content": "Tool returned true."}
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
auth_before="$(curl -sf "$base/api/auth")"
setup="$(curl -sf -X POST "$base/api/auth/setup" -H 'Content-Type: application/json' -d '{"password":"smoke-pass"}')"
token="$(printf '%s' "$setup" | python3 -c 'import json,sys; print(json.load(sys.stdin)["sessionToken"])')"
auth_header=("X-Session-Token: $token")
validate="$(curl -sf "$base/api/auth/validate" -H "X-Session-Token: $token")"
put_chats="$(curl -sf -X PUT "$base/api/chats" -H 'Content-Type: application/json' -H "X-Session-Token: $token" -d '{"chats":[],"currentChatId":"","pins":[]}')"
get_chats="$(curl -sf "$base/api/chats" -H "X-Session-Token: $token")"
mcp_tools="$(curl -sf "$base/api/mcp/tools" -H "${auth_header[0]}")"
llama_backend="$(curl -sf "$base/api/llamacpp/backend" -H "${auth_header[0]}")"
put_chat="$(curl -sf -X PUT "$base/api/chats/smoke-logprobs" -H 'Content-Type: application/json' -H "X-Session-Token: $token" -d '{"title":"Smoke Logprobs"}')"
task_submit="$(curl -sf -X POST "$base/api/tasks/generate" -H 'Content-Type: application/json' -H "${auth_header[0]}" -d '{"model":"stub-model","prompt":"User: hello","max_tokens":32,"logprobs":true,"chat_id":"smoke-logprobs"}')"
task_id="$(printf '%s' "$task_submit" | python3 -c 'import json,sys; print(json.load(sys.stdin)["task_id"])')"
task_wait="$(curl -sf "$base/api/tasks/$task_id/wait" -H "${auth_header[0]}")"
task_status="$(curl -sf "$base/api/tasks/$task_id" -H "${auth_header[0]}")"
saved_chat="$(curl -sf "$base/api/chats/smoke-logprobs" -H "X-Session-Token: $token")"
put_tool_chat="$(curl -sf -X PUT "$base/api/chats/smoke-tool-call" -H 'Content-Type: application/json' -H "X-Session-Token: $token" -d '{"title":"Smoke Tool Call","toolScope":{"enabledPackIds":["diagnostic-test-tools"]}}')"
tool_task_submit="$(curl -sf -X POST "$base/api/tasks/generate" -H 'Content-Type: application/json' -H "${auth_header[0]}" -d '{"model":"stub-model","prompt":"User: call test_return_true and then tell me the result","max_tokens":32,"chat_id":"smoke-tool-call","tool_scope":{"enabledPackIds":["diagnostic-test-tools"]}}')"
tool_task_id="$(printf '%s' "$tool_task_submit" | python3 -c 'import json,sys; print(json.load(sys.stdin)["task_id"])')"
tool_task_wait="$(curl -sf "$base/api/tasks/$tool_task_id/wait" -H "${auth_header[0]}")"
tool_task_status="$(curl -sf "$base/api/tasks/$tool_task_id" -H "${auth_header[0]}")"
saved_tool_chat="$(curl -sf "$base/api/chats/smoke-tool-call" -H "X-Session-Token: $token")"

[[ "$health" == *'"status":"ok"'* ]]
[[ "$auth_before" == *'"setup":false'* ]]
[[ "$validate" == *'"valid":true'* ]]
[[ "$put_chats" == *'"chats":['* ]]
[[ "$get_chats" == *'"chats":['* ]]
[[ "$mcp_tools" == *'"tools":['* ]]
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
assert assistant["content"] == "Tool returned true.", assistant
tool_calls = assistant.get("toolCalls")
assert isinstance(tool_calls, list) and len(tool_calls) == 1, tool_calls
tool_call = tool_calls[0]
assert tool_call["name"] == "test_return_true", tool_call
assert tool_call["status"] == "completed", tool_call
assert tool_call["output"] is True, tool_call
PY

echo "[smoke] Backend smoke passed"
