#include "services/huggingface_service.h"
#include <curl/curl.h>
#include <json/json.h>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <sstream>
#include <algorithm>
#include <thread>
#include <chrono>
#include <map>
#include <mutex>
#include <random>

namespace fs = std::filesystem;

// =============================================================================
// CURL helpers
// =============================================================================

static size_t hfWriteCallback(void* contents, size_t size, size_t nmemb, void* userp) {
    ((std::string*)userp)->append((char*)contents, size * nmemb);
    return size * nmemb;
}

static size_t hfWriteFileCallback(void* contents, size_t size, size_t nmemb, void* userp) {
    std::ofstream* ofs = static_cast<std::ofstream*>(userp);
    size_t realsize = size * nmemb;
    ofs->write((char*)contents, realsize);
    return realsize;
}

struct HfDownloadCtx {
    DownloadProgress* progress;
    std::function<void(const DownloadProgress&)> callback;
    std::ofstream* outFile;
    const std::string* cancelToken;
    long long completedBytesFromPreviousFiles; // bytes from already-completed files
};

static int hfProgressCallback(void* clientp, curl_off_t dltotal, curl_off_t dlnow, curl_off_t, curl_off_t) {
    auto* ctx = static_cast<HfDownloadCtx*>(clientp);
    if (!ctx || !ctx->progress) return 0;

    // Check cancellation
    if (ctx->cancelToken && !ctx->cancelToken->empty()) {
        ctx->progress->status = DownloadProgress::Failed;
        ctx->progress->errorMessage = "Download cancelled";
        return 1; // abort
    }

    // Update cumulative download progress: bytes from completed files + current file progress
    ctx->progress->downloadedBytes = ctx->completedBytesFromPreviousFiles + dlnow;
    if (ctx->callback) ctx->callback(*ctx->progress);
    return 0;
}

// =============================================================================
// Constructor / Destructor
// =============================================================================

HuggingFaceService::HuggingFaceService() = default;
HuggingFaceService::~HuggingFaceService() = default;

// =============================================================================
// HTTP request helper
// =============================================================================

std::string HuggingFaceService::makeRequest(const std::string& url, long timeout) const {
    CURL* curl = curl_easy_init();
    if (!curl) return "";

    std::string responseStr;
    struct curl_slist* headers = nullptr;
    headers = curl_slist_append(headers, "Accept: application/json");
    headers = curl_slist_append(headers, "User-Agent: Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36");

    curl_easy_setopt(curl, CURLOPT_URL, url.c_str());
    curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, hfWriteCallback);
    curl_easy_setopt(curl, CURLOPT_WRITEDATA, &responseStr);
    curl_easy_setopt(curl, CURLOPT_SSL_VERIFYPEER, 0L);
    curl_easy_setopt(curl, CURLOPT_SSL_VERIFYHOST, 0L);
    curl_easy_setopt(curl, CURLOPT_TIMEOUT, timeout);
    curl_easy_setopt(curl, CURLOPT_FOLLOWLOCATION, 1L);

    long httpCode = 0;
    CURLcode res = curl_easy_perform(curl);
    curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &httpCode);
    curl_slist_free_all(headers);
    curl_easy_cleanup(curl);

    if (res != CURLE_OK) {
        std::cerr << "[HuggingFace] CURL error: " << curl_easy_strerror(res) << " for " << url << "\n";
        return "";
    }
    if (httpCode != 200) {
        std::cerr << "[HuggingFace] HTTP " << httpCode << " for " << url << "\n";
        if (!responseStr.empty() && responseStr.size() < 500)
            std::cerr << "[HuggingFace] Response: " << responseStr << "\n";
        return "";
    }
    return responseStr;
}

// =============================================================================
// searchModels
// =============================================================================

