'use client';

import React from 'react';
import {useDocumentWorkspace} from './document-workspace-context';
import {BrushOptions, CloneOptions, HealingOptions} from './brush-options';
import {LassoOptions} from './lasso-options';
import {MarqueeOptions} from './marquee-options';
import {TransformOptions} from './transform-options';

import {getToolDefinition} from '../tools/tool-registry';

export const ToolOptionsBar: React.FC = () => {
	const {tool, maskAlone, setMaskAlone, maskBrush, setMaskBrush} =
		useDocumentWorkspace();
	const maskTool =
		tool === 'eraser' ||
		tool === 'blur' ||
		tool === 'smudge' ||
		tool === 'liquify';
	return (
		<div
			className={`flex shrink-0 items-center gap-3 border-b border-white/8 bg-[#242424] px-[18px] text-xs text-white/70 ${tool === 'move' ? 'h-[42px] flex-nowrap overflow-x-auto' : 'min-h-[42px] flex-wrap py-1.5'}`}
			aria-label="工具选项栏"
			data-testid="tool-options-bar"
		>
			{tool === 'move' ? null : (
			<span className="text-[13px] font-semibold text-white/90">
				{tool === 'marquee-rectangle' || tool === 'marquee-ellipse'
					? '选框'
					: tool === 'lasso' || tool === 'polygon-lasso'
						? '套索'
						: getToolDefinition(tool).label}
			</span>
			)}
			{tool === 'move' ? (
				<TransformOptions />
			) : tool === 'marquee-rectangle' || tool === 'marquee-ellipse' ? (
				<MarqueeOptions />
			) : tool === 'lasso' || tool === 'polygon-lasso' ? (
				<LassoOptions />
			) : tool === 'brush' ? (
				<BrushOptions />
			) : tool === 'healing' ? (
				<HealingOptions />
			) : tool === 'clone-stamp' ? (
				<CloneOptions />
			) : maskTool ? (
				<>
					<label className="flex items-center gap-1.5">
						Size
						<input
							className="h-6 w-16 rounded border border-white/10 bg-black/20 px-1.5 text-[11px]"
							type="number"
							min="1"
							value={maskBrush.size}
							onChange={(event) =>
								setMaskBrush({
									...maskBrush,
									size: Math.max(1, Number(event.target.value)),
								})
							}
						/>
					</label>
					<label className="flex items-center gap-1.5">
						Hardness
						<input
							className="h-6 w-16 rounded border border-white/10 bg-black/20 px-1.5 text-[11px]"
							type="number"
							min="0"
							max="100"
							value={Math.round(maskBrush.hardness * 100)}
							onChange={(event) =>
								setMaskBrush({
									...maskBrush,
									hardness: Math.max(
										0,
										Math.min(1, Number(event.target.value) / 100),
									),
								})
							}
						/>
					</label>
					<label className="flex items-center gap-1.5">
						Opacity
						<input
							className="h-6 w-16 rounded border border-white/10 bg-black/20 px-1.5 text-[11px]"
							type="number"
							min="1"
							max="100"
							value={Math.round(maskBrush.opacity * 100)}
							onChange={(event) =>
								setMaskBrush({
									...maskBrush,
									opacity: Math.max(
										0.01,
										Math.min(1, Number(event.target.value) / 100),
									),
								})
							}
						/>
					</label>
					<label className="flex items-center gap-1.5">
						<input
							type="checkbox"
							checked={maskAlone}
							onChange={(event) => setMaskAlone(event.target.checked)}
						/>
						Mask Alone
					</label>
				</>
			) : null}
			{tool === 'move' ? null : <div className="flex-1" />}
		</div>
	);
};
