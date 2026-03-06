// Connection monitoring module for backend health checks
// Dynamically use the current hostname to allow LAN access
const API_BASE = `${window.location.protocol}//${window.location.hostname}:1024`;

// Connection state
let isConnected = true;
let isOpenRouterAvailable = true;
let healthCheckInterval = null;
let openRouterCheckInterval = null;
let retryInterval = null;

// Callbacks for state changes
let onConnectionChange = null;
let onOpenRouterChange = null;

// Configuration
const HEALTH_CHECK_INTERVAL = 5000; // 5 seconds
const RETRY_INTERVAL = 3000; // 3 seconds

/**
 * Check if backend is connected
 * @returns {boolean}
 */
export function isBackendConnected() {
    return isConnected;
}

/**
 * Check if OpenRouter is available
 * @returns {boolean}
 */
export function isOpenRouterHealthy() {
    return isOpenRouterAvailable;
}

/**
 * Set callback for connection state changes
 * @param {function(boolean)} callback - called with new connection state
 */
export function setConnectionChangeCallback(callback) {
    onConnectionChange = callback;
}

/**
 * Set callback for OpenRouter state changes
 * @param {function(boolean)} callback - called with new OpenRouter availability
 */
export function setOpenRouterChangeCallback(callback) {
    onOpenRouterChange = callback;
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
 * Check OpenRouter availability via backend
 * @returns {Promise<boolean>}
 */
async function checkOpenRouterHealth() {
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000);
        
        const response = await fetch(`${API_BASE}/api/health/external`, {
            method: 'GET',
            signal: controller.signal
        });
        
        clearTimeout(timeoutId);
        
        if (!response.ok) {
            return false;
        }
        
        const data = await response.json();
        return data.openrouter === true;
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
 * Perform OpenRouter health check
 */
async function performOpenRouterCheck() {
    // Only check OpenRouter if backend is connected
    if (!isConnected) {
        if (isOpenRouterAvailable) {
            isOpenRouterAvailable = false;
            if (onOpenRouterChange) {
                onOpenRouterChange(false);
            }
        }
        return;
    }
    
    const wasAvailable = isOpenRouterAvailable;
    isOpenRouterAvailable = await checkOpenRouterHealth();
    
    if (wasAvailable !== isOpenRouterAvailable) {
        console.log(`[ConnectionMonitor] OpenRouter: ${isOpenRouterAvailable ? 'available' : 'unavailable'}`);
        if (onOpenRouterChange) {
            onOpenRouterChange(isOpenRouterAvailable);
        }
    }
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
    performOpenRouterCheck();
    
    // Start periodic health checks
    healthCheckInterval = setInterval(performHealthCheck, HEALTH_CHECK_INTERVAL);
    openRouterCheckInterval = setInterval(performOpenRouterCheck, HEALTH_CHECK_INTERVAL);
}

/**
 * Stop the connection monitoring
 */
export function stopMonitoring() {
    if (healthCheckInterval) {
        clearInterval(healthCheckInterval);
        healthCheckInterval = null;
    }
    if (openRouterCheckInterval) {
        clearInterval(openRouterCheckInterval);
        openRouterCheckInterval = null;
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