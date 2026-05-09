#include "controllers/generation_task_manager.h"

#include "app/server_app.h"

#include <algorithm>
#include <cctype>
#include <cstdio>
#include <deque>
#include <functional>
#include <sstream>
#include <thread>
#include <utility>

#include "controllers/chat_controller.h"
#include "server/http_utils.h"
#include "services/llamacpp_service.h"
#include "services/lmstudio_service.h"
#include "services/mcp_registry.h"
#include "services/tools/tool_system.h"

namespace {

struct ParsedTaskOutput {
    std::string content;
    std::string reasoning;
    Json::Value parts = Json::Value(Json::arrayValue);
    Json::Value reasoningParts = Json::Value(Json::arrayValue);
    Json::Value toolCalls = Json::Value(Json::arrayValue);
    Json::Value logprobs = Json::Value(Json::arrayValue);
    Json::Value revisionTrace = Json::Value(Json::objectValue);
};

ParsedTaskOutput parseTaskOutput(const std::deque<std::string>& chunks);

struct ReasoningTag {
    std::string open;
    std::string close;
};

struct ReasoningOpenMatch {
    bool found = false;
    std::size_t index = std::string::npos;
    std::string open;
    std::string close;
};

const std::vector<ReasoningTag>& reasoningTags() {
    static const std::vector<ReasoningTag> tags = {
        {"<think>", "</think>"},
        {"<thinking>", "</thinking>"},
        {"<reasoning>", "</reasoning>"},
        {"<thought>", "</thought>"},
    };
    return tags;
}

std::string generateTaskId() {
    const auto millis = std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::steady_clock::now().time_since_epoch()).count();
    return "task_" + std::to_string(millis) + "_" + std::to_string(std::rand() % 1000000);
}

Json::Int64 nowMillis() {
    return static_cast<Json::Int64>(std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::system_clock::now().time_since_epoch()).count());
}

void trimWhitespace(std::string& value) {
    const auto start = value.find_first_not_of(" \t\r\n");
    if (start == std::string::npos) {
        value.clear();
        return;
    }
    const auto end = value.find_last_not_of(" \t\r\n");
    value = value.substr(start, end - start + 1);
}

std::string toLowerCopy(std::string value) {
    std::transform(value.begin(), value.end(), value.begin(), [](unsigned char ch) {
        return static_cast<char>(std::tolower(ch));
    });
    return value;
}

ReasoningOpenMatch findNextReasoningOpen(const std::string& value) {
    const std::string lower = toLowerCopy(value);
    ReasoningOpenMatch match;
    for (const auto& tag : reasoningTags()) {
        const std::size_t index = lower.find(tag.open);
        if (index == std::string::npos) {
            continue;
        }
        if (!match.found || index < match.index) {
            match.found = true;
            match.index = index;
            match.open = tag.open;
            match.close = tag.close;
        }
    }
    return match;
}

std::vector<std::string> extractSsePayloads(const std::string& chunk) {
    std::vector<std::string> payloads;
    std::istringstream stream(chunk);
    std::string line;
    while (std::getline(stream, line)) {
        if (line.rfind("data:", 0) != 0) {
            continue;
        }
        std::string payload = line.substr(5);
        if (!payload.empty() && payload.front() == ' ') {
            payload.erase(payload.begin());
        }
        payloads.push_back(std::move(payload));
    }
    return payloads;
}

void appendLogprobEntries(
    Json::Value& outputLogprobs,
    const Json::Value& choice,
    const Json::Value& delta,
    const std::string& fallbackText) {
    if (!fallbackText.empty() && delta.isMember("logprob")) {
        Json::Value entry(Json::objectValue);
        entry["text"] = fallbackText;
        entry["logprob"] = delta["logprob"];
        outputLogprobs.append(entry);
        return;
    }

    if (!choice.isMember("logprobs") || !choice["logprobs"].isObject() ||
        !choice["logprobs"].isMember("content") || !choice["logprobs"]["content"].isArray()) {
        return;
    }

    const Json::Value& entries = choice["logprobs"]["content"];
    bool appended = false;
    for (const auto& item : entries) {
        if (!item.isObject() || !item.isMember("logprob")) {
            continue;
        }

        const std::string token = item.get("token", "").asString();
        if (token.empty()) {
            continue;
        }

        Json::Value entry(Json::objectValue);
        entry["text"] = token;
        entry["logprob"] = item["logprob"];
        outputLogprobs.append(entry);
        appended = true;
    }

    if (!appended && !fallbackText.empty() && entries.size() == 1 &&
        entries[0].isObject() && entries[0].isMember("logprob")) {
        Json::Value entry(Json::objectValue);
        entry["text"] = fallbackText;
        entry["logprob"] = entries[0]["logprob"];
        outputLogprobs.append(entry);
    }
}

void upsertToolCall(Json::Value& toolCalls, const Json::Value& toolCall) {
    if (!toolCall.isObject()) {
        return;
    }
    if (!toolCalls.isArray()) {
        toolCalls = Json::Value(Json::arrayValue);
    }

    const std::string toolCallId = toolCall.get("id", "").asString();
    if (!toolCallId.empty()) {
        for (auto& existing : toolCalls) {
            if (existing.isObject() && existing.get("id", "").asString() == toolCallId) {
                existing = toolCall;
                return;
            }
        }
    }

    toolCalls.append(toolCall);
}

bool isDraftEditorToolCall(const Json::Value& toolCall) {
    if (!toolCall.isObject()) {
        return false;
    }
    const std::string packId = toolCall.get("packId", "").asString();
    const std::string canonicalId = toolCall.get("canonicalId", "").asString();
    const std::string name = toolCall.get("name", "").asString();
    return packId == "draft_editor" ||
           canonicalId.rfind("draft_editor/", 0) == 0 ||
           name.rfind("draft_editor__", 0) == 0;
}

void ensureRevisionTrace(Json::Value& trace, Json::Int64 startedAt = nowMillis()) {
    if (!trace.isObject()) {
        trace = Json::Value(Json::objectValue);
    }
    trace["mode"] = "live_revision";
    if (!trace.isMember("events") || !trace["events"].isArray()) {
        trace["events"] = Json::Value(Json::arrayValue);
    }
    if (!trace.isMember("issues") || !trace["issues"].isArray()) {
        trace["issues"] = Json::Value(Json::arrayValue);
    }
    if (!trace.isMember("startedAt")) {
        trace["startedAt"] = startedAt > 0 ? startedAt : nowMillis();
    }
}

void upsertRevisionIssue(Json::Value& issues, const Json::Value& issue) {
    if (!issue.isObject()) {
        return;
    }
    if (!issues.isArray()) {
        issues = Json::Value(Json::arrayValue);
    }

    const std::string issueId = issue.get("id", "").asString();
    if (!issueId.empty()) {
        for (auto& existing : issues) {
            if (existing.isObject() && existing.get("id", "").asString() == issueId) {
                existing = issue;
                return;
            }
        }
    }
    issues.append(issue);
}

void applyDraftEditorOutput(Json::Value& trace, const Json::Value& toolCall) {
    if (!toolCall.isObject() || !toolCall.isMember("output") || !toolCall["output"].isObject()) {
        return;
    }

    const Json::Value& output = toolCall["output"];
    const std::string operation = output.get("operation", "").asString();
    if (operation.empty() || operation == "draft_error") {
        return;
    }

    const Json::Int64 timestamp = output.get("timestamp", nowMillis()).asInt64();
    ensureRevisionTrace(trace, timestamp);
    trace["updatedAt"] = timestamp;
    trace["stage"] = output.get("stage", "draft");
    trace["committed"] = output.get("final", false).asBool();

    if (output.isMember("content") && output["content"].isString()) {
        trace["currentDraft"] = output["content"];
        if (output.get("final", false).asBool()) {
            trace["finalContent"] = output["content"];
        }
    }
    if (output.isMember("change_summary") && output["change_summary"].isString()) {
        trace["changeSummary"] = output["change_summary"];
    } else if (output.get("final", false).asBool() && output.isMember("summary")) {
        trace["changeSummary"] = output["summary"];
    }

    if (output.isMember("issue") && output["issue"].isObject()) {
        upsertRevisionIssue(trace["issues"], output["issue"]);
    } else if (output.isMember("issues") && output["issues"].isArray()) {
        for (const auto& issue : output["issues"]) {
            upsertRevisionIssue(trace["issues"], issue);
        }
    }

    Json::Value event(Json::objectValue);
    if (output.isMember("event_id")) {
        event["id"] = output["event_id"];
    }
    event["operation"] = operation;
    event["stage"] = output.get("stage", "draft");
    event["timestamp"] = timestamp;
    if (output.isMember("summary")) {
        event["summary"] = output["summary"];
    }
    if (output.isMember("change_summary")) {
        event["changeSummary"] = output["change_summary"];
    }
    if (output.isMember("patch")) {
        event["patch"] = output["patch"];
    }
    if (output.isMember("issue") && output["issue"].isObject()) {
        event["issueId"] = output["issue"].get("id", "");
    }

    const std::string eventId = event.get("id", "").asString();
    if (!eventId.empty()) {
        for (auto& existing : trace["events"]) {
            if (existing.isObject() && existing.get("id", "").asString() == eventId) {
                existing = event;
                return;
            }
        }
    }
    trace["events"].append(event);
}

