#ifndef OPENROUTER_CONTROLLER_H
#define OPENROUTER_CONTROLLER_H

#include "httplib.h"
#include "services/openrouter_service.h"

// Forward-declare to avoid circular includes
class McpRegistry;

void handleChat     (const httplib::Request& req, httplib::Response& res, OpenRouterService& service);
void handleStreaming (const httplib::Request& req, httplib::Response& res,
                     OpenRouterService& service, McpRegistry* registry);
void handleModels        (const httplib::Request& req, httplib::Response& res, OpenRouterService& service);
void handlePricing       (const httplib::Request& req, httplib::Response& res, OpenRouterService& service);
void handleLmStudioModels(const httplib::Request& req, httplib::Response& res, OpenRouterService& service);

#endif // OPENROUTER_CONTROLLER_H