Json::Value HuggingFaceService::searchModels(const HfSearchFilters& filters) const {
    Json::Value result;
    result["data"] = Json::Value(Json::arrayValue);
    result["total"] = 0;

    // Build query URL using the /api/models endpoint
    // HuggingFace API: https://huggingface.co/docs/hub/api
    std::string url = "https://huggingface.co/api/models?";

    // Build query parameters
    std::vector<std::string> params;
    
    // Limit
    params.push_back("limit=" + std::to_string(filters.limit));
    
    // Sort
    if (filters.sort == "downloads") params.push_back("sort=downloads");
    else if (filters.sort == "likes") params.push_back("sort=likes");
    else if (filters.sort == "createdAt") params.push_back("sort=createdAt");
    else if (filters.sort == "trending") params.push_back("sort=trending");
    
    params.push_back("direction=-1"); // descending
    
    // Filter: GGUF only
    params.push_back("filter=gguf");
    
    // Search query
    if (!filters.search.empty()) {
        // URL encode the search query
        std::string encoded;
        for (char c : filters.search) {
            if (c == ' ') encoded += "+";
            else if (isalnum(c) || c == '-' || c == '_' || c == '.' || c == '~') encoded += c;
            else {
                char buf[4];
                snprintf(buf, sizeof(buf), "%%%02X", (unsigned char)c);
                encoded += buf;
            }
        }
        params.push_back("search=" + encoded);
    }
    
    // Author filter
    if (!filters.author.empty()) {
        params.push_back("author=" + filters.author);
    }
    
    // Pipeline filter
    if (!filters.pipeline.empty()) {
        params.push_back("pipeline_tag=" + filters.pipeline);
    }

    // Join params
    for (size_t i = 0; i < params.size(); ++i) {
        url += params[i];
        if (i < params.size() - 1) url += "&";
    }

    std::cout << "[HuggingFace] Searching: " << url << "\n";

    std::string response = makeRequest(url, 30);
    if (response.empty()) {
        result["error"] = "Failed to fetch models from HuggingFace";
        return result;
    }

    // Parse response
    Json::CharReaderBuilder reader;
    std::string errs;
    Json::Value parsed;
    std::istringstream iss(response);
    if (!Json::parseFromStream(reader, iss, &parsed, &errs)) {
        result["error"] = "Failed to parse response: " + errs;
        return result;
    }

    if (!parsed.isArray()) {
        result["error"] = "Unexpected response format";
        return result;
    }

    result["total"] = (int)parsed.size();

    for (const auto& item : parsed) {
        Json::Value m;
        m["id"] = item.get("id", "").asString();      // e.g. "bartowski/Qwen3-8B-GGUF"
        m["name"] = item.get("id", "").asString();     // full name for display
        m["author"] = item.get("author", "").asString();
        m["downloads"] = item.get("downloads", 0).asInt();
        m["likes"] = item.get("likes", 0).asInt();
        m["pipeline_tag"] = item.get("pipeline_tag", "").asString();
        
        // Extract tags
        if (item.isMember("tags") && item["tags"].isArray()) {
            Json::Value tagsArr = Json::Value(Json::arrayValue);
            for (const auto& tag : item["tags"]) {
                tagsArr.append(tag.asString());
            }
            m["tags"] = tagsArr;
        }

        // Check for image/audio support from tags
        const auto& tags = item["tags"];
        if (tags.isArray()) {
            for (const auto& tag : tags) {
                std::string t = tag.asString();
                if (t == "image-text-to-text" || t == "vision" || t == "llava") {
                    m["has_image_support"] = true;
                }
                if (t == "audio" || t == "speech-to-text" || t == "text-to-speech") {
                    m["has_audio_support"] = true;
                }
            }
        }

        // Note: file listing requires a separate API call per model
        // We'll do a lightweight fetch for the first few models only
        m["has_mmproj"] = false;
        m["has_tokenizer"] = false;
        m["gguf_files"] = Json::Value(Json::arrayValue);

        result["data"].append(m);
    }

    return result;
}

// =============================================================================
// getModelInfo — fetches full repo info including sibling file list
// =============================================================================

