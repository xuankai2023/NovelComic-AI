import React, {memo, useCallback} from 'react';
import {useTranslations} from 'next-intl';
import {TextAlignCenterIcon} from '../../icons/text-align-center';
import {TextAlignLeftIcon} from '../../icons/text-align-left';
import {TextAlignRightIcon} from '../../icons/text-align-right';
import {TextAlign} from '../../items/text/text-item-type';
import {changeItem} from '../../state/actions/change-item';
import {useWriteContext} from '../../utils/use-context';
import {InspectorSubLabel} from '../components/inspector-label';

const TextAlignmentControlsUnmemoized: React.FC<{
	align: TextAlign;
	itemId: string;
}> = ({align, itemId}) => {
	const t = useTranslations('editor.inspector');
	const {setState} = useWriteContext();

	const setAlign = useCallback(
		(newAlign: TextAlign) => {
			setState({
				update: (state) => {
					return changeItem(state, itemId, (i) => {
						if (i.type !== 'text' && i.type !== 'captions') {
							throw new Error('Text align can only be changed for text items');
						}

						return {
							...i,
							align: newAlign,
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
			<InspectorSubLabel>{t('controls.alignment')}</InspectorSubLabel>
			<div className="editor-starter-field inline-flex hover:border-transparent">
				<button
					onClick={() => setAlign('left')}
					data-active={align === 'left'}
					className="editor-starter-focus-ring flex h-6 w-10 items-center justify-center rounded-[2px] text-editor-starter-text data-[active=true]:bg-editor-starter-surface-active data-[active=true]:outline data-[active=true]:outline-editor-starter-border"
					title={t('actions.alignLeft')}
					aria-label={t('actions.alignLeft')}
				>
					<TextAlignLeftIcon />
				</button>
				<button
					onClick={() => setAlign('center')}
					data-active={align === 'center'}
					className="editor-starter-focus-ring flex h-6 w-10 items-center justify-center rounded-[2px] text-editor-starter-text data-[active=true]:bg-editor-starter-surface-active data-[active=true]:outline data-[active=true]:outline-editor-starter-border"
					title={t('actions.alignCenter')}
					aria-label={t('actions.alignCenter')}
				>
					<TextAlignCenterIcon />
				</button>
				<button
					onClick={() => setAlign('right')}
					data-active={align === 'right'}
					className="editor-starter-focus-ring flex h-6 w-10 items-center justify-center rounded-[2px] text-editor-starter-text data-[active=true]:bg-editor-starter-surface-active data-[active=true]:outline data-[active=true]:outline-editor-starter-border"
					title={t('actions.alignRight')}
					aria-label={t('actions.alignRight')}
				>
					<TextAlignRightIcon />
				</button>
			</div>
		</div>
	);
};

export const TextAlignmentControls = memo(TextAlignmentControlsUnmemoized);