void appendSystemMessage(Json::Value& messages, const std::string& content) {
    if (content.empty()) {
        return;
    }
    if (!messages.isArray()) {
        messages = Json::Value(Json::arrayValue);
    }
    Json::Value message(Json::objectValue);
    message["role"] = "system";
    message["content"] = content;
    messages.append(message);
}

void appendTextMessage(Json::Value& messages, const std::string& role, const std::string& content) {
    if (!messages.isArray()) {
        messages = Json::Value(Json::arrayValue);
    }
    Json::Value message(Json::objectValue);
    message["role"] = role;
    message["content"] = content;
    messages.append(message);
}

Json::Value mergeSystemPromptIntoMessages(Json::Value messages, const std::string& systemPrompt) {
    if (!messages.isArray()) {
        messages = Json::Value(Json::arrayValue);
    }
    if (systemPrompt.empty()) {
        return messages;
    }

    if (!messages.empty() &&
        messages[0].isObject() &&
        messages[0].get("role", "").asString() == "system" &&
        messages[0].isMember("content") &&
        messages[0]["content"].isString()) {
        const std::string existing = messages[0]["content"].asString();
        messages[0]["content"] = existing.empty() ? systemPrompt : systemPrompt + "\n\n" + existing;
        return messages;
    }

    Json::Value merged(Json::arrayValue);
    Json::Value system(Json::objectValue);
    system["role"] = "system";
    system["content"] = systemPrompt;
    merged.append(system);
    for (const auto& message : messages) {
        merged.append(message);
    }
    return merged;
}

std::string truncateForPrompt(const std::string& value, std::size_t maxChars) {
    if (value.size() <= maxChars) {
        return value;
    }
    return value.substr(0, maxChars) + "\n\n[truncated]";
}

std::string buildScriptedRevisionDraftPrompt() {
    return
        "Transparent revision mode is active. Produce a complete first draft for the user's latest request. "
        "This draft will be reviewed and revised before the final answer is shown. Return only the draft answer; "
        "do not mention revision mode, drafts, review steps, hidden reasoning, or internal analysis.";
}

std::string buildScriptedRevisionReviewPrompt(const std::string& draft) {
    return
        "Review the draft below for the user's request. Return JSON only, with this shape: "
        "{\"issues\":[{\"label\":\"...\",\"severity\":\"low|medium|high|none\",\"span\":\"optional short span\","
        "\"note\":\"user-visible review note\",\"recommended_action\":\"targeted edit\"}]}. "
        "Use 1 to 3 concrete notes. If there are no material issues, return one issue with label \"none\" "
        "and severity \"none\". Do not include private reasoning.\n\nDraft:\n" +
        truncateForPrompt(draft, 16000);
}

std::string issueField(const Json::Value& issue, const std::string& key) {
    return issue.isObject() && issue.isMember(key) && issue[key].isString()
        ? issue[key].asString()
        : "";
}

std::string buildRevisionNotesText(const Json::Value& issues) {
    if (!issues.isArray() || issues.empty()) {
        return "- none: No material issues found. Finalize the draft.";
    }

    std::string notes;
    for (const auto& issue : issues) {
        if (!issue.isObject()) {
            continue;
        }
        const std::string label = issueField(issue, "label").empty() ? "review" : issueField(issue, "label");
        const std::string severity = issueField(issue, "severity");
        const std::string note = issueField(issue, "note");
        const std::string action = issueField(issue, "recommended_action");
        if (!notes.empty()) {
            notes += "\n";
        }
        notes += "- " + label;
        if (!severity.empty()) {
            notes += " (" + severity + ")";
        }
        if (!note.empty()) {
            notes += ": " + note;
        }
        if (!action.empty()) {
            notes += " Action: " + action;
        }
    }
    return notes.empty() ? "- none: No material issues found. Finalize the draft." : notes;
}

std::string buildScriptedRevisionFinalPrompt(const std::string& draft, const Json::Value& issues) {
    return
        "Revise the draft using the review notes. Return only the final answer for the user. "
        "Do not mention the draft, the review process, hidden reasoning, or internal analysis.\n\n"
        "Review notes:\n" + truncateForPrompt(buildRevisionNotesText(issues), 6000) +
        "\n\nDraft:\n" + truncateForPrompt(draft, 20000);
}

bool parseJsonFromText(const std::string& text, Json::Value& parsed) {
    std::string candidate = text;
    trimWhitespace(candidate);

    auto tryParse = [&](const std::string& value) {
        Json::CharReaderBuilder reader;
        std::string errors;
        std::istringstream stream(value);
        return Json::parseFromStream(reader, stream, &parsed, &errors);
    };

    if (!candidate.empty() && tryParse(candidate)) {
        return true;
    }

    const std::size_t arrayStart = candidate.find('[');
    const std::size_t objectStart = candidate.find('{');
    std::size_t start = std::string::npos;
    if (arrayStart != std::string::npos && objectStart != std::string::npos) {
        start = std::min(arrayStart, objectStart);
    } else {
        start = arrayStart != std::string::npos ? arrayStart : objectStart;
    }
    if (start == std::string::npos) {
        return false;
    }

    const char open = candidate[start];
    const char close = open == '[' ? ']' : '}';
    const std::size_t end = candidate.find_last_of(close);
    if (end == std::string::npos || end <= start) {
        return false;
    }
    return tryParse(candidate.substr(start, end - start + 1));
}

Json::Value normalizeRevisionIssue(const Json::Value& rawIssue, int index) {
    Json::Value issue(Json::objectValue);
    issue["id"] = rawIssue.get("id", "issue_" + std::to_string(index)).asString();
    issue["label"] = rawIssue.get("label", "review").asString();
    issue["severity"] = rawIssue.get("severity", "medium").asString();
    issue["span"] = rawIssue.get("span", "").asString();

    std::string note = rawIssue.get("note", "").asString();
    if (note.empty()) {
        note = rawIssue.get("summary", "").asString();
    }
    if (note.empty()) {
        note = rawIssue.get("text", "").asString();
    }
    if (note.empty()) {
        note = rawIssue.get("recommended_action", "").asString();
    }
    if (note.empty()) {
        note = "Review the draft for clarity and correctness.";
    }
    issue["note"] = note;

    std::string action = rawIssue.get("recommended_action", "").asString();
    if (action.empty()) {
        action = note;
    }
    issue["recommended_action"] = action;
    issue["timestamp"] = nowMillis();
    return issue;
}

Json::Value parseRevisionIssues(const std::string& reviewText) {
    Json::Value parsed;
    Json::Value issues(Json::arrayValue);
    if (parseJsonFromText(reviewText, parsed)) {
        if (parsed.isArray() || (parsed.isObject() && parsed.isMember("issues"))) {
            const Json::Value source = parsed.isArray()
                ? parsed
                : parsed.get("issues", Json::Value(Json::arrayValue));
            int issueIndex = 1;
            for (const auto& item : source) {
                if (!item.isObject()) {
                    continue;
                }
                issues.append(normalizeRevisionIssue(item, issueIndex++));
                if (issues.size() >= 3) {
                    break;
                }
            }
        } else if (parsed.isObject()) {
            issues.append(normalizeRevisionIssue(parsed, 1));
        }
    }

    if (!issues.empty()) {
        return issues;
    }

    std::string fallback = reviewText;
    trimWhitespace(fallback);
    Json::Value issue(Json::objectValue);
    issue["id"] = "issue_1";
    issue["label"] = fallback.empty() ? "none" : "review";
    issue["severity"] = fallback.empty() ? "none" : "medium";
    issue["span"] = "";
    issue["note"] = fallback.empty()
        ? "No material issues found."
        : truncateForPrompt(fallback, 600);
    issue["recommended_action"] = fallback.empty()
        ? "Finalize the draft."
        : "Revise the draft using this review note.";
    issue["timestamp"] = nowMillis();
    issues.append(issue);
    return issues;
}

