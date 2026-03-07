#include "controllers/config_controller.h"
#include <json/json.h>
#include <fstream>
#include <mutex>
#include <sstream>
#include <string>

namespace {
    std::mutex config_mutex;
    Json::Value promptTemplates;
    Json::Value settings;
    bool config_loaded = false;
    std::string data_dir; // Set once by initConfigController; never empty after that.

    // Returns the absolute path for a filename inside data_dir.
    std::string dataPath(const std::string& filename) {
        return data_dir + "/" + filename;
    }

    void loadConfig() {
        std::lock_guard<std::mutex> lock(config_mutex);
        if (config_loaded) return;

        // Load prompt templates
        std::ifstream ptFile(dataPath("prompt_templates.json"));
        if (ptFile.is_open()) {
            ptFile >> promptTemplates;
            ptFile.close();
        } else {
            promptTemplates = Json::Value(Json::arrayValue);
        }

        // Load settings
        std::ifstream settingsFile(dataPath("settings.json"));
        if (settingsFile.is_open()) {
            settingsFile >> settings;
            settingsFile.close();
        } else {
            settings = Json::Value();
            settings["defaultModel"] = "arcee-ai/trinity-large-preview:free";
            settings["maxTokens"] = 2048;
            settings["temperature"] = 0.7;
            settings["systemPrompt"] = "";
        }

        // Backfill systemPrompt for old settings files that predate the field.
        if (!settings.isMember("systemPrompt")) {
            settings["systemPrompt"] = "";
        }

        config_loaded = true;
    }

    // NOTE: must be called with config_mutex already held — do NOT lock inside.
    void savePromptTemplates() {
        std::ofstream file(dataPath("prompt_templates.json"));
        file << promptTemplates.toStyledString();
        file.close();
    }

    void saveSettings() {
        std::ofstream file(dataPath("settings.json"));
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

void initConfigController(const std::string& dataDirectory) {
    data_dir = dataDirectory;
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
    newTemplate["id"] = (int)promptTemplates.size() + 1;
    newTemplate["name"] = requestBody["name"];
    newTemplate["template"] = requestBody["template"];

    {
        std::lock_guard<std::mutex> lock(config_mutex);
        promptTemplates.append(newTemplate);
        savePromptTemplates();
    }

    res.status = 201;
    res.set_content(newTemplate.toStyledString(), "application/json");
}

void handleUpdatePromptTemplate(const httplib::Request& req, httplib::Response& res) {
    loadConfig();

    std::string idStr = req.matches[1];
    int id = std::stoi(idStr);

    Json::Value requestBody;
    if (!parseJsonBody(req.body, requestBody)) {
        res.status = 400;
        res.set_content("{\"error\": \"Invalid JSON\"}", "application/json");
        return;
    }

    std::lock_guard<std::mutex> lock(config_mutex);
    for (Json::Value& tmpl : promptTemplates) {
        if (tmpl["id"].asInt() == id) {
            if (requestBody.isMember("name"))     tmpl["name"]     = requestBody["name"];
            if (requestBody.isMember("template")) tmpl["template"] = requestBody["template"];
            savePromptTemplates();
            res.status = 200;
            res.set_content(tmpl.toStyledString(), "application/json");
            return;
        }
    }

    res.status = 404;
    res.set_content("{\"error\": \"Template not found\"}", "application/json");
}

void handleDeletePromptTemplate(const httplib::Request& req, httplib::Response& res) {
    loadConfig();

    std::string idStr = req.matches[1];
    int id = std::stoi(idStr);

    std::lock_guard<std::mutex> lock(config_mutex);
    Json::Value newTemplates(Json::arrayValue);
    bool found = false;
    for (const Json::Value& tmpl : promptTemplates) {
        if (tmpl["id"].asInt() == id) {
            found = true;
        } else {
            newTemplates.append(tmpl);
        }
    }

    if (!found) {
        res.status = 404;
        res.set_content("{\"error\": \"Template not found\"}", "application/json");
        return;
    }

    promptTemplates = newTemplates;
    savePromptTemplates();
    res.status = 200;
    res.set_content("{\"success\": true}", "application/json");
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
    if (requestBody.isMember("defaultModel"))  settings["defaultModel"]  = requestBody["defaultModel"];
    if (requestBody.isMember("maxTokens"))     settings["maxTokens"]     = requestBody["maxTokens"];
    if (requestBody.isMember("temperature"))   settings["temperature"]   = requestBody["temperature"];
    if (requestBody.isMember("systemPrompt"))  settings["systemPrompt"]  = requestBody["systemPrompt"];

    saveSettings();

    res.status = 200;
    res.set_content(settings.toStyledString(), "application/json");
}