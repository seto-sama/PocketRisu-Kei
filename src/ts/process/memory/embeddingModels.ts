export const remoteHypaModels = ['custom', 'ada', 'openai3small', 'openai3large', 'voyage4large', 'voyageContext3', 'voyageContext4'] as const;
export type HypaModel = typeof remoteHypaModels[number];
export const DEFAULT_HYPA_MODEL: HypaModel = 'openai3small';

