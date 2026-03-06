// Connection monitoring UI - handles modal popups and demo mode initialization
import {
    startMonitoring,
    stopMonitoring,
    setConnectionChangeCallback,
    setOpenRouterChangeCallback,
    retryConnection,
    startAutoRetry,
    stopAutoRetry,
    isBackendConnected,
} from './connection-monitor.js';
import { initDemoMode, isDemoEnabled } from './demo-mode.js';

// Modal state
let connectionModal = null;
let openRouterModal = null;
let isConnectionModalVisible = false;
let isOpenRouterModalVisible = false;

/**
 * Initialize connection monitoring and demo mode
 * Call this early in app initialization
 */
export function initConnectionUI() {
    // Initialize demo mode first (checks URL params)
    initDemoMode();
    
    // If in demo mode, skip connection monitoring
    if (isDemoEnabled()) {
        console.log('[ConnectionUI] Demo mode active - skipping connection monitoring');
        return;
    }
    
    // Set up connection state change callbacks
    setConnectionChangeCallback(handleConnectionChange);
    setOpenRouterChangeCallback(handleOpenRouterChange);
    
    // Start monitoring
    startMonitoring();
    
    console.log('[ConnectionUI] Connection monitoring initialized');
}

/**
 * Handle backend connection state changes
 * @param {boolean} isConnected - new connection state
 */
function handleConnectionChange(isConnected) {
    if (isConnected) {
        // Connection restored
        hideConnectionModal();
    } else {
        // Connection lost
        showConnectionModal();
    }
}

/**
 * Handle OpenRouter availability changes
 * @param {boolean} isAvailable - new availability state
 */
function handleOpenRouterChange(isAvailable) {
    if (isAvailable) {
        // OpenRouter available
        hideOpenRouterModal();
    } else {
        // OpenRouter unavailable
        showOpenRouterModal();
    }
}

/**
 * Create and show the connection lost modal
 */
function showConnectionModal() {
    if (isConnectionModalVisible) return;
    
    // Remove existing modal if any
    hideConnectionModal();
    
    const overlay = document.createElement('div');
    overlay.className = 'connection-modal-overlay';
    overlay.id = 'connection-modal';
    
    overlay.innerHTML = `
        <div class="connection-modal">
            <div class="connection-modal-header">
                <div class="connection-modal-icon error">📡</div>
                <h3 class="connection-modal-title">Connection Lost</h3>
            </div>
            <p class="connection-modal-message">
                Lost connection to backend server. The application requires a connection to function properly.
            </p>
            <div class="connection-modal-actions">
                <button class="connection-modal-button secondary" id="conn-modal-cancel">Cancel</button>
                <button class="connection-modal-button primary" id="conn-modal-retry">Retry Connection</button>
            </div>
            <div class="connection-modal-status">
                <span class="connection-modal-status-dot reconnecting"></span>
                <span id="conn-modal-status-text">Auto-retrying every 3 seconds...</span>
            </div>
        </div>
    `;
    
    document.body.appendChild(overlay);
    connectionModal = overlay;
    
    // Add event listeners
    overlay.querySelector('#conn-modal-retry').addEventListener('click', async () => {
        const statusText = overlay.querySelector('#conn-modal-status-text');
        const statusDot = overlay.querySelector('.connection-modal-status-dot');
        statusText.textContent = 'Retrying now...';
        statusDot.className = 'connection-modal-status-dot reconnecting';
        
        const connected = await retryConnection();
        if (connected) {
            hideConnectionModal();
        } else {
            statusText.textContent = 'Still disconnected. Auto-retrying every 3 seconds...';
        }
    });
    
    overlay.querySelector('#conn-modal-cancel').addEventListener('click', () => {
        stopAutoRetry();
        hideConnectionModal();
    });
    
    // Show modal with animation
    requestAnimationFrame(() => {
        overlay.classList.add('visible');
    });
    
    isConnectionModalVisible = true;
    
    // Start auto-retry
    startAutoRetry((connected) => {
        if (connected) {
            hideConnectionModal();
        }
    });
}

/**
 * Hide the connection modal
 */
function hideConnectionModal() {
    if (!connectionModal) return;
    
    stopAutoRetry();
    
    connectionModal.classList.remove('visible');
    
    setTimeout(() => {
        if (connectionModal && connectionModal.parentNode) {
            connectionModal.parentNode.removeChild(connectionModal);
        }
        connectionModal = null;
        isConnectionModalVisible = false;
    }, 300);
}

/**
 * Create and show the OpenRouter unavailable modal
 */
function showOpenRouterModal() {
    if (isOpenRouterModalVisible) return;
    
    // Remove existing modal if any
    hideOpenRouterModal();
    
    const overlay = document.createElement('div');
    overlay.className = 'connection-modal-overlay';
    overlay.id = 'openrouter-modal';
    
    overlay.innerHTML = `
        <div class="connection-modal">
            <div class="connection-modal-header">
                <div class="connection-modal-icon warning">⚠️</div>
                <h3 class="connection-modal-title">OpenRouter API Unavailable</h3>
            </div>
            <p class="connection-modal-message">
                The OpenRouter API is currently unreachable. AI chat features may not work properly.
            </p>
            <div class="connection-modal-note">
                💡 Note: Local features like settings and prompt templates will continue to work.
            </div>
            <div class="connection-modal-actions">
                <button class="connection-modal-button secondary" id="or-modal-dismiss">Dismiss</button>
                <button class="connection-modal-button primary" id="or-modal-retry">Retry Connection</button>
            </div>
            <div class="connection-modal-status">
                <span class="connection-modal-status-dot offline"></span>
                <span id="or-modal-status-text">OpenRouter API offline</span>
            </div>
        </div>
    `;
    
    document.body.appendChild(overlay);
    openRouterModal = overlay;
    
    // Add event listeners
    overlay.querySelector('#or-modal-retry').addEventListener('click', async () => {
        const statusText = overlay.querySelector('#or-modal-status-text');
        const statusDot = overlay.querySelector('.connection-modal-status-dot');
        statusText.textContent = 'Checking OpenRouter status...';
        statusDot.className = 'connection-modal-status-dot reconnecting';
        
        // Trigger a health check
        const event = new CustomEvent('checkOpenRouterHealth');
        window.dispatchEvent(event);
    });
    
    overlay.querySelector('#or-modal-dismiss').addEventListener('click', () => {
        hideOpenRouterModal();
    });
    
    // Show modal with animation
    requestAnimationFrame(() => {
        overlay.classList.add('visible');
    });
    
    isOpenRouterModalVisible = true;
}

/**
 * Hide the OpenRouter modal
 */
function hideOpenRouterModal() {
    if (!openRouterModal) return;
    
    openRouterModal.classList.remove('visible');
    
    setTimeout(() => {
        if (openRouterModal && openRouterModal.parentNode) {
            openRouterModal.parentNode.removeChild(openRouterModal);
        }
        openRouterModal = null;
        isOpenRouterModalVisible = false;
    }, 300);
}

/**
 * Manually check connection status
 * @returns {boolean}
 */
export function checkConnection() {
    return isBackendConnected();
}

/**
 * Clean up connection monitoring on app shutdown
 */
export function cleanupConnectionUI() {
    stopMonitoring();
    hideConnectionModal();
    hideOpenRouterModal();
}