Json::Value HuggingFaceService::getModelInfo(const std::string& modelId) const {
    Json::Value result;

    // modelId goes directly in the path
    std::string url = "https://huggingface.co/api/models/" + modelId;
    std::string response = makeRequest(url, 30);

    if (response.empty()) {
        result["error"] = "Failed to fetch model info";
        return result;
    }

    Json::CharReaderBuilder reader;
    std::string errs;
    std::istringstream iss(response);
    if (!Json::parseFromStream(reader, iss, &result, &errs)) {
        result["error"] = "Failed to parse response: " + errs;
    }

    return result;
}

// =============================================================================
// listModelFiles — returns list of filenames in a repo
// =============================================================================

std::vector<std::string> HuggingFaceService::listModelFiles(const std::string& modelId) const {
    std::vector<std::string> files;

    // Use the model info endpoint with siblings expansion.
    // The modelId (e.g. "unsloth/Qwen3.5-0.8B-GGUF") goes directly in the path.
    // curl's FOLLOWLOCATION handles any redirect encoding automatically.
    std::string url = "https://huggingface.co/api/models/" + modelId + "?expand[]=siblings";
    std::cout << "[HuggingFace] Fetching file list: " << url << "\n";
    std::string response = makeRequest(url, 30);

    if (response.empty()) {
        std::cerr << "[HuggingFace] Empty response for file list of " << modelId << "\n";
        return files;
    }

    Json::CharReaderBuilder reader;
    std::string errs;
    Json::Value parsed;
    std::istringstream iss(response);
    if (!Json::parseFromStream(reader, iss, &parsed, &errs)) {
        std::cerr << "[HuggingFace] JSON parse error: " << errs << "\n";
        return files;
    }

    // Extract siblings (file list)
    if (!parsed.isMember("siblings") || !parsed["siblings"].isArray()) {
        std::cerr << "[HuggingFace] No siblings field in response for " << modelId << "\n";
        return files;
    }

    std::cout << "[HuggingFace] Found " << parsed["siblings"].size() << " files in " << modelId << "\n";
    for (const auto& item : parsed["siblings"]) {
        if (item.isMember("rfilename")) {
            files.push_back(item["rfilename"].asString());
        }
    }

    return files;
}

// =============================================================================
// downloadFile — downloads a single file with progress
// =============================================================================

bool HuggingFaceService::downloadFile(
    const std::string& url,
    const std::string& destPath,
    std::function<void(const DownloadProgress&)> progressCb,
    DownloadProgress& progress
) const {
    CURL* curl = curl_easy_init();
    if (!curl) return false;

    // Ensure parent directory exists
    fs::create_directories(fs::path(destPath).parent_path());

    std::ofstream outFile(destPath, std::ios::binary);
    if (!outFile.is_open()) {
        progress.status = DownloadProgress::Failed;
        progress.errorMessage = "Cannot create file: " + destPath;
        if (progressCb) progressCb(progress);
        curl_easy_cleanup(curl);
        return false;
    }

    HfDownloadCtx ctx;
    ctx.progress = &progress;
    ctx.callback = progressCb;
    ctx.outFile = &outFile;
    ctx.cancelToken = &cancelToken_;
    ctx.completedBytesFromPreviousFiles = progress.completedBytesFromPreviousFiles;

    struct curl_slist* headers = nullptr;
    headers = curl_slist_append(headers, "User-Agent: Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36");

    curl_easy_setopt(curl, CURLOPT_URL, url.c_str());
    curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);
    curl_easy_setopt(curl, CURLOPT_FOLLOWLOCATION, 1L);
    curl_easy_setopt(curl, CURLOPT_SSL_VERIFYPEER, 0L);
    curl_easy_setopt(curl, CURLOPT_SSL_VERIFYHOST, 0L);
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, hfWriteFileCallback);
    curl_easy_setopt(curl, CURLOPT_WRITEDATA, &outFile);
    curl_easy_setopt(curl, CURLOPT_NOPROGRESS, 0L);
    curl_easy_setopt(curl, CURLOPT_XFERINFOFUNCTION, hfProgressCallback);
    curl_easy_setopt(curl, CURLOPT_XFERINFODATA, &ctx);
    curl_easy_setopt(curl, CURLOPT_TIMEOUT, 0L); // no timeout for large files
    curl_easy_setopt(curl, CURLOPT_LOW_SPEED_LIMIT, 1024L);     // 1 KB/s
    curl_easy_setopt(curl, CURLOPT_LOW_SPEED_TIME, 120L);       // for 120 seconds

    CURLcode res = curl_easy_perform(curl);
    curl_slist_free_all(headers);
    curl_easy_cleanup(curl);
    outFile.close();

    if (res != CURLE_OK) {
        progress.status = DownloadProgress::Failed;
        progress.errorMessage = curl_easy_strerror(res);
        if (progressCb) progressCb(progress);
        // Remove incomplete file
        fs::remove(destPath);
        return false;
    }

    return true;
}

