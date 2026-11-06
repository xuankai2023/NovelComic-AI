import type { CoreModelEntity } from '../types.js';
import { GptImage2EditImageToImageModel, GptImage2TextToImageModel } from './gpt-image-2.js';
import { KieImageModel } from './kie_image.js';
import {
  MidjourneyV81ImageToImageModel,
  MidjourneyV81TextToImageModel,
  MidjourneyV82ImageToImageModel,
  MidjourneyV82TextToImageModel,
} from './midjourney.js';
// import { YouchuanVideoImageToVideoModel, YouchuanVideoTextToVideoModel } from './youchuan-video.js';

export const CORE_MODELS: CoreModelEntity[] = [
  KieImageModel,
  MidjourneyV81TextToImageModel,
  MidjourneyV81ImageToImageModel,
  MidjourneyV82TextToImageModel,
  MidjourneyV82ImageToImageModel,
  GptImage2TextToImageModel,
  GptImage2EditImageToImageModel,
  // YouchuanVideoTextToVideoModel,
  // YouchuanVideoImageToVideoModel,
];

export {
  KIE_CREATE_TASK_ENDPOINT,
  KIE_IMAGE_MODEL_ID,
  KIE_IMAGE_PROVIDER_MODEL_ID,
  KIE_RECORD_INFO_ENDPOINT,
  KieImageModel,
  KieImageOptionsSchema,
} from './kie_image.js';
