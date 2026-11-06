import {BrushToolSession} from './brush-tool-session';

/** Clone Stamp (S). Option-click sets the source; dragging copies from it. */
export class CloneStampToolSession extends BrushToolSession {
	constructor(context: ConstructorParameters<typeof BrushToolSession>[0]) {
		super(context, 'clone');
	}
}
