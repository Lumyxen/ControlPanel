#pragma once

#include <string>
#include <vector>
#include <functional>
#include <json/json.h>
#include <curl/curl.h>

struct HfModelInfo {
    std::string id;            // e.g. "bartowski/Qwen3-8B-GGUF"
    std::string name;          // e.g. "Qwen3-8B-GGUF"
    std::string author;        // e.g. "bartowski"
    std::string description;
    int downloads = 0;
    int likes = 0;
    std::string pipeline_tag;  // e.g. "text-generation", "image-text-to-text"
    std::vector<std::string> tags;
    std::vector<std::string> filenames; // list of .gguf files in the repo
    bool hasMmproj = false;
    bool hasTokenizer = false;
};

struct HfSearchFilters {
    std::string search;        // free-text search query
    std::string author;        // filter by author/organization
    std::string pipeline;      // e.g. "text-generation", "image-text-to-text"
    bool imageSupport = false; // models with vision capabilities
    bool audioSupport = false; // models with audio capabilities
    int limit = 20;            // max results
    std::string sort = "downloads"; // "downloads", "likes", "createdAt", "trending"
};

struct DownloadProgress {
    enum Status {
        InProgress,
        Completed,
        Failed
    };
    Status status = InProgress;
    std::string modelId;       // e.g. "bartowski/Qwen3-8B-GGUF"
    std::string directoryName; // e.g. "qwen3-8b"
    long long totalBytes = 0;
    long long downloadedBytes = 0;
    long long completedBytesFromPreviousFiles = 0; // bytes from already-completed files in multi-file download
    std::string currentFile;   // current file being downloaded
    int filesDownloaded = 0;
    int totalFiles = 0;
    std::string errorMessage;
    double percent() const {
        return totalBytes > 0 ? (100.0 * downloadedBytes / totalBytes) : 0.0;
    }
};

struct DownloadJob {
    enum Status { Idle, InProgress, Completed, Failed };
    std::string id;            // unique job ID
    std::string modelId;
    std::string directoryName;
    Status status = Idle;
    long long totalBytes = 0;
    long long downloadedBytes = 0;
    std::string currentFile;
    int filesDownloaded = 0;
    int totalFiles = 0;
    std::string errorMessage;
    double percent() const {
        return totalBytes > 0 ? (100.0 * downloadedBytes / totalBytes) : 0.0;
    }
};

class HuggingFaceService {
public:
    HuggingFaceService();
    ~HuggingFaceService();

    // Search models on HuggingFace
    Json::Value searchModels(const HfSearchFilters& filters) const;

    // Get detailed info about a specific model repo including file list
    Json::Value getModelInfo(const std::string& modelId) const;

    // List all files in a model repo
    std::vector<std::string> listModelFiles(const std::string& modelId) const;

    // Start async download — returns a job ID immediately
    // If ggufPath is empty, auto-selects the best quantisation
    std::string startDownload(
        const std::string& modelId,
        const std::string& directoryName,
        const std::string& modelsDir,
        const std::string& ggufPath = "",
        const std::string& mmprojPath = "",
        const std::string& tokenizerPath = ""
    );

    // Get status of a download job
    DownloadJob getDownloadStatus(const std::string& jobId) const;

    // List all download jobs
    std::vector<DownloadJob> listDownloads() const;

    // Cancel a running download
    void cancelDownload(const std::string& jobId);

    // Install tokenizer files for a model via /resolve/main/ URLs.
    // Tries the given repo first, then falls back to common base model repos.
    // Returns the number of files downloaded.
    int installTokenizer(const std::string& repoId, const std::string& cacheDir) const;

    // Clean up completed jobs older than 5 min
    void cleanupOldJobs();

private:
    mutable std::mutex jobsMutex_;
    std::map<std::string, DownloadJob> jobs_;

    // Internal: runs in background thread
    void downloadWorker(std::string jobId, std::string modelId, std::string dirName,
                        std::string modelsDir, std::string ggufPath,
                        std::string mmprojPath, std::string tokenizerPath);

    mutable std::string cancelToken_; // simple cancellation flag

    // Internal helpers
    static size_t writeCallback(void* contents, size_t size, size_t nmemb, void* userp);
    static int progressCallback(void* clientp, curl_off_t dltotal, curl_off_t dlnow, curl_off_t ultotal, curl_off_t ulnow);

    std::string makeRequest(const std::string& url, long timeout = 30) const;
    bool downloadFile(const std::string& url, const std::string& destPath,
                      std::function<void(const DownloadProgress&)> progressCb,
                      DownloadProgress& progress) const;
};
