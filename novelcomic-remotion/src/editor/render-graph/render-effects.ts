import type {CSSProperties} from 'react';
import type {DocumentColor, LayerEffects} from '../document';

const color = (value: DocumentColor, opacity = value.a) => `rgba(${value.r}, ${value.g}, ${value.b}, ${Math.max(0, Math.min(1, opacity))})`;

export const effectsStyle = (effects: LayerEffects | undefined): CSSProperties => {
	if (!effects) return {};
	const shadows: string[] = [];
	if (effects.stroke?.enabled) {
		const spread = effects.stroke.position === 'inside' ? -effects.stroke.size : effects.stroke.position === 'outside' ? effects.stroke.size : 0;
		shadows.push(`0 0 0 ${Math.max(0, effects.stroke.size + spread)}px ${color(effects.stroke.color, effects.stroke.opacity)}`);
	}
	if (effects.dropShadow?.enabled) shadows.push(`${effects.dropShadow.distance * Math.cos((effects.dropShadow.angle * Math.PI) / 180)}px ${effects.dropShadow.distance * Math.sin((effects.dropShadow.angle * Math.PI) / 180)}px ${effects.dropShadow.size}px ${color(effects.dropShadow.color, effects.dropShadow.opacity)}`);
	if (effects.innerShadow?.enabled) shadows.push(`inset 0 0 ${effects.innerShadow.size}px ${color(effects.innerShadow.color, effects.innerShadow.opacity)}`);
	if (effects.outerGlow?.enabled) shadows.push(`0 0 ${effects.outerGlow.size}px ${effects.outerGlow.spread}px ${color(effects.outerGlow.color, effects.outerGlow.opacity)}`);
	if (effects.innerGlow?.enabled) shadows.push(`inset 0 0 ${effects.innerGlow.size}px ${effects.innerGlow.spread}px ${color(effects.innerGlow.color, effects.innerGlow.opacity)}`);
	return {
		boxShadow: shadows.length ? shadows.join(', ') : undefined,
	};
};
