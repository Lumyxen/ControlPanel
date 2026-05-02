#ifndef CONFIG_CONTROLLER_H
#define CONFIG_CONTROLLER_H

#include "config/config.h"
#include "httplib.h"

class AuthStore;
class VaultStore;

void handleGetSettings(const httplib::Request& req,
                       httplib::Response& res,
                       Config& config,
                       VaultStore& vaultStore);
void handleUpdateSettings(const httplib::Request& req,
                          httplib::Response& res,
                          Config& config,
                          AuthStore& authStore,
                          VaultStore& vaultStore);

#endif // CONFIG_CONTROLLER_H
