#ifndef CONFIG_CONTROLLER_H
#define CONFIG_CONTROLLER_H

#include "config/config.h"
#include "httplib.h"

class AuthStore;

void handleGetSettings(const httplib::Request& req,
                       httplib::Response& res,
                       Config& config);
void handleUpdateSettings(const httplib::Request& req,
                          httplib::Response& res,
                          Config& config,
                          AuthStore& authStore);

#endif // CONFIG_CONTROLLER_H
