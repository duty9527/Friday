export {
  SSH_POLL_COMMAND,
  SSH_PAUSE_COMMAND,
  setDefaultXiaoaiSshHome,
  resolveXiaoaiSshControlPath,
  defaultSshRunner,
  closeXiaoaiSshConnections,
  parseXiaoaiApiOptions,
  parseXiaoaiSshTargets,
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
  handleXiaoaiKeywordWake,
  sendXiaoaiSpeech,
  type XiaoaiSendOptions,
} from './xiaoai/tts-player.js';

export {
  stripXiaoaiDialogDirective,
  shouldContinueXiaoaiDialog,
  sanitizeForSpeech,
  splitSpeechSegments,
  shouldInterceptXiaoaiQuery,
} from './xiaoai/utterance-utils.js';
