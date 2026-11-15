export {
  XIAOAI_KEYWORDS_VERSION,
  DEFAULT_XIAOAI_KEYWORDS,
  DEFAULT_END_SILENCE_MS,
  DEFAULT_SHORT_UTTERANCE_END_SILENCE_MS,
  SHORT_UTTERANCE_SPEECH_MS,
  decodePcm16leToFloat32,
  decodePcm32leToFloat32,
  computeRms,
  normalizeUtteranceSamples,
  computeKwsGain,
  updateAmbientNoiseRms,
  computeForegroundSpeechGate,
  XiaoaiKwsMonitor,
  type XiaoaiKwsStreamHandle,
  type XiaoaiKwsSpotter,
  type XiaoaiAsrRecognizer,
  type XiaoaiSpeechDetector,
  type XiaoaiKwsSpeakerGate,
  type XiaoaiKwsWakeEvent,
  type XiaoaiKwsUtteranceEvent,
  type XiaoaiKwsWorkerMode,
  type XiaoaiKwsWorkerStatus,
  type XiaoaiKwsMonitorOptions,
} from './xiaoai/kws-monitor.js';

export type { XiaoaiMatchedSpeaker } from './im/types.js';

export {
  hasLeadingXiaoaiWakeWord,
  cleanXiaoaiAsrUtterance,
  extractLeadingXiaoaiWakeKeyword,
  isXiaoaiFollowUpCancel,
} from './xiaoai/utterance-utils.js';
