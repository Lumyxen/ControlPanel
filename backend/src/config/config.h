#ifndef CONFIG_H
#define CONFIG_H

#include <string>
#include <fstream>
#include <json/json.h>
#include <stdexcept>

class Config {
private:
    int port;
    int frontendPort;
    std::string host;
    std::string frontendDir;

public:
    Config() : port(1024), frontendPort(1025), host("0.0.0.0"), frontendDir("../ctrlpanel") {}

    bool loadFromFile(const std::string& filePath) {
        try {
            Json::Value config;
            std::ifstream file(filePath);
            if (!file.is_open()) {
                return false;
            }

            file >> config;
            file.close();

            if (config.isMember("port")) {
                port = config["port"].asInt();
            }
            if (config.isMember("frontendPort")) {
                frontendPort = config["frontendPort"].asInt();
            }
            if (config.isMember("host")) {
                host = config["host"].asString();
            }
            if (config.isMember("frontendDir")) {
                frontendDir = config["frontendDir"].asString();
            }

            return true;
        } catch (const std::exception& e) {
            return false;
        }
    }

    int getPort() const {
        return port;
    }

    int getFrontendPort() const {
        return frontendPort;
    }

    std::string getHost() const {
        return host;
    }

    std::string getFrontendDir() const {
        return frontendDir;
    }
};

#endif // CONFIG_H
