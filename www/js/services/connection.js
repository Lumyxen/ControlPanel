// Connection monitoring module for backend health checks
const API_BASE = "";

// Connection state
let isConnected = true;
let healthCheckInterval = null;
let retryInterval = null;

// Callbacks for state changes
let onConnectionChange = null;

// Configuration
export const HEALTH_CHECK_INTERVAL = 5000; // 5 seconds
export const RETRY_INTERVAL = 3000; // 3 seconds

/**
 * Check if backend is connected
 * @returns {boolean}
 */
export function isBackendConnected() {
    return isConnected;
}

/**
 * Set callback for connection state changes
 * @param {function(boolean)} callback - called with new connection state
 */
export function setConnectionChangeCallback(callback) {
    onConnectionChange = callback;
}

/**
 * Perform health check on backend
 * @returns {Promise<boolean>}
 */
async function checkBackendHealth() {
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);
        
        const response = await fetch(`${API_BASE}/health`, {
            method: 'GET',
            signal: controller.signal
        });
        
        clearTimeout(timeoutId);
        return response.ok;
    } catch (err) {
        return false;
    }
}

/**
 * Perform health check and update state
 */
async function performHealthCheck() {
    const wasConnected = isConnected;
    isConnected = await checkBackendHealth();
    
    if (wasConnected !== isConnected) {
        console.log(`[ConnectionMonitor] Backend connection: ${isConnected ? 'connected' : 'disconnected'}`);
        if (onConnectionChange) {
            onConnectionChange(isConnected);
        }
    }
    
    return isConnected;
}

/**
 * Start the connection monitoring
 */
export function startMonitoring() {
    if (healthCheckInterval) {
        console.log('[ConnectionMonitor] Already monitoring');
        return;
    }
    
    console.log('[ConnectionMonitor] Starting health checks');
    
    // Perform initial checks
    performHealthCheck();
    
    // Start periodic health checks
    healthCheckInterval = setInterval(performHealthCheck, HEALTH_CHECK_INTERVAL);
}

/**
 * Stop the connection monitoring
 */
export function stopMonitoring() {
    if (healthCheckInterval) {
        clearInterval(healthCheckInterval);
        healthCheckInterval = null;
    }
    if (retryInterval) {
        clearInterval(retryInterval);
        retryInterval = null;
    }
    console.log('[ConnectionMonitor] Stopped monitoring');
}

/**
 * Manual retry connection - returns promise that resolves when connected
 * @returns {Promise<boolean>}
 */
export async function retryConnection() {
    console.log('[ConnectionMonitor] Manual retry initiated');
    return await performHealthCheck();
}

/**
 * Start auto-retry mechanism
 * @param {function} onRetry - callback called on each retry attempt
 */
export function startAutoRetry(onRetry) {
    if (retryInterval) {
        clearInterval(retryInterval);
    }
    
    retryInterval = setInterval(async () => {
        const connected = await performHealthCheck();
        if (connected && retryInterval) {
            clearInterval(retryInterval);
            retryInterval = null;
        }
        if (onRetry) {
            onRetry(connected);
        }
    }, RETRY_INTERVAL);
}

/**
 * Stop auto-retry mechanism
 */
export function stopAutoRetry() {
    if (retryInterval) {
        clearInterval(retryInterval);
        retryInterval = null;
    }
}