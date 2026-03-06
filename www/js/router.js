import { initUX } from "./ux.js";
import { setActiveRoute } from "./nav-indicator.js";

export function initRouter() {
	const content = document.getElementById("content");
	const cache = new Map();
	let current = "";

	const currentRoute = () => {
		if (location.hash.startsWith("#/")) {
			const name = location.hash.slice(2).trim().toLowerCase();
			return name || "home";
		}
		return "home";
	};

	const pagePath = name => `pages/${name}.html`;

	const fetchFragment = async name => {
		if (cache.has(name)) return cache.get(name).content.cloneNode(true);
		try {
			const res = await fetch(pagePath(name), { cache: "no-cache" });
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const html = await res.text();
			const tpl = document.createElement("template");
			tpl.innerHTML = html.trim();
			cache.set(name, tpl);
			return tpl.content.cloneNode(true);
		} catch {
			if (name !== "home") return fetchFragment("home");
			const tpl = document.createElement("template");
			tpl.innerHTML = `<section><div class="wrap"><div class="block-text">Error</div><p class="quiet">Could not load content. Check pages/${name}.html.</p></div></section>`;
			return tpl.content;
		}
	};

	const setActiveNav = name => {
		document.querySelectorAll("#top-nav a[data-route]").forEach(a => {
			const isActive = a.dataset.route === name;
			if (isActive) a.setAttribute("aria-current", "page");
			else a.removeAttribute("aria-current");
		});
		const homeLink = document.querySelector("header .id a[data-route='home']");
		if (homeLink) {
			if (name === "home") homeLink.setAttribute("aria-current", "page");
			else homeLink.removeAttribute("aria-current");
		}
		setActiveRoute(name);
	};

	const setPageScrollMode = name => {
		const photos = name === "photos";
		document.documentElement.classList.toggle("photos-page", photos);
		document.body.classList.toggle("photos-page", photos);
	};

	const prefetchOnHover = () => {
		const add = a => {
			const name = a?.dataset?.route;
			if (!name) return;
			const fn = () => fetchFragment(name).catch(() => { });
			a.addEventListener("pointerenter", fn, { passive: true });
			a.addEventListener("focusin", fn, { passive: true });
		};
		document.querySelectorAll("#top-nav a[data-route], header .id a[data-route]").forEach(add);
	};

	const animateOut = () => new Promise(resolve => {
		const onEnd = e => {
			if (e.target !== content) return;
			content.removeEventListener("animationend", onEnd);
			resolve();
		};
		content.addEventListener("animationend", onEnd);
		content.classList.remove("page-enter");
		content.classList.add("page-exit");
		content.setAttribute("aria-busy", "true");
	});

	const render = async name => {
		if (current === name) return;
		await animateOut();
		const frag = await fetchFragment(name);
		content.replaceChildren(frag);

		setPageScrollMode(name);

		content.classList.remove("page-exit");
		content.classList.add("page-enter");
		content.setAttribute("aria-busy", "false");
		setActiveNav(name);
		scrollTo({ top: 0, behavior: "smooth" });
		initUX();
		current = name;
	};

	prefetchOnHover();
	render(currentRoute());
	addEventListener("hashchange", () => render(currentRoute()));
}
