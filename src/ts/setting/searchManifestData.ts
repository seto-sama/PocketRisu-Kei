import { language } from 'src/lang';
import { SettingsRoute, type SettingsRouteValue } from '../routing';

export interface ManualSearchEntry {
    id: string;
    label: () => string;
    help?: () => string;
    keywords: string[];
    route: SettingsRouteValue;
    subTab?: number;
}

export const searchManifestEntries: ManualSearchEntry[] = [
    { id: 'manual.page.modelPreset', label: () => language.modelPresetMenu, keywords: ['model preset', 'preset', '모델 프리셋', '프리셋'], route: SettingsRoute.ModelPreset, subTab: 0 },
    { id: 'manual.modelPreset.keys', label: () => language.apiKeyManagerMenu, keywords: ['api key', 'credential', 'api 키'], route: SettingsRoute.ModelPreset, subTab: 1 },
    { id: 'manual.modelPreset.options', label: () => language.modelPresetTabOptions, keywords: ['model options', 'registry', '모델 설정', '레지스트리'], route: SettingsRoute.ModelPreset, subTab: 2 },
    { id: 'manual.page.promptPreset', label: () => language.promptPresetMenu, keywords: ['prompt preset', '프롬프트 프리셋'], route: SettingsRoute.PromptPreset, subTab: 0 },
    { id: 'manual.promptPreset.prompt', label: () => language.prompt, keywords: ['prompt block', 'role', '프롬프트 블록', '역할'], route: SettingsRoute.PromptPreset, subTab: 1 },
    { id: 'manual.promptPreset.advanced', label: () => language.advancedSettings, keywords: ['prompt template', 'legacy', '프롬프트 템플릿'], route: SettingsRoute.PromptPreset, subTab: 2 },
    { id: 'manual.promptPreset.regex', label: () => language.regexScript, keywords: ['regex', 'regexp', '정규식'], route: SettingsRoute.PromptPreset, subTab: 3 },
    { id: 'manual.page.persona', label: () => language.persona, keywords: ['persona', 'user profile', '페르소나'], route: SettingsRoute.Persona },
    { id: 'manual.otherBots.memory', label: () => language.longTermMemory, keywords: ['memory', 'hypa', 'embedding', '장기 기억', '메모리'], route: SettingsRoute.OtherBots, subTab: 0 },
    { id: 'manual.otherBots.tts', label: () => 'TTS', keywords: ['tts', 'voice', 'speech', '음성', '보이스'], route: SettingsRoute.OtherBots, subTab: 1 },
    { id: 'manual.otherBots.image', label: () => language.image, keywords: ['image generation', 'stable diffusion', '이미지 생성'], route: SettingsRoute.OtherBots, subTab: 2 },
    { id: 'manual.page.language', label: () => language.language, keywords: ['language', 'translation', '언어', '번역'], route: SettingsRoute.Language, subTab: 0 },
    { id: 'manual.language.cache', label: () => language.translationCache, keywords: ['translation cache', '번역 캐시'], route: SettingsRoute.Language, subTab: 1 },
    { id: 'manual.addons.plugin', label: () => language.plugin, keywords: ['plugin', '플러그인'], route: SettingsRoute.Addons, subTab: 0 },
    { id: 'manual.addons.module', label: () => language.modules, keywords: ['module', '모듈'], route: SettingsRoute.Addons, subTab: 1 },
    { id: 'manual.addons.mcp', label: () => 'MCP', keywords: ['mcp', 'model context protocol'], route: SettingsRoute.Addons, subTab: 2 },
    { id: 'manual.display.sound', label: () => language.soundAndNotification, keywords: ['sound', 'notification', 'volume', '소리', '알림'], route: SettingsRoute.Display, subTab: 3 },
    { id: 'manual.accessibility.hotkeys', label: () => language.hotkey, keywords: ['hotkey', 'shortcut', '단축키', '핫키'], route: SettingsRoute.Accessibility, subTab: 3 },
    { id: 'manual.page.advanced', label: () => language.advancedSettings, keywords: ['advanced', 'developer', '고급', '개발자'], route: SettingsRoute.Advanced },
    { id: 'manual.inlay.images', label: () => language.playground.inlayImageList, keywords: ['inlay image', '인레이 이미지'], route: SettingsRoute.InlayImageGallery, subTab: 0 },
    { id: 'manual.inlay.media', label: () => language.playground.inlayMediaList, keywords: ['inlay media', 'video', 'audio', '인레이 미디어'], route: SettingsRoute.InlayImageGallery, subTab: 1 },
    { id: 'manual.page.remote', label: () => language.connectionManagement, keywords: ['remote access', 'network', 'tailscale', '원격 접속', '연결'], route: SettingsRoute.RemoteAccess },
    { id: 'manual.system.dashboard', label: () => language.systemDashboard, keywords: ['dashboard', 'storage', 'disk', '대시보드', '용량'], route: SettingsRoute.System, subTab: 0 },
    { id: 'manual.system.backups', label: () => language.systemBackups, keywords: ['backup', 'restore', 'export', '백업', '복원', '내보내기'], route: SettingsRoute.System, subTab: 1 },
    { id: 'manual.system.pluginStorage', label: () => language.pluginStorageTab, keywords: ['plugin storage', '플러그인 저장소'], route: SettingsRoute.System, subTab: 2 },
    { id: 'manual.admin.systemLogs', label: () => language.systemLogs, keywords: ['system log', 'error log', '시스템 로그'], route: SettingsRoute.AdminAndStats, subTab: 0 },
    { id: 'manual.admin.requestLogs', label: () => 'Request Logs', keywords: ['request log', 'api call', '요청 로그'], route: SettingsRoute.AdminAndStats, subTab: 1 },
    { id: 'manual.admin.usage', label: () => 'Usage', keywords: ['usage', 'token', 'statistics', '사용량', '통계'], route: SettingsRoute.AdminAndStats, subTab: 2 },
    { id: 'manual.page.files', label: () => language.files, keywords: ['files', 'assets', '파일'], route: SettingsRoute.Files },
];
