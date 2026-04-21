export function bindQuickNewChat(startNewChat) {
	const quickNewChatBtn = document.getElementById('quickNewChat');
	if (!quickNewChatBtn) return () => {};
	const handleClick = (event) => {
		event.preventDefault();
		startNewChat();
	};
	quickNewChatBtn.addEventListener('click', handleClick);
	return () => quickNewChatBtn.removeEventListener('click', handleClick);
}
