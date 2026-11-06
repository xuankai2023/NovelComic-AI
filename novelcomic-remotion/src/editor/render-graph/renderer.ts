import type {DocumentColor, LayerEffects} from '../document';
import {drawWarpedImage, layerWarp} from '../tools/move/distort-preview';
import {adjustmentFilter} from './render-adjustment';
import {applyCameraRaw} from '../pixels/camera-raw';
import type {RenderGraph, RenderGraphNode} from './types';

export type RenderGraphRendererBackend = 'webgl2' | 'canvas2d';
export type RenderGraphAssetLoader = (
	assetId: string,
) => CanvasImageSource | Promise<CanvasImageSource | undefined> | undefined;

const blendMode: Record<string, GlobalCompositeOperation> = {
	normal: 'source-over',
	multiply: 'multiply',
	screen: 'screen',
	overlay: 'overlay',
	darken: 'darken',
	lighten: 'lighten',
	difference: 'difference',
	exclusion: 'exclusion',
	'hard-light': 'hard-light',
	'soft-light': 'soft-light',
	'color-dodge': 'color-dodge',
	'color-burn': 'color-burn',
};

const fill = (
	ctx: CanvasRenderingContext2D,
	color: DocumentColor,
	width: number,
	height: number,
) => {
	ctx.fillStyle = `rgba(${color.r},${color.g},${color.b},${color.a})`;
	ctx.fillRect(0, 0, width, height);
};

const cssColor = (color: DocumentColor, opacity = 1) =>
	`rgba(${color.r},${color.g},${color.b},${Math.max(0, Math.min(1, color.a * opacity))})`;

const applyLayerTransform = (
	ctx: CanvasRenderingContext2D,
	transform: {
		x: number;
		y: number;
		width: number;
		height: number;
		rotation: number;
		scaleX: number;
		scaleY: number;
		sampling?: 'high' | 'smooth' | 'nearest';
	},
) => {
	const placedWidth = Math.abs(transform.width * transform.scaleX);
	const placedHeight = Math.abs(transform.height * transform.scaleY);
	ctx.translate(transform.x + placedWidth / 2, transform.y + placedHeight / 2);
	ctx.rotate((transform.rotation * Math.PI) / 180);
	ctx.scale(transform.scaleX, transform.scaleY);
	ctx.translate(-transform.width / 2, -transform.height / 2);
	if (transform.sampling === 'nearest') ctx.imageSmoothingEnabled = false;
	else {
		ctx.imageSmoothingEnabled = true;
		ctx.imageSmoothingQuality = transform.sampling === 'smooth' ? 'low' : 'high';
	}
};

export class RenderGraphRenderer {
	readonly backend: RenderGraphRendererBackend;
	private readonly context: CanvasRenderingContext2D | null;
	private readonly gl: WebGL2RenderingContext | null;
	private readonly surface: HTMLCanvasElement;
	private readonly texture: WebGLTexture | null;
	private readonly buffer: WebGLBuffer | null;
	private readonly program: WebGLProgram | null;
	private assetLoader: RenderGraphAssetLoader = () => undefined;
	private readonly renderedLayers = new Map<string, HTMLCanvasElement>();

	constructor(canvas: HTMLCanvasElement, preferWebgl2 = true) {
		const gl = preferWebgl2
			? (canvas.getContext('webgl2', {
					premultipliedAlpha: false,
					antialias: false,
					preserveDrawingBuffer: true,
				}) as WebGL2RenderingContext | null)
			: null;
		this.backend = gl ? 'webgl2' : 'canvas2d';
		this.gl = gl;
		this.surface =
			gl && typeof document !== 'undefined'
				? document.createElement('canvas')
				: canvas;
		this.context = this.surface.getContext('2d');
		if (!gl) {
			this.texture = null;
			this.buffer = null;
			this.program = null;
		} else {
			const vertex = this.compile(
				gl.VERTEX_SHADER,
				`#version 300 es\nin vec2 p; out vec2 uv; void main(){uv=(p+1.0)*0.5; gl_Position=vec4(p,0,1);}`,
			);
			const fragment = this.compile(
				gl.FRAGMENT_SHADER,
				`#version 300 es\nprecision mediump float; uniform sampler2D image; in vec2 uv; out vec4 color; void main(){color=texture(image, vec2(uv.x, 1.0-uv.y));}`,
			);
			const program = gl.createProgram();
			if (!program)
				throw new Error('Unable to create WebGL2 render graph program');
			gl.attachShader(program, vertex);
			gl.attachShader(program, fragment);
			gl.linkProgram(program);
			gl.deleteShader(vertex);
			gl.deleteShader(fragment);
			if (!gl.getProgramParameter(program, gl.LINK_STATUS))
				throw new Error(
					gl.getProgramInfoLog(program) ??
						'Unable to link WebGL2 render graph program',
				);
			this.program = program;
			this.buffer = gl.createBuffer();
			gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
			gl.bufferData(
				gl.ARRAY_BUFFER,
				new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
				gl.STATIC_DRAW,
			);
			this.texture = gl.createTexture();
			gl.bindTexture(gl.TEXTURE_2D, this.texture);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
		}
	}

