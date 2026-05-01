#ifndef APP_SERVER_APP_H
#define APP_SERVER_APP_H

#include <string>

struct AppLifecycleStatus {
    bool running = false;
    bool shutdownRequested = false;
    bool restartPending = false;
    bool restartSupported = false;
    int pid = 0;
    std::string executablePath;
};

AppLifecycleStatus getAppLifecycleStatus();
bool isAppShutdownRequested();
void scheduleAppShutdown(int delayMs = 250);
bool scheduleAppRestart(int shutdownDelayMs = 250, int startupDelayMs = 1500);

class ServerApp {
public:
    int run();
};

#endif // APP_SERVER_APP_H
