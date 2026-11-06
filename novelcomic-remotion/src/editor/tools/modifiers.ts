import type {ToolKeyEvent, ToolModifiers} from './types';

export const emptyModifiers = (): ToolModifiers => ({shift: false, alt: false, meta: false, control: false, space: false});
export const modifiersFromPointer = (event: {shiftKey?: boolean; altKey?: boolean; metaKey?: boolean; ctrlKey?: boolean}, space = false): ToolModifiers => ({shift: Boolean(event.shiftKey), alt: Boolean(event.altKey), meta: Boolean(event.metaKey), control: Boolean(event.ctrlKey), space});
export class ModifierTracker {
	private value = emptyModifiers();
	update(event: Pick<KeyboardEvent, 'shiftKey' | 'altKey' | 'metaKey' | 'ctrlKey'>) { this.value = modifiersFromPointer(event, this.value.space); return this.value; }
	setSpace(space: boolean) { this.value = {...this.value, space}; return this.value; }
	snapshot() { return {...this.value}; }
	keyEvent(event: KeyboardEvent): ToolKeyEvent { return {key: event.key, modifiers: this.update(event), repeat: event.repeat}; }
}