	private compile(type: number, source: string) {
		const shader = this.gl!.createShader(type);
		if (!shader) throw new Error('Unable to create WebGL2 shader');
		this.gl!.shaderSource(shader, source);
		this.gl!.compileShader(shader);
		if (!this.gl!.getShaderParameter(shader, this.gl!.COMPILE_STATUS))
			throw new Error(
				this.gl!.getShaderInfoLog(shader) ?? 'Unable to compile WebGL2 shader',
			);
		return shader;
	}

	setAssetLoader(loader: RenderGraphAssetLoader) {
		this.assetLoader = loader;
	}

	/** One pixel of the composited document, for the brush's Option-click sample. */
	readDocumentPixel(x: number, y: number) {
		const context = this.context;
		if (!context || this.surface.width < 1 || this.surface.height < 1) return null;
		const px = Math.floor(x);
		const py = Math.floor(y);
		if (px < 0 || py < 0 || px >= this.surface.width || py >= this.surface.height) return null;
		const pixel = context.getImageData(px, py, 1, 1).data;
		return {r: pixel[0] ?? 0, g: pixel[1] ?? 0, b: pixel[2] ?? 0, a: pixel[3] ?? 0};
	}

	async render(graph: RenderGraph): Promise<void> {
		const ctx = this.context;
		if (!ctx) return;
		const {width, height} = graph.frame;
		this.surface.width = width;
		this.surface.height = height;
		this.renderedLayers.clear();
		ctx.save();
		ctx.clearRect(0, 0, width, height);
		fill(ctx, graph.frame.background, width, height);
		const adjustmentInputs = new Set(
			graph.nodes.flatMap((node) => node.kind === 'adjustment' ? node.inputNodeIds : []),
		);
		for (const node of graph.nodes) {
			if (node.kind === 'layer' && adjustmentInputs.has(node.layer.id)) {
				await this.renderNode(ctx, node, width, height, false);
				continue;
			}
			if (node.kind === 'adjustment') await this.renderAdjustmentNode(ctx, node, width, height);
			else await this.renderNode(ctx, node, width, height);
		}
		ctx.restore();
		if (this.gl && this.texture && this.program && this.buffer)
			this.presentGpu(width, height);
	}

	private presentGpu(width: number, height: number) {
		const gl = this.gl!;
		gl.viewport(0, 0, width, height);
		gl.clearColor(0, 0, 0, 0);
		gl.clear(gl.COLOR_BUFFER_BIT);
		gl.useProgram(this.program!);
		gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
		const position = gl.getAttribLocation(this.program!, 'p');
		gl.enableVertexAttribArray(position);
		gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
		gl.activeTexture(gl.TEXTURE0);
		gl.bindTexture(gl.TEXTURE_2D, this.texture);
		gl.texImage2D(
			gl.TEXTURE_2D,
			0,
			gl.RGBA,
			gl.RGBA,
			gl.UNSIGNED_BYTE,
			this.surface,
		);
		gl.uniform1i(gl.getUniformLocation(this.program!, 'image'), 0);
		gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
	}

	private makeCanvas(width: number, height: number) {
		const canvas = document.createElement('canvas');
		canvas.width = width;
		canvas.height = height;
		return canvas;
	}

