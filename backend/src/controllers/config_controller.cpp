#include "controllers/config_controller.h"
#include <json/json.h>
#include <fstream>
#include <mutex>
#include <ctime>
#include <sstream>

namespace {
    std::mutex config_mutex;
    Json::Value promptTemplates;
    Json::Value settings;
    bool config_loaded = false;

    void loadConfig() {
        std::lock_guard<std::mutex> lock(config_mutex);
        if (config_loaded) return;
        
        // Load prompt templates
        std::ifstream ptFile("data/prompt_templates.json");
        if (ptFile.is_open()) {
            ptFile >> promptTemplates;
            ptFile.close();
        } else {
            promptTemplates = Json::Value(Json::arrayValue);
        }

        // Load settings
        std::ifstream settingsFile("data/settings.json");
        if (settingsFile.is_open()) {
            settingsFile >> settings;
            settingsFile.close();
        } else {
            settings = Json::Value();
            settings["defaultModel"] = "stepfun/step-3.5-flash:free";
            settings["maxTokens"] = 2048;
            settings["temperature"] = 0.7;
        }
        
        config_loaded = true;
    }

    // Call these ONLY when the mutex is already locked by the caller
    void savePromptTemplates_nolock() {
        std::ofstream file("data/prompt_templates.json");
        file << promptTemplates.toStyledString();
        file.close();
    }

    void saveSettings_nolock() {
        std::ofstream file("data/settings.json");
        file << settings.toStyledString();
        file.close();
    }
    
    bool parseJsonBody(const std::string& body, Json::Value& result) {
        Json::CharReaderBuilder reader;
        std::string errs;
        std::istringstream stream(body);
        return Json::parseFromStream(reader, stream, &result, &errs);
    }
}

void handleGetPromptTemplates(const httplib::Request& req, httplib::Response& res) {
    loadConfig();
    
    res.status = 200;
    res.set_content(promptTemplates.toStyledString(), "application/json");
}

void handleCreatePromptTemplate(const httplib::Request& req, httplib::Response& res) {
    loadConfig();
    
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

    std::lock_guard<std::mutex> lock(config_mutex);
    promptTemplates.append(newTemplate);
    savePromptTemplates_nolock();

    res.status = 201;
    res.set_content(newTemplate.toStyledString(), "application/json");
}

void handleUpdatePromptTemplate(const httplib::Request& req, httplib::Response& res) {
    loadConfig();
    
    // Get ID from path - httplib uses match group
    std::string id = req.matches[1];

    Json::Value requestBody;
    if (!parseJsonBody(req.body, requestBody)) {
        res.status = 400;
        res.set_content("{\"error\": \"Invalid JSON\"}", "application/json");
        return;
    }

    std::lock_guard<std::mutex> lock(config_mutex);
    bool found = false;
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
            savePromptTemplates_nolock();
            break;
        }
    }

    if (!found) {
        res.status = 404;
        res.set_content("{\"error\": \"Template not found\"}", "application/json");
        return;
    }

    res.status = 200;
    res.set_content("{\"status\": \"updated\"}", "application/json");
}

void handleDeletePromptTemplate(const httplib::Request& req, httplib::Response& res) {
    loadConfig();
    
    std::string id = req.matches[1];
    
    std::lock_guard<std::mutex> lock(config_mutex);
    bool found = false;
    Json::Value newArray(Json::arrayValue);
    
    for (auto& template_obj : promptTemplates) {
        if (template_obj["id"].asString() != id) {
            newArray.append(template_obj);
        } else {
            found = true;
        }
    }

    if (!found) {
        res.status = 404;
        res.set_content("{\"error\": \"Template not found\"}", "application/json");
        return;
    }

    promptTemplates = newArray;
    savePromptTemplates_nolock();

    res.status = 200;
    res.set_content("{\"status\": \"deleted\"}", "application/json");
}

void handleGetSettings(const httplib::Request& req, httplib::Response& res) {
    loadConfig();
    
    res.status = 200;
    res.set_content(settings.toStyledString(), "application/json");
}

void handleUpdateSettings(const httplib::Request& req, httplib::Response& res) {
    loadConfig();
    
    Json::Value requestBody;
    if (!parseJsonBody(req.body, requestBody)) {
        res.status = 400;
        res.set_content("{\"error\": \"Invalid JSON\"}", "application/json");
        return;
    }

    std::lock_guard<std::mutex> lock(config_mutex);
    if (requestBody.isMember("defaultModel")) {
        settings["defaultModel"] = requestBody["defaultModel"];
    }
    if (requestBody.isMember("maxTokens")) {
        settings["maxTokens"] = requestBody["maxTokens"];
    }
    if (requestBody.isMember("temperature")) {
        settings["temperature"] = requestBody["temperature"];
    }
    
    saveSettings_nolock();

    res.status = 200;
    res.set_content(settings.toStyledString(), "application/json");
}