// =============================================================================
// Async download management
// =============================================================================

static std::string generateJobId() {
    static std::random_device rd;
    static std::mt19937 gen(rd());
    static std::uniform_int_distribution<> dist(0, 0xFFFFFFF);
    char buf[16];
    snprintf(buf, sizeof(buf), "%x", dist(gen));
    return "dl_" + std::string(buf);
}

std::string HuggingFaceService::startDownload(
    const std::string& modelId,
    const std::string& directoryName,
    const std::string& modelsDir,
    const std::string& ggufPath,
    const std::string& mmprojPath,
    const std::string& tokenizerPath
) {
    std::string jobId = generateJobId();

    DownloadJob job;
    job.id = jobId;
    job.modelId = modelId;
    job.directoryName = directoryName;
    job.status = DownloadJob::InProgress;

    {
        std::lock_guard<std::mutex> lock(jobsMutex_);
        jobs_[jobId] = job;
    }

    cancelToken_.clear();
    std::thread(&HuggingFaceService::downloadWorker, this,
                jobId, modelId, directoryName, modelsDir,
                ggufPath, mmprojPath, tokenizerPath).detach();

    std::cout << "[HuggingFace] Started download job " << jobId << " for " << modelId << "\n";
    return jobId;
}

DownloadJob HuggingFaceService::getDownloadStatus(const std::string& jobId) const {
    std::lock_guard<std::mutex> lock(jobsMutex_);
    auto it = jobs_.find(jobId);
    if (it != jobs_.end()) return it->second;
    DownloadJob empty;
    empty.id = jobId;
    empty.status = DownloadJob::Failed;
    empty.errorMessage = "Job not found";
    return empty;
}

std::vector<DownloadJob> HuggingFaceService::listDownloads() const {
    std::lock_guard<std::mutex> lock(jobsMutex_);
    std::vector<DownloadJob> out;
    for (auto& [id, job] : jobs_) out.push_back(job);
    return out;
}

void HuggingFaceService::cancelDownload(const std::string& jobId) {
    cancelToken_ = jobId;
    std::lock_guard<std::mutex> lock(jobsMutex_);
    auto it = jobs_.find(jobId);
    if (it != jobs_.end()) {
        it->second.status = DownloadJob::Failed;
        it->second.errorMessage = "Cancelled by user";
    }
}

void HuggingFaceService::cleanupOldJobs() {
    std::lock_guard<std::mutex> lock(jobsMutex_);
    // Simple cleanup: remove completed/failed jobs
    for (auto it = jobs_.begin(); it != jobs_.end(); ) {
        if (it->second.status == DownloadJob::Completed || it->second.status == DownloadJob::Failed) {
            it = jobs_.erase(it);
        } else {
            ++it;
        }
    }
}

// =============================================================================
// downloadWorker — runs in background thread
// =============================================================================