bool revisionIssuesAreMaterial(const Json::Value& issues) {
    if (!issues.isArray()) {
        return false;
    }
    for (const auto& issue : issues) {
        if (!issue.isObject()) {
            continue;
        }
        if (issue.get("label", "").asString() != "none" &&
            issue.get("severity", "").asString() != "none") {
            return true;
        }
    }
    return false;
}

Json::Value makeRevisionEvent(
    const std::string& taskId,
    const std::string& eventId,
    const std::string& operation,
    const std::string& stage,
    const std::string& content,
    const std::string& summary,
    bool final = false,
    const std::string& changeSummary = "",
    const Json::Value& issues = Json::Value(Json::arrayValue)) {
    Json::Value output(Json::objectValue);
    output["operation"] = operation;
    output["stage"] = stage;
    output["timestamp"] = nowMillis();
    output["content"] = content;
    output["summary"] = summary;
    output["event_id"] = eventId;
    if (final) {
        output["final"] = true;
    }
    if (!changeSummary.empty()) {
        output["change_summary"] = changeSummary;
    }
    if (issues.isArray() && !issues.empty()) {
        output["issues"] = issues;
    }

    Json::Value patch(Json::objectValue);
    patch["op"] = "replace";
    patch["path"] = "/content";
    patch["value"] = content;
    output["patch"] = Json::Value(Json::arrayValue);
    output["patch"].append(patch);

    Json::Value toolCall(Json::objectValue);
    toolCall["id"] = taskId + "_revision_" + eventId;
    toolCall["name"] = "draft_editor__" + operation;
    toolCall["canonicalId"] = "draft_editor/" + operation;
    toolCall["title"] = "Draft Editor";
    toolCall["packId"] = "draft_editor";
    toolCall["executor"] = "native";
    toolCall["riskTier"] = "read";
    toolCall["approvalMode"] = "auto";
    toolCall["status"] = "completed";
    toolCall["input"] = Json::Value(Json::objectValue);
    toolCall["output"] = output;
    toolCall["modelOutput"] = summary;

    Json::Value event(Json::objectValue);
    event["type"] = "tool_event";
    event["event"] = "completed";
    event["tool_call"] = toolCall;
    return event;
}

bool emitRevisionEvent(
    const std::function<bool(const std::string&)>& onChunk,
    const std::string& taskId,
    const std::string& eventId,
    const std::string& operation,
    const std::string& stage,
    const std::string& content,
    const std::string& summary,
    bool final = false,
    const std::string& changeSummary = "",
    const Json::Value& issues = Json::Value(Json::arrayValue)) {
    if (!onChunk) {
        return true;
    }
    const Json::Value event = makeRevisionEvent(
        taskId,
        eventId,
        operation,
        stage,
        content,
        summary,
        final,
        changeSummary,
        issues);
    return onChunk("data: " + writeJson(event) + "\n\n");
}

bool emitRevisionModelOutputEvent(
    const std::function<bool(const std::string&)>& onChunk,
    const std::string& phaseId,
    const std::string& stage,
    const std::string& label,
    const std::string& status,
    const std::string& contentDelta = "",
    const std::string& reasoningDelta = "") {
    if (!onChunk) {
        return true;
    }
    if (phaseId.empty() || (status.empty() && contentDelta.empty() && reasoningDelta.empty())) {
        return true;
    }

    Json::Value event(Json::objectValue);
    event["type"] = "revision_model_output";
    event["phase_id"] = phaseId;
    event["stage"] = stage;
    event["label"] = label;
    event["status"] = status.empty() ? "streaming" : status;
    event["timestamp"] = nowMillis();
    if (!contentDelta.empty()) {
        event["delta"] = contentDelta;
    }
    if (!reasoningDelta.empty()) {
        event["reasoning_delta"] = reasoningDelta;
    }
    return onChunk("data: " + writeJson(event) + "\n\n");
}

bool emitRevisionModelToolEvent(
    const std::function<bool(const std::string&)>& onChunk,
    const std::string& phaseId,
    const std::string& stage,
    const std::string& label,
    const Json::Value& sourceEvent) {
    if (!onChunk || phaseId.empty() || !sourceEvent.isObject() ||
        !sourceEvent.isMember("tool_call") || !sourceEvent["tool_call"].isObject()) {
        return true;
    }

    Json::Value event(Json::objectValue);
    event["type"] = "revision_model_output";
    event["phase_id"] = phaseId;
    event["stage"] = stage;
    event["label"] = label;
    event["status"] = "streaming";
    event["timestamp"] = nowMillis();
    event["tool_call"] = sourceEvent["tool_call"];
    if (sourceEvent.isMember("event")) {
        event["tool_event"] = sourceEvent["event"];
    }
    if (sourceEvent.isMember("approval")) {
        event["approval"] = sourceEvent["approval"];
    }
    return onChunk("data: " + writeJson(event) + "\n\n");
}

bool emitRevisionModelDeltasFromChunk(
    const std::function<bool(const std::string&)>& onChunk,
    const std::string& phaseId,
    const std::string& stage,
    const std::string& label,
    const std::string& chunk) {
    if (!onChunk || phaseId.empty()) {
        return true;
    }

    for (const auto& payload : extractSsePayloads(chunk)) {
        if (payload.empty() || payload == "[DONE]") {
            continue;
        }

        Json::CharReaderBuilder reader;
        std::string errors;
        std::istringstream stream(payload);
        Json::Value json;
        if (!Json::parseFromStream(reader, stream, &json, &errors) ||
            !json.isObject()) {
            continue;
        }

        const std::string type = json.get("type", "").asString();
        if ((type == "tool_execution" || type == "tool_event") && json.isMember("tool_call")) {
            if (!emitRevisionModelToolEvent(onChunk, phaseId, stage, label, json)) {
                return false;
            }
            continue;
        }

        if (!json.isMember("choices") || !json["choices"].isArray() || json["choices"].empty()) {
            continue;
        }

        const Json::Value& delta = json["choices"][0]["delta"];
        const std::string contentDelta =
            delta.isMember("content") && delta["content"].isString()
                ? delta["content"].asString()
                : "";
        const std::string reasoningDelta =
            delta.isMember("reasoning") && delta["reasoning"].isString()
                ? delta["reasoning"].asString()
                : "";
        if (contentDelta.empty() && reasoningDelta.empty()) {
            continue;
        }
        if (!emitRevisionModelOutputEvent(
                onChunk,
                phaseId,
                stage,
                label,
                "streaming",
                contentDelta,
                reasoningDelta)) {
            return false;
        }
    }
    return true;
}

