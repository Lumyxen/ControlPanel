#include "server/api_routes.h"

#include <algorithm>
#include <deque>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <sstream>
#include <thread>

#include "config/config.h"
#include "controllers/auth_controller.h"
#include "controllers/chat_controller.h"
#include "controllers/config_controller.h"
#include "controllers/generation_task_manager.h"
#include "controllers/lmstudio_controller.h"
#include "controllers/mcp_controller.h"
#include "server/http_utils.h"
#include "services/backend_builder.h"
#include "services/huggingface_service.h"
#include "services/llamacpp_service.h"
#include "services/lmstudio_service.h"
#include "services/mcp_registry.h"
#include "services/mcp_service.h"
#include "services/tools/tool_system.h"

namespace fs = std::filesystem;

void registerApiRoutes(httplib::Server& svr, ApiRouteContext& ctx) {
    auto applyHeaders = [](const httplib::Request& req, httplib::Response& res) {
        addSecurityHeaders(res);
        addCorsHeaders(res, req);
    };

    auto parsePackScope = [](const httplib::Request& req) {
        Json::Value scope(Json::objectValue);
        scope["enabledPackIds"] = Json::Value(Json::arrayValue);
        if (!req.has_param("enabled_pack_ids")) {
            return scope;
        }

        std::stringstream stream(req.get_param_value("enabled_pack_ids"));
        std::string item;
        while (std::getline(stream, item, ',')) {
            if (!item.empty()) {
                scope["enabledPackIds"].append(item);
            }
        }
        return scope;
    };

    auto setBuildProgressJson = [](Json::Value& result,
                                   const std::string& stage,
                                   const std::string& stageLabel,
                                   int stageIndex,
                                   int stageCount,
                                   int stagePercent,
                                   int overallPercent,
                                   bool determinate) {
        result["stage"] = stage;
        result["stageLabel"] = stageLabel;
        result["stageIndex"] = stageIndex;
        result["stageCount"] = stageCount;
        result["stagePercent"] = stagePercent;
        result["overallPercent"] = overallPercent;
        result["determinate"] = determinate;
    };

    svr.Get("/api/llamacpp/backend", [&](const httplib::Request& req, httplib::Response& res) {
        applyHeaders(req, res);

        const auto availableBackends = LlamaCppService::listAvailableBackends(ctx.libsDir);
        const std::string configuredBackend = ctx.config.getLlamacppBackend();
        const std::string resolvedBackend =
            LlamaCppService::resolveBackendPreference(configuredBackend, availableBackends);
        const LlamaServerStatus serverStatus = ctx.llamaCppService
            ? ctx.llamaCppService->getServerStatus()
            : LlamaServerStatus{};

        Json::Value result;
        result["active"] = !serverStatus.activeBackend.empty() ? serverStatus.activeBackend : resolvedBackend;
        result["setting"] = configuredBackend;
        result["dismissed"] = ctx.config.getBackendSuggestionDismissed();
        result["modelReady"] = serverStatus.ready;
        result["tag"] = ctx.config.getLlamacppTag();

        Json::Value allArr(Json::arrayValue);
        for (const char* b : {"cpu", "cuda", "rocm", "vulkan"}) allArr.append(b);
        result["all"] = allArr;

        Json::Value availArr(Json::arrayValue);
        for (const auto& b : availableBackends) availArr.append(b);
        result["available"] = availArr;

        if (configuredBackend != "auto") {
            if (std::find(availableBackends.begin(), availableBackends.end(), configuredBackend) == availableBackends.end()) {
                result["settingValid"] = false;
                result["setting"] = "auto";
            } else {
                result["settingValid"] = true;
            }
        } else {
            result["settingValid"] = true;
        }

        Json::Value hwArr(Json::arrayValue);
        for (const auto& b : LlamaCppService::detectHardwareBackends()) hwArr.append(b);
        result["hardware"] = hwArr;

        Json::Value suggest(Json::arrayValue);
        if (!ctx.config.getBackendSuggestionDismissed()) {
            const bool hasVendor =
                std::find(availableBackends.begin(), availableBackends.end(), "cuda") != availableBackends.end() ||
                std::find(availableBackends.begin(), availableBackends.end(), "rocm") != availableBackends.end();
            for (const auto& h : hwArr) {
                const std::string b = h.asString();
                if (b == "cpu") continue;
                if (std::find(availableBackends.begin(), availableBackends.end(), b) != availableBackends.end()) continue;
                if (b == "vulkan" && hasVendor) continue;
                suggest.append(b);
            }
        }
        result["suggest"] = suggest;

        Json::Value prereqs(Json::objectValue);
        for (const char* b : {"cuda", "rocm", "vulkan"}) {
            const std::string err = BackendBuilder::checkPrerequisites(b);
            if (!err.empty()) prereqs[b] = err;
        }
        result["prereqs"] = prereqs;
        setJson(res, result);
    });

    svr.Post("/api/llamacpp/backend", [&](const httplib::Request& req, httplib::Response& res) {
        applyHeaders(req, res);
        Json::Value body;
        if (!parseJsonBody(req.body, body, res)) return;

        const std::string backend = body.get("backend", "auto").asString();
        if (!ctx.llamaCppService) {
            res.status = 503;
            res.set_content("{\"error\":\"llama.cpp service unavailable\"}", "application/json");
            return;
        }

        if (backend != "auto") {
            const auto avail = ctx.llamaCppService->availableBackends();
            if (std::find(avail.begin(), avail.end(), backend) == avail.end()) {
                res.status = 404;
                res.set_content("{\"error\":\"Backend '" + backend + "' is not built/available\"}", "application/json");
                return;
            }
        }

        Json::Value patch;
        patch["llamacppBackend"] = backend;
        ctx.config.updateFromJson(patch);

        const std::string resolved = ctx.llamaCppService->resolveBackend(backend);
        std::cout << "[Backend] Switch requested: " << backend << " → " << resolved << "\n";
        const bool ok = ctx.llamaCppService->switchBackend(resolved);

        Json::Value result;
        result["success"] = ok;
        result["active"] = ctx.llamaCppService->getActiveBackend();
        if (!ok) result["error"] = "Backend switch failed — check logs";
        setJson(res, result);
    });

    svr.Delete(R"(/api/llamacpp/backend/([^/]+))", [&](const httplib::Request& req, httplib::Response& res) {
        applyHeaders(req, res);

        const std::string backend = req.matches[1];
        if (backend != "cpu" && backend != "cuda" && backend != "rocm" && backend != "vulkan") {
            res.status = 400;
            res.set_content("{\"error\":\"backend must be cpu|cuda|rocm|vulkan\"}", "application/json");
            return;
        }

        const fs::path backendDir = fs::path(ctx.libsDir) / backend;
        if (!fs::exists(backendDir)) {
            res.status = 404;
            res.set_content("{\"error\":\"Backend runtime not found\"}", "application/json");
            return;
        }

        if (ctx.llamaCppService && ctx.llamaCppService->getActiveBackend() == backend) {
            std::cout << "[Backend] Removing active backend '" << backend << "'\n";
            ctx.llamaCppService->unloadLib();
        }

        std::vector<std::string> removed;
        std::error_code removeError;
        fs::remove_all(backendDir, removeError);
        if (removeError) {
            res.status = 500;
            res.set_content("{\"error\":\"Failed to remove backend runtime\"}", "application/json");
            return;
        }
        removed.push_back((fs::path(backend) / "llama-server").string());

        if (ctx.config.getLlamacppBackend() == backend) {
            Json::Value patch;
            patch["llamacppBackend"] = "auto";
            ctx.config.updateFromJson(patch);
            if (ctx.llamaCppService) {
                ctx.llamaCppService->markConfigDirty();
                const std::string resolved = ctx.llamaCppService->resolveBackend("auto");
                if (resolved != "none") {
                    ctx.llamaCppService->switchBackend(resolved);
                }
            }
        }

        std::cout << "[Backend] Removed: " << backend << " (" << removed.size() << " files)\n";

        Json::Value result;
        result["success"] = true;
        result["removed"] = Json::Value(Json::arrayValue);
        for (const auto& file : removed) result["removed"].append(file);
        result["active"] = ctx.llamaCppService ? ctx.llamaCppService->getActiveBackend() : "none";
        setJson(res, result);
    });

    svr.Post("/api/llamacpp/reload-model", [&](const httplib::Request& req, httplib::Response& res) {
        applyHeaders(req, res);
        if (!ctx.llamaCppService) {
            res.status = 503;
            res.set_content("{\"error\":\"llama.cpp service unavailable\"}", "application/json");
            return;
        }

        ctx.config.load();
        ctx.llamaCppService->markConfigDirty();
        const bool ok = ctx.llamaCppService->reloadModel();
        Json::Value result;
        result["success"] = ok;
        result["modelId"] = ctx.llamaCppService->getLoadedModelId();
        result["backend"] = ctx.llamaCppService->getActiveBackend();
        result["ready"] = ctx.llamaCppService->isReady();
        result["deferred"] = ok && !result["ready"].asBool();
        setJson(res, result);
    });

    svr.Post("/api/llamacpp/build", [&](const httplib::Request& req, httplib::Response& res) {
        applyHeaders(req, res);
        Json::Value body;
        if (!parseJsonBody(req.body, body, res)) return;

        const std::string backend = body.get("backend", "").asString();
        if (backend != "cpu" && backend != "cuda" && backend != "rocm" && backend != "vulkan") {
            res.status = 400;
            res.set_content("{\"error\":\"backend must be cpu|cuda|rocm|vulkan\"}", "application/json");
            return;
        }

        const std::string tag = (body.isMember("tag") && !body["tag"].asString().empty())
            ? body["tag"].asString() : ctx.config.getLlamacppTag();

        const std::string prereqErr = BackendBuilder::checkPrerequisites(backend);
        if (!prereqErr.empty()) {
            Json::Value result;
            result["error"] = prereqErr;
            res.status = 422;
            setJson(res, result);
            return;
        }

        {
            std::lock_guard<std::mutex> lock(ctx.buildState.mutex);
            if (ctx.buildState.running) {
                Json::Value result;
                result["error"] = "A build is already running for: " + ctx.buildState.backend;
                res.status = 409;
                setJson(res, result);
                return;
            }
            ctx.buildState.running = true;
            ctx.buildState.done = false;
            ctx.buildState.success = false;
            ctx.buildState.backend = backend;
            ctx.buildState.logPath = (fs::path(ctx.dataDir) / "logs" / ("build_" + backend + ".log")).string();
            ctx.buildState.stage = "prepare";
            ctx.buildState.stageLabel = "Preparing build";
            ctx.buildState.stageIndex = 1;
            ctx.buildState.stageCount = kBackendBuildStageCount;
            ctx.buildState.stagePercent = -1;
            ctx.buildState.overallPercent = 0;
            ctx.buildState.stageDeterminate = false;
        }

        BuildState* buildState = &ctx.buildState;
        const std::string libsDir = ctx.libsDir;
        const std::string buildCacheDir = ctx.buildCacheDir;
        const std::string dataDir = ctx.dataDir;
        std::thread([backend, tag, libsDir, buildCacheDir, dataDir, buildState]() {
            const auto applyProgress = [buildState](const BackendBuildProgress& progress) {
                std::lock_guard<std::mutex> lock(buildState->mutex);
                buildState->stage = progress.stage;
                buildState->stageLabel = progress.stageLabel;
                buildState->stageIndex = progress.stageIndex;
                buildState->stageCount = progress.stageCount;
                buildState->stagePercent = progress.stagePercent;
                buildState->overallPercent = progress.overallPercent;
                buildState->stageDeterminate = progress.determinate;
            };

            try {
                fs::create_directories(fs::path(dataDir) / "logs");
                const std::string logPath = (fs::path(dataDir) / "logs" / ("build_" + backend + ".log")).string();
                std::cout << "[BackendBuild] Starting: " << backend << " (tag " << tag << ")\n";
                const int ret = BackendBuilder::build(backend, libsDir, buildCacheDir, logPath, tag, applyProgress);
                std::lock_guard<std::mutex> lock(buildState->mutex);
                buildState->running = false;
                buildState->done = true;
                buildState->success = (ret == 0);
                if (ret == 0) {
                    buildState->stage = "complete";
                    buildState->stageLabel = "Build complete";
                    buildState->stageIndex = kBackendBuildStageCount;
                    buildState->stageCount = kBackendBuildStageCount;
                    buildState->stagePercent = 100;
                    buildState->overallPercent = 100;
                    buildState->stageDeterminate = true;
                }
                std::cout << "[BackendBuild] " << backend << (ret == 0 ? " succeeded" : " FAILED") << "\n";
            } catch (const std::exception& e) {
                std::lock_guard<std::mutex> lock(buildState->mutex);
                buildState->running = false;
                buildState->done = true;
                buildState->success = false;
                buildState->stageDeterminate = false;
                std::cerr << "[BackendBuild] Exception: " << e.what() << "\n";
            } catch (...) {
                std::lock_guard<std::mutex> lock(buildState->mutex);
                buildState->running = false;
                buildState->done = true;
                buildState->success = false;
                buildState->stageDeterminate = false;
                std::cerr << "[BackendBuild] Unknown exception\n";
            }
        }).detach();

        Json::Value result;
        result["started"] = true;
        result["backend"] = backend;
        result["tag"] = tag;
        result["logPath"] = ctx.buildState.logPath;
        setJson(res, result);
    });

    svr.Get("/api/llamacpp/build/status", [&](const httplib::Request& req, httplib::Response& res) {
        applyHeaders(req, res);
        std::lock_guard<std::mutex> lock(ctx.buildState.mutex);
        Json::Value result;
        result["running"] = ctx.buildState.running;
        result["done"] = ctx.buildState.done;
        result["success"] = ctx.buildState.success;
        result["backend"] = ctx.buildState.backend;
        result["logPath"] = ctx.buildState.logPath;
        setBuildProgressJson(
            result,
            ctx.buildState.stage,
            ctx.buildState.stageLabel,
            ctx.buildState.stageIndex,
            ctx.buildState.stageCount,
            ctx.buildState.stagePercent,
            ctx.buildState.overallPercent,
            ctx.buildState.stageDeterminate);
        setJson(res, result);
    });

    svr.Get("/api/llamacpp/build/log", [&](const httplib::Request& req, httplib::Response& res) {
        applyHeaders(req, res);

        std::string logPath;
        std::string stage;
        std::string stageLabel;
        int stageIndex = 0;
        int stageCount = 0;
        int stagePercent = -1;
        int overallPercent = 0;
        bool determinate = false;
        {
            std::lock_guard<std::mutex> lock(ctx.buildState.mutex);
            logPath = ctx.buildState.logPath;
            stage = ctx.buildState.stage;
            stageLabel = ctx.buildState.stageLabel;
            stageIndex = ctx.buildState.stageIndex;
            stageCount = ctx.buildState.stageCount;
            stagePercent = ctx.buildState.stagePercent;
            overallPercent = ctx.buildState.overallPercent;
            determinate = ctx.buildState.stageDeterminate;
        }

        int nLines = 80;
        if (req.has_param("lines")) {
            try { nLines = std::min(500, std::stoi(req.get_param_value("lines"))); } catch (...) {}
        }

        std::uintmax_t offset = 0;
        if (req.has_param("offset")) {
            try {
                const long long parsed = std::stoll(req.get_param_value("offset"));
                if (parsed > 0) {
                    offset = static_cast<std::uintmax_t>(parsed);
                }
            } catch (...) {}
        }

        Json::Value result;
        result["logPath"] = logPath;
        result["chunk"] = "";
        result["nextOffset"] = Json::Value(static_cast<Json::UInt64>(0));
        result["reset"] = false;
        setBuildProgressJson(result, stage, stageLabel, stageIndex, stageCount, stagePercent, overallPercent, determinate);

        if (logPath.empty() || !fs::exists(logPath)) {
            result["lines"] = Json::Value(Json::arrayValue);
            result["percent"] = -1;
            setJson(res, result);
            return;
        }

        const std::uintmax_t fileSize = fs::file_size(logPath);
        const bool reset = offset > fileSize;
        const std::uintmax_t effectiveOffset = reset ? 0 : offset;
        result["reset"] = reset;
        result["nextOffset"] = Json::Value(static_cast<Json::UInt64>(fileSize));

        std::ifstream chunkFile(logPath, std::ios::binary);
        if (chunkFile) {
            chunkFile.seekg(static_cast<std::streamoff>(effectiveOffset), std::ios::beg);
            std::ostringstream chunkStream;
            chunkStream << chunkFile.rdbuf();
            result["chunk"] = chunkStream.str();
        }

        std::ifstream file(logPath);
        std::deque<std::string> window;
        std::string line;
        int percent = -1;

        while (std::getline(file, line)) {
            window.push_back(line);
            if (static_cast<int>(window.size()) > nLines) window.pop_front();

            auto bracket = line.find('[');
            auto pct = line.find('%');
            if (bracket != std::string::npos && pct != std::string::npos && pct > bracket) {
                try {
                    int parsed = std::stoi(line.substr(bracket + 1, pct - bracket - 1));
                    if (parsed >= 0 && parsed <= 100) percent = parsed;
                } catch (...) {}
            }
        }

        Json::Value lines(Json::arrayValue);
        for (const auto& entry : window) lines.append(entry);

        result["lines"] = lines;
        result["percent"] = percent;
        setJson(res, result);
    });

    svr.Post("/api/llamacpp/backend/dismiss", [&](const httplib::Request& req, httplib::Response& res) {
        applyHeaders(req, res);
        Json::Value patch;
        patch["backendSuggestionDismissed"] = true;
        ctx.config.updateFromJson(patch);
        res.set_content("{\"ok\":true}", "application/json");
    });

    svr.Get("/api/llamacpp/pool/status", [&](const httplib::Request& req, httplib::Response& res) {
        applyHeaders(req, res);

        Json::Value result;
        if (ctx.llamaCppService) {
            const auto status = ctx.llamaCppService->getServerStatus();
            result["running"] = status.running;
            result["ready"] = status.ready;
            result["backend"] = status.activeBackend;
            result["pid"] = status.pid;
            result["parallel_slots"] = status.parallelSlots;
            result["max_loaded_models"] = status.maxLoadedModels;
            result["loaded_models"] = status.loadedModels;
            result["loaded_model_ids"] = status.loadedModelIds;
        } else {
            result["error"] = "Service not available";
        }
        setJson(res, result);
    });

    svr.Post("/api/chat", [&](const httplib::Request& req, httplib::Response& res) {
        applyHeaders(req, res);
        handleChat(req, res, ctx.lmstudioService);
    });

    svr.Post("/api/chat/token-count", [&](const httplib::Request& req, httplib::Response& res) {
        applyHeaders(req, res);
        handleTokenCount(req, res, ctx.lmstudioService, ctx.llamaCppService);
    });

    svr.Post("/api/chat/stream", [&](const httplib::Request& req, httplib::Response& res) {
        applyHeaders(req, res);
        handleStreaming(req, res, ctx.lmstudioService, &ctx.registry, &ctx.toolSystem, ctx.llamaCppService);
    });

    svr.Post("/api/chat/stop", [&](const httplib::Request& req, httplib::Response& res) {
        applyHeaders(req, res);
        handleStopStream(req, res);
    });

    svr.Post("/api/chat/generate-title", [&](const httplib::Request& req, httplib::Response& res) {
        applyHeaders(req, res);

        Json::Value body;
        if (!parseJsonBody(req.body, body, res)) return;

        std::string message = body.get("message", "").asString();
        if (message.empty()) {
            res.status = 400;
            res.set_content("{\"error\": \"Missing required field: message\"}", "application/json");
            return;
        }

        std::string model = body.get("model", "").asString();
        std::string systemPrompt = body.get("title_system_prompt", "").asString();
        if (systemPrompt.empty()) systemPrompt = body.get("system_prompt", "").asString();
        if (systemPrompt.empty()) systemPrompt = ctx.config.getAiTitleSystemPrompt();

        const bool isLlamaCpp = model.rfind("llamacpp::", 0) == 0;
        std::string title;

        try {
            if (isLlamaCpp) {
                if (!ctx.llamaCppService) {
                    res.status = 503;
                    res.set_content("{\"error\": \"llama.cpp service not available\"}", "application/json");
                    return;
                }
                title = ctx.llamaCppService->generateTitle(model, message, systemPrompt);
            } else {
                title = ctx.lmstudioService.generateTitle(model, message, systemPrompt);
            }
        } catch (const std::exception& e) {
            std::cerr << "[TitleGen] Error: " << e.what() << "\n";
            res.status = 500;
            res.set_content("{\"error\": \"Title generation failed\"}", "application/json");
            return;
        }

        if (title.empty()) {
            res.status = 500;
            res.set_content("{\"error\": \"Failed to generate title\"}", "application/json");
            return;
        }

        Json::Value result;
        result["title"] = title;
        setJson(res, result);
    });

    svr.Post("/api/tasks/generate", [&](const httplib::Request& req, httplib::Response& res) {
        applyHeaders(req, res);
        handleTaskSubmit(req, res, ctx.lmstudioService, ctx.llamaCppService, &ctx.registry, &ctx.chatStore, &ctx.toolSystem);
    });

    svr.Get("/api/tasks", [&](const httplib::Request& req, httplib::Response& res) {
        applyHeaders(req, res);
        handleTaskList(req, res);
    });

    svr.Get("/api/tasks/by-chat", [&](const httplib::Request& req, httplib::Response& res) {
        applyHeaders(req, res);
        handleTaskByChat(req, res);
    });

    auto handleTaskSubRoute = [&](const httplib::Request& req, httplib::Response& res) {
        applyHeaders(req, res);
        const std::string prefix = "/api/tasks/";
        std::string rest = req.path.substr(prefix.size());
        size_t slashPos = rest.find('/');
        std::string taskId = (slashPos == std::string::npos) ? rest : rest.substr(0, slashPos);
        std::string action = (slashPos == std::string::npos) ? "" : rest.substr(slashPos + 1);

        if (action == "wait" && req.method == "GET") {
            handleTaskWait(req, res, taskId);
        } else if (action == "stream" && req.method == "GET") {
            handleTaskStream(req, res, taskId);
        } else if (action == "cancel" && req.method == "POST") {
            handleTaskCancel(req, res, taskId);
        } else {
            handleTaskStatus(req, res, taskId);
        }
    };

    svr.Options(R"(/api/tasks/.*)", [&](const httplib::Request& req, httplib::Response& res) {
        applyHeaders(req, res);
        res.status = 200;
    });

    svr.Get(R"(/api/tasks/.*)", [&](const httplib::Request& req, httplib::Response& res) {
        handleTaskSubRoute(req, res);
    });

    svr.Post(R"(/api/tasks/.*)", [&](const httplib::Request& req, httplib::Response& res) {
        handleTaskSubRoute(req, res);
    });

    svr.Get("/api/models", [&](const httplib::Request& req, httplib::Response& res) {
        applyHeaders(req, res);
        handleModels(
            req,
            res,
            ctx.lmstudioService,
            ctx.modelsDir,
            ctx.config.getLlamacppCtxSize() > 0 ? ctx.config.getLlamacppCtxSize() : 65536,
            ctx.llamaCppService);
    });

    svr.Delete("/api/models", [&](const httplib::Request& req, httplib::Response& res) {
        applyHeaders(req, res);

        Json::CharReaderBuilder reader;
        Json::Value body;
        std::string errs;
        std::istringstream stream(req.body);
        if (!Json::parseFromStream(reader, stream, &body, &errs)) {
            res.status = 400;
            Json::Value err;
            err["error"] = "Invalid JSON";
            setJson(res, err);
            return;
        }

        std::string modelId = body.get("model_id", "").asString();
        if (modelId.empty()) {
            res.status = 400;
            Json::Value err;
            err["error"] = "Missing model_id";
            setJson(res, err);
            return;
        }

        Json::Value result;
        fs::path removePath;
        for (const auto& model : LlamaCppService::scanModelDirectory(
                 ctx.modelsDir,
                 ctx.config.getLlamacppCtxSize() > 0 ? ctx.config.getLlamacppCtxSize() : 65536)) {
            if (model.id != modelId) {
                continue;
            }
            const fs::path ggufPath(model.ggufPath);
            removePath = (ggufPath.parent_path() == fs::path(ctx.modelsDir)) ? ggufPath : ggufPath.parent_path();
            break;
        }

        if (removePath.empty() || !fs::exists(removePath)) {
            res.status = 404;
            result["status"] = "not_found";
            result["error"] = "Model path does not exist";
        } else {
            if (ctx.llamaCppService) {
                ctx.llamaCppService->unloadModel(modelId);
                ctx.llamaCppService->markConfigDirty();
            }

            std::error_code ec;
            if (fs::is_directory(removePath)) {
                fs::remove_all(removePath, ec);
            } else {
                fs::remove(removePath, ec);
            }
            if (ec) {
                res.status = 500;
                result["status"] = "error";
                result["error"] = ec.message();
            } else {
                result["status"] = "deleted";
                result["path"] = removePath.string();
                std::cout << "[ModelManager] Deleted model: " << modelId << "\n";
            }
        }

        setJson(res, result);
    });

    auto& hfService = *ctx.huggingFaceService;

    svr.Get("/api/huggingface/search", [&](const httplib::Request& req, httplib::Response& res) {
        applyHeaders(req, res);

        HfSearchFilters filters;
        filters.search = req.get_param_value("search");
        filters.author = req.get_param_value("author");
        filters.pipeline = req.get_param_value("pipeline");
        filters.limit = req.has_param("limit") ? std::stoi(req.get_param_value("limit")) : 20;
        filters.sort = req.get_param_value("sort");
        if (filters.sort.empty()) filters.sort = "downloads";
        filters.imageSupport = req.has_param("image_support");
        filters.audioSupport = req.has_param("audio_support");

        Json::Value result = hfService.searchModels(filters);
        setJson(res, result);
    });

    svr.Get("/api/huggingface/model-info", [&](const httplib::Request& req, httplib::Response& res) {
        applyHeaders(req, res);

        std::string modelId = req.get_param_value("model_id");
        if (modelId.empty()) {
            res.status = 400;
            Json::Value err;
            err["error"] = "Missing model_id parameter";
            setJson(res, err);
            return;
        }

        Json::Value result = hfService.getModelInfo(modelId);
        setJson(res, result);
    });

    svr.Get("/api/huggingface/files", [&](const httplib::Request& req, httplib::Response& res) {
        applyHeaders(req, res);

        std::string modelId = req.get_param_value("model_id");
        if (modelId.empty()) {
            res.status = 400;
            Json::Value err;
            err["error"] = "Missing model_id parameter";
            setJson(res, err);
            return;
        }

        auto allFiles = hfService.listModelFiles(modelId);
        Json::Value result;
        result["gguf"] = Json::Value(Json::arrayValue);
        result["mmproj"] = Json::Value(Json::arrayValue);
        result["tokenizer"] = Json::Value(Json::arrayValue);

        for (const auto& file : allFiles) {
            std::string fname = fs::path(file).filename().string();
            Json::Value entry;
            entry["path"] = file;
            entry["name"] = fname;

            if (fname.find("mmproj") != std::string::npos && fname.find(".gguf") != std::string::npos) {
                result["mmproj"].append(entry);
            } else if (fname.find(".gguf") != std::string::npos) {
                result["gguf"].append(entry);
            } else if (fname == "vocab.json" || fname.find(".tiktoken") != std::string::npos ||
                       fname == "tokenizer.json" || fname == "tokenizer_config.json") {
                result["tokenizer"].append(entry);
            }
        }

        setJson(res, result);
    });

    svr.Post("/api/huggingface/download", [&](const httplib::Request& req, httplib::Response& res) {
        applyHeaders(req, res);

        Json::CharReaderBuilder reader;
        Json::Value body;
        std::string errs;
        std::istringstream stream(req.body);
        if (!Json::parseFromStream(reader, stream, &body, &errs)) {
            res.status = 400;
            Json::Value err;
            err["error"] = "Invalid JSON: " + errs;
            setJson(res, err);
            return;
        }

        std::string modelId = body.get("model_id", "").asString();
        std::string dirName = body.get("directory_name", "").asString();
        std::string ggufPath = body.get("gguf_path", "").asString();
        std::string mmprojPath = body.get("mmproj_path", "").asString();
        std::string tokenizerPath = body.get("tokenizer_path", "").asString();

        if (modelId.empty()) {
            res.status = 400;
            Json::Value err;
            err["error"] = "Missing model_id";
            setJson(res, err);
            return;
        }

        if (dirName.empty()) {
            size_t slashPos = modelId.find('/');
            std::string provider = (slashPos != std::string::npos) ? modelId.substr(0, slashPos) : "unknown";
            std::string modelName = (slashPos != std::string::npos) ? modelId.substr(slashPos + 1) : modelId;

            if (!ggufPath.empty()) {
                std::string ggufName = fs::path(ggufPath).filename().string();
                static const std::vector<std::string> quants = {
                    "Q4_K_M", "Q4_K_S", "Q5_K_M", "Q5_K_S", "Q4_0", "Q3_K_M", "Q6_K", "Q8_0",
                    "IQ4_XS", "IQ4_NL", "IQ3_M", "IQ3_S", "Q2_K", "IQ2_M", "IQ2_XS", "IQ2_S",
                    "Q4_AWQ", "FP16", "FP32"
                };
                for (const auto& quant : quants) {
                    if (ggufName.find(quant) != std::string::npos) {
                        modelName += "-" + quant;
                        break;
                    }
                }
            }

            dirName = provider + "/" + modelName;
        }

        std::string jobId = hfService.startDownload(modelId, dirName, ctx.modelsDir, ggufPath, mmprojPath, tokenizerPath);

        Json::Value result;
        result["status"] = "started";
        result["job_id"] = jobId;
        result["model_id"] = modelId;
        result["directory_name"] = dirName;
        setJson(res, result);
    });

    svr.Get("/api/huggingface/download-status", [&](const httplib::Request& req, httplib::Response& res) {
        applyHeaders(req, res);

        std::string jobId = req.get_param_value("job_id");
        if (jobId.empty()) {
            Json::Value result;
            result["jobs"] = Json::Value(Json::arrayValue);
            auto jobs = hfService.listDownloads();
            for (const auto& job : jobs) {
                Json::Value entry;
                entry["id"] = job.id;
                entry["model_id"] = job.modelId;
                entry["directory_name"] = job.directoryName;
                entry["status"] = (job.status == DownloadJob::Completed) ? "completed" :
                                  (job.status == DownloadJob::Failed) ? "failed" : "in_progress";
                entry["current_file"] = job.currentFile;
                entry["files_downloaded"] = job.filesDownloaded;
                entry["total_files"] = job.totalFiles;
                entry["percent"] = job.percent();
                if (!job.errorMessage.empty()) entry["error"] = job.errorMessage;
                result["jobs"].append(entry);
            }
            setJson(res, result);
            return;
        }

        auto job = hfService.getDownloadStatus(jobId);
        Json::Value result;
        result["id"] = job.id;
        result["model_id"] = job.modelId;
        result["directory_name"] = job.directoryName;
        result["status"] = (job.status == DownloadJob::Completed) ? "completed" :
                          (job.status == DownloadJob::Failed) ? "failed" : "in_progress";
        result["current_file"] = job.currentFile;
        result["files_downloaded"] = job.filesDownloaded;
        result["total_files"] = job.totalFiles;
        result["percent"] = job.percent();
        if (!job.errorMessage.empty()) result["error"] = job.errorMessage;
        setJson(res, result);
    });

    svr.Post("/api/huggingface/cancel-download", [&](const httplib::Request& req, httplib::Response& res) {
        applyHeaders(req, res);

        Json::CharReaderBuilder reader;
        Json::Value body;
        std::string errs;
        std::istringstream stream(req.body);
        if (!Json::parseFromStream(reader, stream, &body, &errs)) {
            res.status = 400;
            Json::Value err;
            err["error"] = "Invalid JSON";
            setJson(res, err);
            return;
        }

        std::string jobId = body.get("job_id", "").asString();
        if (!jobId.empty()) hfService.cancelDownload(jobId);

        Json::Value result;
        result["status"] = "cancelled";
        setJson(res, result);
    });

    svr.Post("/api/huggingface/install-tokenizer", [&](const httplib::Request& req, httplib::Response& res) {
        applyHeaders(req, res);

        Json::CharReaderBuilder reader;
        Json::Value body;
        std::string errs;
        std::istringstream stream(req.body);
        if (!Json::parseFromStream(reader, stream, &body, &errs)) {
            res.status = 400;
            Json::Value err;
            err["error"] = "Invalid JSON";
            setJson(res, err);
            return;
        }

        std::string modelId = body.get("model_id", "").asString();
        std::string dirName = body.get("directory_name", "").asString();
        std::string baseModel = body.get("base_model", "").asString();

        if (modelId.empty()) {
            res.status = 400;
            Json::Value err;
            err["error"] = "Missing model_id";
            setJson(res, err);
            return;
        }

        if (dirName.empty()) {
            std::string id = modelId;
            if (id.rfind("llamacpp::", 0) == 0) id = id.substr(10);
            dirName = id;
        }

        fs::path modelDir = fs::path(ctx.modelsDir) / dirName;
        if (!fs::exists(modelDir)) {
            res.status = 404;
            Json::Value err;
            err["error"] = "Model directory not found: " + dirName;
            setJson(res, err);
            return;
        }

        int downloaded = hfService.installTokenizer(modelId, modelDir.string());
        if (downloaded == 0 && !baseModel.empty()) {
            downloaded = hfService.installTokenizer(baseModel, modelDir.string());
        }

        Json::Value result;
        result["status"] = downloaded > 0 ? "installed" : "failed";
        result["files_downloaded"] = downloaded;
        result["directory"] = dirName;
        if (downloaded == 0) result["error"] = "Could not find tokenizer files";
        setJson(res, result);
    });

    svr.Get("/api/lmstudio/models", [&](const httplib::Request& req, httplib::Response& res) {
        applyHeaders(req, res);
        handleLmStudioModels(req, res, ctx.lmstudioService);
    });

    svr.Get("/api/config/settings", [&](const httplib::Request& req, httplib::Response& res) {
        applyHeaders(req, res);
        handleGetSettings(req, res, ctx.config);
    });

    svr.Put("/api/config/settings", [&](const httplib::Request& req, httplib::Response& res) {
        applyHeaders(req, res);
        handleUpdateSettings(req, res, ctx.config);
    });

    svr.Get("/api/tools/catalog", [&](const httplib::Request& req, httplib::Response& res) {
        applyHeaders(req, res);
        const std::string query = req.has_param("query") ? req.get_param_value("query") : "";
        const int limit = req.has_param("limit") ? std::max(1, std::atoi(req.get_param_value("limit").c_str())) : 10;
        setJson(res, ctx.toolSystem.getCatalog(query, parsePackScope(req), limit));
    });

    svr.Get("/api/tools/packs", [&](const httplib::Request& req, httplib::Response& res) {
        applyHeaders(req, res);
        setJson(res, ctx.toolSystem.getPackSummaries());
    });

    svr.Post("/api/tools/reload", [&](const httplib::Request& req, httplib::Response& res) {
        applyHeaders(req, res);
        ctx.toolSystem.reload();
        setJson(res, ctx.toolSystem.getPackSummaries());
    });

    svr.Get("/api/tools/approvals", [&](const httplib::Request& req, httplib::Response& res) {
        applyHeaders(req, res);
        const std::string taskId = req.has_param("task_id") ? req.get_param_value("task_id") : "";
        Json::Value result(Json::objectValue);
        result["approvals"] = ctx.toolSystem.listApprovals(taskId);
        setJson(res, result);
    });

    svr.Post(R"(/api/tools/approvals/([^/]+)/approve)", [&](const httplib::Request& req, httplib::Response& res) {
        applyHeaders(req, res);
        Json::Value body(Json::objectValue);
        if (!req.body.empty() && !parseJsonBody(req.body, body, res)) {
            return;
        }
        const std::string approvalId = req.matches[1];
        Json::Value result = ctx.toolSystem.resolveApproval(
            approvalId,
            true,
            body.get("note", "").asString());
        setJson(res, result, result.isMember("error") ? 404 : 200);
    });

    svr.Post(R"(/api/tools/approvals/([^/]+)/deny)", [&](const httplib::Request& req, httplib::Response& res) {
        applyHeaders(req, res);
        Json::Value body(Json::objectValue);
        if (!req.body.empty() && !parseJsonBody(req.body, body, res)) {
            return;
        }
        const std::string approvalId = req.matches[1];
        Json::Value result = ctx.toolSystem.resolveApproval(
            approvalId,
            false,
            body.get("note", "").asString());
        setJson(res, result, result.isMember("error") ? 404 : 200);
    });

    svr.Get("/api/mcp/tools", [&](const httplib::Request& req, httplib::Response& res) {
        applyHeaders(req, res);
        Json::Value result;
        result["tools"] = ctx.registry.getAggregatedTools();
        setJson(res, result);
    });

    svr.Post("/api/mcp/reload", [&](const httplib::Request& req, httplib::Response& res) {
        applyHeaders(req, res);
        ctx.registry.loadFromFile(ctx.config.getMcpConfigPath());
        ctx.toolSystem.reload();
        Json::Value result;
        Json::Value packSummary = ctx.toolSystem.getPackSummaries();
        result["liveClients"] = static_cast<int>(ctx.registry.liveCount());
        result["tools"] = ctx.registry.getAggregatedTools();
        result["packs"] = packSummary.get("packs", Json::Value(Json::arrayValue));
        setJson(res, result);
    });

    svr.Get("/api/chats", [&](const httplib::Request& req, httplib::Response& res) {
        applyHeaders(req, res);
        handleGetChats(req, res, ctx.chatStore);
    });

    svr.Put("/api/chats", [&](const httplib::Request& req, httplib::Response& res) {
        applyHeaders(req, res);
        handleSaveChats(req, res, ctx.chatStore);
    });

    svr.Get(R"(/api/chats/([^/]+))", [&](const httplib::Request& req, httplib::Response& res) {
        applyHeaders(req, res);
        handleGetChat(req, res, ctx.chatStore);
    });

    svr.Put(R"(/api/chats/([^/]+))", [&](const httplib::Request& req, httplib::Response& res) {
        applyHeaders(req, res);
        handleSaveChat(req, res, ctx.chatStore);
    });

    svr.Delete(R"(/api/chats/([^/]+))", [&](const httplib::Request& req, httplib::Response& res) {
        applyHeaders(req, res);
        handleDeleteChat(req, res, ctx.chatStore);
    });

    svr.Get("/api/auth", [&](const httplib::Request& req, httplib::Response& res) {
        applyHeaders(req, res);
        handleGetAuth(req, res, ctx.authStore);
    });

    svr.Post("/api/auth/setup", [&](const httplib::Request& req, httplib::Response& res) {
        applyHeaders(req, res);
        handleSetupAuth(req, res, ctx.authStore);
    });

    svr.Post("/api/auth/login", [&](const httplib::Request& req, httplib::Response& res) {
        applyHeaders(req, res);
        handleLoginAuth(req, res, ctx.authStore);
    });

    svr.Post("/api/auth/logout", [&](const httplib::Request& req, httplib::Response& res) {
        applyHeaders(req, res);
        handleLogoutAuth(req, res);
    });

    svr.Get("/api/auth/validate", [&](const httplib::Request& req, httplib::Response& res) {
        applyHeaders(req, res);
        handleValidateAuth(req, res, ctx.authStore);
    });

    svr.Post("/mcp", [&](const httplib::Request& req, httplib::Response& res) {
        addCorsHeaders(res, req);
        handleMcpPost(req, res, ctx.mcpService);
    });

    svr.Get("/mcp", [&](const httplib::Request& req, httplib::Response& res) {
        addCorsHeaders(res, req);
        handleMcpGet(req, res);
    });
}
