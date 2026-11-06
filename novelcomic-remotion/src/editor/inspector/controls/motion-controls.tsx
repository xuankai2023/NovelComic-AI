import {Plus, Trash2} from 'lucide-react';
import {useTranslations} from 'next-intl';
import React, {memo, useCallback, useEffect, useMemo, useState} from 'react';
import {createIdentityMeshGrid} from '../../advanced/mesh-grid';
import type {BoneRig, MeshGrid} from '../../advanced/types';
import {applySpriteMotion} from '../../comic/apply-sprite-motion';
import {createCommandId} from '../../commands/types';
import type {ImageItem} from '../../items/image/image-item-type';
import {
	DEFAULT_MOTION_INTENSITY,
	MOTION_INTENSITIES,
	type MotionIntensity,
} from '../../motion/intensity';
import {
	CAMERA_PRESET_IDS,
	ITEM_PRESET_IDS,
	expandCameraPreset,
	expandItemPreset,
	type CameraPresetId,
	type ItemPresetId,
} from '../../motion/presets';
import {
	EASING_NAMES,
	TRANSFORM_LOOPS,
	type EasingName,
	type TransformAnimation,
	type TransformKeyframe,
	type TransformLoop,
} from '../../motion/types';
import {writeShotCameraPropertySet} from '../../property/materialize-motion';
import {changeItem} from '../../state/actions/change-item';
import {
	useAllItems,
	useAssets,
	useShotById,
	useTracks,
	useWriteContext,
} from '../../utils/use-context';
import {InspectorSubLabel} from '../components/inspector-label';
import {GraphEditor} from './graph-editor';
import {
	appendTransformKeyframe,
	clearShotCameraMotion,
	initialTransformAnimation,
	removeTransformKeyframe,
	setTransformLoop,
	updateTransformKeyframe,
	writeShotCameraMotion,
} from './motion-controls-helpers';
import {
	NumberControl,
	type NumberControlUpdateHandler,
} from './number-controls';

const presetLabels: Record<ItemPresetId, string> = {
	breathing: 'breathing',
	float: 'float',
	'hair-sway': 'hairSway',
};

const cameraPresetLabels: Record<CameraPresetId, string> = {
	'camera-push': 'cameraPush',
	'camera-pull': 'cameraPull',
	'pan-left': 'panLeft',
	'pan-right': 'panRight',
};

const easingLabels: Record<EasingName, string> = {
	linear: 'linear',
	'ease-in': 'easeIn',
	'ease-out': 'easeOut',
	'ease-in-out': 'easeInOut',
};

const loopLabels: Record<TransformLoop, string> = {
	none: 'none',
	repeat: 'repeat',
	'ping-pong': 'pingPong',
};

const intensityLabels: Record<MotionIntensity, string> = {
	light: 'lightIntensity',
	medium: 'mediumIntensity',
	heavy: 'heavyIntensity',
};

