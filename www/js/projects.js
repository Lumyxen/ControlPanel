const PROJECTS = [
	{
		id: "iro-engine",
		title: "Iro Engine",
		tags: ["C++", "VULKAN"],
		stats: {
			status: "In Development",
			year: "2024-2025"
		},
		description: "GUI-based game engine built with pure C++ and Vulkan.",
		fullDescription: "Iro Engine is a high-performance, GUI-driven game engine built from the ground up using pure C++ and Vulkan. Designed with a focus on performance optimization and usability, it minimizes external dependencies while providing a comprehensive toolset for game development. The engine features a custom rendering pipeline, intuitive editor interface, and efficient resource management systems.",
		features: [
			"Custom Vulkan rendering pipeline with modern graphics features",
			"Intuitive GUI-based editor for scene composition and asset management",
			"Minimal external dependencies for maximum performance",
			"Real-time scene editing with immediate visual feedback",
			"Efficient entity component system for game logic",
			"Cross-platform support with native performance",
			"Advanced material and shader system",
			"Built-in physics integration and collision detection"
		],
		technologies: [
			{
				category: "Core",
				items: ["C++23", "Vulkan API", "GLSL"]
			},
			{
				category: "Architecture",
				items: ["Entity Component System", "Custom Memory Allocators", "Multi-threaded Rendering"]
			},
			{
				category: "Tools",
				items: ["Make Build System"]
			}
		],
		links: [
			{
				label: "View on GitHub",
				url: "https://github.com/IroEngine/IroEngine",
				type: "github"
			}
		]
	}
];

let currentProjectIndex = -1;
let viewingProject = false;
let lastActiveEl = null;

function getViewerParts() {
	return {
		root: document.getElementById("project-viewer"),
		backdrop: document.getElementById("project-viewer-backdrop"),
		frame: document.getElementById("project-viewer-frame"),
		title: document.getElementById("project-viewer-title"),
		tags: document.getElementById("project-viewer-tags"),
		stats: document.getElementById("project-viewer-stats"),
		description: document.getElementById("project-viewer-description"),
		features: document.getElementById("project-viewer-features"),
		technologies: document.getElementById("project-viewer-technologies"),
		links: document.getElementById("project-viewer-links"),
		closeBtn: document.getElementById("project-viewer-close")
	};
}

function focusables(root) {
	return Array.from(
		root.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')
	).filter(el => !el.hasAttribute("disabled") && !el.getAttribute("aria-hidden") && el.offsetParent !== null);
}

function bindViewerKeys() {
	document.addEventListener("keydown", e => {
		if (!viewingProject) return;

		if (e.key === "Escape") {
			e.preventDefault();
			closeViewer();
			return;
		}

		if (e.key === "Tab") {
			const { root } = getViewerParts();
			if (!root) return;
			const list = focusables(root);
			if (!list.length) return;
			const first = list[0];
			const last = list[list.length - 1];
			if (e.shiftKey) {
				if (document.activeElement === first) {
					last.focus();
					e.preventDefault();
				}
			} else if (document.activeElement === last) {
				first.focus();
				e.preventDefault();
			}
		}
	});
}

async function openViewer(index) {
	const project = PROJECTS[index];
	const { root, title, tags, stats, description, features, technologies, links, closeBtn } = getViewerParts();

	if (!project || !root) return;

	currentProjectIndex = index;
	viewingProject = true;
	lastActiveEl = document.activeElement;

	title.textContent = project.title;
	tags.innerHTML = project.tags.map(tag => `<span class="lang-pill">${tag}</span>`).join("");
	stats.innerHTML = `<span class="stat">${project.stats.status}</span><span class="stat-divider">•</span><span class="stat">${project.stats.year}</span>`;
	description.textContent = project.fullDescription;

	if (project.features?.length) {
		features.innerHTML = `<h4>Features</h4><ul>${project.features.map(f => `<li>${f}</li>`).join("")}</ul>`;
	} else {
		features.innerHTML = "";
	}

	if (project.technologies?.length) {
		technologies.innerHTML = `<h4>Technologies</h4><div class="tech-grid">${project.technologies.map(tech => `<div class="tech-category"><h5>${tech.category}</h5><ul>${tech.items.map(item => `<li>${item}</li>`).join("")}</ul></div>`).join("")}</div>`;
	} else {
		technologies.innerHTML = "";
	}

	if (project.links?.length) {
		links.innerHTML = project.links.map(link => `<a href="${link.url}" target="_blank" rel="noopener noreferrer" class="code-link ${link.type}">${link.label}</a>`).join("");
	} else {
		links.innerHTML = "";
	}

	root.hidden = false;
	document.documentElement.classList.add("no-scroll");
	closeBtn?.focus?.();

	bindViewerKeys();
}

function closeViewer() {
	const { root } = getViewerParts();
	if (!root || root.hidden) return;
	root.hidden = true;
	document.documentElement.classList.remove("no-scroll");
	viewingProject = false;
	currentProjectIndex = -1;
	if (lastActiveEl?.focus) lastActiveEl.focus();
}

function createProjectCard(project, index) {
	const card = document.createElement("article");
	card.className = "card project-card";
	card.dataset.cursor = "grow";
	card.dataset.index = String(index);
	card.tabIndex = 0;
	card.setAttribute("role", "button");
	card.setAttribute("aria-label", `View ${project.title}`);

	const thumb = document.createElement("div");
	thumb.className = "thumb project-thumb";
	thumb.setAttribute("aria-hidden", "true");
	thumb.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
		<rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect>
		<line x1="8" y1="21" x2="16" y2="21"></line>
		<line x1="12" y1="17" x2="12" y2="21"></line>
	</svg>`;

	const body = document.createElement("div");
	body.className = "card-body";

	const title = document.createElement("h3");
	title.textContent = project.title;

	const meta = document.createElement("div");
	meta.className = "code-meta";

	const tagElements = document.createElement("div");
	tagElements.className = "lang-pills";
	tagElements.innerHTML = project.tags.map(tag => `<span class="lang-pill">${tag}</span>`).join("");

	const statsElements = document.createElement("div");
	statsElements.className = "code-stats";
	statsElements.innerHTML = `<span class="stat">${project.stats.status}</span><span class="stat-divider">•</span><span class="stat">${project.stats.year}</span>`;

	meta.appendChild(tagElements);
	meta.appendChild(statsElements);

	const desc = document.createElement("p");
	desc.className = "quiet";
	desc.textContent = project.description;

	body.appendChild(title);
	body.appendChild(meta);
	body.appendChild(desc);

	card.appendChild(thumb);
	card.appendChild(body);

	const open = () => openViewer(index);
	card.addEventListener("click", open);
	card.addEventListener("keydown", e => {
		if (e.key === "Enter" || e.key === " ") {
			e.preventDefault();
			open();
		}
	});

	return card;
}

function initViewerWiring() {
	const { backdrop, closeBtn } = getViewerParts();
	backdrop?.addEventListener("click", closeViewer);
	closeBtn?.addEventListener("click", closeViewer);
}

export function initProjectsPage() {
	const grid = document.getElementById("projects-grid");
	if (!grid) return;

	const frag = document.createDocumentFragment();
	PROJECTS.forEach((project, i) => frag.appendChild(createProjectCard(project, i)));
	grid.replaceChildren(frag);

	initViewerWiring();
}
