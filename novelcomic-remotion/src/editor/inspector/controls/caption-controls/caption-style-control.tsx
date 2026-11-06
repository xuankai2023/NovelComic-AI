import React, {memo, useCallback} from 'react';
import {useTranslations} from 'next-intl';
import {
	CAPTION_STYLE_TYPES,
	CaptionStyleType,
	normalizeCaptionStyle,
} from '../../../items/captions/captions-item-type';
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '../../../select';
import {changeItem} from '../../../state/actions/change-item';
import {useWriteContext} from '../../../utils/use-context';
import {InspectorSubLabel} from '../../components/inspector-label';

const CAPTION_STYLE_LABEL_KEYS: Record<CaptionStyleType, string> = {
	default: 'captionStyles.default',
	'colored-words': 'captionStyles.coloredWords',
	'scaling-words': 'captionStyles.scalingWords',
	'animated-background': 'captionStyles.animatedBackground',
};

const CaptionStyleControlUnmemoized: React.FC<{
	itemId: string;
	captionStyle: CaptionStyleType;
}> = ({itemId, captionStyle}) => {
	const t = useTranslations('editor.inspector');
	const {setState} = useWriteContext();

	const onValueChange = useCallback(
		(value: string) => {
			const nextStyle = normalizeCaptionStyle(value);

			setState({
				update: (state) => {
					return changeItem(state, itemId, (i) => {
						if (i.type !== 'captions') {
							throw new Error(
								'Caption style can only be changed for captions items',
							);
						}

						if (normalizeCaptionStyle(i.captionStyle) === nextStyle) {
							return i;
						}

						return {
							...i,
							captionStyle: nextStyle,
						};
					});
				},
				commitToUndoStack: true,
			});
		},
		[itemId, setState],
	);

	return (
		<div className="mt-2">
			<InspectorSubLabel>{t('controls.style')}</InspectorSubLabel>
			<Select value={captionStyle} onValueChange={onValueChange}>
				<SelectTrigger className="w-full">
					<SelectValue placeholder={t('controls.captionStyle')} />
				</SelectTrigger>
				<SelectContent className="w-full">
					{CAPTION_STYLE_TYPES.map((style) => {
						return (
							<SelectItem key={style} value={style}>
								{t(CAPTION_STYLE_LABEL_KEYS[style])}
							</SelectItem>
						);
					})}
				</SelectContent>
			</Select>
		</div>
	);
};

export const CaptionStyleControl = memo(CaptionStyleControlUnmemoized);
