import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';

import { listOpenAIResearchProfiles, runOpenAINativeResearch } from '../openai-native-research.js';
import { getEnabledResearchBackends, isResearchBackendEnabled } from '../feature-policy.js';
import { buildPlannerPriorTurns } from '../planner-prompts.js';
import { PLANNER_CONNECTION_MODES, PLANNER_REQUEST_TIMEOUT_REASON, raceTaskWithAbortSignal } from '../planner-request-router.js';
import { DEFAULT_RESULT_VARIABLE_NAME, neutralizeSillyTavernMacros, normalizeResultInjectionDepth } from '../research-injection.js';
import { evaluateNativeResearchGate, hasExplicitNoSearchIntent, hasExplicitSearchIntent } from '../research-gate.js';
import { captureRuntimeClock, classifyTemporalRequest } from '../runtime-time.js';
import { isJsSlashRunnerPromptViewerRefreshActive, shouldSkipSyntheticGeneration } from '../generation-request-guard.js';

// Execute the actual extension entry point and host adapter with the real native
// researcher. Only the TT host boundary and remote API are replaced with fakes.
const index = await readFile(new URL('../index.js', import.meta.url), 'utf8');
function extract(name) {
    const match = new RegExp(`(?:async )?function ${name}\\(`, 'u').exec(index);
    assert.ok(match, `Missing integration function ${name}`);
    const tail = index.slice(match.index);
    const end = /\r?\n\}(?=\r?\n|$)/u.exec(tail);
    assert.ok(end, `Missing integration function boundary ${name}`);
    return tail.slice(0, end.index + end[0].length);
}

const PROFILE = {
    id: 'gpt-research', name: 'GPT 资料员', api: 'custom_openai_responses',
    'custom-api-format': 'openai_responses', 'api-url': 'https://api.openai.com/v1',
    'secret-id': 'saved-official-gpt-key', model: 'gpt-research-fixture',
};
const SOURCE = 'https://example.org/canon/character';
const LONG_REPORT = '【原作事实】角色的说话方式、人物关系和时间顺序已经核实。'.repeat(90)
    + `\n[原作资料](${SOURCE})\n【自定义剧情】你们当前的相遇属于用户新增设定，应保持不变。`;

function nativeResponse(report = LONG_REPORT, options = {}) {
    const content = JSON.stringify({ report, needsMoreSearch: false, gaps: [], ...options });
    return {
        choices: [{
            finish_reason: 'stop',
            message: {
                role: 'assistant', content,
                native: { openai_responses: { output: [
                    { type: 'web_search_call', status: 'completed', action: { sources: [{ title: '原作资料', url: SOURCE }] } },
                    { type: 'message', role: 'assistant', status: 'completed', content: [{
                        type: 'output_text', text: content,
                        annotations: [{ type: 'url_citation', title: '原作资料', url: SOURCE }],
                    }] },
                ] } },
            },
        }],
    };
}