const SpriteMotionControls: React.FC<{item: ImageItem}> = ({item}) => {
	const t = useTranslations('editor.inspector');
	const {setState} = useWriteContext();
	const {assets} = useAssets();
	const {items} = useAllItems();
	const {tracks} = useTracks();
	const [openAssetId, setOpenAssetId] = useState(item.assetId);
	const [closedAssetId, setClosedAssetId] = useState('');
	const [halfAssetId, setHalfAssetId] = useState('');
	const [seed, setSeed] = useState(42);

	const imageAssets = useMemo(
		() => Object.values(assets).filter((asset) => asset.type === 'image'),
		[assets],
	);
	const assetIdForSemantic = useCallback(
		(semantic: string) => {
			const track = tracks.find((candidate) => candidate.semantic === semantic);
			const imageItemId = track?.items.find(
				(itemId) => items[itemId]?.type === 'image',
			);
			const imageItem = imageItemId ? items[imageItemId] : undefined;
			return imageItem?.type === 'image' ? imageItem.assetId : '';
		},
		[items, tracks],
	);
	const itemTrack = tracks.find((track) => track.items.includes(item.id));
	const isSource = itemTrack?.role === 'source';
	const dialogueItemIds = Object.values(items)
		.filter(
			(candidate) =>
				candidate.type === 'captions' &&
				(!item.shotId || candidate.id.includes(`dialogue:${item.shotId}:`)),
		)
		.map((candidate) => candidate.id);

	useEffect(() => {
		setOpenAssetId(
			item.assetId ||
				assetIdForSemantic('eye-open') ||
				assetIdForSemantic('mouth-open'),
		);
		setClosedAssetId(
			assetIdForSemantic('eye-closed') ||
				assetIdForSemantic('mouth-closed') ||
				'',
		);
		setHalfAssetId(assetIdForSemantic('mouth-half'));
	}, [assetIdForSemantic, item.assetId, item.id]);

	const updateSpriteMotion = useCallback(
		(
			update: (
				state: Parameters<typeof applySpriteMotion>[0],
			) => Parameters<typeof applySpriteMotion>[0],
		) => {
			setState({
				update: (state) => ({
					...state,
					undoableState: update(state.undoableState),
				}),
				commitToUndoStack: true,
				command: {type: 'sprite.update'},
			});
		},
		[setState],
	);

	const applyBlink = useCallback(() => {
		if (!openAssetId || !closedAssetId) {
			return;
		}
		updateSpriteMotion((project) =>
			applySpriteMotion(project, {
				itemId: item.id,
				mode: 'replace',
				sprite: {
					kind: 'blink',
					openAssetId,
					closedAssetId,
					seed,
				},
			}),
		);
	}, [closedAssetId, item.id, openAssetId, seed, updateSpriteMotion]);

	const applyMouthFlap = useCallback(() => {
		if (!openAssetId || !closedAssetId || dialogueItemIds.length === 0) {
			return;
		}
		updateSpriteMotion((project) =>
			applySpriteMotion(project, {
				itemId: item.id,
				mode: 'replace',
				sprite: {
					kind: 'mouth-flap',
					openAssetId,
					closedAssetId,
					halfAssetId: halfAssetId || undefined,
					dialogueItemIds,
				},
			}),
		);
	}, [
		closedAssetId,
		dialogueItemIds,
		halfAssetId,
		item.id,
		openAssetId,
		updateSpriteMotion,
	]);

	const clearSpriteMotion = useCallback(() => {
		setState({
			update: (state) =>
				changeItem(state, item.id, (current) => {
					if (current.type !== 'image' || !current.motion) {
						return current;
					}
					const motion = {...current.motion};
					delete motion.spriteStates;
					if (Object.keys(motion).length === 0) {
						return Object.fromEntries(
							Object.entries(current).filter(
								([key]) => key !== 'motion' && key !== 'spriteAssetIds',
							),
						) as ImageItem;
					}
					return {...current, motion, spriteAssetIds: undefined};
				}),
			commitToUndoStack: true,
			command: {type: 'sprite.update'},
		});
	}, [item.id, setState]);

	const assetOptions = imageAssets.map((asset) => (
		<option key={asset.id} value={asset.id}>
			{asset.filename}
		</option>
	));

	return (
		<div className="border-editor-starter-border space-y-2 border-t pt-3">
			<InspectorSubLabel>{t('controls.spriteMotion')}</InspectorSubLabel>
			{isSource ? (
				<div className="text-xs text-amber-200">
					{t('controls.sourceMotionBlocked')}
				</div>
			) : (
				<>
					<label className="text-editor-starter-text-faint block text-xs">
						{t('controls.openAsset')}
						<select
							className="editor-starter-field mt-1 w-full px-2 py-1.5 text-xs"
							value={openAssetId}
							onChange={(event) => setOpenAssetId(event.target.value)}
						>
							{assetOptions}
						</select>
					</label>
					<label className="text-editor-starter-text-faint block text-xs">
						{t('controls.closedAsset')}
						<select
							className="editor-starter-field mt-1 w-full px-2 py-1.5 text-xs"
							value={closedAssetId}
							onChange={(event) => setClosedAssetId(event.target.value)}
						>
							<option value="">-</option>
							{assetOptions}
						</select>
					</label>
					<label className="text-editor-starter-text-faint block text-xs">
						{t('controls.halfAsset')}
						<select
							className="editor-starter-field mt-1 w-full px-2 py-1.5 text-xs"
							value={halfAssetId}
							onChange={(event) => setHalfAssetId(event.target.value)}
						>
							<option value="">-</option>
							{assetOptions}
						</select>
					</label>
					<label className="text-editor-starter-text-faint block text-xs">
						{t('controls.seed')}
						<input
							className="editor-starter-field mt-1 w-full px-2 py-1.5 text-xs"
							type="number"
							value={seed}
							onChange={(event) => setSeed(Number(event.target.value) || 0)}
						/>
					</label>
					<div className="grid grid-cols-2 gap-2">
						<button
							type="button"
							className="border-editor-starter-border text-editor-starter-text-muted hover:text-editor-starter-text border px-2 py-1.5 text-xs disabled:opacity-40"
							disabled={!openAssetId || !closedAssetId}
							onClick={applyBlink}
						>
							{t('controls.applyBlink')}
						</button>
						<button
							type="button"
							className="border-editor-starter-border text-editor-starter-text-muted hover:text-editor-starter-text border px-2 py-1.5 text-xs disabled:opacity-40"
							disabled={
								!openAssetId || !closedAssetId || dialogueItemIds.length === 0
							}
							onClick={applyMouthFlap}
						>
							{t('controls.applyMouthFlap')}
						</button>
					</div>
					{dialogueItemIds.length === 0 ? (
						<div className="text-editor-starter-text-faint text-[10px]">
							{t('controls.requiresDialogue')}
						</div>
					) : null}
					{item.motion?.spriteStates?.length ? (
						<div className="text-editor-starter-text-faint flex items-center justify-between text-[10px]">
							<span>
								{t('controls.spriteStateCount', {
									count: item.motion.spriteStates.length,
								})}
							</span>
							<button
								type="button"
								className="text-editor-starter-text-muted hover:text-editor-starter-text"
								onClick={clearSpriteMotion}
							>
								{t('controls.clearSpriteMotion')}
							</button>
						</div>
					) : null}
				</>
			)}
		</div>
	);
};

