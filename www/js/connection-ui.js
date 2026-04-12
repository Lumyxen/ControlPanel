// Connection monitoring UI - handles modal popups
import {
    startMonitoring,
    stopMonitoring,
    setConnectionChangeCallback,
    retryConnection,
    startAutoRetry,
    stopAutoRetry,
    RETRY_INTERVAL,
} from './connection-monitor.js';

// Modal state
let connectionModal = null;
let isConnectionModalVisible = false;
let countdownTimer = null;
let countdownValue = 0;
let countdownOverlayRef = null;
const RETRY_SECONDS = Math.round(RETRY_INTERVAL / 1000);

function updateCountdownDisplay() {
    if (!countdownOverlayRef) return;
    const statusText = countdownOverlayRef.querySelector('#conn-modal-status-text');
    if (!statusText) return;
    const sec = countdownValue;
    statusText.textContent = `Retrying automatically in ${sec} second${sec !== 1 ? 's' : ''}...`;
}

function startCountdown() {
    countdownValue = RETRY_SECONDS;
    updateCountdownDisplay();

    if (countdownTimer) clearInterval(countdownTimer);

    countdownTimer = setInterval(() => {
        countdownValue--;
        if (countdownValue <= 0) {
            countdownValue = RETRY_SECONDS;
        }
        updateCountdownDisplay();
    }, 1000);
}

function stopCountdown() {
    if (countdownTimer) {
        clearInterval(countdownTimer);
        countdownTimer = null;
    }
}

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
                <div class="connection-modal-icon error"><svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-globe-off-icon lucide-globe-off"><path d="M10.114 4.462A14.5 14.5 0 0 1 12 2a10 10 0 0 1 9.313 13.643"/><path d="M15.557 15.556A14.5 14.5 0 0 1 12 22 10 10 0 0 1 4.929 4.929"/><path d="M15.892 10.234A14.5 14.5 0 0 0 12 2a10 10 0 0 0-3.643.687"/><path d="M17.656 12H22"/><path d="M19.071 19.071A10 10 0 0 1 12 22 14.5 14.5 0 0 1 8.44 8.45"/><path d="M2 12h10"/><path d="m2 2 20 20"/></svg></div>
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
                <span id="conn-modal-status-text">Retrying automatically in ${RETRY_SECONDS} seconds...</span>
            </div>
        </div>
    `;

    document.body.appendChild(overlay);
    connectionModal = overlay;
    countdownOverlayRef = overlay;

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
            startCountdown();
        }
    });

    overlay.querySelector('#conn-modal-cancel').addEventListener('click', () => {
        stopAutoRetry();
        stopCountdown();
        hideConnectionModal();
    });

    // Show modal with animation
    requestAnimationFrame(() => {
        overlay.classList.add('visible');
    });

    isConnectionModalVisible = true;

    // Start countdown
    startCountdown();

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
    stopCountdown();

    connectionModal.classList.remove('visible');

    setTimeout(() => {
        if (connectionModal && connectionModal.parentNode) {
            connectionModal.parentNode.removeChild(connectionModal);
        }
        connectionModal = null;
        isConnectionModalVisible = false;
    }, 300);
}