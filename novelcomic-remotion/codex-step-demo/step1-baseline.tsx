import React from 'react';
import {AbsoluteFill, Img, staticFile} from 'remotion';

export const BaselineFrame: React.FC = () => (
  <AbsoluteFill style={{backgroundColor: '#f4f1eb'}}>
    <Img
      src={staticFile('codex-step-demo/source.png')}
      style={{width: '100%', height: '100%', objectFit: 'cover'}}
    />
  </AbsoluteFill>
);
