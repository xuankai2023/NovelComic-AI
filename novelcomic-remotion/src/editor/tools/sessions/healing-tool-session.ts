import {BrushToolSession} from './brush-tool-session';

/** Spot Healing Brush (J). The gesture is the brush's; the pixels come from nearby texture. */
export class HealingToolSession extends BrushToolSession {
	constructor(context: ConstructorParameters<typeof BrushToolSession>[0]) {
		super(context, 'healing');
	}
}
