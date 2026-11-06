import React, {ComponentProps, PropsWithChildren} from 'react';
import {ITEM_COLORS} from '../../constants';
import {EditorStarterItem} from '../../items/item-type';
import {SolidItem} from '../../items/solid/solid-item-type';

const SimplePreview = ({
	children,
	style,
	textClassName = 'text-white',
}: ComponentProps<'div'> & {textClassName?: string}) => {
	return (
		<div
			className={`flex h-full w-full flex-nowrap gap-1 p-1 text-xs ${textClassName}`}
			style={{background: '#FF9843', ...style}}
		>
			{children}
		</div>
	);
};

const Text = ({children}: PropsWithChildren) => {
	return <span className="truncate">{children}</span>;
};

SimplePreview.Text = Text;

const CaptionsPreview: React.FC = () => {
	return (
		<SimplePreview style={{background: '#FF7F50'}}>
			<SimplePreview.Text>Captions</SimplePreview.Text>
		</SimplePreview>
	);
};

const TextItemPreview: React.FC<{
	text: string;
}> = ({text}) => {
	return (
		<SimplePreview style={{background: ITEM_COLORS.text}}>
			<SimplePreview.Text>{text}</SimplePreview.Text>
		</SimplePreview>
	);
};

const ImageItemPreview: React.FC = () => {
	return (
		<SimplePreview style={{background: ITEM_COLORS.image}}></SimplePreview>
	);
};

const GifItemPreview: React.FC = () => {
	return <SimplePreview style={{background: ITEM_COLORS.gif}}></SimplePreview>;
};

const VideoItemPreview: React.FC = () => {
	return (
		<SimplePreview
			style={{background: 'var(--color-editor-starter-timeline-slot)'}}
			textClassName="text-editor-starter-text"
		></SimplePreview>
	);
};

const AudioItemPreview: React.FC = () => {
	return (
		<SimplePreview
			style={{background: 'var(--color-editor-starter-timeline-slot)'}}
			textClassName="text-editor-starter-text"
		></SimplePreview>
	);
};

const SolidItemPreview: React.FC<{
	item: SolidItem;
}> = ({item}) => {
	return (
		<SimplePreview style={{background: ITEM_COLORS.solid}}>
			<div
				className={'mt-[1px] h-3 w-3 shrink-0 rounded-full'}
				style={{
					backgroundColor: item.color,
				}}
			></div>
			<SimplePreview.Text>Solid</SimplePreview.Text>
		</SimplePreview>
	);
};

export const TimelineItemPreview: React.FC<{
	item: EditorStarterItem;
}> = ({item}) => {
	if (item.type === 'text') {
		return <TextItemPreview text={item.text} />;
	}

	if (item.type === 'image') {
		return <ImageItemPreview />;
	}

	if (item.type === 'video') {
		return <VideoItemPreview />;
	}

	if (item.type === 'solid') {
		return <SolidItemPreview item={item} />;
	}

	if (item.type === 'captions') {
		return <CaptionsPreview />;
	}

	if (item.type === 'audio') {
		return <AudioItemPreview />;
	}

	if (item.type === 'gif') {
		return <GifItemPreview />;
	}

	throw new Error(`Unknown item type: ${JSON.stringify(item satisfies never)}`);
};