void applyRevisionModelOutputEvent(Json::Value& trace, const Json::Value& event) {
    if (!event.isObject()) {
        return;
    }

    const std::string phaseId = event.get("phase_id", "").asString();
    if (phaseId.empty()) {
        return;
    }

    const Json::Int64 timestamp = event.get("timestamp", nowMillis()).asInt64();
    ensureRevisionTrace(trace, timestamp);
    if (!trace.isMember("modelOutputs") || !trace["modelOutputs"].isArray()) {
        trace["modelOutputs"] = Json::Value(Json::arrayValue);
    }

    Json::Value* phase = nullptr;
    for (auto& candidate : trace["modelOutputs"]) {
        if (candidate.isObject() && candidate.get("id", "").asString() == phaseId) {
            phase = &candidate;
            break;
        }
    }

    if (!phase) {
        Json::Value nextPhase(Json::objectValue);
        nextPhase["id"] = phaseId;
        nextPhase["stage"] = event.get("stage", "draft");
        nextPhase["label"] = event.get("label", "Model output");
        nextPhase["status"] = event.get("status", "streaming");
        nextPhase["content"] = "";
        nextPhase["reasoning"] = "";
        nextPhase["startedAt"] = timestamp;
        trace["modelOutputs"].append(nextPhase);
        phase = &trace["modelOutputs"][trace["modelOutputs"].size() - 1];
    }

    if (event.isMember("stage") && event["stage"].isString()) {
        (*phase)["stage"] = event["stage"];
        trace["stage"] = event["stage"];
    }
    if (event.isMember("label") && event["label"].isString()) {
        (*phase)["label"] = event["label"];
    }
    if (event.isMember("status") && event["status"].isString()) {
        (*phase)["status"] = event["status"];
        if (event["status"].asString() == "completed") {
            (*phase)["completedAt"] = timestamp;
        }
    }
    if (event.isMember("delta") && event["delta"].isString()) {
        (*phase)["content"] = phase->get("content", "").asString() + event["delta"].asString();
    }
    if (event.isMember("reasoning_delta") && event["reasoning_delta"].isString()) {
        (*phase)["reasoning"] = phase->get("reasoning", "").asString() + event["reasoning_delta"].asString();
    }
    if (event.isMember("tool_call") && event["tool_call"].isObject()) {
        if (!phase->isMember("toolCalls") || !(*phase)["toolCalls"].isArray()) {
            (*phase)["toolCalls"] = Json::Value(Json::arrayValue);
        }

        const Json::Value& toolCall = event["tool_call"];
        const std::string toolCallId = toolCall.get("id", "").asString();
        bool updated = false;
        if (!toolCallId.empty()) {
            for (auto& existing : (*phase)["toolCalls"]) {
                if (existing.isObject() && existing.get("id", "").asString() == toolCallId) {
                    existing = toolCall;
                    updated = true;
                    break;
                }
            }
        }
        if (!updated) {
            (*phase)["toolCalls"].append(toolCall);
        }
    }
    (*phase)["updatedAt"] = timestamp;
    trace["updatedAt"] = timestamp;
}

using MessageStreamer = std::function<void(
    const Json::Value&,
    int,
    std::function<bool(const std::string&)>,
    std::function<void(const std::string&)>)>;

bool collectRevisionPhaseText(
    const MessageStreamer& streamMessages,
    const Json::Value& messages,
    int maxTokens,
    const std::function<void(const std::string&)>& onError,
    const std::function<bool()>& cancelCheck,
    std::string& outputText,
    const std::function<bool(const std::string&)>& onPhaseChunk = nullptr) {
    std::deque<std::string> chunks;
    bool failed = false;

    streamMessages(
        messages,
        maxTokens,
        [&](const std::string& chunk) {
            if (cancelCheck && cancelCheck()) {
                return false;
            }
            if (onPhaseChunk && !onPhaseChunk(chunk)) {
                return false;
            }
            chunks.push_back(chunk);
            return true;
        },
        [&](const std::string& error) {
            failed = true;
            if (onError) {
                onError(error);
            }
        });

    if (failed || (cancelCheck && cancelCheck())) {
        return false;
    }

    for (const auto& chunk : chunks) {
        for (const auto& payload : extractSsePayloads(chunk)) {
            Json::Value json;
            Json::CharReaderBuilder reader;
            std::string errors;
            std::istringstream stream(payload);
            if (!Json::parseFromStream(reader, stream, &json, &errors) || !json.isMember("error")) {
                continue;
            }
            std::string message;
            const Json::Value& error = json["error"];
            if (error.isObject()) {
                message = error.get("message", "").asString();
            } else if (error.isString()) {
                message = error.asString();
            }
            if (message.empty()) {
                message = writeJson(error);
            }
            if (onError) {
                onError(message);
            }
            return false;
        }
    }

    ParsedTaskOutput parsed = parseTaskOutput(chunks);
    outputText = parsed.content;
    trimWhitespace(outputText);
    return true;
}

bool runScriptedRevisionFlow(
    const std::string& taskId,
    const Json::Value& baseMessages,
    int maxTokens,
    const std::function<bool(const std::string&)>& onChunk,
    const std::function<void(const std::string&)>& onError,
    const std::function<bool()>& cancelCheck,
    const MessageStreamer& streamMessages) {
    auto emitPhaseStart = [&](const std::string& phaseId, const std::string& stage, const std::string& label) {
        return emitRevisionModelOutputEvent(onChunk, phaseId, stage, label, "streaming");
    };
    auto emitPhaseDone = [&](const std::string& phaseId, const std::string& stage, const std::string& label) {
        return emitRevisionModelOutputEvent(onChunk, phaseId, stage, label, "completed");
    };
    auto emitPhaseChunk = [&](const std::string& phaseId,
                              const std::string& stage,
                              const std::string& label,
                              const std::string& chunk) {
        return emitRevisionModelDeltasFromChunk(onChunk, phaseId, stage, label, chunk);
    };

    if (!emitRevisionEvent(onChunk, taskId, "draft", "create_draft", "draft", "", "Drafting a first pass.")) {
        return false;
    }

    Json::Value draftMessages = baseMessages;
    appendSystemMessage(draftMessages, buildScriptedRevisionDraftPrompt());

    std::string draft;
    if (!emitPhaseStart("draft", "draft", "First draft")) {
        return false;
    }
    if (!collectRevisionPhaseText(
            streamMessages,
            draftMessages,
            maxTokens,
            onError,
            cancelCheck,
            draft,
            [&](const std::string& chunk) {
                return emitPhaseChunk("draft", "draft", "First draft", chunk);
            })) {
        return false;
    }
    if (!emitPhaseDone("draft", "draft", "First draft")) {
        return false;
    }
    if (draft.empty()) {
        if (onError) {
            onError("Revision mode draft generation produced no content");
        }
        return false;
    }
    if (!emitRevisionEvent(onChunk, taskId, "draft", "create_draft", "draft", draft, "Created a working draft.")) {
        return false;
    }

    if (!emitRevisionEvent(onChunk, taskId, "review", "annotate_issue", "review", draft, "Reviewing the draft.")) {
        return false;
    }
    Json::Value reviewMessages = baseMessages;
    appendTextMessage(reviewMessages, "assistant", draft);
    appendTextMessage(reviewMessages, "user", buildScriptedRevisionReviewPrompt(draft));

    std::string reviewText;
    const int reviewMaxTokens = std::clamp(maxTokens / 4, 256, 1024);
    if (!emitPhaseStart("review", "review", "Review output")) {
        return false;
    }
    if (!collectRevisionPhaseText(
            streamMessages,
            reviewMessages,
            reviewMaxTokens,
            onError,
            cancelCheck,
            reviewText,
            [&](const std::string& chunk) {
                return emitPhaseChunk("review", "review", "Review output", chunk);
            })) {
        return false;
    }
    if (!emitPhaseDone("review", "review", "Review output")) {
        return false;
    }
    const Json::Value issues = parseRevisionIssues(reviewText);
    if (!emitRevisionEvent(
            onChunk,
            taskId,
            "review",
            "annotate_issue",
            "review",
            draft,
            "Reviewed the draft.",
            false,
            "",
            issues)) {
        return false;
    }

    if (!emitRevisionEvent(onChunk, taskId, "revise", "replace_text", "revise", draft, "Revising the draft.")) {
        return false;
    }
    Json::Value finalMessages = baseMessages;
    appendTextMessage(finalMessages, "assistant", draft);
    appendTextMessage(finalMessages, "user", buildScriptedRevisionFinalPrompt(draft, issues));

    std::string finalText;
    if (!emitPhaseStart("final", "revise", "Final answer output")) {
        return false;
    }
    if (!collectRevisionPhaseText(
            streamMessages,
            finalMessages,
            maxTokens,
            onError,
            cancelCheck,
            finalText,
            [&](const std::string& chunk) {
                return emitPhaseChunk("final", "revise", "Final answer output", chunk);
            })) {
        return false;
    }
    if (!emitPhaseDone("final", "revise", "Final answer output")) {
        return false;
    }
    if (finalText.empty()) {
        finalText = draft;
    }

    const std::string changeSummary = revisionIssuesAreMaterial(issues)
        ? "Reviewed the draft and applied refinements before finalizing."
        : "Reviewed the draft and finalized it without material changes.";
    if (!emitRevisionEvent(
            onChunk,
            taskId,
            "commit",
            "commit_final",
            "commit",
            finalText,
            "Committed the final answer.",
            true,
            changeSummary,
            issues)) {
        return false;
    }

    return !onChunk || onChunk("data: [DONE]\n\n");
}