void HuggingFaceService::downloadWorker(
    std::string jobId,
    std::string modelId,
    std::string directoryName,
    std::string modelsDir,
    std::string userGgufPath,
    std::string userMmprojPath,
    std::string userTokenizerPath
) {
    auto updateJob = [&](const DownloadProgress& p) {
        std::lock_guard<std::mutex> lock(jobsMutex_);
        auto& job = jobs_[jobId];
        job.currentFile = p.currentFile;
        job.filesDownloaded = p.filesDownloaded;
        job.totalFiles = p.totalFiles;
        job.totalBytes = p.totalBytes;
        job.downloadedBytes = p.downloadedBytes;
        if (p.status == DownloadProgress::Completed) job.status = DownloadJob::Completed;
        else if (p.status == DownloadProgress::Failed) {
            job.status = DownloadJob::Failed;
            job.errorMessage = p.errorMessage;
        }
    };

    std::cout << "[HuggingFace] Worker fetching file list for " << modelId << "\n";

    DownloadProgress progress;
    progress.modelId = modelId;
    progress.directoryName = directoryName;
    progress.status = DownloadProgress::InProgress;

    // If user specified exact paths, use those directly
    std::vector<std::pair<std::string, std::string>> downloads;

    if (!userGgufPath.empty()) {
        downloads.push_back({"https://huggingface.co/" + modelId + "/resolve/main/" + userGgufPath, userGgufPath});
        if (!userMmprojPath.empty())
            downloads.push_back({"https://huggingface.co/" + modelId + "/resolve/main/" + userMmprojPath, userMmprojPath});
        if (!userTokenizerPath.empty())
            downloads.push_back({"https://huggingface.co/" + modelId + "/resolve/main/" + userTokenizerPath, userTokenizerPath});
    } else {
        // Auto-select: scan files and pick best quantisation
        std::vector<std::string> allFiles = listModelFiles(modelId);
        if (allFiles.empty()) {
            progress.status = DownloadProgress::Failed;
            progress.errorMessage = "No files found in model repository";
            updateJob(progress);
            return;
        }

        std::string mainGguf, mmproj, tokenizer;

        static const std::vector<std::string> quantPriority = {
            "Q4_K_M", "Q4_K_S", "Q5_K_M", "Q5_K_S", "Q4_0",
            "Q3_K_M", "Q6_K", "Q8_0", "IQ4_XS", "IQ4_NL",
        };

        for (const auto& file : allFiles) {
            std::string fname = fs::path(file).filename().string();

            if (fname.find("mmproj") != std::string::npos && fname.find(".gguf") != std::string::npos) {
                if (mmproj.empty()) mmproj = file;
                continue;
            }

            if (fname == "vocab.json" || fname.find(".tiktoken") != std::string::npos ||
                fname == "tokenizer.json" || fname == "tokenizer_config.json") {
                if (tokenizer.empty() || fname == "vocab.json") tokenizer = file;
                continue;
            }

            if (fname.find(".gguf") != std::string::npos && fname.find("mmproj") == std::string::npos) {
                if (mainGguf.empty()) {
                    mainGguf = file;
                } else {
                    std::string curFname = fs::path(mainGguf).filename().string();
                    int curPri = -1, newPri = -1;
                    for (size_t i = 0; i < quantPriority.size(); i++) {
                        if (curFname.find(quantPriority[i]) != std::string::npos) curPri = (int)i;
                        if (fname.find(quantPriority[i]) != std::string::npos) newPri = (int)i;
                    }
                    if (newPri >= 0 && (curPri < 0 || newPri < curPri)) mainGguf = file;
                }
            }
        }

        if (!mainGguf.empty())
            downloads.push_back({"https://huggingface.co/" + modelId + "/resolve/main/" + mainGguf, mainGguf});
        if (!mmproj.empty())
            downloads.push_back({"https://huggingface.co/" + modelId + "/resolve/main/" + mmproj, mmproj});
        if (!tokenizer.empty())
            downloads.push_back({"https://huggingface.co/" + modelId + "/resolve/main/" + tokenizer, tokenizer});
    }

    if (downloads.empty()) {
        progress.status = DownloadProgress::Failed;
        progress.errorMessage = "No suitable GGUF file found";
        updateJob(progress);
        return;
    }

    progress.totalFiles = (int)downloads.size();
    progress.filesDownloaded = 0;
    progress.completedBytesFromPreviousFiles = 0;

    std::string outputDir = modelsDir + "/" + directoryName;
    fs::create_directories(outputDir);

    std::cout << "[HuggingFace] Downloading " << downloads.size() << " file(s) to " << outputDir << "\n";

    // Calculate total size upfront by checking Content-Length for each file
    long long grandTotalBytes = 0;
    for (const auto& [url, filename] : downloads) {
        CURL* curl = curl_easy_init();
        if (curl) {
            curl_easy_setopt(curl, CURLOPT_URL, url.c_str());
            curl_easy_setopt(curl, CURLOPT_NOBODY, 1L); // HEAD request
            curl_easy_setopt(curl, CURLOPT_FOLLOWLOCATION, 1L);
            curl_easy_setopt(curl, CURLOPT_SSL_VERIFYPEER, 0L);
            curl_easy_setopt(curl, CURLOPT_SSL_VERIFYHOST, 0L);
            curl_easy_setopt(curl, CURLOPT_TIMEOUT, 30L);
            curl_easy_setopt(curl, CURLOPT_USERAGENT, "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36");
            
            CURLcode res = curl_easy_perform(curl);
            if (res == CURLE_OK) {
                curl_off_t contentLength = 0;
                curl_easy_getinfo(curl, CURLINFO_CONTENT_LENGTH_DOWNLOAD_T, &contentLength);
                if (contentLength > 0) {
                    grandTotalBytes += (long long)contentLength;
                }
            }
            curl_easy_cleanup(curl);
        }
    }
    
    progress.totalBytes = grandTotalBytes;
    std::cout << "[HuggingFace] Total download size: " << (grandTotalBytes / (1024.0 * 1024.0)) << " MB\n";

    for (const auto& [url, filename] : downloads) {
        if (cancelToken_ == jobId) return;

        progress.currentFile = fs::path(filename).filename().string();
        updateJob(progress);

        std::string destPath = outputDir + "/" + fs::path(filename).filename().string();
        bool success = downloadFile(url, destPath, updateJob, progress);
        if (!success) return;

        // Add this file's size to completed bytes for next file's progress tracking
        auto fileSize = fs::file_size(destPath);
        progress.completedBytesFromPreviousFiles += fileSize;
        progress.downloadedBytes = progress.completedBytesFromPreviousFiles;
        progress.filesDownloaded++;
        updateJob(progress);
    }

    progress.status = DownloadProgress::Completed;
    updateJob(progress);

    // Auto-install tokenizer into the model directory alongside the .gguf
    installTokenizer(modelId, outputDir);

    std::cout << "[HuggingFace] Download complete for " << modelId << " \u2192 " << outputDir << "\n";
}

