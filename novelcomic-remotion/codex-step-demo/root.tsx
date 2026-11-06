import React from 'react';
import {Composition} from 'remotion';
import {BaselineFrame} from './step1-baseline';

export const CodexStepRoot: React.FC = () => (
  <Composition
    id="CodexStep1"
    component={BaselineFrame}
    durationInFrames={150}
    fps={30}
    width={1080}
    height={1920}
  />
);
