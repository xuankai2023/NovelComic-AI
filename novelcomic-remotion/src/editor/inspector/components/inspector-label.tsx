import React from 'react';

const InspectorLabelForwardRef: React.ForwardRefRenderFunction<
	HTMLDivElement,
	React.HTMLProps<HTMLDivElement>
> = (props, ref) => {
	return (
		<div
			ref={ref}
			className="text-xs font-bold text-editor-starter-text-muted"
			{...props}
		></div>
	);
};

export const InspectorLabel = React.forwardRef(InspectorLabelForwardRef);

const InspectorSubLabelForwardRef: React.ForwardRefRenderFunction<
	HTMLDivElement,
	React.HTMLProps<HTMLDivElement>
> = (props, ref) => {
	return (
		<div
			ref={ref}
			className="mt-2 mb-1 text-[0.7rem] font-semibold text-editor-starter-text-faint"
			{...props}
		></div>
	);
};

export const InspectorSubLabel = React.forwardRef(InspectorSubLabelForwardRef);
