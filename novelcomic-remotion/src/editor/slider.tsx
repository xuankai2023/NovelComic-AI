import React, {useRef} from 'react';

interface SliderProps {
	value: number;
	onValueChange: (value: number, commitToUndoStack: boolean) => void;
	min?: number;
	max?: number;
	step?: number;
	className?: string;
	title: string;
}

export const Slider: React.FC<SliderProps> = ({
	value,
	onValueChange,
	min = 0,
	max = 100,
	step = 1,
	className = '',
	title,
}) => {
	const ref = useRef<HTMLInputElement>(null);
	const handleChange = React.useCallback(
		(e: React.ChangeEvent<HTMLInputElement>) => {
			onValueChange(Number(e.target.value), false);
		},
		[onValueChange],
	);

	const handlePointerDown = React.useCallback(() => {
		window.addEventListener(
			'pointerup',
			() => {
				onValueChange(Number(ref.current?.value), true);
			},
			{once: true},
		);
	}, [onValueChange]);

	const percentage = ((value - min) / (max - min)) * 100;

	return (
		<div
			className={`relative flex w-full touch-none items-center select-none ${className}`}
		>
			<input
				type="range"
				min={min}
				max={max}
				step={step}
				value={value}
				ref={ref}
				onChange={handleChange}
				onPointerDown={handlePointerDown}
				title={title}
				aria-label={title}
				className="slider-thumb bg-editor-starter-surface-muted focus-visible:ring-editor-starter-border relative mt-2 mb-2 h-2 w-full cursor-pointer appearance-none rounded-full transition-colors outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50"
				style={{
					background: `linear-gradient(to right, var(--color-editor-starter-slider-fill) 0%, var(--color-editor-starter-slider-fill) ${percentage}%, var(--color-editor-starter-slider-track) ${percentage}%, var(--color-editor-starter-slider-track) 100%)`,
				}}
			/>
			<style
				dangerouslySetInnerHTML={{
					__html: `
					.slider-thumb::-webkit-slider-thumb {
						appearance: none;
						height: 16px;
						width: 16px;
						border-radius: 50%;
						background: var(--color-editor-starter-slider-thumb);
						cursor: pointer;
						transition: all 0.2s ease;
						box-shadow: 0 2px 4px var(--color-editor-starter-soft-shadow);
					}
					.slider-thumb::-webkit-slider-thumb:hover {
						background: var(--color-editor-starter-slider-thumb-hover);
						transform: scale(1.1);
					}
					.slider-thumb::-moz-range-thumb {
						height: 16px;
						width: 16px;
						border-radius: 50%;
						background: var(--color-editor-starter-slider-thumb);
						cursor: pointer;
						border: none;
						transition: all 0.2s ease;
						box-shadow: 0 2px 4px var(--color-editor-starter-soft-shadow);
					}
					.slider-thumb::-moz-range-thumb:hover {
						background: var(--color-editor-starter-slider-thumb-hover);
						transform: scale(1.1);
					}
				`,
				}}
			/>
		</div>
	);
};
