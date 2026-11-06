import {useCallback} from 'react';
import {toast} from 'sonner';
import {setAutoKeyEnabled} from '../state/actions/auto-key';
import {saveAutoKeyEnabled} from '../state/auto-key-persistance';
import {useFullState, useWriteContext} from '../utils/use-context';

export const AutoKeyToggle = () => {
	const autoKeyEnabled = useFullState().autoKeyEnabled;
	const {setState} = useWriteContext();

	const toggle = useCallback(() => {
		const enabled = !autoKeyEnabled;
		saveAutoKeyEnabled(enabled);
		toast.info(
			enabled
				? '自动关键帧已开启：属性修改会写入当前帧'
				: '自动关键帧已关闭：未动画属性将修改整段',
		);
		setState({
			update: (state) => setAutoKeyEnabled(state, enabled),
			commitToUndoStack: false,
		});
	}, [autoKeyEnabled, setState]);

	return (
		<button
			type="button"
			className="ae-auto-key-toggle"
			data-active={autoKeyEnabled}
			aria-pressed={autoKeyEnabled}
			aria-label={autoKeyEnabled ? '关闭自动关键帧' : '开启自动关键帧'}
			title={
				autoKeyEnabled
					? '自动关键帧已开启：修改属性时新增或更新当前帧关键帧'
					: '自动关键帧已关闭：修改未动画属性会作用于整段'
			}
			onClick={toggle}
		>
			<span className="ae-auto-key-indicator" aria-hidden="true" />
			<span className="ae-auto-key-label">自动关键帧</span>
		</button>
	);
};
