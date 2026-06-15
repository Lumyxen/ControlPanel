const DEFAULT_ROUTE = "pages/ai-chat.html";
export const normalise = (hash) => hash.replace(/^#\/?/, "");
export const currentRoute = () => normalise(location.hash) || DEFAULT_ROUTE;

export function getRouteChatId(route) {
	try {
		return new URLSearchParams(route.split("?")[1] || "").get("chat");
	} catch {
		return null;
	}
}

export function navigateTo(route) {
	location.hash = route;
}

export function createHashRouter(onChange) {
	const handleChange = () => onChange(currentRoute());
	return {
		start() {
			window.addEventListener('hashchange', handleChange);
			handleChange();
		},
		stop() {
			window.removeEventListener('hashchange', handleChange);
		},
	};
}
