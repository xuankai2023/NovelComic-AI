import {useTranslations} from 'next-intl';
import React, {memo, useCallback} from 'react';
import type {
	ImageBlendMode,
	ImageItem,
} from '../../items/image/image-item-type';
import {changeItem} from '../../state/actions/change-item';
import {useWriteContext} from '../../utils/use-context';
import {InspectorSubLabel} from '../components/inspector-label';

const BLEND_MODE_LABELS: Record<ImageBlendMode, string> = {
	normal: 'blendNormal',
	multiply: 'blendMultiply',
	screen: 'blendScreen',
	overlay: 'blendOverlay',
	darken: 'blendDarken',
	lighten: 'blendLighten',
	'color-dodge': 'blendColorDodge',
	'color-burn': 'blendColorBurn',
	'hard-light': 'blendHardLight',
	'soft-light': 'blendSoftLight',
	difference: 'blendDifference',
	exclusion: 'blendExclusion',
	hue: 'blendHue',
	saturation: 'blendSaturation',
	color: 'blendColor',
	luminosity: 'blendLuminosity',
};

const BLEND_MODES = Object.keys(BLEND_MODE_LABELS) as ImageBlendMode[];

const BlendModeControlsUnmemoized: React.FC<{item: ImageItem}> = ({item}) => {
	const t = useTranslations('editor.inspector');
	const {setState} = useWriteContext();

	const updateBlendMode = useCallback(
		(blendMode: ImageBlendMode) => {
			setState({
				update: (state) =>
					changeItem(state, item.id, (current) => {
						if (current.type !== 'image') {
							return current;
						}

						if (blendMode === 'normal') {
							const nextItem = {...current};
							delete nextItem.blendMode;
							return nextItem;
						}

						return {...current, blendMode};
					}),
				commitToUndoStack: true,
			});
		},
		[item.id, setState],
	);

	return (
		<div>
			<InspectorSubLabel>{t('controls.blendMode')}</InspectorSubLabel>
			<select
				className="editor-starter-field text-editor-starter-text-muted w-full px-2 py-2 text-xs"
				value={item.blendMode ?? 'normal'}
				onChange={(event) =>
					updateBlendMode(event.target.value as ImageBlendMode)
				}
				aria-label={t('controls.blendMode')}
			>
				{BLEND_MODES.map((mode) => (
					<option key={mode} value={mode}>
						{t(`controls.${BLEND_MODE_LABELS[mode]}`)}
					</option>
				))}
			</select>
		</div>
	);
};

export const BlendModeControls = memo(BlendModeControlsUnmemoized);
