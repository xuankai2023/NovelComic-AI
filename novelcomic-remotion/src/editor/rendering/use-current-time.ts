import {useEffect, useState} from 'react';

export const useCurrentTime = () => {
	const [now, setNow] = useState(() => Date.now());

	useEffect(() => {
		const interval = setInterval(() => {
			setNow(Date.now());
		}, 10000); // 10 seconds

		return () => clearInterval(interval);
	}, []);

	return Math.max(now, Date.now());
};
