/**
 * settings-store.js
 *
 * Reactive singleton store for backend settings.
 *
 * Usage:
 *   import * as SettingsStore from './settings-store.js';
 *
 *   // Load once on startup (idempotent afterwards)
 *   await SettingsStore.init();
 *
 *   // Read the cached value at any time (synchronous, never null after init)
 *   const s = SettingsStore.get();
 *
 *   // Save a partial update – merges with current cache, PUTs to backend, notifies subscribers
 *   await SettingsStore.save({ temperature: 0.8 });
 *
 *   // Subscribe to every change (initial + updates)
 *   const unsub = SettingsStore.subscribe(settings => console.log(settings));
 *   unsub(); // call the returned function to stop listening
 */

import { getSettings, updateSettings } from './api.js';

// ─── internal state ──────────────────────────────────────────────────────────

/** @type {Object|null} */
let _cache = null;

/** Whether an initial load has completed */
let _ready = false;

/** Pending promise for the in-flight init (avoids duplicate fetches) */
let _initPromise = null;

/** Set of subscriber callbacks */
const _subscribers = new Set();

/** ID returned by setInterval so we can cancel polling */
let _pollTimerId = null;

/** Timestamp of the last successful save – used to suppress false-positive poll notifications */
let _lastSaveAt = 0;

const POLL_INTERVAL_MS = 10_000; // check for external file edits every 10 s

// ─── helpers ─────────────────────────────────────────────────────────────────

function _notify() {
    _subscribers.forEach((fn) => {
        try { fn(_cache); } catch (e) { console.error('[SettingsStore] subscriber error', e); }
    });
}

/** Deep-compare two plain objects by JSON serialisation (good enough for small settings objects) */
function _changed(a, b) {
    return JSON.stringify(a) !== JSON.stringify(b);
}

// ─── public API ──────────────────────────────────────────────────────────────

/**
 * Fetch settings from the backend and populate the cache.
 * Safe to call multiple times – subsequent calls while a fetch is in flight share the same promise.
 * @returns {Promise<Object>}
 */
export async function init() {
    if (_ready) return _cache;
    if (_initPromise) return _initPromise;

    _initPromise = (async () => {
        try {
            const settings = await getSettings();
            _cache = settings ?? {};
        } catch (err) {
            console.warn('[SettingsStore] Failed to load settings on init – using defaults:', err);
            _cache = _cache ?? {};
        }
        _ready = true;
        _initPromise = null;
        _notify();
        return _cache;
    })();

    return _initPromise;
}

/**
 * Return the currently cached settings (may be null before init() resolves).
 * @returns {Object|null}
 */
export function get() {
    return _cache;
}

/**
 * Save a partial settings object. Merges with the current cache, PUTs to the
 * backend, updates the cache, and notifies all subscribers.
 * @param {Object} patch - Fields to update
 * @returns {Promise<Object>} The updated settings object returned by the backend
 */
export async function save(patch) {
    const merged = { ..._cache, ...patch };
    const updated = await updateSettings(merged);
    _cache = updated ?? merged;
    _lastSaveAt = Date.now();
    _notify();
    return _cache;
}

/**
 * Register a callback that fires immediately with the current cache (if ready)
 * and on every subsequent change.
 * @param {function(Object): void} fn
 * @returns {function(): void} Unsubscribe function
 */
export function subscribe(fn) {
    _subscribers.add(fn);
    if (_ready && _cache !== null) {
        try { fn(_cache); } catch (e) { /* ignore */ }
    }
    return () => _subscribers.delete(fn);
}

/**
 * Start background polling so external edits to settings.json are reflected
 * in the frontend without a page reload.
 * Safe to call multiple times – only one interval is ever running.
 */
export function startPolling() {
    if (_pollTimerId !== null) return;
    _pollTimerId = setInterval(async () => {
        // Suppress polls that fire within 2 s of a save we initiated (avoids echo)
        if (Date.now() - _lastSaveAt < 2_000) return;
        try {
            const fresh = await getSettings();
            if (fresh && _changed(_cache, fresh)) {
                _cache = fresh;
                _notify();
            }
        } catch {
            // Network might be briefly unavailable – silently skip
        }
    }, POLL_INTERVAL_MS);
}