import React from 'react';
import {AudioLayer} from './audio/audio-layer';
import {CaptionsLayer} from './captions/captions-layer';
import {GifLayer} from './gif/gif-layer';
import {ImageLayer} from './image/image-layer';
import {EditorStarterItem} from './item-type';
import {VideoLayer} from './video/video-layer';

export const InnerLayer: React.FC<{
	item: EditorStarterItem;
	trackMuted: boolean;
	cropBackground: boolean;
}> = ({item, trackMuted, cropBackground}) => {
	if (item.type === 'image') {
		return <ImageLayer item={item} cropBackground={cropBackground} />;
	}

	if (item.type === 'video') {
		return (
			<VideoLayer
				item={item}
				trackMuted={trackMuted}
				cropBackground={cropBackground}
			/>
		);
	}

	// Legacy text and solid items are retained in the serialized union only so
	// older projects can be inspected. Their creation and rendering belong to
	// the Compositor document/render graph and are intentionally disabled here.
	if (item.type === 'text' || item.type === 'solid') return null;

	if (item.type === 'audio') {
		return <AudioLayer item={item} trackMuted={trackMuted} />;
	}

	if (item.type === 'captions') {
		return <CaptionsLayer item={item} />;
	}

	if (item.type === 'gif') {
		return <GifLayer item={item} cropBackground={cropBackground} />;
	}

	throw new Error(
		'Unimplemented item type: ' + JSON.stringify(item satisfies never),
	);
};
