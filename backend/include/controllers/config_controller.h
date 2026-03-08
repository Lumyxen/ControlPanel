#ifndef CONFIG_CONTROLLER_H
#define CONFIG_CONTROLLER_H

#include "httplib.h"
#include "config/config.h"
#include <string>

// Prompt template handlers
void handleGetPromptTemplates(const httplib::Request& req, httplib::Response& res, const std::string& dataDir);
void handleCreatePromptTemplate(const httplib::Request& req, httplib::Response& res, const std::string& dataDir);
void handleUpdatePromptTemplate(const httplib::Request& req, httplib::Response& res, const std::string& dataDir);
void handleDeletePromptTemplate(const httplib::Request& req, httplib::Response& res, const std::string& dataDir);

// Settings handlers
void handleGetSettings(const httplib::Request& req, httplib::Response& res, Config& config);
void handleUpdateSettings(const httplib::Request& req, httplib::Response& res, Config& config);

#endif // CONFIG_CONTROLLER_H