/** Command and Shift as the Move bar shows them. Keys held while typing do not count. */
export type HeldModifierFlags = {command: boolean; shift: boolean};

export const heldFlagsFor = (
	keys: {meta: boolean; shift: boolean},
	typing: boolean,
): HeldModifierFlags =>
	typing ? {command: false, shift: false} : {command: keys.meta, shift: keys.shift};

const typingTarget = (target: EventTarget | null) => {
	if (!(target instanceof Element)) return false;
	return Boolean(target.closest('input, textarea, select, [contenteditable="true"]'));
};

let flags: HeldModifierFlags = {command: false, shift: false};
const listeners = new Set<() => void>();

const setFlags = (next: HeldModifierFlags) => {
	if (next.command === flags.command && next.shift === flags.shift) return;
	flags = next;
	for (const listener of listeners) listener();
};

export const getHeldModifiers = () => flags;

export const subscribeHeldModifiers = (listener: () => void) => {
	listeners.add(listener);
	return () => listeners.delete(listener);
};

export const noteHeldModifiers = (
	keys: {metaKey: boolean; shiftKey: boolean},
	target: EventTarget | null,
) => {
	setFlags(heldFlagsFor({meta: keys.metaKey, shift: keys.shiftKey}, typingTarget(target)));
};

export const clearHeldModifiers = () => setFlags({command: false, shift: false});

export const resetHeldModifiers = () => {
	flags = {command: false, shift: false};
};