	private tintedAlpha(
		source: HTMLCanvasElement,
		color: DocumentColor,
		opacity: number,
	) {
		const canvas = this.makeCanvas(source.width, source.height);
		const ctx = canvas.getContext('2d');
		if (!ctx) return canvas;
		ctx.drawImage(source, 0, 0);
		ctx.globalCompositeOperation = 'source-in';
		ctx.fillStyle = cssColor(color, opacity);
		ctx.fillRect(0, 0, canvas.width, canvas.height);
		return canvas;
	}

	private applyLayerEffects(
		source: HTMLCanvasElement,
		effects: LayerEffects | undefined,
	) {
		if (!effects) return source;
		const result = this.makeCanvas(source.width, source.height);
		const ctx = result.getContext('2d');
		if (!ctx) return source;
		const shadow = (
			color: DocumentColor,
			opacity: number,
			x: number,
			y: number,
			blur: number,
		) => {
			ctx.save();
			ctx.filter = `drop-shadow(${x}px ${y}px ${Math.max(0, blur)}px ${cssColor(color, opacity)})`;
			ctx.drawImage(source, 0, 0);
			ctx.restore();
		};
		if (effects.dropShadow?.enabled) {
			const radians = (effects.dropShadow.angle * Math.PI) / 180;
			shadow(
				effects.dropShadow.color,
				effects.dropShadow.opacity,
				effects.dropShadow.distance * Math.cos(radians),
				effects.dropShadow.distance * Math.sin(radians),
				effects.dropShadow.size + effects.dropShadow.spread,
			);
		}
		if (effects.outerGlow?.enabled)
			shadow(
				effects.outerGlow.color,
				effects.outerGlow.opacity,
				0,
				0,
				effects.outerGlow.size + effects.outerGlow.spread,
			);
		if (effects.stroke?.enabled && effects.stroke.size > 0) {
			const stroke = this.tintedAlpha(source, effects.stroke.color, effects.stroke.opacity);
			const radius = Math.max(1, Math.round(effects.stroke.size));
			const factor = effects.stroke.position === 'inside' ? 0 : effects.stroke.position === 'center' ? 0.5 : 1;
			if (factor > 0)
				for (let angle = 0; angle < 360; angle += Math.max(12, 90 / radius)) {
					const radians = (angle * Math.PI) / 180;
					ctx.drawImage(stroke, Math.cos(radians) * radius * factor, Math.sin(radians) * radius * factor);
				}
		}
		ctx.drawImage(source, 0, 0);
		if (effects.colorOverlay?.enabled) {
			ctx.save();
			ctx.globalCompositeOperation = blendMode[effects.colorOverlay.blendMode] ?? 'source-over';
			ctx.drawImage(this.tintedAlpha(source, effects.colorOverlay.color, effects.colorOverlay.opacity), 0, 0);
			ctx.restore();
		}
		const inner = (color: DocumentColor, opacity: number, x: number, y: number, blur: number) => {
			const canvas = this.makeCanvas(source.width, source.height);
			const innerCtx = canvas.getContext('2d');
			if (!innerCtx) return;
			innerCtx.filter = `blur(${Math.max(0, blur)}px)`;
			innerCtx.drawImage(this.tintedAlpha(source, color, opacity), x, y);
			innerCtx.filter = 'none';
			innerCtx.globalCompositeOperation = 'destination-in';
			innerCtx.drawImage(source, 0, 0);
			ctx.drawImage(canvas, 0, 0);
		};
		if (effects.innerShadow?.enabled) {
			const radians = (effects.innerShadow.angle * Math.PI) / 180;
			inner(effects.innerShadow.color, effects.innerShadow.opacity, effects.innerShadow.distance * Math.cos(radians), effects.innerShadow.distance * Math.sin(radians), effects.innerShadow.size + effects.innerShadow.spread);
		}
		if (effects.innerGlow?.enabled) inner(effects.innerGlow.color, effects.innerGlow.opacity, 0, 0, effects.innerGlow.size + effects.innerGlow.spread);
		return result;
	}

