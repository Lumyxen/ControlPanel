export function createChatSessionState() {
	return {
		editingNodeId: null,
		editingDraft: '',
		editingSaveMode: null,
		typingEl: null,
		typingTimeout: null,
		streamAbort: null,
		flushResponse: null,
		isGenerating: false,
		isTitleGenerating: false,
		liveGeneratingNode: null,
		activeTaskId: null,
		pendingReplyNodeId: null,
		pendingReplyIsFirst: false,
		isScrolledUp: false,
		isSubmitting: false,
	};
}