const MotionControlsUnmemoized: React.FC<{item: ImageItem}> = ({item}) => {
	const t = useTranslations('editor.inspector');
	const {setState} = useWriteContext();
	const shot = useShotById(item.shotId);
	const [boneFrame, setBoneFrame] = useState(0);
	const [itemIntensity, setItemIntensity] = useState<MotionIntensity>(
		DEFAULT_MOTION_INTENSITY,
	);
	const [cameraPreset, setCameraPreset] = useState<CameraPresetId | 'none'>(
		'none',
	);
	const [cameraIntensity, setCameraIntensity] = useState<MotionIntensity>(
		DEFAULT_MOTION_INTENSITY,
	);
	const [graphProperty, setGraphProperty] = useState<
		'x' | 'y' | 'scaleX' | 'scaleY' | 'rotation' | 'opacity'
	>('x');
	const transform = item.motion?.transform;
	useEffect(() => {
		const intensity = item.motion?.preset?.parameters.intensity;
		setItemIntensity(
			typeof intensity === 'string' &&
				MOTION_INTENSITIES.includes(intensity as MotionIntensity)
				? (intensity as MotionIntensity)
				: DEFAULT_MOTION_INTENSITY,
		);
	}, [item.id, item.motion?.preset?.parameters.intensity]);
	const keyframes = useMemo(
		() => transform?.keyframes ?? [],
		[transform?.keyframes],
	);

	const updateMotion = useCallback(
		(
			updater: (motion: NonNullable<ImageItem['motion']>) => void,
			commit = true,
			command?: Parameters<typeof setState>[0]['command'],
		) => {
			setState({
				update: (state) =>
					changeItem(state, item.id, (current) => {
						if (current.type !== 'image') {
							return current;
						}
						const motion = {
							...(current.motion ?? {}),
						};
						updater(motion);
						return {...current, motion};
					}),
				commitToUndoStack: commit,
				command,
			});
		},
		[item.id, setState],
	);

	const updateTransform = useCallback(
		(
			updater: (animation: TransformAnimation) => TransformAnimation,
			commit = true,
		) => {
			updateMotion((motion) => {
				motion.transform = updater(
					motion.transform ?? initialTransformAnimation(),
				);
			}, commit);
		},
		[updateMotion],
	);

	const applyPreset = useCallback(
		(presetId: string, intensity?: MotionIntensity) => {
			if (presetId === 'none') {
				updateMotion(
					(motion) => {
						delete motion.transform;
						delete motion.preset;
					},
					true,
					{
						type: 'property.update',
						transactionId: createCommandId('motion-preset'),
					},
				);
				return;
			}

			const animation = expandItemPreset(presetId as ItemPresetId, {
				durationInFrames: item.durationInFrames,
				parameters: {
					intensity: intensity ?? DEFAULT_MOTION_INTENSITY,
				},
			});
			updateMotion(
				(motion) => {
					motion.transform = animation;
					motion.preset = {
						id: presetId,
						parameters: {
							intensity: intensity ?? DEFAULT_MOTION_INTENSITY,
						},
					};
				},
				true,
				{
					type: 'property.update',
					transactionId: createCommandId('motion-preset'),
				},
			);
		},
		[item.durationInFrames, updateMotion],
	);

	const updateKeyframe = useCallback(
		(index: number, patch: Partial<TransformKeyframe>, commit = true) => {
			updateTransform((animation) => {
				return updateTransformKeyframe({
					animation,
					index,
					patch,
					durationInFrames: item.durationInFrames,
				});
			}, commit);
		},
		[item.durationInFrames, updateTransform],
	);

	const setNumber =
		(
			index: number,
			field: 'frame' | 'x' | 'y' | 'scaleX' | 'scaleY' | 'rotation' | 'opacity',
		) =>
		({num, commitToUndoStack}: Parameters<NumberControlUpdateHandler>[0]) => {
			updateKeyframe(index, {[field]: num}, commitToUndoStack);
		};

	const addKeyframe = useCallback(() => {
		updateTransform((animation) => {
			return appendTransformKeyframe({
				animation,
				durationInFrames: item.durationInFrames,
			});
		});
	}, [item.durationInFrames, updateTransform]);

	const removeKeyframe = useCallback(
		(index: number) => {
			const nextAnimation = transform
				? removeTransformKeyframe({animation: transform, index})
				: null;
			if (!nextAnimation) {
				updateMotion((motion) => {
					delete motion.transform;
					delete motion.preset;
				});
				return;
			}
			updateMotion((motion) => {
				motion.transform = nextAnimation;
			});
		},
		[transform, updateMotion],
	);

	const setLoop = useCallback(
		(loop: TransformLoop) => {
			updateTransform((animation) => {
				return setTransformLoop({
					animation,
					loop,
					durationInFrames: item.durationInFrames,
				});
			});
		},
		[item.durationInFrames, updateTransform],
	);

	const applyCameraPreset = useCallback(
		(presetId: string, intensity: MotionIntensity = cameraIntensity) => {
			if (!shot || presetId === 'none') {
				return;
			}
			setCameraPreset(presetId as CameraPresetId);

			const cameraMotion = expandCameraPreset(presetId as CameraPresetId, {
				durationInFrames: shot.durationInFrames,
				parameters: {intensity},
			});
			setState({
				update: (state) => {
					const updated = {
						...state.undoableState,
						shots: writeShotCameraMotion(
							state.undoableState.shots ?? [],
							shot.id,
							cameraMotion,
						),
					};
					return {
						...state,
						undoableState: writeShotCameraPropertySet(
							updated,
							shot.id,
							cameraMotion,
						),
					};
				},
				commitToUndoStack: true,
				command: {
					type: 'property.update',
					transactionId: createCommandId('camera-preset'),
				},
			});
		},
		[cameraIntensity, setState, shot],
	);

	const clearCameraMotion = useCallback(() => {
		if (!shot) {
			return;
		}

		setState({
			update: (state) => {
				const updated = {
					...state.undoableState,
					shots: clearShotCameraMotion(
						state.undoableState.shots ?? [],
						shot.id,
					),
				};
				return {
					...state,
					undoableState: writeShotCameraPropertySet(
						updated,
						shot.id,
						undefined,
					),
				};
			},
			commitToUndoStack: true,
			command: {type: 'property.update'},
		});
	}, [setState, shot]);

	const clearMotion = useCallback(() => {
		setState({
			update: (state) =>
				changeItem(state, item.id, (current) => {
					if (current.type !== 'image') {
						return current;
					}
					if (current.motion?.spriteStates?.length) {
						return {
							...current,
							motion: {spriteStates: current.motion.spriteStates},
						};
					}
					const nextItem = {...current};
					delete nextItem.motion;
					return nextItem;
				}),
			commitToUndoStack: true,
		});
	}, [item.id, setState]);

	const updateBoneRig = useCallback(
		(updater: (rig: BoneRig) => BoneRig) => {
			updateMotion((motion) => {
				motion.boneRig = updater(
					motion.boneRig ?? {
						rootBoneId: 'root',
						bones: [
							{
								id: 'root',
								name: 'Root',
								x: 0,
								y: 0,
								length: Math.max(1, item.width * 0.5),
								rotation: 0,
								scaleX: 1,
								scaleY: 1,
							},
						],
					},
				);
			});
		},
		[item.width, updateMotion],
	);

	const rootBone = item.motion?.boneRig?.bones.find(
		(bone) => bone.id === item.motion?.boneRig?.rootBoneId,
	);
	const setRootBone = useCallback(
		(field: 'x' | 'y' | 'rotation' | 'scaleX' | 'scaleY', value: number) => {
			updateBoneRig((rig) => ({
				...rig,
				bones: rig.bones.map((bone) =>
					bone.id === rig.rootBoneId ? {...bone, [field]: value} : bone,
				),
			}));
		},
		[updateBoneRig],
	);
	const addBoneKeyframe = useCallback(() => {
		updateBoneRig((rig) => ({
			...rig,
			bones: rig.bones.map((bone) =>
				bone.id === rig.rootBoneId
					? {
							...bone,
							keyframes: [
								...(bone.keyframes ?? []).filter(
									(keyframe) => keyframe.frame !== boneFrame,
								),
								{
									frame: boneFrame,
									x: bone.x,
									y: bone.y,
									rotation: bone.rotation,
									scaleX: bone.scaleX,
									scaleY: bone.scaleY,
								},
							].sort((left, right) => left.frame - right.frame),
						}
					: bone,
			),
		}));
	}, [boneFrame, updateBoneRig]);

	const updateMeshGrid = useCallback(
		(updater: (grid: MeshGrid) => MeshGrid) => {
			updateMotion((motion) => {
				motion.meshGrid = updater(
					motion.meshGrid ?? createIdentityMeshGrid(3, 3),
				);
			});
		},
		[updateMotion],
	);
	const enableMeshGrid = useCallback(() => {
		updateMeshGrid((grid) => grid);
	}, [updateMeshGrid]);
	const setMeshPoint = useCallback(
		(index: number, axis: 'x' | 'y', value: number) => {
			updateMeshGrid((grid) => ({
				...grid,
				points: grid.points.map((point, pointIndex) =>
					pointIndex === index ? {...point, [axis]: value} : point,
				),
			}));
		},
		[updateMeshGrid],
	);
	const clearDeformation = useCallback(() => {
		updateMotion((motion) => {
			delete motion.boneRig;
			delete motion.meshGrid;
		});
	}, [updateMotion]);

	const updateGraphKeyframes = useCallback(
		(nextKeyframes: TransformKeyframe[], commitToUndoStack: boolean) => {
			updateTransform(
				(animation) => ({...animation, keyframes: nextKeyframes}),
				commitToUndoStack,
			);
		},
		[updateTransform],
	);

	return (
		<div className="space-y-3">
			<div>
				<InspectorSubLabel>{t('controls.motionPreset')}</InspectorSubLabel>
				<select
					className="editor-starter-field text-editor-starter-text-muted w-full px-2 py-2 text-xs"
					value={item.motion?.preset?.id ?? 'none'}
					onChange={(event) => applyPreset(event.target.value)}
					aria-label={t('controls.motionPreset')}
				>
					<option value="none">{t('controls.none')}</option>
					{ITEM_PRESET_IDS.map((presetId) => (
						<option key={presetId} value={presetId}>
							{t(`controls.${presetLabels[presetId]}`)}
						</option>
					))}
				</select>
				<label className="text-editor-starter-text-faint mt-2 block text-xs">
					{t('controls.motionIntensity')}
					<select
						className="editor-starter-field mt-1 w-full px-2 py-2 text-xs"
						value={itemIntensity}
						onChange={(event) => {
							const intensity = event.target.value as MotionIntensity;
							setItemIntensity(intensity);
							const presetId = item.motion?.preset?.id;
							if (presetId) {
								applyPreset(presetId, intensity);
							}
						}}
						aria-label={t('controls.motionIntensity')}
					>
						{MOTION_INTENSITIES.map((intensity) => (
							<option key={intensity} value={intensity}>
								{t(`controls.${intensityLabels[intensity]}`)}
							</option>
						))}
					</select>
				</label>
			</div>

			<SpriteMotionControls item={item} />

			<div>
				<InspectorSubLabel>
					{t('controls.cameraMotionPreset')}
				</InspectorSubLabel>
				{shot ? (
					<div className="space-y-2">
						<select
							className="editor-starter-field text-editor-starter-text-muted w-full px-2 py-2 text-xs"
							value={cameraPreset}
							onChange={(event) => applyCameraPreset(event.target.value)}
							aria-label={t('controls.cameraMotionPreset')}
						>
							<option value="none">{t('controls.none')}</option>
							{CAMERA_PRESET_IDS.map((presetId) => (
								<option key={presetId} value={presetId}>
									{t(`controls.${cameraPresetLabels[presetId]}`)}
								</option>
							))}
						</select>
						<label className="text-editor-starter-text-faint block text-xs">
							{t('controls.motionIntensity')}
							<select
								className="editor-starter-field mt-1 w-full px-2 py-2 text-xs"
								value={cameraIntensity}
								onChange={(event) => {
									const intensity = event.target.value as MotionIntensity;
									setCameraIntensity(intensity);
									if (cameraPreset !== 'none') {
										applyCameraPreset(cameraPreset, intensity);
									}
								}}
								aria-label={t('controls.motionIntensity')}
							>
								{MOTION_INTENSITIES.map((intensity) => (
									<option key={intensity} value={intensity}>
										{t(`controls.${intensityLabels[intensity]}`)}
									</option>
								))}
							</select>
						</label>
						<button
							type="button"
							className="border-editor-starter-border text-editor-starter-text-muted hover:text-editor-starter-text w-full border px-2 py-2 text-xs"
							onClick={clearCameraMotion}
						>
							{t('controls.clearCameraMotion')}
						</button>
					</div>
				) : (
					<div className="text-editor-starter-text-faint text-xs">
						{t('controls.noShotForCamera')}
					</div>
				)}
			</div>

			<div>
				<div className="mb-1 flex items-center justify-between">
					<InspectorSubLabel>{t('controls.keyframes')}</InspectorSubLabel>
					<button
						type="button"
						className="text-editor-starter-text-muted hover:text-editor-starter-text flex items-center gap-1 text-xs"
						onClick={addKeyframe}
						title={t('controls.addKeyframe')}
					>
						<Plus className="size-3.5" />
						{t('controls.addKeyframe')}
					</button>
				</div>
				{keyframes.length === 0 ? (
					<div className="text-editor-starter-text-faint text-xs">
						{t('controls.noKeyframes')}
					</div>
				) : (
					<div className="space-y-2">
						{keyframes.map((keyframe, index) => (
							<div
								key={`${keyframe.frame}-${index}`}
								className="border-editor-starter-border space-y-1 border p-2"
							>
								<div className="flex items-center justify-between">
									<span className="text-editor-starter-text-faint text-[0.7rem]">
										{t('controls.keyframe')} {index + 1}
									</span>
									<button
										type="button"
										className="text-editor-starter-text-faint hover:text-editor-starter-text"
										onClick={() => removeKeyframe(index)}
										title={t('controls.removeKeyframe')}
										aria-label={t('controls.removeKeyframe')}
									>
										<Trash2 className="size-3.5" />
									</button>
								</div>
								<div className="grid grid-cols-2 gap-1">
									<NumberControl
										label={t('controls.frame')}
										value={keyframe.frame}
										setValue={setNumber(index, 'frame')}
										min={0}
										max={item.durationInFrames - 1}
										step={1}
										accessibilityLabel={t('controls.frame')}
									/>
									<select
										className="editor-starter-field text-editor-starter-text-muted min-w-0 px-1 text-xs"
										value={keyframe.easing ?? 'linear'}
										onChange={(event) =>
											updateKeyframe(index, {
												easing: event.target.value as EasingName,
											})
										}
										aria-label={t('controls.easing')}
									>
										{EASING_NAMES.map((easing) => (
											<option key={easing} value={easing}>
												{t(`controls.${easingLabels[easing]}`)}
											</option>
										))}
									</select>
								</div>
								<div className="grid grid-cols-2 gap-1">
									{(
										[
											'x',
											'y',
											'scaleX',
											'scaleY',
											'rotation',
											'opacity',
										] as const
									).map((field) => (
										<NumberControl
											key={field}
											label={t(`controls.${field}`)}
											value={
												keyframe[field] ??
												(field === 'scaleX' || field === 'scaleY'
													? 1
													: field === 'opacity'
														? 1
														: 0)
											}
											setValue={setNumber(index, field)}
											min={field === 'opacity' ? 0 : null}
											max={field === 'opacity' ? 1 : null}
											step={
												field === 'opacity' ||
												field === 'scaleX' ||
												field === 'scaleY'
													? 0.01
													: 1
											}
											accessibilityLabel={t(`controls.${field}`)}
										/>
									))}
								</div>
							</div>
						))}
					</div>
				)}
			</div>

			<div>
				<InspectorSubLabel>{t('controls.loop')}</InspectorSubLabel>
				<select
					className="editor-starter-field text-editor-starter-text-muted w-full px-2 py-2 text-xs"
					value={transform?.loop ?? 'none'}
					onChange={(event) => setLoop(event.target.value as TransformLoop)}
					aria-label={t('controls.loop')}
				>
					{TRANSFORM_LOOPS.map((loop) => (
						<option key={loop} value={loop}>
							{t(`controls.${loopLabels[loop]}`)}
						</option>
					))}
				</select>
			</div>

			{keyframes.length > 0 ? (
				<div className="space-y-2">
					<div className="flex items-center justify-between">
						<InspectorSubLabel>{t('controls.graphEditor')}</InspectorSubLabel>
						<select
							className="editor-starter-field w-24 px-1.5 py-1 text-[10px]"
							value={graphProperty}
							onChange={(event) =>
								setGraphProperty(
									event.target.value as
										| 'x'
										| 'y'
										| 'scaleX'
										| 'scaleY'
										| 'rotation'
										| 'opacity',
								)
							}
							aria-label={t('controls.graphEditor')}
						>
							{(
								['x', 'y', 'scaleX', 'scaleY', 'rotation', 'opacity'] as const
							).map((property) => (
								<option key={property} value={property}>
									{t(`controls.${property}`)}
								</option>
							))}
						</select>
					</div>
					<GraphEditor
						keyframes={keyframes}
						durationInFrames={item.durationInFrames}
						property={graphProperty}
						onChange={updateGraphKeyframes}
					/>
				</div>
			) : null}

			<div className="space-y-2">
				<div className="flex items-center justify-between">
					<InspectorSubLabel>{t('controls.boneRig')}</InspectorSubLabel>
					<button
						type="button"
						className="text-editor-starter-text-muted hover:text-editor-starter-text text-xs"
						onClick={() => updateBoneRig((rig) => rig)}
					>
						{rootBone ? t('controls.enabled') : t('controls.enable')}
					</button>
				</div>
				{rootBone ? (
					<>
						<div className="grid grid-cols-2 gap-1">
							{(['x', 'y', 'rotation', 'scaleX', 'scaleY'] as const).map(
								(field) => (
									<NumberControl
										key={field}
										label={t(`controls.${field}`)}
										value={rootBone[field]}
										setValue={({num}) => setRootBone(field, num)}
										min={null}
										max={null}
										step={field === 'scaleX' || field === 'scaleY' ? 0.01 : 1}
										accessibilityLabel={t(`controls.${field}`)}
									/>
								),
							)}
						</div>
						<button
							type="button"
							className="border-editor-starter-border text-editor-starter-text-muted hover:text-editor-starter-text w-full border px-2 py-1.5 text-xs"
							onClick={addBoneKeyframe}
						>
							{t('controls.addBoneKeyframe')}
						</button>
						<input
							type="number"
							min={0}
							max={Math.max(0, item.durationInFrames - 1)}
							value={boneFrame}
							onChange={(event) => {
								const value = Number(event.target.value);
								if (!Number.isFinite(value)) return;
								setBoneFrame(
									Math.max(
										0,
										Math.min(Math.max(0, item.durationInFrames - 1), value),
									),
								);
							}}
							aria-label={t('controls.frame')}
							className="editor-starter-field w-full px-2 py-1 text-xs"
						/>
					</>
				) : null}
			</div>

			<div className="space-y-2">
				<div className="flex items-center justify-between">
					<InspectorSubLabel>{t('controls.meshGrid')}</InspectorSubLabel>
					<button
						type="button"
						className="text-editor-starter-text-muted hover:text-editor-starter-text text-xs"
						onClick={enableMeshGrid}
					>
						{item.motion?.meshGrid
							? t('controls.enabled')
							: t('controls.enable')}
					</button>
				</div>
				{item.motion?.meshGrid ? (
					<div className="space-y-1">
						{item.motion.meshGrid.points.map((point, index) => (
							<div key={index} className="grid grid-cols-2 gap-1">
								<NumberControl
									label={`P${index + 1} X`}
									value={point.x}
									setValue={({num}) => setMeshPoint(index, 'x', num)}
									min={-1}
									max={2}
									step={0.01}
									accessibilityLabel={`P${index + 1} X`}
								/>
								<NumberControl
									label={`P${index + 1} Y`}
									value={point.y}
									setValue={({num}) => setMeshPoint(index, 'y', num)}
									min={-1}
									max={2}
									step={0.01}
									accessibilityLabel={`P${index + 1} Y`}
								/>
							</div>
						))}
					</div>
				) : null}
			</div>

			<button
				type="button"
				className="border-editor-starter-border text-editor-starter-text-muted hover:text-editor-starter-text w-full border px-2 py-2 text-xs"
				onClick={clearMotion}
			>
				{t('controls.clearMotion')}
			</button>
			<button
				type="button"
				className="border-editor-starter-border text-editor-starter-text-muted hover:text-editor-starter-text w-full border px-2 py-2 text-xs"
				onClick={clearDeformation}
			>
				{t('controls.clearDeformation')}
			</button>
		</div>
	);
};

export const MotionControls = memo(MotionControlsUnmemoized);
