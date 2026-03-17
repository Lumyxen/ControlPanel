// Connection monitoring UI - handles modal popups
import {
    startMonitoring,
    stopMonitoring,
    setConnectionChangeCallback,
    retryConnection,
    startAutoRetry,
    stopAutoRetry,
} from './connection-monitor.js';

// Modal state
let connectionModal = null;
let isConnectionModalVisible = false;

/**
 * Initialize connection monitoring
 * Call this early in app initialization
 */
export function initConnectionUI() {
    // Set up connection state change callbacks
    setConnectionChangeCallback(handleConnectionChange);
    
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