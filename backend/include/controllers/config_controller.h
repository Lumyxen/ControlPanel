#ifndef CONFIG_CONTROLLER_H
#define CONFIG_CONTROLLER_H

#include "config/config.h"
#include "httplib.h"

void handleGetSettings(const httplib::Request& req, httplib::Response& res, Config& config);
void handleUpdateSettings(const httplib::Request& req, httplib::Response& res, Config& config);

#endif // CONFIG_CONTROLLER_H
