import type { Attachment } from 'svelte/attachments';

export const longpress = (callback:(e:MouseEvent)=>void): Attachment<HTMLElement> => (node) => {
	const TIME_MS = 500;
	let timeoutPtr: number;
	function handleMouseDown(e:MouseEvent) {
		window.addEventListener('mousemove', handleMoveBeforeLong);
		timeoutPtr = window.setTimeout(() => {
			window.removeEventListener('mousemove', handleMoveBeforeLong);
			callback(e);
		}, TIME_MS);
	}
	function handleMoveBeforeLong(e:MouseEvent) {
		window.clearTimeout(timeoutPtr); 
		window.removeEventListener('mousemove', handleMoveBeforeLong);
	}
	function handleMouseUp(e:MouseEvent) {
		window.clearTimeout(timeoutPtr); 
		window.removeEventListener('mousemove', handleMoveBeforeLong);
	}
	node.addEventListener('mousedown', handleMouseDown);
	node.addEventListener('mouseup', handleMouseUp);
	return () => {
		node.removeEventListener('mousedown', handleMouseDown);
		node.removeEventListener('mouseup', handleMouseUp);
	};
};