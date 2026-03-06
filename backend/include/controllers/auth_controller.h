#ifndef AUTH_CONTROLLER_H
#define AUTH_CONTROLLER_H

#include <httplib.h>
#include "config/config.h"

void handleAuthVerify(const httplib::Request& req, httplib::Response& res, const Config& config);

#endif // AUTH_CONTROLLER_H
