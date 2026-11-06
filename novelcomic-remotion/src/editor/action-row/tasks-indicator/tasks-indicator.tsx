import React from 'react';

export const taskIndicatorRef = React.createRef<{
	open: () => void;
	close: () => void;
}>();
