import {MoreHorizontal} from 'lucide-react';
import React from 'react';
import {TransformPropertyInspector} from '../inspector/controls/transform-property-inspector';
import {useAllItems, useAssets, useSelectedItems} from '../utils/use-context';

const formatNumber = (value: number) =>
	Number.isInteger(value) ? String(value) : value.toFixed(1);

const EffectValue: React.FC<{
	label: string;
	value: string;
	animated?: boolean;
}> = ({label, value, animated = false}) => {
	return (
		<div className="ae-effect-property">
			<span>{label}</span>
			<span className="ae-effect-value">{value}</span>
			<span
				className={`ae-stopwatch ${animated ? 'active' : ''}`}
				title={
					animated
						? '该属性已有动画数据'
						: '关键帧编辑尚未接入，详见 docs/ae-layout-follow-up.md'
				}
				aria-label={animated ? `${label}已有动画数据` : `${label}关键帧待接入`}
			/>
		</div>
	);
};

export const CompositionEffectPanel: React.FC = () => {
	const {selectedItems} = useSelectedItems();
	const {items} = useAllItems();
	const {assets} = useAssets();
	const selectedItem =
		selectedItems.length === 1 ? items[selectedItems[0]] : null;

	const layerName = selectedItem
		? 'assetId' in selectedItem
			? (assets[selectedItem.assetId]?.filename ?? selectedItem.id)
			: selectedItem.type === 'text'
				? selectedItem.text || selectedItem.id
				: selectedItem.id
		: null;
	const transformKeyframes =
		selectedItem?.type === 'image'
			? (selectedItem.motion?.transform?.keyframes?.length ?? 0)
			: 0;

	return (
		<aside className="ae-effect-column" aria-label="效果控件">
			<div className="ae-panel-titlebar">
				<span>效果控件</span>
				<button
					type="button"
					title="效果控件面板菜单"
					aria-label="效果控件面板菜单"
				>
					<MoreHorizontal size={14} />
				</button>
			</div>
			{selectedItem && layerName ? (
				<>
					<div className="ae-effect-selected">
						<strong title={layerName}>{layerName}</strong>
						<small>
							{selectedItem.type} ·{' '}
							{transformKeyframes > 0 ? '已设置动画' : '基础属性'}
						</small>
					</div>
					{selectedItem.type === 'image' ? (
						<TransformPropertyInspector item={selectedItem} />
					) : (
						<div className="ae-effect-section">
						<div className="ae-effect-section-title">
							<span>▾</span>
							<strong>Transform</strong>
						</div>
						<EffectValue
							label="锚点"
							value="—"
							animated={transformKeyframes > 0}
						/>
						<EffectValue
							label="位置"
							value={`${formatNumber(selectedItem.left)}, ${formatNumber(selectedItem.top)}`}
							animated={transformKeyframes > 0}
						/>
						<EffectValue
							label="尺寸"
							value={`${formatNumber(selectedItem.width)} × ${formatNumber(selectedItem.height)}`}
							animated={transformKeyframes > 0}
						/>
						{'rotation' in selectedItem ? (
							<EffectValue
								label="旋转"
								value={`${formatNumber(selectedItem.rotation)}°`}
								animated={transformKeyframes > 0}
							/>
						) : null}
						<EffectValue
							label="不透明度"
							value={`${Math.round(selectedItem.opacity * 100)}%`}
							animated={transformKeyframes > 0}
						/>
						</div>
					)}
				</>
			) : (
				<div className="ae-effect-empty">
					<div>未选择图层</div>
					<small>从画布或时间线选择图层后查看属性</small>
				</div>
			)}
		</aside>
	);
};
