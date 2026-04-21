#ifndef LMSTUDIO_CONTROLLER_H
#define LMSTUDIO_CONTROLLER_H

#include <string>

#include "httplib.h"
#include "services/lmstudio_service.h"

class LlamaCppService;
class McpRegistry;
class ToolSystem;

void handleChat(const httplib::Request& req, httplib::Response& res, LmStudioService& service);
void handleStreaming(
    const httplib::Request& req,
    httplib::Response& res,
    LmStudioService& service,
    McpRegistry* registry,
    ToolSystem* toolSystem,
    LlamaCppService* llamaCppService = nullptr);
void handleStopStream(const httplib::Request& req, httplib::Response& res);

void handleLmStudioModels(const httplib::Request& req, httplib::Response& res, LmStudioService& service);
void handleModels(
    const httplib::Request& req,
    httplib::Response& res,
    LmStudioService& service,
    const std::string& llamaCppModelsDir,
    int llamaCppContextLength,
    LlamaCppService* llamaCppService = nullptr);

void startStreamCleanupLoop();
void stopStreamCleanupLoop();

#endif // LMSTUDIO_CONTROLLER_H