void appendReasoningTextPart(Json::Value& reasoningParts, const std::string& text) {
    if (text.empty()) {
        return;
    }
    if (!reasoningParts.isArray()) {
        reasoningParts = Json::Value(Json::arrayValue);
    }

    if (!reasoningParts.empty()) {
        Json::Value& last = reasoningParts[reasoningParts.size() - 1];
        if (last.isObject() && last.get("type", "").asString() == "text") {
            last["content"] = last.get("content", "").asString() + text;
            return;
        }
    }

    Json::Value part(Json::objectValue);
    part["type"] = "text";
    part["content"] = text;
    reasoningParts.append(part);
}

void upsertReasoningToolPart(Json::Value& reasoningParts, const Json::Value& toolCall) {
    if (!toolCall.isObject()) {
        return;
    }
    if (!reasoningParts.isArray()) {
        reasoningParts = Json::Value(Json::arrayValue);
    }

    const std::string toolCallId = toolCall.get("id", "").asString();
    if (!toolCallId.empty()) {
        for (auto& existing : reasoningParts) {
            if (!existing.isObject() || existing.get("type", "").asString() != "tool_call") {
                continue;
            }
            if (existing.get("toolCallId", "").asString() != toolCallId) {
                continue;
            }
            existing["toolCallId"] = toolCallId;
            existing["toolCall"] = toolCall;
            return;
        }
    }

    Json::Value part(Json::objectValue);
    part["type"] = "tool_call";
    if (!toolCallId.empty()) {
        part["toolCallId"] = toolCallId;
    }
    part["toolCall"] = toolCall;
    reasoningParts.append(part);
}

void appendMessagePart(Json::Value& parts, const std::string& type, const std::string& content) {
    if (content.empty()) {
        return;
    }
    if (!parts.isArray()) {
        parts = Json::Value(Json::arrayValue);
    }

    if ((type == "text" || type == "reasoning") && !parts.empty()) {
        Json::Value& last = parts[parts.size() - 1];
        if (last.isObject() && last.get("type", "").asString() == type) {
            last["content"] = last.get("content", "").asString() + content;
            return;
        }
    }

    Json::Value part(Json::objectValue);
    part["type"] = type;
    part["content"] = content;
    parts.append(part);
}

bool hasReasoningMessagePart(const Json::Value& parts) {
    if (!parts.isArray()) {
        return false;
    }
    for (const auto& part : parts) {
        if (part.isObject() && part.get("type", "").asString() == "reasoning" &&
            !part.get("content", "").asString().empty()) {
            return true;
        }
    }
    return false;
}

Json::Value normalizeMessageParts(
    const Json::Value& rawParts,
    std::string& outputContent,
    std::string& outputReasoning,
    bool& reasoningFromContent) {
    Json::Value parsedParts(Json::arrayValue);
    outputContent.clear();
    outputReasoning.clear();
    reasoningFromContent = false;

    if (!rawParts.isArray()) {
        return parsedParts;
    }

    for (const auto& rawPart : rawParts) {
        if (!rawPart.isObject()) {
            continue;
        }

        const std::string type = rawPart.get("type", "").asString();
        const std::string value = rawPart.get("content", "").asString();
        if (value.empty()) {
            continue;
        }

        if (type == "reasoning") {
            outputReasoning += value;
            appendMessagePart(parsedParts, "reasoning", value);
            continue;
        }
        if (type != "text") {
            continue;
        }

        std::string remaining = value;
        while (true) {
            const ReasoningOpenMatch openMatch = findNextReasoningOpen(remaining);
            if (!openMatch.found) {
                outputContent += remaining;
                appendMessagePart(parsedParts, "text", remaining);
                break;
            }

            const std::string leadingContent = remaining.substr(0, openMatch.index);
            outputContent += leadingContent;
            appendMessagePart(parsedParts, "text", leadingContent);

            const std::size_t contentStart = openMatch.index + openMatch.open.size();
            const std::string lowerRemaining = toLowerCopy(remaining);
            const std::size_t closeIndex = lowerRemaining.find(openMatch.close, contentStart);
            if (closeIndex == std::string::npos) {
                const std::string reasoning = remaining.substr(contentStart);
                outputReasoning += reasoning;
                appendMessagePart(parsedParts, "reasoning", reasoning);
                reasoningFromContent = true;
                break;
            }

            const std::string reasoning = remaining.substr(contentStart, closeIndex - contentStart);
            outputReasoning += reasoning + "\n\n";
            appendMessagePart(parsedParts, "reasoning", reasoning);
            reasoningFromContent = true;
            remaining = remaining.substr(closeIndex + openMatch.close.size());
        }
    }

    return parsedParts;
}

ParsedTaskOutput parseTaskOutput(const std::deque<std::string>& chunks) {
    ParsedTaskOutput output;
    Json::Value rawParts(Json::arrayValue);
    bool reasoningFromContent = false;

    for (const auto& chunk : chunks) {
        for (const auto& payload : extractSsePayloads(chunk)) {
            if (payload.empty() || payload == "[DONE]") {
                continue;
            }

            Json::CharReaderBuilder reader;
            std::string errors;
            std::istringstream stream(payload);
            Json::Value json;
            if (!Json::parseFromStream(reader, stream, &json, &errors)) {
                continue;
            }

            if (json.get("type", "").asString() == "retract") {
                rawParts = Json::Value(Json::arrayValue);
                output.parts = Json::Value(Json::arrayValue);
                output.reasoningParts = Json::Value(Json::arrayValue);
                output.toolCalls = Json::Value(Json::arrayValue);
                output.logprobs = Json::Value(Json::arrayValue);
                reasoningFromContent = false;
                continue;
            }

            if (json.get("type", "").asString() == "revision_model_output") {
                applyRevisionModelOutputEvent(output.revisionTrace, json);
                continue;
            }

            if ((json.get("type", "").asString() == "tool_execution" ||
                 json.get("type", "").asString() == "tool_event") &&
                json.isMember("tool_call")) {
                if (isDraftEditorToolCall(json["tool_call"])) {
                    applyDraftEditorOutput(output.revisionTrace, json["tool_call"]);
                    continue;
                }
                upsertToolCall(output.toolCalls, json["tool_call"]);
                upsertReasoningToolPart(output.reasoningParts, json["tool_call"]);
                continue;
            }

            if (!json.isMember("choices") || !json["choices"].isArray() || json["choices"].empty()) {
                continue;
            }

            const Json::Value& choice = json["choices"][0];
            const Json::Value& delta = choice["delta"];
            if (delta.isMember("reasoning") && delta["reasoning"].isString()) {
                const std::string reasoningDelta = delta["reasoning"].asString();
                appendMessagePart(rawParts, "reasoning", reasoningDelta);
                appendReasoningTextPart(output.reasoningParts, reasoningDelta);
            }
            if (delta.isMember("content") && delta["content"].isString()) {
                const std::string token = delta["content"].asString();
                appendMessagePart(rawParts, "text", token);
                appendLogprobEntries(output.logprobs, choice, delta, token);
            }
        }
    }

    Json::Value parsedParts = normalizeMessageParts(
        rawParts,
        output.content,
        output.reasoning,
        reasoningFromContent);
    const bool hasInlineReasoning = hasReasoningMessagePart(parsedParts);
    if (hasInlineReasoning && parsedParts.isArray() && !parsedParts.empty()) {
        output.parts = parsedParts;
    }

    trimWhitespace(output.content);
    trimWhitespace(output.reasoning);
    if (output.content.empty() &&
        output.revisionTrace.isObject() &&
        output.revisionTrace.isMember("finalContent") &&
        output.revisionTrace["finalContent"].isString()) {
        output.content = output.revisionTrace["finalContent"].asString();
        trimWhitespace(output.content);
    }
    bool hasReasoningTextPart = false;
    if (output.reasoningParts.isArray()) {
        for (const auto& part : output.reasoningParts) {
            if (part.isObject() && part.get("type", "").asString() == "text" &&
                !part.get("content", "").asString().empty()) {
                hasReasoningTextPart = true;
                break;
            }
        }
    }
    if (!hasInlineReasoning && !output.reasoning.empty() && !hasReasoningTextPart) {
        Json::Value textPart(Json::objectValue);
        textPart["type"] = "text";
        textPart["content"] = output.reasoning;

        Json::Value merged(Json::arrayValue);
        merged.append(textPart);
        if (output.reasoningParts.isArray()) {
            for (const auto& part : output.reasoningParts) {
                merged.append(part);
            }
        }
        output.reasoningParts = merged;
    }
    return output;
}

