import { initPhotosPage } from "./photos.js";
import { initSnippetsPage } from "./snippets.js";
import { initProjectsPage } from "./projects.js";
import { initAvailability } from "./availability.js";

export function initUX() {
    initEmailCopy();
    initParallax();
    initPhotosIfPresent();
    initSnippetsIfPresent();
    initProjectsIfPresent();
    initAvailability();
}

function initEmailCopy() {
    const container = document.querySelector(".contact-list");
    if (!container) return;

    container.querySelectorAll("p").forEach(p => {
        const emailLink = p.querySelector('a[href^="mailto:"]');
        const badge = p.querySelector(".mono");
        if (!emailLink || !badge) return;

        emailLink.addEventListener("click", e => {
            if (e.metaKey || e.ctrlKey) return;
            e.preventDefault();
            const text = emailLink.textContent.trim();

            const copy = async () => {
                try {
                    if (navigator.clipboard?.writeText) {
                        await navigator.clipboard.writeText(text);
                        return true;
                    }
                    const ta = document.createElement("textarea");
                    ta.value = text;
                    ta.style.position = "fixed";
                    ta.style.opacity = "0";
                    document.body.appendChild(ta);
                    ta.select();
                    const ok = document.execCommand("copy");
                    document.body.removeChild(ta);
                    return ok;
                } catch {
                    return false;
                }
            };

            copy().then(ok => {
                badge.textContent = ok ? "[copied]" : "[copy failed]";
                badge.style.opacity = "1";
                clearTimeout(badge.__t);
                badge.__t = setTimeout(() => {
                    badge.style.opacity = "0";
                }, 900);
            });
        });
    });
}

function initParallax() {
    if (initParallax.__done) return;
    const el = document.querySelector(".hero-ambient");
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!el || reduce) return;
    initParallax.__done = true;

    let targetX = 0;
    let targetY = 0;
    let raf = 0;

    const apply = () => {
        raf = 0;
        el.style.transform = `translate(${targetX}px, ${targetY}px)`;
    };

    addEventListener("mousemove", e => {
        targetX = (e.clientX / innerWidth - 0.5) * 4;
        targetY = (e.clientY / innerHeight - 0.5) * 4;
        if (!raf) raf = requestAnimationFrame(apply);
    }, { passive: true });
}

function initPhotosIfPresent() {
    if (document.getElementById("photo-grid")) initPhotosPage();
}

function initSnippetsIfPresent() {
    if (document.getElementById("code-grid")) initSnippetsPage();
}

function initProjectsIfPresent() {
    if (document.getElementById("projects-grid")) initProjectsPage();
}
