import {
	AlertTriangle,
	Blend,
	Check,
	ChevronDown,
	Eye,
	Image as ImageIcon,
	Layers3,
	Scan,
	SquareCheck,
	SquareDashed,
} from 'lucide-react';
import React, {useEffect, useMemo, useRef, useState} from 'react';
import {clsx} from '../utils/clsx';
import {useFullState, useShots, useTracks} from '../utils/use-context';
import {
	type QualityPreviewMode,
	getQualityTrackPlan,
	summarizeQualityIssues,
	useQualityPreview,
} from './quality-preview';

const LABELS: Record<QualityPreviewMode, string> = {
	normal: 'Normal',
	source: 'Source',
	recomposed: 'Layers',
	overlay: 'Overlay',
	difference: 'Difference',
	checkerboard: 'Alpha',
	mask: 'Mask',
	'alpha-holes': 'Holes',
};

const MODES: readonly QualityPreviewMode[] = [
	'normal',
	'source',
	'recomposed',
	'overlay',
	'difference',
	'checkerboard',
	'mask',
	'alpha-holes',
];

const ModeIcon = ({mode}: {mode: QualityPreviewMode}) => {
	if (mode === 'source') return <ImageIcon size={13} />;
	if (mode === 'recomposed') return <Layers3 size={13} />;
	if (mode === 'difference') return <Blend size={13} />;
	if (mode === 'overlay') return <Scan size={13} />;
	if (mode === 'checkerboard') return <SquareDashed size={13} />;
	if (mode === 'mask') return <SquareCheck size={13} />;
	if (mode === 'alpha-holes') return <AlertTriangle size={13} />;
	return <Eye size={13} />;
};

export const QualityPreviewControls: React.FC = () => {
	const {mode, setMode, visibility, setVisibility} = useQualityPreview();
	const state = useFullState();
	const {tracks} = useTracks();
	const {shots} = useShots();
	const [isOpen, setIsOpen] = useState(false);
	const rootRef = useRef<HTMLDivElement>(null);
	const summary = useMemo(
		() => summarizeQualityIssues(state.undoableState),
		[state.undoableState],
	);
	const qualityPlan = useMemo(
		() => getQualityTrackPlan(tracks, shots, mode),
		[mode, shots, tracks],
	);
	const issueCount = summary.issues.length;

	useEffect(() => {
		if (!isOpen) return;
		const close = (event: PointerEvent) => {
			if (!rootRef.current?.contains(event.target as Node)) setIsOpen(false);
		};
		window.addEventListener('pointerdown', close);
		return () => window.removeEventListener('pointerdown', close);
	}, [isOpen]);

	return (
		<div ref={rootRef} className="ae-view-options">
			<button
				type="button"
				className="ae-view-options-trigger"
				onClick={() => setIsOpen((open) => !open)}
				aria-haspopup="menu"
				aria-expanded={isOpen}
				title="查看器显示与质量检查"
			>
				<ModeIcon mode={mode} />
				<span>{LABELS[mode]}</span>
				{issueCount > 0 ? <span className="ae-view-issue-dot" /> : null}
				<ChevronDown size={12} />
			</button>
			{isOpen ? (
				<div className="ae-view-options-menu" role="menu">
					<div className="ae-view-options-heading">View</div>
					{MODES.map((entry) => (
						<button
							key={entry}
							type="button"
							role="menuitemradio"
							aria-checked={mode === entry}
							className={clsx('ae-view-options-item', mode === entry && 'is-selected')}
							onClick={() => {
								setMode(entry);
								setIsOpen(false);
							}}
						>
							<ModeIcon mode={entry} />
							<span>{LABELS[entry]}</span>
							{entry === 'alpha-holes' && issueCount > 0 ? (
								<span className="ae-view-options-count">{issueCount}</span>
							) : mode === entry ? (
								<Check size={13} />
							) : null}
						</button>
					))}
					<div className="ae-view-options-divider" />
					<div className="ae-view-options-heading">Quality layers</div>
					{(
						[
							['source', 'Original'],
							['cleanPlate', 'Clean plate'],
							['cutouts', 'Cutouts'],
						] as const
					).map(([key, label]) => (
						<label key={key} className="ae-view-options-check">
							<input
								type="checkbox"
								checked={visibility[key]}
								onChange={(event) =>
									setVisibility((current) => ({
										...current,
										[key]: event.target.checked,
									}))
								}
							/>
							<span>{label}</span>
						</label>
					))}
					{qualityPlan.usesSourceFallback ? (
						<div className="ae-view-options-warning">
							Clean Plate 未完成，Normal 当前使用源图回退。
						</div>
					) : null}
				</div>
			) : null}
		</div>
	);
};