void saveParsedOutputToTask(
    const std::shared_ptr<GenerationTask>& task,
    const ParsedTaskOutput& output) {
    std::lock_guard<std::mutex> lock(task->mutex);
    task->resultContent = output.content;
    task->resultReasoning = output.reasoning;
    task->resultParts = output.parts;
    task->resultReasoningParts = output.reasoningParts;
    task->resultToolCalls = output.toolCalls;
    task->resultLogprobs = output.logprobs;
    task->resultRevisionTrace = output.revisionTrace;
}

void persistParsedOutputToChat(
    ChatStore* chatStore,
    const std::shared_ptr<GenerationTask>& task,
    const ParsedTaskOutput& output) {
    const std::string chatId = task->request.get("chat_id", "").asString();
    const std::string parentUserId = task->request.get("parent_user_node_id", "").asString();
    if (!chatStore || chatId.empty()) {
        return;
    }

    if (output.content.empty() &&
        output.reasoning.empty() &&
        output.toolCalls.empty() &&
        (!output.revisionTrace.isObject() || output.revisionTrace.empty())) {
        return;
    }

    chatStore->appendAssistantMessage(
        chatId,
        parentUserId,
        output.content,
        output.reasoning,
        output.parts,
        output.reasoningParts,
        output.toolCalls,
        output.logprobs,
        output.revisionTrace);
}

} // namespace

std::string taskStatusToString(TaskStatus status) {
    switch (status) {
        case TaskStatus::Pending:
            return "pending";
        case TaskStatus::Running:
            return "running";
        case TaskStatus::WaitingApproval:
            return "waiting_approval";
        case TaskStatus::Completed:
            return "completed";
        case TaskStatus::Cancelled:
            return "cancelled";
        case TaskStatus::Failed:
            return "failed";
    }
    return "unknown";
}

TaskManager::~TaskManager() {
    cancelAllTasks();
    waitForAllTasks();
}

TaskManager& TaskManager::instance() {
    static TaskManager manager;
    return manager;
}

TaskManager::TaskCreateResult TaskManager::createTask(const Json::Value& request) {
    auto task = std::make_shared<GenerationTask>();
    task->request = request;
    task->created = std::chrono::steady_clock::now();
    task->updated = task->created;

    std::string requestedId = request.get("task_id", "").asString();
    std::string id = requestedId.empty() ? generateTaskId() : requestedId;

    std::lock_guard<std::mutex> lock(mutex_);
    while (tasks_.find(id) != tasks_.end()) {
        id = requestedId.empty() ? generateTaskId() : requestedId + "_" + std::to_string(std::rand() % 1000000);
        requestedId.clear();
    }

    task->id = id;
    if (preCancelledTasks_.erase(id) > 0) {
        task->cancelled.store(true);
        task->status = TaskStatus::Cancelled;
        task->finalized.store(true);
    }

    tasks_[id] = task;
    return {id, task};
}

void TaskManager::startTask(const std::shared_ptr<GenerationTask>& task, std::future<void> future) {
    if (!task) {
        return;
    }

    std::lock_guard<std::mutex> lock(task->mutex);
    task->workerFuture = std::make_shared<std::future<void>>(std::move(future));
    if (!task->cancelled.load() && task->status == TaskStatus::Pending) {
        task->status = TaskStatus::Running;
        task->updated = std::chrono::steady_clock::now();
    }
}

std::shared_ptr<GenerationTask> TaskManager::findTask(std::string_view taskId) const {
    std::lock_guard<std::mutex> lock(mutex_);
    const auto it = tasks_.find(std::string(taskId));
    return it == tasks_.end() ? nullptr : it->second;
}

Json::Value TaskManager::buildSnapshot(const std::shared_ptr<GenerationTask>& task) const {
    Json::Value result(Json::objectValue);
    if (!task) {
        result["error"] = "Task not found";
        return result;
    }

    std::lock_guard<std::mutex> lock(task->mutex);
    result["id"] = task->id;
    result["status"] = taskStatusToString(task->status);
    result["finalized"] = task->finalized.load();
    result["chunkCount"] = static_cast<int>(task->chunks.size());
    if (!task->error.empty()) {
        result["error"] = task->error;
    }

    if (task->finalized.load() &&
        (!task->resultContent.empty() || !task->resultReasoning.empty() ||
         !task->resultParts.empty() || !task->resultReasoningParts.empty() || !task->resultToolCalls.empty() ||
         !task->resultLogprobs.empty() || !task->resultRevisionTrace.empty())) {
        result["result"]["content"] = task->resultContent;
        result["result"]["reasoning"] = task->resultReasoning;
        result["result"]["parts"] = task->resultParts;
        result["result"]["reasoningParts"] = task->resultReasoningParts;
        result["result"]["toolCalls"] = task->resultToolCalls;
        result["result"]["logprobs"] = task->resultLogprobs;
        result["result"]["revisionTrace"] = task->resultRevisionTrace;
    }

    return result;
}

Json::Value TaskManager::getTaskStatus(std::string_view taskId) const {
    return buildSnapshot(findTask(taskId));
}

Json::Value TaskManager::getTaskByChat(std::string_view chatId) const {
    std::shared_ptr<GenerationTask> bestTask;
    {
        std::lock_guard<std::mutex> lock(mutex_);
        for (const auto& [id, task] : tasks_) {
            if (task->request.get("chat_id", "").asString() != chatId) {
                continue;
            }
            if (!bestTask || task->created > bestTask->created) {
                bestTask = task;
            }
        }
    }

    if (!bestTask) {
        Json::Value result(Json::objectValue);
        result["found"] = false;
        result["chat_id"] = std::string(chatId);
        result["status"] = "none";
        return result;
    }

    Json::Value result = buildSnapshot(bestTask);
    result["found"] = true;
    result["chat_id"] = std::string(chatId);
    return result;
}

Json::Value TaskManager::listTasks() const {
    std::vector<std::shared_ptr<GenerationTask>> tasks;
    {
        std::lock_guard<std::mutex> lock(mutex_);
        for (const auto& [id, task] : tasks_) {
            tasks.push_back(task);
        }
    }

    Json::Value result(Json::arrayValue);
    for (const auto& task : tasks) {
        result.append(buildSnapshot(task));
    }
    return result;
}

void TaskManager::setTaskStatus(std::string_view taskId, TaskStatus status) {
    auto task = findTask(taskId);
    if (!task) {
        return;
    }

    std::lock_guard<std::mutex> lock(task->mutex);
    task->status = status;
    task->updated = std::chrono::steady_clock::now();
}

void TaskManager::cancelTask(std::string_view taskId) {
    const std::string id(taskId);
    if (id.empty()) {
        return;
    }

    std::shared_ptr<GenerationTask> task;
    {
        std::lock_guard<std::mutex> lock(mutex_);
        const auto it = tasks_.find(id);
        if (it == tasks_.end()) {
            preCancelledTasks_[id] = std::chrono::steady_clock::now();
            return;
        }
        task = it->second;
    }

    task->cancelled.store(true);
    std::lock_guard<std::mutex> taskLock(task->mutex);
    if (task->status == TaskStatus::Pending ||
        task->status == TaskStatus::Running ||
        task->status == TaskStatus::WaitingApproval) {
        task->status = TaskStatus::Cancelled;
        task->updated = std::chrono::steady_clock::now();
    }
}

void TaskManager::cancelAllTasks() {
    std::vector<std::shared_ptr<GenerationTask>> tasks;
    {
        std::lock_guard<std::mutex> lock(mutex_);
        for (const auto& [id, task] : tasks_) {
            tasks.push_back(task);
        }
    }

    const auto now = std::chrono::steady_clock::now();
    for (const auto& task : tasks) {
        task->cancelled.store(true);
        std::lock_guard<std::mutex> taskLock(task->mutex);
        if (task->status == TaskStatus::Pending ||
            task->status == TaskStatus::Running ||
            task->status == TaskStatus::WaitingApproval) {
            task->status = TaskStatus::Cancelled;
            task->updated = now;
        }
    }
}