function deferred() {
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

function fixture({ reply = async () => nativeResponse(), overrides = {} } = {}) {
    const requests = [];
    const prompts = new Map();
    const promptHistory = [];
    const statuses = [];
    const traces = [];
    const logs = [];
    const aborts = [];
    const ui = new Map();
    const service = {
        getSupportedProfiles: () => [PROFILE],
        async sendRequest(profileId, messages, maxTokens, custom, overridePayload) {
            const request = { profileId, messages, maxTokens, custom, overridePayload };
            requests.push(request);
            return reply(request, requests.length);
        },
    };
    const context = {
        chatId: 'chat-a', characterId: 0,
        characters: [{ name: '角色甲', description: '原作角色，穿着用户自定义服装。', personality: '克制、寡言' }],
        chat: [{ is_user: false, mes: '她推开门，向你点头。' }, { is_user: true, mes: '我向她问好，请继续扮演这个角色。' }],
        mainApi: 'openai', chatCompletionSettings: { chat_completion_source: 'makersuite', model: 'gemini-rp-fixture' },
        selectedProfile: 'gemini-main',
        ConnectionManagerRequestService: service,
        CONNECT_API_MAP: { custom_openai_responses: { selected: 'openai', source: 'custom' } },
    };
    function jquery(selector) {
        const key = String(selector);
        return {
            val(value) { if (arguments.length) { ui.set(key, value); return this; } return ui.get(key); },
            prop() { return this; },
            text() { return this; },
        };
    }
    const sandbox = {
        listOpenAIResearchProfiles, runOpenAINativeResearch, getEnabledResearchBackends, isResearchBackendEnabled,
        buildPlannerPriorTurns, PLANNER_CONNECTION_MODES, PLANNER_REQUEST_TIMEOUT_REASON, raceTaskWithAbortSignal,
        DEFAULT_RESULT_VARIABLE_NAME, neutralizeSillyTavernMacros, normalizeResultInjectionDepth,
        evaluateNativeResearchGate, hasExplicitNoSearchIntent, hasExplicitSearchIntent,
        captureRuntimeClock, classifyTemporalRequest, isJsSlashRunnerPromptViewerRefreshActive, shouldSkipSyntheticGeneration,
        AbortController, URL, structuredClone, setTimeout, clearTimeout,
        SillyTavern: { getContext: () => context }, document: { querySelectorAll: () => [] },
        $: jquery, console: { debug() {}, warn() {}, error() {} },
        CLIENT_COMPATIBILITY: { supported: true }, ENABLE_SERVER_DEPENDENT_FEATURES: false,
        MINIMUM_SUPPORTED_CLIENT_VERSION: '1.13.3', DISPLAY_NAME: 'P1G搜（测试）',
        PROMPT_KEY: '___HiddenWebResearch___',
        extension_prompt_types: { IN_CHAT: 1, BEFORE_PROMPT: 2, IN_PROMPT: 3 },
        extension_prompt_roles: { USER: 1, SYSTEM: 0, ASSISTANT: 2 },
        searchLogGeneration: 0, researchCache: new Map(), queryCache: new Map(),
        researchResponseGuard: { clear() {} }, plannerDirectSaveLocked: false,
        is_send_press: false, is_group_generating: false,
        restoreActiveVariableInjection() {},
        stageVariableResultInjection() { throw new Error('This fixture uses the normal prompt destination'); },
        setExtensionPrompt(key, value, position, depth, scan, role) {
            const prompt = { value, position, depth, scan, role };
            prompts.set(key, prompt);
            promptHistory.push(prompt);
        },
        updateStatus(state, text) { statuses.push({ state, text }); },
        startDiagnosticRun() { return { trace: (event, data) => traces.push({ event, data }), startedAt: Date.now() }; },
        recordSearchLog(entry) { logs.push(entry); },
        getSearchBackendLabel() { return 'GPT 原生联网（TT）'; },
        isClientToolTransportSupported() { return true; },
        resolveResearchTransport() { return 'tool'; },
        buildClientWebSearchInvocations() { throw new Error('Native research must not fabricate client tool calls'); },
        buildTrustedRuntimeClockPrompt() { return '<trusted_runtime_clock>2026-11-12</trusted_runtime_clock>'; },
        saveSettingsDebounced() {}, debugLog() {},
        toastr: { info() {}, warning() {}, error() {}, success() {} },
    };
    vm.createContext(sandbox);
    const functions = [
        'normalizeWhitespace', 'getLatestUserMessage', 'hashString', 'pruneCache', 'makeResearchCacheKey',
        'getResultInjectionPlacement', 'setResearchPrompt', 'clearPrompt', 'invalidateRun', 'isRunCurrent',
        'runAbortableRequest', 'getOpenAIResearchProfiles', 'getOpenAICharacterContext',
        'runOpenAIProfileResearch', 'testOpenAIResearchProfile', 'hiddenWebResearchInterceptor',
    ];
    vm.runInContext(`
        let runEpoch = 0;
        let activeRunEpoch = null;
        let activeAbortController = null;
        let openaiResearchTestController = null;
        let plannerDirectTestAbortController = null;
        let generationStartSnapshot = null;
        let activeToolTransport = null;
        let activePromptInjection = false;
        const RESEARCH_BACKENDS = new Set(getEnabledResearchBackends());
        const HANDLED_GENERATION_TYPES = new Set(['normal', 'regenerate', 'swipe']);
        ${index.match(/const defaultSettings = \{[\s\S]*?\r?\n\};/u)[0]}
        ${functions.map(extract).join('\n')}
    `, sandbox);
    const defaults = vm.runInContext('structuredClone(defaultSettings)', sandbox);
    sandbox.settings = {
        ...defaults, enabled: true, openaiResearchProfileId: PROFILE.id, openaiWorkTitle: '测试作品', ...overrides,
    };
    sandbox.getSettings = () => sandbox.settings;
    const run = async (type = 'normal') => sandbox.hiddenWebResearchInterceptor(
        context.chat, 32000, value => aborts.push(value), type,
    );
    return {
        sandbox, defaults, context, requests, prompts, promptHistory, statuses, traces, logs, aborts, ui, run,
        currentPrompt: () => prompts.get(sandbox.PROMPT_KEY)?.value || '',
    };
}

test('native GPT research enters the current Gemini prompt with full detail and verified sources', async () => {
    const f = fixture();
    const before = structuredClone({ settings: f.context.chatCompletionSettings, selectedProfile: f.context.selectedProfile });
    await f.run();

    assert.equal(f.requests.length, 1);
    assert.equal(f.requests[0].profileId, PROFILE.id);
    assert.equal(f.requests[0].custom.extractData, false);
    assert.equal(f.requests[0].overridePayload.enable_web_search, true);
    assert.ok(f.currentPrompt().includes(LONG_REPORT), 'Research must not be cut to the old 1200-character snippet limit');
    assert.ok(f.currentPrompt().length > 2500);
    assert.match(f.currentPrompt(), /https:\/\/example\.org\/canon\/character/u);
    assert.doesNotMatch(f.currentPrompt(), /HWR_GAPS_JSON|function_call|hwr_web_search/u);
    assert.equal(f.aborts.length, 0);
    assert.deepEqual({ settings: f.context.chatCompletionSettings, selectedProfile: f.context.selectedProfile }, before);
    assert.equal(f.context.chat.length, 2, 'The researcher must not append an assistant message to the RP transcript');
    assert.match(f.statuses.at(-1).text, /资料已交给当前主模型/u);
    const nextMainRequest = {
        ...f.context.chatCompletionSettings,
        messages: [...f.context.chat, { role: 'user', content: f.currentPrompt() }],
    };
    assert.equal(nextMainRequest.chat_completion_source, 'makersuite');
    assert.equal(nextMainRequest.model, 'gemini-rp-fixture');
    assert.ok(nextMainRequest.messages.at(-1).content.includes(LONG_REPORT));
});

test('fresh settings choose RP research on every message instead of skipping roleplay', async () => {
    const f = fixture();
    assert.equal(f.defaults.researchBackend, 'openai_native');
    assert.equal(f.defaults.searchPolicy, 'always');
    assert.equal(f.defaults.enabled, false, 'Installing the extension alone must not spend API credits');
    await f.run();
    assert.equal(f.requests.length, 1, 'A normal roleplay request must actually reach the researcher');
    const input = JSON.parse(f.requests[0].messages[1].content);
    assert.equal(input.workTitle, '测试作品');
    assert.match(input.researchInstruction, /角色卡.*不是原作证据/u);
    assert.match(input.researchInstruction, /角色甲/u);
    assert.equal(input.latestUserRequest, f.context.chat.at(-1).mes);
});

test('explicit no-search intent makes zero GPT requests and clears the previous temporary packet', async () => {
    const f = fixture();
    await f.run();
    f.context.chat.push({ is_user: true, mes: '不要联网搜索，只根据我提供的内容继续角色扮演。' });
    await f.run();
    assert.equal(f.requests.length, 1);
    assert.equal(f.currentPrompt(), '');
    assert.equal(f.aborts.length, 0);
    assert.match(f.statuses.at(-1).text, /跳过/u);
});

test('research cache reuses regeneration but separates chat, recent context and configuration', async () => {
    const f = fixture();
    await f.run();
    await f.run('regenerate');
    assert.equal(f.requests.length, 1, 'Same-chat regenerate should reuse verified research');
    f.context.chatId = 'chat-b';
    await f.run('regenerate');
    assert.equal(f.requests.length, 2, 'Another chat must not receive the old cache entry');
    f.context.chat[0].mes = '这次对话发生在原作故事的另一个时期。';
    await f.run('regenerate');
    assert.equal(f.requests.length, 3, 'Changed prior context must trigger a fresh search');
    f.sandbox.settings.openaiSpoilerBoundary = '仅动画第一季';
    await f.run('regenerate');
    assert.equal(f.requests.length, 4, 'Changed spoiler requirements must invalidate the research');
    f.context.characters[0].description = '使用另一个同名角色的原作身份。';
    await f.run('regenerate');
    assert.equal(f.requests.length, 5, 'Changed character identity must not reuse old research');
});

test('GPT failure pauses the main generation when verified research is required', async () => {
    const f = fixture({ reply: async () => { throw new Error('fixture API unavailable'); } });
    await f.run();
    assert.equal(f.requests.length, 1);
    assert.deepEqual(f.aborts, [true]);
    assert.equal(f.currentPrompt(), '');
    assert.equal(f.context.chatCompletionSettings.model, 'gemini-rp-fixture');
    assert.match(f.statuses.at(-1).text, /查资料失败.*暂停/u);
});

test('a model-only answer without native search is never passed to Gemini as verified research', async () => {
    const f = fixture({ reply: async () => ({ choices: [{ finish_reason: 'stop', message: { content: 'I remember the answer.' } }] }) });
    await f.run();
    assert.deepEqual(f.aborts, [true]);
    assert.equal(f.currentPrompt(), '');
    assert.equal(f.sandbox.researchCache.size, 0);
});

test('stopping generation aborts pending research and discards a late API result', async () => {
    const pending = deferred();
    const started = deferred();
    const f = fixture({ reply: async request => { started.resolve(request); return pending.promise; } });
    const running = f.run();
    const request = await started.promise;
    f.sandbox.invalidateRun('Generation stopped');
    assert.equal(request.custom.signal.aborted, true);
    pending.resolve(nativeResponse());
    await running;
    assert.equal(f.currentPrompt(), '');
    assert.equal(f.sandbox.researchCache.size, 0);
    assert.equal(f.logs.length, 0);
    assert.equal(f.ui.get('#hwr_openai_native_preview'), undefined);
    assert.equal(f.requests.length, 1);
});

test('switching chat while GPT is searching cannot inject the old research into the new chat', async () => {
    const pending = deferred();
    const started = deferred();
    const f = fixture({ reply: async () => { started.resolve(); return pending.promise; } });
    const running = f.run();
    await started.promise;
    f.context.chatId = 'another-chat';
    f.context.chat = [{ is_user: true, mes: '另一个作品的全新对话。' }];
    pending.resolve(nativeResponse());
    await running;
    assert.equal(f.currentPrompt(), '');
    assert.equal(f.sandbox.researchCache.size, 0);
    assert.equal(f.logs.length, 0);
    assert.equal(f.requests.length, 1);
});

test('the GPT connection test only previews research and never starts Gemini or adds an RP message', async () => {
    const f = fixture();
    const initialChat = structuredClone(f.context.chat);
    await f.sandbox.testOpenAIResearchProfile();
    assert.equal(f.requests.length, 1);
    assert.equal(f.requests[0].profileId, PROFILE.id);
    assert.deepEqual(f.context.chat, initialChat);
    assert.equal(f.currentPrompt(), '');
    assert.ok(f.ui.get('#hwr_openai_native_preview').includes(LONG_REPORT));
    assert.match(f.statuses.at(-1).text, /尚未发送给 Gemini/u);
    assert.equal(f.context.selectedProfile, 'gemini-main');
});
