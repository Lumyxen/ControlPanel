#ifndef CONFIG_CONTROLLER_H
#define CONFIG_CONTROLLER_H

#include "httplib.h"

// Prompt template handlers
void handleGetPromptTemplates(const httplib::Request& req, httplib::Response& res);
void handleCreatePromptTemplate(const httplib::Request& req, httplib::Response& res);
void handleUpdatePromptTemplate(const httplib::Request& req, httplib::Response& res);
void handleDeletePromptTemplate(const httplib::Request& req, httplib::Response& res);

// Settings handlers
void handleGetSettings(const httplib::Request& req, httplib::Response& res);
void handleUpdateSettings(const httplib::Request& req, httplib::Response& res);

#endif // CONFIG_CONTROLLER_H