void TaskManager::waitForAllTasks(int timeoutMs) {
    std::vector<std::shared_ptr<std::future<void>>> futures;
    {
        std::lock_guard<std::mutex> lock(mutex_);
        futures.reserve(tasks_.size());
        for (const auto& [id, task] : tasks_) {
            if (!task) {
                continue;
            }
            std::lock_guard<std::mutex> taskLock(task->mutex);
            if (task->workerFuture) {
                futures.push_back(task->workerFuture);
            }
        }
    }

    const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(std::max(timeoutMs, 0));
    for (const auto& future : futures) {
        if (!future) {
            continue;
        }

        const auto now = std::chrono::steady_clock::now();
        const auto remaining = deadline > now ? deadline - now : std::chrono::milliseconds(0);
        if (future->wait_for(remaining) != std::future_status::ready) {
            continue;
        }

        try {
            future->get();
        } catch (...) {
        }
    }
}

void TaskManager::cleanupOldTasks(int maxAgeSeconds) {
    const auto now = std::chrono::steady_clock::now();

    std::lock_guard<std::mutex> lock(mutex_);
    for (auto it = tasks_.begin(); it != tasks_.end();) {
        const auto& task = it->second;
        const auto age = std::chrono::duration_cast<std::chrono::seconds>(now - task->updated).count();
        const bool isTerminal =
            task->status == TaskStatus::Completed ||
            task->status == TaskStatus::Cancelled ||
            task->status == TaskStatus::Failed;
        if (isTerminal && age > maxAgeSeconds) {
            it = tasks_.erase(it);
        } else {
            ++it;
        }
    }

    for (auto it = preCancelledTasks_.begin(); it != preCancelledTasks_.end();) {
        const auto age = std::chrono::duration_cast<std::chrono::seconds>(now - it->second).count();
        if (age > maxAgeSeconds) {
            it = preCancelledTasks_.erase(it);
        } else {
            ++it;
        }
    }
}

void handleTaskSubmit(
    const httplib::Request& req,
    httplib::Response& res,
    LmStudioService& lmstudioService,
    LlamaCppService* llamaCppService,
    McpRegistry* registry,
    ChatStore* chatStore,
    ToolSystem* toolSystem) {
    Json::Value body;
    if (!parseJsonBody(req.body, body, res)) {
        return;
    }

    if (!body.isMember("model") || !body.isMember("prompt")) {
        setJsonError(res, 400, "Missing required fields: model, prompt");
        return;
    }

    Json::Value request(Json::objectValue);
    request["model"] = body["model"];
    request["prompt"] = body["prompt"];
    request["max_tokens"] = body.get("max_tokens", 8192);
    request["system_prompt"] = body.get("system_prompt", "");
    request["temperature"] = body.get("temperature", -1.0);
    request["context_window"] = body.get("context_window", 0);
    request["logprobs"] = body.get("logprobs", false);
    request["revision_mode"] = body.get("revision_mode", false);

    if (body.isMember("task_id") && body["task_id"].isString() && !body["task_id"].asString().empty()) {
        request["task_id"] = body["task_id"];
    }
    if (body.isMember("messages") && body["messages"].isArray()) {
        request["messages"] = body["messages"];
    }
    if (body.isMember("tools") && body["tools"].isArray()) {
        request["tools"] = body["tools"];
    }
    if (body.isMember("tool_scope") && body["tool_scope"].isObject()) {
        request["tool_scope"] = body["tool_scope"];
    }
    if (body.isMember("chat_id") && body["chat_id"].isString() && !body["chat_id"].asString().empty()) {
        request["chat_id"] = body["chat_id"];
    }
    if (body.isMember("parent_user_node_id") && body["parent_user_node_id"].isString() &&
        !body["parent_user_node_id"].asString().empty()) {
        request["parent_user_node_id"] = body["parent_user_node_id"];
    }

    Json::Value tools = request.isMember("tools") ? request["tools"] : Json::Value(Json::arrayValue);
    request["tools"] = tools;

    const bool isLlamaCpp = request.get("model", "").asString().rfind("llamacpp::", 0) == 0;
    if (isLlamaCpp) {
        if (!llamaCppService) {
            setJsonError(res, 503, "llama.cpp service not available");
            return;
        }
    }

    auto [taskId, task] = TaskManager::instance().createTask(request);
    if (!task || task->cancelled.load()) {
        Json::Value result(Json::objectValue);
        result["task_id"] = taskId;
        result["status"] = "cancelled";
        setJson(res, result, 202);
        return;
    }

    const bool hasPrebuiltMessages =
        request.isMember("messages") && request["messages"].isArray() && !request["messages"].empty();

    if (toolSystem) {
        ToolSystem::SessionOptions sessionOptions;
        sessionOptions.taskId = taskId;
        sessionOptions.chatId = request.get("chat_id", "").asString();
        sessionOptions.toolScope = request.get("tool_scope", Json::Value(Json::objectValue));
        sessionOptions.legacyTools = tools;
        // Scripted revision mode emits its own draft-editor events. Keep the
        // model-facing session on normal tools so real tool calls still execute.
        sessionOptions.revisionMode = false;
        sessionOptions.onStatusChange = [taskId](const std::string& status) {
            if (status == "waiting_approval") {
                TaskManager::instance().setTaskStatus(taskId, TaskStatus::WaitingApproval);
            } else if (status == "running") {
                TaskManager::instance().setTaskStatus(taskId, TaskStatus::Running);
            }
        };
        toolSystem->beginTaskSession(sessionOptions);
    }

    auto future = std::async(
        std::launch::async,
        [task, &lmstudioService, toolSystem, chatStore, llamaCppService, isLlamaCpp, hasPrebuiltMessages, tools]() mutable {
            struct FinalizeGuard {
                std::shared_ptr<GenerationTask> task;
                ToolSystem* toolSystem = nullptr;

                ~FinalizeGuard() {
                    if (toolSystem && task) {
                        toolSystem->endTaskSession(task->id);
                    }
                    if (task) {
                        task->finalized.store(true);
                    }
                }
            } finalizeGuard{task, toolSystem};

            auto onChunk = [task](const std::string& chunk) -> bool {
                if (task->cancelled.load()) {
                    return false;
                }

                if (!chunk.empty()) {
                    std::lock_guard<std::mutex> lock(task->mutex);
                    task->chunks.push_back(chunk);
                    task->updated = std::chrono::steady_clock::now();
                }
                return !task->cancelled.load();
            };

            auto onError = [task](const std::string& error) {
                if (task->cancelled.load()) {
                    return;
                }
                std::lock_guard<std::mutex> lock(task->mutex);
                task->error = error;
                task->status = TaskStatus::Failed;
                task->updated = std::chrono::steady_clock::now();
            };

            auto cancelCheck = [task]() {
                return task->cancelled.load();
            };

            const std::string model = task->request.get("model", "").asString();
            const std::string prompt = task->request.get("prompt", "").asString();
            const int maxTokens = task->request.get("max_tokens", 8192).asInt();
            const std::string systemPrompt = task->request.get("system_prompt", "").asString();
            const double temperature = task->request.get("temperature", -1.0).asDouble();
            const int contextWindow = task->request.get("context_window", 0).asInt();
            const bool emitLogprobs = task->request.get("logprobs", false).asBool();
            const bool revisionMode = task->request.get("revision_mode", false).asBool();

            try {
                if (isLlamaCpp) {
                    Json::Value messages = hasPrebuiltMessages
                        ? mergeSystemPromptIntoMessages(task->request["messages"], systemPrompt)
                        : llamaCppService->buildMessages(prompt, systemPrompt);
                    if (revisionMode) {
                        MessageStreamer streamMessages =
                            [llamaCppService, toolSystem, taskId = task->id, tools, &model, temperature, contextWindow, &cancelCheck](
                                const Json::Value& phaseMessages,
                                int phaseMaxTokens,
                                std::function<bool(const std::string&)> phaseOnChunk,
                                std::function<void(const std::string&)> phaseOnError) {
                                if (toolSystem || (tools.isArray() && !tools.empty())) {
                                    llamaCppService->streamingChatWithTools(
                                        model,
                                        phaseMessages,
                                        tools,
                                        taskId,
                                        phaseMaxTokens,
                                        std::move(phaseOnChunk),
                                        std::move(phaseOnError),
                                        toolSystem,
                                        temperature,
                                        contextWindow,
                                        cancelCheck,
                                        false);
                                } else {
                                    llamaCppService->streamingMessagesWithCallback(
                                        model,
                                        phaseMessages,
                                        phaseMaxTokens,
                                        std::move(phaseOnChunk),
                                        std::move(phaseOnError),
                                        temperature,
                                        contextWindow,
                                        cancelCheck,
                                        false);
                                }
                            };
                        runScriptedRevisionFlow(
                            task->id,
                            messages,
                            maxTokens,
                            onChunk,
                            onError,
                            cancelCheck,
                            streamMessages);
                    } else {
                        llamaCppService->streamingChatWithTools(
                            model,
                            messages,
                            tools,
                            task->id,
                            maxTokens,
                            onChunk,
                            onError,
                            toolSystem,
                            temperature,
                            contextWindow,
                            cancelCheck,
                            emitLogprobs);
                    }
                } else {
                    const bool useTools = tools.isArray() && !tools.empty();
                    if (revisionMode) {
                        Json::Value messages = hasPrebuiltMessages
                            ? mergeSystemPromptIntoMessages(task->request["messages"], systemPrompt)
                            : lmstudioService.buildMessages(prompt, systemPrompt);
                        MessageStreamer streamMessages =
                            [&lmstudioService, toolSystem, taskId = task->id, tools, &model, temperature, contextWindow, &cancelCheck](
                                const Json::Value& phaseMessages,
                                int phaseMaxTokens,
                                std::function<bool(const std::string&)> phaseOnChunk,
                                std::function<void(const std::string&)> phaseOnError) {
                                if (toolSystem || (tools.isArray() && !tools.empty())) {
                                    lmstudioService.streamingChatWithTools(
                                        model,
                                        phaseMessages,
                                        tools,
                                        taskId,
                                        phaseMaxTokens,
                                        std::move(phaseOnChunk),
                                        std::move(phaseOnError),
                                        toolSystem,
                                        temperature,
                                        contextWindow,
                                        cancelCheck,
                                        false);
                                } else {
                                    lmstudioService.streamingMessagesWithCallback(
                                        model,
                                        phaseMessages,
                                        phaseMaxTokens,
                                        std::move(phaseOnChunk),
                                        std::move(phaseOnError),
                                        temperature,
                                        contextWindow,
                                        cancelCheck,
                                        false);
                                }
                            };
                        runScriptedRevisionFlow(
                            task->id,
                            messages,
                            maxTokens,
                            onChunk,
                            onError,
                            cancelCheck,
                            streamMessages);
                    } else if (toolSystem || useTools || hasPrebuiltMessages) {
                        Json::Value messages = hasPrebuiltMessages
                            ? mergeSystemPromptIntoMessages(task->request["messages"], systemPrompt)
                            : lmstudioService.buildMessages(prompt, systemPrompt);

                        lmstudioService.streamingChatWithTools(
                            model,
                            messages,
                            tools,
                            task->id,
                            maxTokens,
                            onChunk,
                            onError,
                            toolSystem,
                            temperature,
                            contextWindow,
                            cancelCheck,
                            emitLogprobs);
                    } else {
                        lmstudioService.streamingChatWithCallback(
                            model,
                            prompt,
                            maxTokens,
                            onChunk,
                            onError,
                            systemPrompt,
                            temperature,
                            contextWindow,
                            cancelCheck,
                            emitLogprobs);
                    }
                }
            } catch (const std::exception& exception) {
                onError(exception.what());
            } catch (...) {
                onError("Generation failed");
            }

            std::deque<std::string> chunkCopy;
            {
                std::lock_guard<std::mutex> lock(task->mutex);
                chunkCopy = task->chunks;
            }

            const ParsedTaskOutput output = parseTaskOutput(chunkCopy);
            saveParsedOutputToTask(task, output);
            persistParsedOutputToChat(chatStore, task, output);

            std::lock_guard<std::mutex> lock(task->mutex);
            if (task->cancelled.load()) {
                task->status = TaskStatus::Cancelled;
            } else if (task->status == TaskStatus::Pending ||
                       task->status == TaskStatus::Running ||
                       task->status == TaskStatus::WaitingApproval) {
                task->status = TaskStatus::Completed;
            }
            task->updated = std::chrono::steady_clock::now();
        });

    TaskManager::instance().startTask(task, std::move(future));

    Json::Value result(Json::objectValue);
    result["task_id"] = taskId;
    result["status"] = "pending";
    setJson(res, result, 202);
}