	private async renderAdjustmentNode(
		ctx: CanvasRenderingContext2D,
		node: Extract<RenderGraphNode, {kind: 'adjustment'}>,
		width: number,
		height: number,
	) {
		const content = node.layer.content;
		if (
			content.kind === 'pixel' ||
			content.kind === 'group' ||
			content.kind === 'text' ||
			content.kind === 'shape'
		)
			return;
		const surface = this.makeCanvas(width, height);
		const layerContext = surface.getContext('2d');
		if (!layerContext) return;
		if (content.kind === 'camera-raw') {
			for (const inputId of node.inputNodeIds) {
				const input = this.renderedLayers.get(inputId);
				if (input) layerContext.drawImage(input, 0, 0);
			}
			const image = layerContext.getImageData(0, 0, width, height);
			const graded = applyCameraRaw({width, height, data: image.data}, content.settings);
			layerContext.putImageData(new ImageData(graded.data as Uint8ClampedArray<ArrayBuffer>, width, height), 0, 0);
		} else {
			layerContext.save();
			layerContext.globalAlpha = Math.max(0, Math.min(1, node.layer.opacity));
			layerContext.filter = adjustmentFilter(content);
			for (const inputId of node.inputNodeIds) {
				const input = this.renderedLayers.get(inputId);
				if (input) layerContext.drawImage(input, 0, 0);
			}
			layerContext.restore();
		}
		this.renderedLayers.set(node.layer.id, surface);
		ctx.save();
		if (content.kind === 'camera-raw') ctx.globalAlpha = Math.max(0, Math.min(1, node.layer.opacity));
		ctx.globalCompositeOperation = blendMode[node.layer.blendMode] ?? 'source-over';
		ctx.drawImage(surface, 0, 0);
		ctx.restore();
	}

