import React from 'react';
import {useTranslations} from 'next-intl';
import {ClockIcon} from '../../../icons/clock';
import {changeItem} from '../../../state/actions/change-item';
import {updatePageDurationInMillseconds} from '../../../state/actions/update-page-duration';
import {useWriteContext} from '../../../utils/use-context';
import {InspectorSubLabel} from '../../components/inspector-label';
import {NumberControl, NumberControlUpdateHandler} from '../number-controls';

const PageDurationControlsUnmemoized: React.FC<{
	itemId: string;
	pageDurationInMilliseconds: number;
}> = ({pageDurationInMilliseconds, itemId}) => {
	const t = useTranslations('editor.inspector.controls');
	const {setState} = useWriteContext();

	const onPageDurationInMilliseconds: NumberControlUpdateHandler =
		React.useCallback(
			({num, commitToUndoStack}) => {
				setState({
					update: (state) => {
						return changeItem(state, itemId, (i) =>
							updatePageDurationInMillseconds({
								item: i,
								pageDurationInMilliseconds: num,
							}),
						);
					},
					commitToUndoStack,
				});
			},
			[setState, itemId],
		);

	return (
		<div>
			<InspectorSubLabel>{t('pageDuration')}</InspectorSubLabel>
			<div className="flex w-full flex-row gap-2">
				<div className="flex-1">
					<NumberControl
						label={
							<div className="flex items-center gap-1">
								<ClockIcon className="size-3" />
							</div>
						}
						setValue={onPageDurationInMilliseconds}
						value={pageDurationInMilliseconds}
						min={200}
						max={null}
						step={100}
						accessibilityLabel={t('pageDuration')}
					/>
				</div>
			</div>
		</div>
	);
};

export const PageDurationControls = React.memo(PageDurationControlsUnmemoized);
