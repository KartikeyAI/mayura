export const releaseBriefing =
  'Start with five percent of traffic. Verify the error rate and latency against the baseline. Expand when the canary is healthy, or roll back if the thresholds are exceeded.';

export const fixtureMedia = {
  video: '/fixtures/release-sequence.webm',
  captions: '/fixtures/release-sequence.vtt',
  poster: '/fixtures/release-sequence.png',
  audio: '/fixtures/release-briefing.wav',
} as const;

export const replyArtifactFixtures = [
  {
    id: 'canary',
    type: 'chart',
    title: 'Canary rollout',
    description: 'Share of traffic after each successful checkpoint.',
    unit: '%',
    points: [
      { label: 'Canary', value: 5 },
      { label: 'Expand', value: 25 },
      { label: 'Release', value: 100 },
    ],
  },
  {
    id: 'walkthrough',
    type: 'video',
    title: 'Release sequence',
    description: 'A silent walkthrough of the canary, verification and expansion steps.',
    src: fixtureMedia.video,
    captions: fixtureMedia.captions,
    poster: fixtureMedia.poster,
  },
  {
    id: 'briefing',
    type: 'audio',
    title: 'Release briefing',
    src: fixtureMedia.audio,
    transcript: releaseBriefing,
  },
  {
    id: 'runbook',
    type: 'link',
    title: 'Mayura documentation',
    description: 'Guides for running agents, workflows and approval flows.',
    href: 'https://mayurajs.com/docs/',
  },
] as const;