	private async renderNode(
		ctx: CanvasRenderingContext2D,
		node: RenderGraphNode,
		width: number,
		height: number,
		composite = true,
	) {
		const layer = node.layer;
		if (!layer.visible || layer.kind === 'group') return;
		const content = layer.content;
		const surface = this.makeCanvas(width, height);
		const layerContext = surface.getContext('2d');
		if (!layerContext) return;
		const warp = content.kind === 'pixel' ? layerWarp(layer.id) : undefined;
		layerContext.save();
		layerContext.globalAlpha = Math.max(0, Math.min(1, layer.opacity));
		if (!warp) applyLayerTransform(layerContext, layer.transform);
		if (content.kind === 'pixel' && warp) {
			const image = await this.assetLoader(content.assetId);
			if (image)
				drawWarpedImage(
					layerContext,
					image,
					layer.transform.width,
					layer.transform.height,
					warp,
				);
		} else if (content.kind === 'pixel') {
			const image = await this.assetLoader(content.assetId);
			if (image)
				layerContext.drawImage(
					image,
					0,
					0,
					layer.transform.width,
					layer.transform.height,
				);
		} else if (content.kind === 'shape') {
			layerContext.fillStyle = `rgba(${content.fill.r},${content.fill.g},${content.fill.b},${content.fill.a})`;
			if (content.shape === 'ellipse') {
				layerContext.beginPath();
				layerContext.ellipse(
					layer.transform.width / 2,
					layer.transform.height / 2,
					layer.transform.width / 2,
					layer.transform.height / 2,
					0,
					0,
					Math.PI * 2,
				);
				layerContext.fill();
			} else if (content.shape === 'rounded-rectangle') {
				layerContext.beginPath();
				layerContext.roundRect(0, 0, layer.transform.width, layer.transform.height, content.cornerRadius ?? 0);
				layerContext.fill();
			} else if (content.shape === 'line') {
				layerContext.strokeStyle = `rgba(${(content.stroke ?? content.fill).r},${(content.stroke ?? content.fill).g},${(content.stroke ?? content.fill).b},${(content.stroke ?? content.fill).a})`;
				layerContext.lineWidth = Math.max(1, content.strokeWidth);
				layerContext.beginPath();
				layerContext.moveTo(0, layer.transform.height / 2);
				layerContext.lineTo(layer.transform.width, layer.transform.height / 2);
				layerContext.stroke();
			} else
				layerContext.fillRect(
					0,
					0,
					layer.transform.width,
					layer.transform.height,
				);
		} else if (content.kind === 'text') {
			layerContext.fillStyle = `rgba(${content.color.r},${content.color.g},${content.color.b},${content.color.a})`;
			layerContext.textAlign = content.align;
			const startX = content.align === 'left' ? 0 : content.align === 'center' ? layer.transform.width / 2 : layer.transform.width;
			let y = content.fontSize;
			for (const line of content.text.split('\n')) {
				const lineStart = content.text.indexOf(line);
				const runs = (content.runs ?? []).filter((run) => run.end > lineStart && run.start < lineStart + line.length);
				if (!runs.length) {
					layerContext.font = `${content.fontSize}px ${content.fontFamily}`;
					layerContext.fillText(line, startX, y);
				} else {
					layerContext.textAlign = 'left';
					let x = content.align === 'left' ? 0 : startX - layerContext.measureText(line).width * (content.align === 'center' ? 0.5 : 1);
					let cursor = 0;
					for (const run of runs) {
						const relativeStart = Math.max(0, run.start - lineStart);
						const relativeEnd = Math.min(line.length, run.end - lineStart);
						const before = line.slice(cursor, relativeStart);
						layerContext.font = `${content.fontSize}px ${content.fontFamily}`;
						layerContext.fillStyle = cssColor(content.color);
						layerContext.fillText(before, x, y);
						x += layerContext.measureText(before).width + before.length * content.letterSpacing;
						const segment = line.slice(relativeStart, relativeEnd);
						layerContext.font = `${run.fontSize ?? content.fontSize}px ${run.fontFamily ?? content.fontFamily}`;
						layerContext.fillStyle = cssColor(run.color ?? content.color);
						layerContext.fillText(segment, x, y);
						x += layerContext.measureText(segment).width + segment.length * content.letterSpacing;
						cursor = relativeEnd;
					}
					const tail = line.slice(cursor);
					layerContext.font = `${content.fontSize}px ${content.fontFamily}`;
					layerContext.fillStyle = cssColor(content.color);
					layerContext.fillText(tail, x, y);
				}
				y += content.fontSize * content.lineHeight;
			}
		}
		if (content.kind === 'shape' && content.stroke && content.strokeWidth > 0 && content.shape !== 'line') {
			layerContext.strokeStyle = `rgba(${content.stroke.r},${content.stroke.g},${content.stroke.b},${content.stroke.a})`;
			layerContext.lineWidth = content.strokeWidth;
			layerContext.strokeRect(0, 0, layer.transform.width, layer.transform.height);
		}
		layerContext.restore();
		for (const applied of layer.effectiveMasks) {
			if (!applied.mask.enabled) continue;
			const image = await this.assetLoader(applied.mask.assetId);
			if (!image) continue;
			const maskCanvas = this.makeCanvas(width, height);
			const maskContext = maskCanvas.getContext('2d');
			if (!maskContext) continue;
			maskContext.save();
			applyLayerTransform(maskContext, applied.transform);
			maskContext.filter =
				applied.mask.feather > 0 ? `blur(${applied.mask.feather}px)` : 'none';
			maskContext.drawImage(
				image,
				0,
				0,
				applied.transform.width,
				applied.transform.height,
			);
			maskContext.restore();
			layerContext.save();
			layerContext.globalCompositeOperation = applied.mask.invert
				? 'destination-out'
				: 'destination-in';
			layerContext.drawImage(maskCanvas, 0, 0);
			layerContext.restore();
		}
		if (layer.liveMask) {
			const source = this.renderedLayers.get(layer.liveMask.sourceLayerId);
			if (source) {
				layerContext.save();
				layerContext.globalCompositeOperation = layer.liveMask.mode.endsWith(
					'inverted',
				)
					? 'destination-out'
					: 'destination-in';
				layerContext.drawImage(source, 0, 0);
				layerContext.restore();
			}
		}
		const output = this.applyLayerEffects(surface, layer.effects);
		this.renderedLayers.set(layer.id, output);
		if (composite) {
			ctx.save();
			ctx.globalCompositeOperation = blendMode[layer.blendMode] ?? 'source-over';
			ctx.drawImage(output, 0, 0);
			ctx.restore();
		}
	}
}

export const createRenderGraphRenderer = (
	canvas: HTMLCanvasElement,
	options?: {preferWebgl2?: boolean},
) => new RenderGraphRenderer(canvas, options?.preferWebgl2 ?? true);
