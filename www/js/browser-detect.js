(function () {
	try {
		const ua = (navigator.userAgent || "").toLowerCase();
		if (ua.includes("ladybird")) document.documentElement.dataset.browser = "ladybird";
		else if (ua.includes("firefox")) document.documentElement.dataset.browser = "firefox";
	} catch {}
})();
