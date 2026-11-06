import {BrushToolSession} from './brush-tool-session';

/** Smear (R). Liquify, Blur and Smudge share the brush gesture; Tab steps the mode. */
export class BlurToolSession extends BrushToolSession {
	constructor(context: ConstructorParameters<typeof BrushToolSession>[0]) {
		super(context, 'blur');
	}
}
