#ifndef OPENROUTER_CONTROLLER_H
#define OPENROUTER_CONTROLLER_H

#include "httplib.h"
#include "services/openrouter_service.h"

void handleChat(const httplib::Request& req, httplib::Response& res, OpenRouterService& service);
void handleStreaming(const httplib::Request& req, httplib::Response& res, OpenRouterService& service);
void handleModels(const httplib::Request& req, httplib::Response& res, OpenRouterService& service);
void handlePricing(const httplib::Request& req, httplib::Response& res, OpenRouterService& service);

#endif // OPENROUTER_CONTROLLER_H
