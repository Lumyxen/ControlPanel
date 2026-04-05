#ifndef LMSTUDIO_CONTROLLER_H
#define LMSTUDIO_CONTROLLER_H

#include "httplib.h"
#include "services/lmstudio_service.h"
#include "services/llamacpp_service.h"

class McpRegistry;

void handleChat    (const httplib::Request& req, httplib::Response& res,
                    LmStudioService& service);

void handleStreaming(const httplib::Request& req, httplib::Response& res,
                    LmStudioService& service, McpRegistry* registry,
                    LlamaCppService* llamaCppService = nullptr);

void handleStopStream(const httplib::Request& req, httplib::Response& res);

void handleLmStudioModels(const httplib::Request& req, httplib::Response& res,
                          LmStudioService& service);

void handleModels  (const httplib::Request& req, httplib::Response& res,
                    LmStudioService& service,
                    LlamaCppService* llamaCppService = nullptr);

#endif // LMSTUDIO_CONTROLLER_H