'use client';

import React from 'react';
import {COLOR_RANGE_PREVIEW} from '../pixels/color-range';
import {
	displayedColorRangeMode,
	getColorRangeActions,
	getColorRangeActionsVersion,
	getColorRangeSettings,
	subscribeColorRangeSettings,
	updateColorRangeSettings,
	type ColorRangeSampleMode,
} from '../tools/color-range/color-range-settings';

const modes: Array<{id: ColorRangeSampleMode; label: string; title: string}> = [
	{id: 'replace', label: '取样', title: '点击画面，选取该颜色'},
	{id: 'add', label: '添加', title: '点击画面，把该颜色加入选区'},
	{id: 'remove', label: '去除', title: '点击画面，把该颜色从选区去掉'},
];

const clampFuzziness = (value: number) => Math.min(200, Math.max(0, Math.round(value) || 0));

export const ColorRangePanel: React.FC = () => {
	const settings = React.useSyncExternalStore(subscribeColorRangeSettings, getColorRangeSettings, getColorRangeSettings);
	const actionsVersion = React.useSyncExternalStore(
		subscribeColorRangeSettings,
		getColorRangeActionsVersion,
		getColorRangeActionsVersion,
	);
	const previewRef = React.useRef<HTMLCanvasElement>(null);
	const mode = displayedColorRangeMode(settings);
	const actions = actionsVersion >= 0 ? getColorRangeActions() : null;
	const preview = settings.preview;
	React.useEffect(() => {
		const canvas = previewRef.current;
		if (!canvas) return;
		const context = canvas.getContext('2d');
		if (!context) return;
		context.fillStyle = '#000';
		context.fillRect(0, 0, canvas.width, canvas.height);
		if (!preview) return;
		const image = context.createImageData(preview.width, preview.height);
		for (let index = 0; index < preview.data.length; index++) {
			const tone = preview.data[index] ?? 0;
			image.data[index * 4] = tone;
			image.data[index * 4 + 1] = tone;
			image.data[index * 4 + 2] = tone;
			image.data[index * 4 + 3] = 255;
		}
		context.putImageData(image, 0, 0);
	}, [preview]);
	const frame = preview
		? {
				width: preview.width / 2,
				height: preview.height / 2,
			}
		: COLOR_RANGE_PREVIEW;
	return (
		<div
			className="absolute top-3 right-3 z-20 w-[340px] rounded-md border border-white/15 bg-[#2b2c2f] p-4 text-xs text-white/80 shadow-2xl"
			role="dialog"
			aria-label="色彩范围"
		>
			<div className="flex gap-1" role="group" aria-label="取样方式">
				{modes.map((item) => (
					<button
						key={item.id}
						type="button"
						aria-pressed={mode === item.id}
						title={item.title}
						className="rounded px-2 py-1 aria-pressed:bg-white/20"
						onClick={() => updateColorRangeSettings({sampleMode: item.id})}
					>
						{item.label}
					</button>
				))}
			</div>
			<div className="mt-3 flex justify-center">
				<canvas
					ref={previewRef}
					width={preview?.width ?? 2}
					height={preview?.height ?? 2}
					className="bg-black"
					style={{width: frame.width, height: frame.height, maxWidth: '100%'}}
					aria-label="选区预览，白色为选中"
				/>
			</div>
			<p className="mt-3 text-white/45">
				{settings.include.length
					? '按住 Shift 添加颜色，按住 Option 去掉颜色。'
					: '点击画面，选取要选中的颜色。'}
			</p>
			<label className="mt-3 flex items-center gap-2" title="颜色和取样相差多少以内仍会被选中">
				<span className="shrink-0">颜色容差</span>
				<input
					aria-label="颜色容差"
					type="range"
					min="0"
					max="200"
					value={settings.fuzziness}
					onChange={(event) => updateColorRangeSettings({fuzziness: clampFuzziness(Number(event.target.value))})}
				/>
				<input
					aria-label="颜色容差数值"
					className="h-6 w-14 rounded border border-white/10 bg-black/20 px-1.5 text-right"
					type="number"
					min="0"
					max="200"
					value={settings.fuzziness}
					onChange={(event) => updateColorRangeSettings({fuzziness: clampFuzziness(Number(event.target.value))})}
				/>
			</label>
			<label className="mt-3 flex items-center gap-2" title="选中这些颜色以外的部分">
				<input
					type="checkbox"
					checked={settings.invert}
					onChange={(event) => updateColorRangeSettings({invert: event.target.checked})}
				/>
				反相
			</label>
			{settings.error ? <p className="mt-3 text-orange-300">{settings.error}</p> : null}
			<div className="mt-4 flex items-center justify-end gap-2 border-t border-white/10 pt-3">
				<button type="button" className="rounded px-2 py-1 hover:bg-white/10" onClick={() => actions?.cancel()}>
					取消
				</button>
				<button
					type="button"
					className="rounded bg-white/15 px-2 py-1 hover:bg-white/25 disabled:opacity-40"
					disabled={!actions}
					onClick={() => actions?.commit()}
				>
					确定
				</button>
			</div>
		</div>
	);
};
