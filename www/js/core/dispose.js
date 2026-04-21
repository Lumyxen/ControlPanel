export function createDisposalBin() {
	const cleanups = [];

	return {
		add(cleanup) {
			if (typeof cleanup === 'function') cleanups.push(cleanup);
			return cleanup;
		},
		dispose() {
			while (cleanups.length > 0) {
				const cleanup = cleanups.pop();
				try {
					cleanup();
				} catch (error) {
					console.error('[dispose] cleanup failed', error);
				}
			}
		},
	};
}
