export {
  SSH_POLL_COMMAND,
  SSH_PAUSE_COMMAND,
  setDefaultXiaoaiSshHome,
  resolveXiaoaiSshControlPath,
  defaultSshRunner,
  closeXiaoaiSshConnections,
  parseXiaoaiApiOptions,
  parseXiaoaiSshTargets,
  getXiaoaiWakeCacheFileName,
  buildXiaoaiWakeCommand,
  buildXiaoaiWakePrewarmCommand,
  buildXiaoaiLedCommand,
  setXiaoaiSpeakerLed,
  type XiaoaiSshTarget,
  type XiaoaiSshRunner,
  type XiaoaiApiOptions,
} from './xiaoai/ssh.js';

export {
  isXiaoaiPollable,
  parseXiaoaiWebhookPayload,
  getCloudBases,
  resolveCloudSession,
  fetchMinaDeviceList,
  selectTargetMinaDevices,
  callMinaRemoteUbus,
  pollXiaoaiChannel,
  type XiaoaiPollResult,
  type XiaoaiCloudSession,
  type MinaDevice,
} from './xiaoai/cloud-auth.js';

export {
  bumpXiaoaiSpeechEpoch,
  markXiaoaiSpeakingGuard,
  isXiaoaiSpeakingSelfEcho,
  resetXiaoaiRuntimeState,
  XIAOAI_URGENT_WAKE_MAX_MS,
  DEFAULT_OWNER_WAKE_GREETINGS,
  resolveXiaoaiWakeGreeting,
  tightenWakeMp3BufferWithFfmpeg,
  prewarmXiaoaiWakeGreetings,
  handleXiaoaiKeywordWake,
  sendXiaoaiSpeech,
  type XiaoaiSendOptions,
} from './xiaoai/tts-player.js';

export {
  stripXiaoaiDialogDirective,
  shouldContinueXiaoaiDialog,
  sanitizeForSpeech,
  smoothXiaoaiTtsProsody,
  splitSpeechSegments,
  shouldInterceptXiaoaiQuery,
} from './xiaoai/utterance-utils.js';
