import {useTranslations} from 'next-intl';
import React, {memo, useCallback, useMemo} from 'react';
import type {ImageAsset} from '../../assets/assets';
import type {ImageItem, ImageMaskMode} from '../../items/image/image-item-type';
import {changeItem} from '../../state/actions/change-item';
import {useAssets, useWriteContext} from '../../utils/use-context';
import {InspectorSubLabel} from '../components/inspector-label';

const MASK_MODE_LABELS: Record<ImageMaskMode, string> = {
	alpha: 'maskAlpha',
	luma: 'maskLuma',
	'inverse-alpha': 'maskInverseAlpha',
};

const MASK_MODES = Object.keys(MASK_MODE_LABELS) as ImageMaskMode[];

const MaskControlsUnmemoized: React.FC<{item: ImageItem}> = ({item}) => {
	const t = useTranslations('editor.inspector');
	const {assets} = useAssets();
	const {setState} = useWriteContext();

	const imageAssets = useMemo(
		() =>
			Object.values(assets)
				.filter((asset): asset is ImageAsset => asset.type === 'image')
				.sort((a, b) => a.filename.localeCompare(b.filename)),
		[assets],
	);

	const selectedMask = item.maskAssetId ? assets[item.maskAssetId] : undefined;
	const maskOptions = useMemo(() => {
		if (
			selectedMask &&
			selectedMask.type === 'image' &&
			!imageAssets.some((asset) => asset.id === selectedMask.id)
		) {
			return [selectedMask, ...imageAssets];
		}
		return imageAssets;
	}, [imageAssets, selectedMask]);

	const updateMaskAsset = useCallback(
		(maskAssetId: string) => {
			setState({
				update: (state) =>
					changeItem(state, item.id, (current) => {
						if (current.type !== 'image') {
							return current;
						}

						if (maskAssetId === 'none') {
							const nextItem = {...current};
							delete nextItem.maskAssetId;
							delete nextItem.maskMode;
							return nextItem;
						}

						return {
							...current,
							maskAssetId,
							maskMode: current.maskMode ?? 'alpha',
						};
					}),
				commitToUndoStack: true,
			});
		},
		[item.id, setState],
	);

	const updateMaskMode = useCallback(
		(maskMode: ImageMaskMode) => {
			setState({
				update: (state) =>
					changeItem(state, item.id, (current) => {
						if (current.type !== 'image' || !current.maskAssetId) {
							return current;
						}
						return {...current, maskMode};
					}),
				commitToUndoStack: true,
			});
		},
		[item.id, setState],
	);

	return (
		<div className="space-y-2">
			<div>
				<InspectorSubLabel>{t('controls.maskAsset')}</InspectorSubLabel>
				<select
					className="editor-starter-field text-editor-starter-text-muted w-full px-2 py-2 text-xs"
					value={item.maskAssetId ?? 'none'}
					onChange={(event) => updateMaskAsset(event.target.value)}
					aria-label={t('controls.maskAsset')}
				>
					<option value="none">{t('controls.noMask')}</option>
					{maskOptions.map((asset) => (
						<option key={asset.id} value={asset.id}>
							{asset.filename}
						</option>
					))}
				</select>
			</div>
			<div>
				<InspectorSubLabel>{t('controls.maskMode')}</InspectorSubLabel>
				<select
					className="editor-starter-field text-editor-starter-text-muted w-full px-2 py-2 text-xs disabled:opacity-50"
					value={item.maskMode ?? 'alpha'}
					onChange={(event) =>
						updateMaskMode(event.target.value as ImageMaskMode)
					}
					disabled={!item.maskAssetId}
					aria-label={t('controls.maskMode')}
				>
					{MASK_MODES.map((mode) => (
						<option key={mode} value={mode}>
							{t(`controls.${MASK_MODE_LABELS[mode]}`)}
						</option>
					))}
				</select>
			</div>
		</div>
	);
};

export const MaskControls = memo(MaskControlsUnmemoized);
