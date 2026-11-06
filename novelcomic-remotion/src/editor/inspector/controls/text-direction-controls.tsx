import React, {memo, useCallback} from 'react';
import {useTranslations} from 'next-intl';
import {LeftToRightIcon} from '../../icons/left-to-right';
import {RightToLeftIcon} from '../../icons/right-to-left';
import {TextDirection} from '../../items/text/text-item-type';
import {changeItem} from '../../state/actions/change-item';
import {useWriteContext} from '../../utils/use-context';
import {InspectorSubLabel} from '../components/inspector-label';

const TextDirectionControlsUnmemoized: React.FC<{
	direction: TextDirection;
	itemId: string;
}> = ({direction, itemId}) => {
	const t = useTranslations('editor.inspector.controls');
	const {setState} = useWriteContext();

	const setDirection = useCallback(
		(newDirection: TextDirection) => {
			setState({
				update: (state) => {
					return changeItem(state, itemId, (i) => {
						if (i.type !== 'text' && i.type !== 'captions') {
							throw new Error(
								'Text direction can only be changed for text items',
							);
						}

						return {
							...i,
							direction: newDirection,
						};
					});
				},
				commitToUndoStack: true,
			});
		},
		[setState, itemId],
	);

	return (
		<div className="flex-1">
			<InspectorSubLabel>{t('direction')}</InspectorSubLabel>
			<div className="editor-starter-field inline-flex hover:border-transparent">
				<button
					onClick={() => setDirection('ltr')}
					data-active={direction === 'ltr'}
					className="editor-starter-focus-ring flex h-6 w-10 items-center justify-center rounded-[2px] text-editor-starter-text-muted data-[active=true]:bg-editor-starter-surface-active data-[active=true]:outline data-[active=true]:outline-editor-starter-border"
					title={t('leftToRight')}
					aria-label={t('leftToRight')}
				>
					<LeftToRightIcon />
				</button>
				<button
					onClick={() => setDirection('rtl')}
					data-active={direction === 'rtl'}
					className="editor-starter-focus-ring flex h-6 w-10 items-center justify-center rounded-[2px] text-editor-starter-text-muted data-[active=true]:bg-editor-starter-surface-active data-[active=true]:outline data-[active=true]:outline-editor-starter-border"
					title={t('rightToLeft')}
					aria-label={t('rightToLeft')}
				>
					<RightToLeftIcon />
				</button>
			</div>
		</div>
	);
};

export const TextDirectionControls = memo(TextDirectionControlsUnmemoized);
