const SNIPPETS = [
	{
		id: "code-dump",
		title: "Code Dump and Recovery",
		languages: ["PYTHON"],
		stats: {
			size: "6.6 KiB",
			lines: "202 lines"
		},
		description: "Export code to Markdown/JSON with project recovery.",
		fullDescription: "A comprehensive Python utility that recursively scans project directories and exports all code files to structured Markdown or JSON formats. Features intelligent file filtering via blacklist system, automatic directory tree generation, and complete project structure preservation for easy recovery and documentation.",
		features: [
			"Automatic directory tree generation using system tree command",
			"Dual export format: JSON with nested structure and Markdown with syntax highlighting",
			"Smart blacklist system for files and folders (configured in script)",
			"Full project restoration from either JSON or Markdown dumps",
			"Preserves complete directory structure and file hierarchy",
			"UTF-8 encoding with comprehensive error handling"
		],
		usage: `# Replace 'dev/' with the directory you put the script in
# Dump code from a directory
python dev/dump.py dump -d ./project

# Interactive mode (prompts for directory)
python dev/dump.py dump

# Restore from dump files (looks for project.json or project.md)
python dev/dump.py restore

# Restore to custom output directory
python dev/dump.py restore -o ./recovered_project`,
		links: [
			{
				label: "View on GitHub",
				url: "https://github.com/Lumyxen/Code-Dump",
				type: "github"
			},
			{
				label: "Download Script",
				url: "./assets/scripts/dump.py",
				type: "download"
			}
		]
	}
];

let currentSnippetIndex = -1;
let viewingSnippet = false;
let lastActiveEl = null;

function getViewerParts() {
	return {
		root: document.getElementById("code-viewer"),
		backdrop: document.getElementById("code-viewer-backdrop"),
		frame: document.getElementById("code-viewer-frame"),
		title: document.getElementById("code-viewer-title"),
		langs: document.getElementById("code-viewer-langs"),
		stats: document.getElementById("code-viewer-stats"),
		description: document.getElementById("code-viewer-description"),
		features: document.getElementById("code-viewer-features"),
		usage: document.getElementById("code-viewer-usage"),
		links: document.getElementById("code-viewer-links"),
		closeBtn: document.getElementById("code-viewer-close")
	};
}

function focusables(root) {
	return Array.from(
		root.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')
	).filter(el => !el.hasAttribute("disabled") && !el.getAttribute("aria-hidden") && el.offsetParent !== null);
}

function bindViewerKeys() {
	document.addEventListener("keydown", e => {
		if (!viewingSnippet) return;

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
			if (e.shiftTab) {
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
	const snippet = SNIPPETS[index];
	const { root, title, langs, stats, description, features, usage, links, closeBtn } = getViewerParts();

	if (!snippet || !root) return;

	currentSnippetIndex = index;
	viewingSnippet = true;
	lastActiveEl = document.activeElement;

	title.textContent = snippet.title;
	langs.innerHTML = snippet.languages.map(lang => `<span class="lang-pill">${lang}</span>`).join("");
	stats.innerHTML = `<span class="stat">${snippet.stats.size}</span><span class="stat-divider">•</span><span class="stat">${snippet.stats.lines}</span>`;
	description.textContent = snippet.fullDescription;

	if (snippet.features?.length) {
		features.innerHTML = `<h4>Features</h4><ul>${snippet.features.map(f => `<li>${f}</li>`).join("")}</ul>`;
	} else {
		features.innerHTML = "";
	}

	if (snippet.usage) {
		usage.innerHTML = `<h4>Usage</h4><pre><code>${escapeHtml(snippet.usage)}</code></pre>`;
	} else {
		usage.innerHTML = "";
	}

	if (snippet.links?.length) {
		links.innerHTML = snippet.links.map(link => `<a href="${link.url}" target="_blank" rel="noopener noreferrer" class="code-link ${link.type}">${link.label}</a>`).join("");
	} else {
		links.innerHTML = "";
	}

	root.hidden = false;
	document.documentElement.classList.add("no-scroll");
	closeBtn?.focus?.();

	bindViewerKeys();
}

function escapeHtml(text) {
	const div = document.createElement("div");
	div.textContent = text;
	return div.innerHTML;
}

function closeViewer() {
	const { root } = getViewerParts();
	if (!root || root.hidden) return;
	root.hidden = true;
	document.documentElement.classList.remove("no-scroll");
	viewingSnippet = false;
	currentSnippetIndex = -1;
	if (lastActiveEl?.focus) lastActiveEl.focus();
}

function createSnippetCard(snippet, index) {
	const card = document.createElement("article");
	card.className = "card code-card";
	card.dataset.cursor = "grow";
	card.dataset.index = String(index);
	card.tabIndex = 0;
	card.setAttribute("role", "button");
	card.setAttribute("aria-label", `View ${snippet.title}`);

	const thumb = document.createElement("div");
	thumb.className = "thumb code-thumb";
	thumb.setAttribute("aria-hidden", "true");
	thumb.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
		<polyline points="16 18 22 12 16 6"></polyline>
		<polyline points="8 6 2 12 8 18"></polyline>
	</svg>`;

	const body = document.createElement("div");
	body.className = "card-body";

	const title = document.createElement("h3");
	title.textContent = snippet.title;

	const meta = document.createElement("div");
	meta.className = "code-meta";

	const pills = document.createElement("div");
	pills.className = "lang-pills";
	pills.innerHTML = snippet.languages.map(lang => `<span class="lang-pill">${lang}</span>`).join("");

	const stats = document.createElement("div");
	stats.className = "code-stats";
	stats.innerHTML = `<span class="stat">${snippet.stats.size}</span><span class="stat-divider">•</span><span class="stat">${snippet.stats.lines}</span>`;

	meta.appendChild(pills);
	meta.appendChild(stats);

	const desc = document.createElement("p");
	desc.className = "quiet";
	desc.textContent = snippet.description;

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

export function initSnippetsPage() {
	const grid = document.getElementById("code-grid");
	if (!grid) return;

	const frag = document.createDocumentFragment();
	SNIPPETS.forEach((snippet, i) => frag.appendChild(createSnippetCard(snippet, i)));
	grid.replaceChildren(frag);

	initViewerWiring();
}
