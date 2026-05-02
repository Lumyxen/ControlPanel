#pragma once

#include <chrono>
#include <deque>
#include <mutex>
#include <string>
#include <unordered_map>

class SlidingWindowRateLimiter {
public:
    bool isLimited(const std::string& key,
                   int limit,
                   std::chrono::seconds window) {
        std::lock_guard<std::mutex> lock(mutex_);
        auto& attempts = attempts_[key];
        pruneUnlocked(attempts, window);
        return static_cast<int>(attempts.size()) >= limit;
    }

    int recordFailure(const std::string& key,
                      std::chrono::seconds window) {
        std::lock_guard<std::mutex> lock(mutex_);
        auto& attempts = attempts_[key];
        pruneUnlocked(attempts, window);
        attempts.push_back(std::chrono::steady_clock::now());
        return static_cast<int>(attempts.size());
    }

    void clear(const std::string& key) {
        std::lock_guard<std::mutex> lock(mutex_);
        attempts_.erase(key);
    }

private:
    static void pruneUnlocked(std::deque<std::chrono::steady_clock::time_point>& attempts,
                              std::chrono::seconds window) {
        const auto cutoff = std::chrono::steady_clock::now() - window;
        while (!attempts.empty() && attempts.front() < cutoff) {
            attempts.pop_front();
        }
    }

    std::mutex mutex_;
    std::unordered_map<std::string, std::deque<std::chrono::steady_clock::time_point>> attempts_;
};
