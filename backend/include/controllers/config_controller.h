#ifndef CONFIG_CONTROLLER_H
#define CONFIG_CONTROLLER_H

#include "httplib.h"
#include "config/config.h"
#include <string>

// Settings handlers
void handleGetSettings(const httplib::Request& req, httplib::Response& res, Config& config);
void handleUpdateSettings(const httplib::Request& req, httplib::Response& res, Config& config);

#endif // CONFIG_CONTROLLER_H