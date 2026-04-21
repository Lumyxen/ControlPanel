#include "services/llamacpp_instance_registry.h"
#include "services/llamacpp_service.h"
#include "config/config.h"

#include <iostream>
#include <chrono>
#include <thread>
#include <algorithm>

namespace {
    constexpr int kDefaultMaxInstances = 4;
    constexpr int kDefaultKeepAliveMinutes = 5;
    constexpr int kCleanupIntervalSeconds = 30;
}

LlamaCppInstanceRegistry::LlamaCppInstanceRegistry(
    const std::string& modelsDir,
    const std::string& libsDir,
    Config& config)
    : modelsDir_(modelsDir),
      libsDir_(libsDir),
      config_(config),
      maxInstances_(kDefaultMaxInstances),
      idleTimeoutSeconds_(kDefaultKeepAliveMinutes * 60)
{
    // Pre-spawn one instance so the first request is fast.
    // Additional instances spawn on demand.
    auto inst = spawnInstance();
    if (inst) {
        auto now = std::chrono::steady_clock::now();
        pool_.push_back({inst, false, false, now});
    }

    // Start the background cleanup thread.
    cleanupThread_ = std::thread(&LlamaCppInstanceRegistry::runCleanupLoop, this);
}

LlamaCppInstanceRegistry::~LlamaCppInstanceRegistry() {
    shutdown();
}

// ── Public API ────────────────────────────────────────────────────────────────

std::shared_ptr<LlamaCppService> LlamaCppInstanceRegistry::acquire(int timeoutMs) {
  if (timeoutMs < 0) timeoutMs = 0;
  if (shuttingDown_.load()) {
        return nullptr;
    }

    std::unique_lock<std::mutex> lock(poolMutex_);

    // Re-check after lock acquisition (TOCTOU guard).
    if (shuttingDown_.load()) {
        return nullptr;
    }

    // Try to find an idle, non-removed instance.
    for (auto& entry : pool_) {
        if (!entry.inUse && !entry.removed) {
            entry.inUse = true;
            entry.lastUsed = std::chrono::steady_clock::now();
            return entry.instance;
        }
    }

    // Count only live (non-removed) entries to decide whether to spawn.
    int aliveCount = 0;
    for (const auto& entry : pool_) {
        if (!entry.removed) aliveCount++;
    }

    int limit = maxInstances_.load();
    if (aliveCount < limit) {
        auto inst = spawnInstance();
        if (inst) {
            auto now = std::chrono::steady_clock::now();
            pool_.push_back({inst, true, false, now});  // mark as in-use immediately
            return inst;
        }
        // spawn failed; fall through to wait
    }

    // Pool is at capacity; wait for an instance to be released.
    auto hasIdle = [this]() -> bool {
        for (auto& entry : pool_) {
            if (!entry.inUse && !entry.removed) return true;
        }
        return false;
    };

    if (timeoutMs == 0) {
        poolCv_.wait(lock, [this, &hasIdle]() {
            return shuttingDown_.load() || hasIdle();
        });
    } else {
        bool got = poolCv_.wait_for(lock, std::chrono::milliseconds(timeoutMs),
                                     [this, &hasIdle]() {
                                         return shuttingDown_.load() || hasIdle();
                                     });
        if (!got || shuttingDown_.load()) {
            return nullptr;
        }
    }

    if (shuttingDown_.load()) {
        return nullptr;
    }

    // After waking, find and claim the instance that became available.
    for (auto& entry : pool_) {
        if (!entry.inUse && !entry.removed) {
            entry.inUse = true;
            entry.lastUsed = std::chrono::steady_clock::now();
            return entry.instance;
        }
    }

    // Spurious wakeup + nothing available.
    return nullptr;
}

std::shared_ptr<LlamaCppService> LlamaCppInstanceRegistry::tryAcquireIdle() {
    if (shuttingDown_.load()) {
        return nullptr;
    }

    std::lock_guard<std::mutex> lock(poolMutex_);
    if (shuttingDown_.load()) {
        return nullptr;
    }

    for (auto& entry : pool_) {
        if (!entry.inUse && !entry.removed) {
            entry.inUse = true;
            entry.lastUsed = std::chrono::steady_clock::now();
            return entry.instance;
        }
    }

    return nullptr;
}

void LlamaCppInstanceRegistry::release(std::shared_ptr<LlamaCppService> instance) {
    if (!instance) return;

    std::unique_lock<std::mutex> lock(poolMutex_);
    for (auto& entry : pool_) {
        if (entry.instance == instance) {
            if (!entry.inUse) {
                // Already released or never acquired — ignore double-release.
                return;
            }
            entry.inUse = false;
            entry.lastUsed = std::chrono::steady_clock::now();
            poolCv_.notify_one();
            return;
        }
    }
    // Instance not found in pool; ignore (already removed during cleanup).
}

