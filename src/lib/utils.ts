import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
	return twMerge(clsx(inputs));
}

const INTERACTIVE_ELEMENT_SELECTOR = [
	'button',
	'a[href]',
	'input',
	'select',
	'textarea',
	'label',
	'[role="button"]',
	'[role="checkbox"]',
	'[role="menuitem"]',
	'[contenteditable="true"]',
].join(', ');

/** Returns true when an event bubbled from a nested interactive control. */
export function isEventFromInteractiveChild(event: Event): boolean {
	const { currentTarget, target } = event;
	if (!(currentTarget instanceof Element) || !(target instanceof Element) || target === currentTarget) {
		return false;
	}

	const interactiveElement = target.closest(INTERACTIVE_ELEMENT_SELECTOR);
	return interactiveElement !== null
		&& interactiveElement !== currentTarget
		&& currentTarget.contains(interactiveElement);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type WithoutChild<T> = T extends { child?: any } ? Omit<T, "child"> : T;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type WithoutChildren<T> = T extends { children?: any } ? Omit<T, "children"> : T;
export type WithoutChildrenOrChild<T> = WithoutChildren<WithoutChild<T>>;
export type WithElementRef<T, U extends HTMLElement = HTMLElement> = T & { ref?: U | null };