// =============================================================================
// (old cancelDownload removed — now part of async management above)
// =============================================================================

// =============================================================================
// installTokenizer — fetch via /resolve/main/ URLs with fallback
// =============================================================================

int HuggingFaceService::installTokenizer(const std::string& repoId, const std::string& cacheDir) const {
    // Files to try, in priority order
    static const std::vector<std::string> tokenizerFiles = {
        "tokenizer.json",
        "tokenizer_config.json",
        "special_tokens_map.json",
        "vocab.json",
        "merges.txt",
    };

    // Build a list of candidate repos to try
    std::vector<std::string> candidates;
    candidates.push_back(repoId);

    // If the repo name contains "-GGUF" or similar, try stripping it
    std::string baseRepo = repoId;
    auto stripSuffix = [&](const std::string& suffix) {
        auto pos = baseRepo.find(suffix);
        if (pos != std::string::npos) {
            std::string stripped = baseRepo.substr(0, pos);
            // Remove trailing hyphen
            if (!stripped.empty() && stripped.back() == '-') stripped.pop_back();
            candidates.push_back(stripped);
        }
    };
    stripSuffix("-GGUF");
    stripSuffix("-gguf");
    stripSuffix("-ggufs");
    stripSuffix("-GGUFs");
    stripSuffix("-4bit");
    stripSuffix("-8bit");

    // Also try just the author + stripped model name (e.g. "unsloth/Qwen3-8B" from "unsloth/Qwen3-8B-GGUF")
    // Already covered by the suffix stripping above

    // Deduplicate
    std::sort(candidates.begin(), candidates.end());
    candidates.erase(std::unique(candidates.begin(), candidates.end()), candidates.end());

    fs::create_directories(cacheDir);
    int totalDownloaded = 0;

    for (const auto& fname : tokenizerFiles) {
        fs::path destPath = fs::path(cacheDir) / fname;
        if (fs::exists(destPath)) {
            std::cout << "[HuggingFace] Tokenizer already cached: " << destPath.string() << "\n";
            totalDownloaded++;
            continue;
        }

        bool found = false;
        for (const auto& repo : candidates) {
            std::string url = "https://huggingface.co/" + repo + "/resolve/main/" + fname;
            std::cout << "[HuggingFace] Trying tokenizer: " << url << "\n";

            CURL* curl = curl_easy_init();
            if (!curl) continue;

            std::ofstream ofs(destPath, std::ios::binary);
            if (!ofs.is_open()) { curl_easy_cleanup(curl); continue; }

            long httpCode = 0;
            curl_easy_setopt(curl, CURLOPT_URL, url.c_str());
            curl_easy_setopt(curl, CURLOPT_FOLLOWLOCATION, 1L);
            curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, hfWriteFileCallback);
            curl_easy_setopt(curl, CURLOPT_WRITEDATA, &ofs);
            curl_easy_setopt(curl, CURLOPT_SSL_VERIFYPEER, 0L);
            curl_easy_setopt(curl, CURLOPT_SSL_VERIFYHOST, 0L);
            curl_easy_setopt(curl, CURLOPT_TIMEOUT, 15L);
            curl_easy_setopt(curl, CURLOPT_USERAGENT, "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36");
            curl_easy_setopt(curl, CURLOPT_FAILONERROR, 0L);
            curl_easy_setopt(curl, CURLOPT_NOPROGRESS, 1L);

            CURLcode res = curl_easy_perform(curl);
            curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &httpCode);
            curl_easy_cleanup(curl);
            ofs.close();

            if (res == CURLE_OK && httpCode == 200) {
                // Verify it's not an HTML error page
                std::ifstream check(destPath, std::ios::ate);
                if (check.is_open()) {
                    auto sz = check.tellg();
                    check.seekg(0);
                    std::string header;
                    header.resize(std::min((size_t)64, (size_t)sz));
                    check.read(&header[0], header.size());
                    check.close();
                    // If it starts with "<!DOCTYPE" or "<html", it's an error page
                    if (header.find("<!DOCTYPE") == 0 || header.find("<html") == 0) {
                        fs::remove(destPath);
                        std::cout << "[HuggingFace] Tokenizer fetch returned HTML error page for " << url << "\n";
                        continue;
                    }
                }

                std::cout << "[HuggingFace] Downloaded tokenizer: " << destPath.string() << " from " << repo << "\n";
                totalDownloaded++;
                found = true;
                break;
            } else {
                // Remove the failed file
                fs::remove(destPath);
                std::cout << "[HuggingFace] HTTP " << httpCode << " for " << url << "\n";
            }
        }

        if (!found && fname == "tokenizer.json") {
            // tokenizer.json is the most critical — warn if missing
            std::cerr << "[HuggingFace] Failed to fetch tokenizer.json from any candidate repo for " << repoId << "\n";
        }
    }

    std::cout << "[HuggingFace] Tokenizer installation complete: " << totalDownloaded << " file(s) for " << repoId << "\n";
    return totalDownloaded;
}