int LlamaCppInstanceRegistry::totalInstances() const {
    std::lock_guard<std::mutex> lock(poolMutex_);
    int count = 0;
    for (const auto& entry : pool_) {
        if (!entry.removed) count++;
    }
    return count;
}

int LlamaCppInstanceRegistry::busyInstances() const {
    std::lock_guard<std::mutex> lock(poolMutex_);
    int count = 0;
    for (const auto& entry : pool_) {
        if (!entry.removed && entry.inUse) count++;
    }
    return count;
}

int LlamaCppInstanceRegistry::idleInstances() const {
    std::lock_guard<std::mutex> lock(poolMutex_);
    int count = 0;
    for (const auto& entry : pool_) {
        if (!entry.removed && !entry.inUse) count++;
    }
    return count;
}

int LlamaCppInstanceRegistry::maxInstances() const {
    return maxInstances_.load();
}

LlamaCppInstanceRegistry::PoolStats LlamaCppInstanceRegistry::getPoolStats() const {
    std::lock_guard<std::mutex> lock(poolMutex_);
    PoolStats stats{};
    stats.maxInstances = maxInstances_.load();
    for (const auto& entry : pool_) {
        if (entry.removed) {
            stats.removedEntries++;
        } else {
            stats.total++;
            if (entry.inUse) stats.busy++;
            else stats.idle++;
        }
    }
    return stats;
}

void LlamaCppInstanceRegistry::setIdleTimeoutSeconds(int seconds) {
  idleTimeoutSeconds_.store(std::max(30, seconds));
}

bool LlamaCppInstanceRegistry::hasRemovedEntries() const {
  std::lock_guard<std::mutex> lock(poolMutex_);
  for (const auto& entry : pool_) {
    if (entry.removed) return true;
  }
  return false;
}

void LlamaCppInstanceRegistry::compactPool() {
    std::lock_guard<std::mutex> lock(poolMutex_);
    auto before = pool_.size();
    pool_.erase(
        std::remove_if(pool_.begin(), pool_.end(),
                       [](const PoolEntry& e) { return e.removed; }),
        pool_.end());
    if (pool_.size() != before) {
        std::cout << "[Pool] Compacted: " << before << " -> " << pool_.size()
                  << " entries (" << (before - pool_.size()) << " removed)\n";
    }
}

void LlamaCppInstanceRegistry::setMaxInstances(int max) {
    int clamped = std::max(1, max);
    maxInstances_.store(clamped);
    cleanupIdleInstances();
}

void LlamaCppInstanceRegistry::shutdown() {
    shuttingDown_.store(true);
    poolCv_.notify_all();
    cleanupCv_.notify_one();

    if (cleanupThread_.joinable()) {
        cleanupThread_.join();
    }

    std::lock_guard<std::mutex> lock(poolMutex_);
    for (auto& entry : pool_) {
        entry.inUse = false;
        entry.removed = true;
        entry.instance.reset();
    }
}

// ── Private helpers ───────────────────────────────────────────────────────────

std::shared_ptr<LlamaCppService> LlamaCppInstanceRegistry::spawnInstance() {
    try {
        auto inst = std::make_shared<LlamaCppService>(modelsDir_, libsDir_, config_);
        return inst;
    } catch (const std::exception& e) {
        std::cerr << "[LlamaCppInstanceRegistry] Failed to spawn instance: "
                  << e.what() << "\n";
        return nullptr;
    }
}

void LlamaCppInstanceRegistry::cleanupIdleInstances() {
    // Mark idle instances that haven't been used for longer than the timeout
    // and have no external references (use_count <= 1) as removed.
    // Physical removal from the vector is deferred to compactPool() to avoid
    // invalidating iterators during concurrent acquire()/release().
    std::lock_guard<std::mutex> lock(poolMutex_);
    const int timeoutSec = idleTimeoutSeconds_.load();
    const auto now = std::chrono::steady_clock::now();
    const auto cutoff = std::chrono::seconds(timeoutSec);

    for (auto& entry : pool_) {
        if (!entry.removed && !entry.inUse && entry.instance.use_count() <= 1) {
            auto idleDuration = now - entry.lastUsed;
            if (idleDuration >= cutoff) {
                entry.removed = true;
                entry.instance.reset();  // drop our reference so it's destroyed
            }
        }
    }
}

void LlamaCppInstanceRegistry::runCleanupLoop() {
  std::unique_lock<std::mutex> lock(cleanupMutex_);
  while (!shuttingDown_.load()) {
    // Wait for the cleanup interval or until shutdown is requested.
    cleanupCv_.wait_for(lock, std::chrono::seconds(kCleanupIntervalSeconds),
    [this]() { return shuttingDown_.load(); });

    if (shuttingDown_.load()) break;

    // Step 1: Mark expired idle instances as removed.
    cleanupIdleInstances();

    // Step 2: Compact the pool vector to remove soft-deleted entries only if needed.
    if (hasRemovedEntries()) {
      compactPool();
    }
  }
}
