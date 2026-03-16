// ctrlpanel/js/backend-suggest.js
//
// Shows a non-intrusive notification card in the top-right corner when the
// server detects faster GPU hardware with no matching backend built yet.
// Only shown on the AI chat page. Does NOT auto-dismiss on navigation.
//
// Clicking "Build" stores the pending build in sessionStorage, then navigates
// to Settings → Hardware Backend where the build runs with a real progress bar.

const BANNER_ID   = "gpu-backend-suggest-banner";
const PENDING_KEY = "ctrlpanel:pendingBackendBuild";

/**
 * Poll /api/llamacpp/backend and show the card if a better backend is available.
 * Only fires when the current route is the AI chat page.
 * Safe to call multiple times — only one card is ever shown.
 */
export async function checkAndSuggest() {
    const route = location.hash.replace(/^#\/?/, "");
    if (!route.includes("ai-chat")) return;
    if (document.getElementById(BANNER_ID)) return;

    try {
        const res  = await fetch("/api/llamacpp/backend");
        if (!res.ok) return;
        const data = await res.json();
        const suggest = Array.isArray(data.suggest) ? data.suggest : [];
        if (suggest.length === 0) return;

        const priority = ["cuda", "rocm", "vulkan"];
        const backend  = priority.find(b => suggest.includes(b)) || suggest[0];
        showBanner(backend, data);
    } catch { /* silently skip */ }
}

/**
 * Consume and return a pending build stored by the Build button.
 * Returns { backend, tag } or null.
 */
export function consumePendingBuild() {
    try {
        const raw = sessionStorage.getItem(PENDING_KEY);
        if (!raw) return null;
        sessionStorage.removeItem(PENDING_KEY);
        return JSON.parse(raw);
    } catch { return null; }
}

// ── Internal ──────────────────────────────────────────────────────────────────

const BACKEND_LABELS = { cuda: "NVIDIA CUDA", rocm: "AMD ROCm", vulkan: "Vulkan", cpu: "CPU" };

function dismissBanner() {
    const el = document.getElementById(BANNER_ID);
    if (!el) return;
    el.style.opacity   = "0";
    el.style.transform = "translateX(110%)";
    setTimeout(() => el.remove(), 300);
}

function showBanner(backend, initialData) {
    const label = BACKEND_LABELS[backend] || backend.toUpperCase();
    const tag   = initialData?.tag || "b8337";

    const el = document.createElement("div");
    el.id = BANNER_ID;
    el.innerHTML = `
        <div style="display:flex;align-items:flex-start;gap:10px;">
            <span style="font-size:1rem;flex-shrink:0;margin-top:1px;">⚡</span>
            <div style="flex:1;min-width:0;">
                <div style="font-weight:600;color:var(--text);font-size:0.85rem;margin-bottom:3px;">
                    ${label} GPU detected
                </div>
                <div style="color:var(--muted);font-size:0.8rem;line-height:1.4;">
                    Build the ${label} backend for faster local inference.
                </div>
                <div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap;">
                    <button id="gpu-suggest-build" style="
                        padding:4px 10px;font-size:0.78rem;cursor:pointer;
                        background:var(--accent);color:var(--bg);border:none;font:inherit;
                    ">Build</button>
                    <button id="gpu-suggest-dismiss" style="
                        padding:4px 10px;font-size:0.78rem;cursor:pointer;
                        background:transparent;color:var(--muted);
                        border:1px solid var(--border);font:inherit;
                    ">Dismiss</button>
                    <button id="gpu-suggest-never" style="
                        padding:4px 10px;font-size:0.78rem;cursor:pointer;
                        background:transparent;color:var(--muted);
                        border:none;font:inherit;opacity:0.7;
                    ">Don't show again</button>
                </div>
            </div>
            <button id="gpu-suggest-close" style="
                background:none;border:none;color:var(--muted);cursor:pointer;
                font-size:1.1rem;padding:0;line-height:1;flex-shrink:0;
            " aria-label="Close">×</button>
        </div>
    `;

    Object.assign(el.style, {
        position:   "fixed",
        top:        "16px",
        right:      "16px",
        zIndex:     "9000",
        width:      "min(300px, calc(100vw - 32px))",
        background: "var(--panel)",
        border:     "1px solid var(--border)",
        boxShadow:  "0 4px 20px rgba(0,0,0,0.25)",
        padding:    "12px 14px",
        fontSize:   "0.85rem",
        color:      "var(--text)",
        opacity:    "0",
        transform:  "translateX(110%)",
        transition: "opacity 0.25s ease, transform 0.25s ease",
    });

    document.body.appendChild(el);
    requestAnimationFrame(() => requestAnimationFrame(() => {
        el.style.opacity   = "1";
        el.style.transform = "translateX(0)";
    }));

    el.querySelector("#gpu-suggest-build").addEventListener("click", () => {
        try { sessionStorage.setItem(PENDING_KEY, JSON.stringify({ backend, tag })); } catch {}
        dismissBanner();
        const settingsRoute = "pages/settings.html";
        if (location.hash !== "#" + settingsRoute) {
            location.hash = settingsRoute;
        } else {
            window.dispatchEvent(new CustomEvent("ctrlpanel:checkPendingBuild"));
        }
    });

    el.querySelector("#gpu-suggest-dismiss").addEventListener("click", dismissBanner);
    el.querySelector("#gpu-suggest-close").addEventListener("click", dismissBanner);
    el.querySelector("#gpu-suggest-never").addEventListener("click", async () => {
        dismissBanner();
        try { await fetch("/api/llamacpp/backend/dismiss", { method: "POST" }); } catch {}
    });
}