void handleTaskStatus(const httplib::Request&, httplib::Response& res, const std::string& taskId) {
    if (taskId.empty()) {
        setJsonError(res, 400, "Missing task ID");
        return;
    }

    if (!TaskManager::instance().findTask(taskId)) {
        setJsonError(res, 404, "Task not found");
        return;
    }

    Json::Value status = TaskManager::instance().getTaskStatus(taskId);
    setJson(res, status);
}

void handleTaskWait(const httplib::Request&, httplib::Response& res, const std::string& taskId) {
    if (taskId.empty()) {
        setJsonError(res, 400, "Missing task ID");
        return;
    }

    for (int attempt = 0; attempt < 3000; ++attempt) {
        if (isAppShutdownRequested()) {
            setJsonError(res, 503, "Application shutdown in progress");
            return;
        }

        auto task = TaskManager::instance().findTask(taskId);
        if (!task) {
            setJsonError(res, 404, "Task not found");
            return;
        }

        Json::Value snapshot = TaskManager::instance().getTaskStatus(taskId);
        const std::string status = snapshot.get("status", "").asString();
        if (status == "completed" || status == "failed" || status == "cancelled") {
            Json::Value result(Json::objectValue);
            result["status"] = status;
            if (snapshot.isMember("result")) {
                result["result"] = snapshot["result"];
            }
            if (snapshot.isMember("error") && !snapshot["error"].asString().empty()) {
                result["error"] = snapshot["error"];
            }
            setJson(res, result);
            return;
        }

        std::this_thread::sleep_for(std::chrono::milliseconds(200));
    }

    setJsonError(res, 408, "Task timeout");
}

void handleTaskStream(const httplib::Request& req, httplib::Response& res, const std::string& taskId) {
    if (taskId.empty()) {
        setJsonError(res, 400, "Missing task ID");
        return;
    }

    auto task = TaskManager::instance().findTask(taskId);
    if (!task) {
        setJsonError(res, 404, "Task not found");
        return;
    }

    std::size_t resumeOffset = 0;
    if (req.has_header("X-Chunk-Offset")) {
        try {
            resumeOffset = std::stoull(req.get_header_value("X-Chunk-Offset"));
        } catch (...) {
            resumeOffset = 0;
        }
    }

    res.set_header("Cache-Control", "no-cache");
    res.set_header("Connection", "keep-alive");
    res.set_content_provider(
        "text/event-stream",
        [task, offset = resumeOffset](std::size_t, httplib::DataSink& sink) mutable -> bool {
            if (isAppShutdownRequested()) {
                sink.done();
                return false;
            }

            std::string payload;
            bool done = false;

            {
                std::lock_guard<std::mutex> lock(task->mutex);
                std::size_t index = 0;
                for (const auto& chunk : task->chunks) {
                    if (index >= offset) {
                        payload += chunk;
                    }
                    ++index;
                }
                offset = task->chunks.size();
                done = task->finalized.load();
            }

            if (!payload.empty()) {
                if (!sink.write(payload.data(), payload.size())) {
                    return false;
                }
                sink.os.flush();
            } else if (!done) {
                if (!sink.write(":\n\n", 3)) {
                    return false;
                }
                sink.os.flush();
            }

            if (done) {
                sink.done();
                return false;
            }

            std::this_thread::sleep_for(std::chrono::milliseconds(10));
            return true;
        });
}

void handleTaskCancel(const httplib::Request&, httplib::Response& res, const std::string& taskId) {
    if (taskId.empty()) {
        setJsonError(res, 400, "Missing task ID");
        return;
    }

    TaskManager::instance().cancelTask(taskId);
    Json::Value result(Json::objectValue);
    result["status"] = "cancelled";
    result["task_id"] = taskId;
    setJson(res, result);
}

void handleTaskList(const httplib::Request&, httplib::Response& res) {
    Json::Value result(Json::objectValue);
    result["tasks"] = TaskManager::instance().listTasks();
    setJson(res, result);
}

void handleTaskByChat(const httplib::Request& req, httplib::Response& res) {
    std::string chatId;
    if (req.matches.size() > 1) {
        chatId = req.matches[1];
    } else if (req.has_param("chat_id")) {
        chatId = req.get_param_value("chat_id");
    }

    if (chatId.empty()) {
        setJsonError(res, 400, "Missing chat_id");
        return;
    }

    Json::Value result = TaskManager::instance().getTaskByChat(chatId);
    setJson(res, result);
}
