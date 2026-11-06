import {useEffect} from 'react';
import type {ImageItem} from '../../items/image/image-item-type';
import {
	TRANSFORM_TIMELINE_PROPERTIES,
	isTransformPropertyAnimated,
	type TransformTimelineProperty,
} from '../../motion/transform-property-timeline';
import {isEventTargetInputElement} from '../../utils/is-event-target-input-element';

const propertyForKey: Record<string, TransformTimelineProperty> = {
	a: 'anchorPoint',
	p: 'position',
	s: 'scale',
	r: 'rotation',
	t: 'opacity',
};

export const TransformPropertyShortcuts = ({
	selectedImage,
	onReveal,
}: {
	selectedImage: ImageItem | null;
	onReveal: (
		itemId: string,
		properties: readonly TransformTimelineProperty[],
	) => void;
}) => {
	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (
				!selectedImage ||
				isEventTargetInputElement(event) ||
				event.metaKey ||
				event.ctrlKey ||
				event.altKey
			)
				return;
			const key = event.key.toLowerCase();
			if (key === 'u') {
				event.preventDefault();
				onReveal(
					selectedImage.id,
					TRANSFORM_TIMELINE_PROPERTIES.filter((property) =>
						isTransformPropertyAnimated(
							selectedImage.motion?.transform,
							property,
						),
					),
				);
				return;
			}
			const property = propertyForKey[key];
			if (!property) return;
			event.preventDefault();
			onReveal(selectedImage.id, [property]);
		};
		window.addEventListener('keydown', onKeyDown);
		return () => window.removeEventListener('keydown', onKeyDown);
	}, [onReveal, selectedImage]);
	return null;
};
