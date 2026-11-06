import type {UndoableState} from '../state/types';
import type {ProjectIssue} from './types';

const issue = (
	severity: ProjectIssue['severity'],
	code: string,
	message: string,
	ids: Partial<Pick<ProjectIssue, 'shotId' | 'itemId' | 'assetId'>>,
): ProjectIssue => {
	return {...ids, severity, code, message};
};

const finitePositive = (value: number): boolean => {
	return Number.isFinite(value) && value > 0;
};

export const validateManualLayerBounds = (
	project: UndoableState,
): ProjectIssue[] => {
	const issues: ProjectIssue[] = [];

	for (const layer of Object.values(project.comicEditLayers ?? {})) {
		const ids = {
			shotId: layer.shotId,
			itemId: layer.id,
			assetId: layer.sourceAssetId,
		};
		const canvasIsValid =
			Number.isInteger(layer.sourceCanvas.width) &&
			Number.isInteger(layer.sourceCanvas.height) &&
			layer.sourceCanvas.width > 0 &&
			layer.sourceCanvas.height > 0;
		if (!canvasIsValid) {
			issues.push(
				issue(
					'error',
					'INVALID_LAYER_CANVAS',
					`Layer ${layer.id} has an invalid source canvas`,
					ids,
				),
			);
			continue;
		}

		const {bounds} = layer;
		const boundsAreValid =
			Number.isFinite(bounds.x) &&
			Number.isFinite(bounds.y) &&
			finitePositive(bounds.width) &&
			finitePositive(bounds.height) &&
			bounds.x >= 0 &&
			bounds.y >= 0 &&
			bounds.x + bounds.width <= layer.sourceCanvas.width &&
			bounds.y + bounds.height <= layer.sourceCanvas.height;
		if (!boundsAreValid) {
			issues.push(
				issue(
					'error',
					'LAYER_BOUNDS_OUT_OF_RANGE',
					`Layer ${layer.id} bounds fall outside its source canvas`,
					ids,
				),
			);
		}

		if (layer.anchor) {
			const anchorIsValid =
				Number.isFinite(layer.anchor.x) &&
				Number.isFinite(layer.anchor.y) &&
				layer.anchor.x >= 0 &&
				layer.anchor.x <= 1 &&
				layer.anchor.y >= 0 &&
				layer.anchor.y <= 1;
			if (!anchorIsValid) {
				issues.push(
					issue(
						'error',
						'LAYER_ANCHOR_OUT_OF_RANGE',
						`Layer ${layer.id} anchor must be between 0 and 1`,
						ids,
					),
				);
			}
		}

		for (const point of layer.polygon ?? []) {
			if (
				!Number.isFinite(point.x) ||
				!Number.isFinite(point.y) ||
				point.x < 0 ||
				point.y < 0 ||
				point.x > layer.sourceCanvas.width ||
				point.y > layer.sourceCanvas.height
			) {
				issues.push(
					issue(
						'error',
						'LAYER_POLYGON_OUT_OF_RANGE',
						`Layer ${layer.id} contains a polygon point outside its source canvas`,
						ids,
					),
				);
				break;
			}
		}
	}

	return issues;
};
