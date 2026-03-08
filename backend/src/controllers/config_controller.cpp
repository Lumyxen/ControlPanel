#include "controllers/config_controller.h"
#include <json/json.h>
#include <fstream>
#include <mutex>
#include <ctime>
#include <sstream>
#include <iostream>

namespace {
    std::mutex config_mutex;
    Json::Value promptTemplates;
    bool templates_loaded = false;

    void loadPromptTemplates(const std::string& dataDir) {
        std::lock_guard<std::mutex> lock(config_mutex);
        if (templates_loaded) return;
        
        std::ifstream ptFile(dataDir + "/prompt_templates.json");
        if (ptFile.is_open()) {
            ptFile >> promptTemplates;
            ptFile.close();
        } else {
            promptTemplates = Json::Value(Json::arrayValue);
            std::ofstream out(dataDir + "/prompt_templates.json");
            out << promptTemplates.toStyledString();
        }
        templates_loaded = true;
    }

    void savePromptTemplates(const std::string& dataDir) {
        std::lock_guard<std::mutex> lock(config_mutex);
        std::ofstream file(dataDir + "/prompt_templates.json");
        file << promptTemplates.toStyledString();
        file.close();
    }
    
    bool parseJsonBody(const std::string& body, Json::Value& result) {
        Json::CharReaderBuilder reader;
        std::string errs;
        std::istringstream stream(body);
        return Json::parseFromStream(reader, stream, &result, &errs);
    }
}

void handleGetPromptTemplates(const httplib::Request& req, httplib::Response& res, const std::string& dataDir) {
    loadPromptTemplates(dataDir);
    std::lock_guard<std::mutex> lock(config_mutex);
    res.status = 200;
    res.set_content(promptTemplates.toStyledString(), "application/json");
}

void handleCreatePromptTemplate(const httplib::Request& req, httplib::Response& res, const std::string& dataDir) {
    loadPromptTemplates(dataDir);
    
    Json::Value requestBody;
    if (!parseJsonBody(req.body, requestBody)) {
        res.status = 400;
        res.set_content("{\"error\": \"Invalid JSON\"}", "application/json");
        return;
    }

    if (!requestBody.isMember("name") || !requestBody.isMember("template")) {
        res.status = 400;
        res.set_content("{\"error\": \"Missing required fields: name, template\"}", "application/json");
        return;
    }

    Json::Value newTemplate;
    newTemplate["id"] = std::to_string(std::time(nullptr));
    newTemplate["name"] = requestBody["name"];
    newTemplate["template"] = requestBody["template"];
    newTemplate["created_at"] = std::to_string(std::time(nullptr));

    {
        std::lock_guard<std::mutex> lock(config_mutex);
        promptTemplates.append(newTemplate);
    }
    savePromptTemplates(dataDir);

    res.status = 201;
    res.set_content(newTemplate.toStyledString(), "application/json");
}

void handleUpdatePromptTemplate(const httplib::Request& req, httplib::Response& res, const std::string& dataDir) {
    loadPromptTemplates(dataDir);
    
    std::string id = req.matches[1];

    Json::Value requestBody;
    if (!parseJsonBody(req.body, requestBody)) {
        res.status = 400;
        res.set_content("{\"error\": \"Invalid JSON\"}", "application/json");
        return;
    }

    bool found = false;
    {
        std::lock_guard<std::mutex> lock(config_mutex);
        for (auto& template_obj : promptTemplates) {
            if (template_obj["id"].asString() == id) {
                if (requestBody.isMember("name")) {
                    template_obj["name"] = requestBody["name"];
                }
                if (requestBody.isMember("template")) {
                    template_obj["template"] = requestBody["template"];
                }
                template_obj["updated_at"] = std::to_string(std::time(nullptr));
                found = true;
                break;
            }
        }
    }

    if (!found) {
        res.status = 404;
        res.set_content("{\"error\": \"Template not found\"}", "application/json");
        return;
    }

    savePromptTemplates(dataDir);
    res.status = 200;
    res.set_content("{\"status\": \"updated\"}", "application/json");
}

void handleDeletePromptTemplate(const httplib::Request& req, httplib::Response& res, const std::string& dataDir) {
    loadPromptTemplates(dataDir);
    
    std::string id = req.matches[1];
    
    bool found = false;
    {
        std::lock_guard<std::mutex> lock(config_mutex);
        Json::Value newArray(Json::arrayValue);
        
        for (auto& template_obj : promptTemplates) {
            if (template_obj["id"].asString() != id) {
                newArray.append(template_obj);
            } else {
                found = true;
            }
        }

        if (found) {
            promptTemplates = newArray;
        }
    }

    if (!found) {
        res.status = 404;
        res.set_content("{\"error\": \"Template not found\"}", "application/json");
        return;
    }

    savePromptTemplates(dataDir);

    res.status = 200;
    res.set_content("{\"status\": \"deleted\"}", "application/json");
}

void handleGetSettings(const httplib::Request& req, httplib::Response& res, Config& config) {
    res.status = 200;
    res.set_content(config.toJson().toStyledString(), "application/json");
}

void handleUpdateSettings(const httplib::Request& req, httplib::Response& res, Config& config) {
    Json::Value requestBody;
    if (!parseJsonBody(req.body, requestBody)) {
        res.status = 400;
        res.set_content("{\"error\": \"Invalid JSON\"}", "application/json");
        return;
    }

    config.updateFromJson(requestBody);

    res.status = 200;
    res.set_content(config.toJson().toStyledString(), "application/json");
}