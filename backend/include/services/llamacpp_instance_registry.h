#pragma once

#include <string>
#include <vector>
#include <memory>
#include <mutex>
#include <atomic>
#include <optional>
#include <condition_variable>
#include <chrono>

class LlamaCppService;
class Config;

/**
 * Manages a pool of LlamaCppService instances to enable concurrent AI generations.
 *
 * Each instance is a fully independent LlamaCppService with its own model,
 * context, and inference mutex.  This allows multiple generations to run
 * simultaneously by spawning separate llama.cpp instances rather than
 * serializing through a single global instance.
 *
 * Strategy:
 *   - acquire(): returns an idle instance or spawns a new one (up to maxInstances)
 *   - release(): returns an instance to the pool for reuse
 *   - Instances that sit idle past the keep-alive timeout are destroyed
 */
class LlamaCppInstanceRegistry {
public:
    /**
     * @param modelsDir   Base directory for llama.cpp models
     * @param libsDir     Base directory for llama.cpp backend .so files
     * @param config      Shared configuration (hot-reloaded)
     */
    LlamaCppInstanceRegistry(const std::string& modelsDir,
                             const std::string& libsDir,
                             Config& config);
    ~LlamaCppInstanceRegistry();

    LlamaCppInstanceRegistry(const LlamaCppInstanceRegistry&)            = delete;
    LlamaCppInstanceRegistry& operator=(const LlamaCppInstanceRegistry&) = delete;

    /**
     * Acquire a LlamaCppService instance for a generation request.
     *
     * If an idle instance is available, it is returned immediately.
     * If all instances are busy and the pool hasn't reached maxInstances,
     * a new instance is spawned.
     * If the pool is at capacity, this blocks until an instance becomes free
     * (or returns nullptr if the registry is shutting down).
     *
     * @param timeoutMs  Max time to wait when pool is at capacity (0 = block indefinitely)
     * @return           A shared_ptr to the acquired instance (nullptr on timeout/shutdown)
     */
    std::shared_ptr<LlamaCppService> acquire(int timeoutMs = 0);

    /**
     * Acquire an already-idle instance without spawning a new one or waiting.
     * Returns nullptr immediately when all instances are busy.
     */
    std::shared_ptr<LlamaCppService> tryAcquireIdle();

    /**
     * Return an instance to the pool after use.
     * Safe to call multiple times; does nothing if the instance was already released.
     */
    void release(std::shared_ptr<LlamaCppService> instance);

    /**
     * Current statistics.
     */
    int  totalInstances()  const;   // alive + not removed (across all states)
    int  busyInstances()   const;   // currently acquired (doing inference)
    int  idleInstances()   const;   // available in the pool
    int  maxInstances()    const;   // configured upper limit

    /**
     * Snapshot of pool statistics for monitoring.
     */
    struct PoolStats {
        int total;
        int busy;
        int idle;
        int maxInstances;
        int removedEntries;  // soft-deleted entries pending compaction
    };
    PoolStats getPoolStats() const;

    /**
     * Update the max concurrent instances limit at runtime (from config reload).
     * Note: this is a soft cap for currently-busy entries; if the limit is
     * lowered while requests are in flight, the pool may temporarily exceed
     * the cap until those requests complete and instances become idle.
     */
    void setMaxInstances(int max);

    /**
     * Set the idle keep-alive timeout (in seconds).  Idle instances with no
     * external references that have been unused for longer than this duration
     * are automatically destroyed by the background cleanup thread.
     * Default: 300 seconds (5 minutes).
     */
    void setIdleTimeoutSeconds(int seconds);

/**
 * Compact the pool vector by removing all soft-deleted entries.
 * Called periodically by the cleanup thread; can also be called manually.
 */
  void compactPool();

  /**
   * Check if there are any soft-deleted entries pending compaction.
   * Used to avoid calling compactPool() unnecessarily.
   */
  bool hasRemovedEntries() const;

    /**
     * Shut down all instances and prevent new acquisitions.
     */
    void shutdown();

private:
    struct PoolEntry {
        std::shared_ptr<LlamaCppService> instance;
        bool inUse;
        bool removed;  // soft-delete flag for double-release safety
        std::chrono::steady_clock::time_point lastUsed;  // for idle timeout
    };

    std::string modelsDir_;
    std::string libsDir_;
    Config&     config_;

    mutable std::mutex  poolMutex_;
    std::vector<PoolEntry> pool_;

    std::atomic<bool> shuttingDown_{false};
    std::atomic<int>  maxInstances_{4};   // default cap
    std::atomic<int>  idleTimeoutSeconds_{300};  // 5 min default

    std::condition_variable poolCv_;

    // Background cleanup thread
    std::thread cleanupThread_;
    std::mutex  cleanupMutex_;
    std::condition_variable cleanupCv_;

    std::shared_ptr<LlamaCppService> spawnInstance();
    void cleanupIdleInstances();
    void runCleanupLoop();
};
