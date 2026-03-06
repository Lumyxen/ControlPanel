(function() {
	try {
		const ua = (navigator.userAgent || "").toLowerCase();
		if (ua.includes("ladybird")) {
			document.documentElement.setAttribute("data-browser", "ladybird");
			const note = document.getElementById("ladybird-note");
			if (note) {
				note.textContent = "❤️ Using Ladybird";
				note.style.opacity = "1";
			}
		}
	} catch {}
})();
