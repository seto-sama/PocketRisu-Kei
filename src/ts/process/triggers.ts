import { parseChatML } from "../parser/chatML";
import { risuChatParser } from "../parser/parser.svelte";
import { getCurrentCharacter, getCurrentChat, getDatabase, setCurrentCharacter, setDatabase, type Chat, type character } from "../storage/database.svelte";
import { tokenize } from "../tokenizer";
import { getModuleTriggers } from "./modules";
import { get } from "svelte/store";
import { ReloadChatPointer, ReloadGUIPointer, selectedCharID, CurrentTriggerIdStore } from "../stores.svelte";
import { processMultiCommand } from "./command";
import { parseKeyValue, sleep } from "../util";
import { alertError, alertInput, alertNormal, alertSelect } from "../alert";
import type { OpenAIChat } from "./index.svelte";
import { HypaProcesser } from "./memory/hypamemory";
import { requestChatData } from "./request/request";
import { collectStreamingText } from "./request/shared";
import { generateAIImage } from "./stableDiff";
import { writeInlayImage } from "./files/inlays";
import { runScripted } from "./scriptings";
import { createTriggerV2Core, type TriggerV2Effect } from "./triggerV2Core";
import { evaluateTriggerConditions, type TriggerConditionLike } from "./triggerConditionCore";


export interface triggerscript{
    comment: string;
    type: 'start'|'manual'|'output'|'input'|'display'|'request'
    conditions: triggerCondition[]
    effect:triggerEffect[]
    lowLevelAccess?: boolean
}

export type triggerCondition = triggerConditionsVar|triggerConditionsExists|triggerConditionsChatIndex

export type triggerEffect = triggerEffectV1|triggerCode|triggerEffectV2
export type triggerEffectV1 = triggerEffectCutChat|triggerEffectModifyChat|triggerEffectImgGen|triggerEffectRegex|triggerEffectRunLLM|triggerEffectCheckSimilarity|triggerEffectSendAIprompt|triggerEffectShowAlert|triggerEffectSetvar|triggerEffectSystemPrompt|triggerEffectImpersonate|triggerEffectCommand|triggerEffectStop|triggerEffectRunTrigger|triggerEffectRunAxLLM
export type triggerEffectV2 =   triggerV2Header|triggerV2IfVar|triggerV2Else|triggerV2EndIndent|triggerV2SetVar|triggerV2Loop|triggerV2BreakLoop|
                                triggerV2RunTrigger|triggerV2ConsoleLog|triggerV2StopTrigger|triggerV2CutChat|triggerV2ModifyChat|triggerV2SystemPrompt|triggerV2Impersonate|
                                triggerV2Command|triggerV2SendAIprompt|triggerV2ImgGen|triggerV2CheckSimilarity|triggerV2RunLLM|triggerV2ShowAlert|triggerV2ExtractRegex|
                                triggerV2GetLastMessage|triggerV2GetMessageAtIndex|triggerV2GetMessageCount|
                                triggerV2ModifyLorebook|triggerV2GetLorebook|triggerV2GetLorebookCount|triggerV2GetLorebookEntry|
                                triggerV2SetLorebookActivation|triggerV2GetLorebookIndexViaName|triggerV2LoopNTimes|triggerV2Random|triggerV2GetCharAt|
                                triggerV2GetCharCount|triggerV2ToLowerCase|triggerV2ToUpperCase|triggerV2SetCharAt|triggerV2SplitString|triggerV2JoinArrayVar|triggerV2GetCharacterDesc|
                                triggerV2SetCharacterDesc|triggerV2GetPersonaDesc|triggerV2SetPersonaDesc|triggerV2MakeArrayVar|triggerV2GetArrayVarLength|triggerV2GetArrayVar|triggerV2SetArrayVar|
                                triggerV2PushArrayVar|triggerV2PopArrayVar|triggerV2ShiftArrayVar|triggerV2UnshiftArrayVar|triggerV2SpliceArrayVar|triggerV2GetFirstMessage|
                                triggerV2SliceArrayVar|triggerV2GetIndexOfValueInArrayVar|triggerV2RemoveIndexFromArrayVar|triggerV2ConcatString|triggerV2GetLastUserMessage|
                                triggerV2GetLastCharMessage|triggerV2GetAlertInput|triggerV2GetAlertSelect|triggerV2GetDisplayState|triggerV2SetDisplayState|triggerV2UpdateGUI|triggerV2UpdateChatAt|triggerV2Wait|
                                triggerV2GetRequestState|triggerV2SetRequestState|triggerV2GetRequestStateRole|triggerV2SetRequestStateRole|triggerV2GetRequestStateLength|triggerV2IfAdvanced|
                                triggerV2QuickSearchChat|triggerV2StopPromptSending|triggerV2Tokenize|triggerV2GetAllLorebooks|triggerV2GetLorebookByName|triggerV2GetLorebookByIndex|
                                triggerV2CreateLorebook|triggerV2ModifyLorebookByIndex|triggerV2DeleteLorebookByIndex|triggerV2GetLorebookCountNew|triggerV2SetLorebookAlwaysActive|
                                triggerV2RegexTest|triggerV2GetReplaceGlobalNote|triggerV2SetReplaceGlobalNote|
                                triggerV2GetAuthorNote|triggerV2SetAuthorNote|triggerV2MakeDictVar|triggerV2GetDictVar|triggerV2SetDictVar|triggerV2DeleteDictKey|
                                triggerV2HasDictKey|triggerV2ClearDict|triggerV2GetDictSize|triggerV2GetDictKeys|triggerV2GetDictValues|triggerV2Calculate|triggerV2ReplaceString|triggerV2Comment|
                                triggerV2DeclareLocalVar

export type triggerConditionsVar = {
    type:'var'|'value'
    var:string
    value:string
    operator:'='|'!='|'>'|'<'|'>='|'<='|'null'|'true'
}

export type triggerCode = {
    type: 'triggercode'|'triggerlua',
    code: string
}

export type triggerConditionsChatIndex = {
    type:'chatindex'
    value:string
    operator:'='|'!='|'>'|'<'|'>='|'<='|'null'|'true'
}

export type triggerConditionsExists ={
    type: 'exists'
    value:string
    type2: 'strict'|'loose'|'regex',
    depth: number
}

export interface triggerEffectSetvar{
    type: 'setvar',
    operator: '='|'+='|'-='|'*='|'/='
    var:string
    value:string
}

export interface triggerEffectCutChat{
    type: 'cutchat',
    start: string,
    end: string
}

export interface triggerEffectModifyChat{
    type: 'modifychat',
    index: string,
    value: string
}

export interface triggerEffectSystemPrompt{
    type: 'systemprompt',
    location: 'start'|'historyend'|'promptend',
    value:string
}

export interface triggerEffectImpersonate{
    type: 'impersonate'
    role: 'user'|'char',
    value:string
}

type triggerMode = 'start'|'manual'|'output'|'input'|'display'|'request'

export interface triggerEffectCommand{
    type: 'command',
    value: string
}

export interface triggerEffectRegex{
    type: 'extractRegex',
    value: string
    regex: string
    flags: string
    result: string
    inputVar: string
}

export interface triggerEffectShowAlert{
    type: 'showAlert',
    alertType: string
    value: string
    inputVar: string
}

export interface triggerEffectRunTrigger{
    type: 'runtrigger',
    value: string
}

export interface triggerEffectStop{
    type: 'stop'
}

export interface triggerEffectSendAIprompt{
    type: 'sendAIprompt'
}

export interface triggerEffectImgGen{
    type: 'runImgGen',
    value: string,
    negValue: string,
    inputVar: string
}


export interface triggerEffectCheckSimilarity{
    type: 'checkSimilarity',
    source: string,
    value: string,
    inputVar: string
}

export interface triggerEffectRunLLM{
    type: 'runLLM',
    value: string,
    inputVar: string
}

export interface triggerEffectRunAxLLM{
    type: 'runAxLLM',
    value: string,
    inputVar: string
}

export type additonalSysPrompt = {
    start:string,
    historyend: string,
    promptend: string
}

export type triggerV2Header = {
    type: 'v2Header',
    code?: string,
    indent: number
}

export type triggerV2IfVar = {
    type: 'v2If',
    condition: '='|'!='|'>'|'<'|'>='|'<=',
    targetType: 'var'|'value',
    target: string,
    source: string,
    indent: number
}

export type triggerV2Else = {
    type: 'v2Else'
    indent: number
}

export type triggerV2EndIndent = {
    type: 'v2EndIndent',
    endOfLoop?: boolean,
    indent: number
}

export type triggerV2SetVar = {
    type: 'v2SetVar',
    operator: '='|'+='|'-='|'*='|'/='|'%=',
    var: string,
    valueType: 'var'|'value',
    value: string,
    indent: number
}

export type triggerV2Loop = {
    type: 'v2Loop',
    indent: number
}

export type triggerV2LoopNTimes = {
    type: 'v2LoopNTimes',
    value: string,
    valueType: 'var'|'value',
    indent: number
}

export type triggerV2BreakLoop = {
    type: 'v2BreakLoop',
    indent: number
}

export type triggerV2RunTrigger = {
    type: 'v2RunTrigger',
    target: string,
    indent: number
}

export type triggerV2ConsoleLog = {
    type: 'v2ConsoleLog',
    sourceType: 'var'|'value',
    source: string,
    indent: number
}

export type triggerV2StopTrigger = {
    type: 'v2StopTrigger',
    indent: number
}

export type triggerV2CutChat = {
    type: 'v2CutChat',
    start: string,
    startType: 'var'|'value',
    end: string,
    endType: 'var'|'value',
    indent: number
}

export type triggerV2ModifyChat = {
    type: 'v2ModifyChat',
    index: string,
    indexType: 'var'|'value',
    value: string,
    valueType: 'var'|'value',
    indent: number
}

export type triggerV2SystemPrompt = {
    type: 'v2SystemPrompt',
    location: 'start'|'historyend'|'promptend',
    value: string,
    valueType: 'var'|'value',
    indent: number
}

export type triggerV2Impersonate = {
    type: 'v2Impersonate',
    role: 'user'|'char',
    value: string,
    valueType: 'var'|'value',
    indent: number
}

export type triggerV2Command = {
    type: 'v2Command',
    value: string,
    valueType: 'var'|'value',
    indent: number
}

export type triggerV2SendAIprompt = {
    type: 'v2SendAIprompt',
    indent: number
}

export type triggerV2ImgGen = {
    type: 'v2ImgGen',
    value: string,
    valueType: 'var'|'value',
    negValue: string,
    negValueType: 'var'|'value',
    outputVar: string,
    indent: number
}

export type triggerV2CheckSimilarity = {
    type: 'v2CheckSimilarity',
    source: string,
    sourceType: 'var'|'value',
    value: string,
    valueType: 'var'|'value',
    outputVar: string,
    indent: number
}

export type triggerV2RunLLM = {
    type: 'v2RunLLM',
    value: string,
    valueType: 'var'|'value',
    model: 'model'|'submodel',
    streaming?: boolean,
    outputVar: string,
    indent: number
}

export type triggerV2ShowAlert = {
    type: 'v2ShowAlert',
    value: string,
    valueType: 'var'|'value',
    indent: number
}

export type triggerV2ExtractRegex = {
    type: 'v2ExtractRegex',
    value: string,
    valueType: 'var'|'value',
    regex: string,
    regexType: 'var'|'value',
    flags: string,
    flagsType: 'var'|'value',
    result: string,
    resultType: 'var'|'value',
    outputVar: string,
    indent: number
}

export type triggerV2GetLastMessage = {
    type: 'v2GetLastMessage',
    outputVar: string,
    indent: number
}

export type triggerV2GetMessageAtIndex = {
    type: 'v2GetMessageAtIndex',
    index: string,
    indexType: 'var'|'value',
    outputVar: string,
    indent: number
}

export type triggerV2GetMessageCount = {
    type: 'v2GetMessageCount',
    outputVar: string,
    indent: number
}

export type triggerV2ModifyLorebook = {
    type: 'v2ModifyLorebook',
    target: string,
    targetType: 'var'|'value',
    value: string,
    valueType: 'var'|'value',
    indent: number
}

export type triggerV2GetLorebook = {
    type: 'v2GetLorebook',
    target: string,
    targetType: 'var'|'value',
    outputVar: string,
    indent: number
}

export type triggerV2GetLorebookCount = {
    type: 'v2GetLorebookCount',
    outputVar: string,
    indent: number
}

export type triggerV2GetLorebookEntry = {
    type: 'v2GetLorebookEntry',
    index: string,
    indexType: 'var'|'value',
    outputVar: string,
    indent: number
}

export type triggerV2SetLorebookActivation = {
    type: 'v2SetLorebookActivation',
    index: string,
    indexType: 'var'|'value',
    value: boolean,
    indent: number
}

export type triggerV2GetLorebookIndexViaName = {
    type: 'v2GetLorebookIndexViaName',
    name: string,
    nameType: 'var'|'value',
    outputVar: string,
    indent: number
}

export type triggerV2Random = {
    type: 'v2Random',
    min: string,
    minType: 'var'|'value',
    max: string,
    maxType: 'var'|'value',
    outputVar: string,
    indent: number
}

export type triggerV2GetCharAt = {
    type: 'v2GetCharAt',
    source: string,
    sourceType: 'var'|'value',
    index: string,
    indexType: 'var'|'value',
    outputVar: string,
    indent: number
}

export type triggerV2GetCharCount = {
    type: 'v2GetCharCount',
    source: string,
    sourceType: 'var'|'value',
    outputVar: string,
    indent: number
}

export type triggerV2ToLowerCase = {
    type: 'v2ToLowerCase',
    source: string,
    sourceType: 'var'|'value',
    outputVar: string,
    indent: number
}

export type triggerV2ToUpperCase = {
    type: 'v2ToUpperCase',
    source: string,
    sourceType: 'var'|'value',
    outputVar: string,
    indent: number
}

export type triggerV2SetCharAt = {
    type: 'v2SetCharAt',
    source: string,
    sourceType: 'var'|'value',
    index: string,
    indexType: 'var'|'value',
    value: string,
    valueType: 'var'|'value',
    outputVar: string,
    indent: number
}

export type triggerV2SplitString = {
    type: 'v2SplitString',
    source: string,
    sourceType: 'var'|'value',
    delimiter: string,
    delimiterType: 'var'|'value'|'regex',
    outputVar: string,
    indent: number
}

export type triggerV2JoinArrayVar = {
    type: 'v2JoinArrayVar',
    var: string,
    varType: 'var'|'value',
    delimiter: string,
    delimiterType: 'var'|'value',
    outputVar: string,
    indent: number
}

export type triggerV2GetCharacterDesc = {
    type: 'v2GetCharacterDesc',
    outputVar: string,
    indent: number
}

export type triggerV2SetCharacterDesc = {
    type: 'v2SetCharacterDesc',
    value: string,
    valueType: 'var'|'value',
    indent: number
}

export type triggerV2GetPersonaDesc = {
    type: 'v2GetPersonaDesc',
    outputVar: string,
    indent: number
}

export type triggerV2SetPersonaDesc = {
    type: 'v2SetPersonaDesc',
    value: string,
    valueType: 'var'|'value',
    indent: number
}

export type triggerV2MakeArrayVar = {
    type: 'v2MakeArrayVar',
    var: string,
    indent: number
}

export type triggerV2GetArrayVarLength = {
    type: 'v2GetArrayVarLength',
    var: string,
    outputVar: string,
    indent: number
}

export type triggerV2GetArrayVar = {
    type: 'v2GetArrayVar',
    var: string,
    index: string,
    indexType: 'var'|'value',
    outputVar: string,
    indent: number
}

export type triggerV2SetArrayVar = {
    type: 'v2SetArrayVar',
    var: string,
    index: string,
    indexType: 'var'|'value',
    value: string,
    valueType: 'var'|'value',
    indent: number
}

export type triggerV2PushArrayVar = {
    type: 'v2PushArrayVar',
    var: string,
    value: string,
    valueType: 'var'|'value',
    indent: number
}

export type triggerV2PopArrayVar = {
    type: 'v2PopArrayVar',
    var: string,
    outputVar: string,
    indent: number
}

export type triggerV2ShiftArrayVar = {
    type: 'v2ShiftArrayVar',
    var: string,
    outputVar: string,
    indent: number
}

export type triggerV2UnshiftArrayVar = {
    type: 'v2UnshiftArrayVar',
    var: string,
    value: string,
    valueType: 'var'|'value',
    indent: number
}

export type triggerV2SpliceArrayVar = {
    type: 'v2SpliceArrayVar',
    var: string,
    start: string,
    startType: 'var'|'value',
    item: string,
    itemType: 'var'|'value',
    indent: number
}

export type triggerV2SliceArrayVar = {
    type: 'v2SliceArrayVar',
    var: string,
    start: string,
    startType: 'var'|'value',
    end: string,
    endType: 'var'|'value',
    outputVar: string,
    indent: number
}

export type triggerV2GetIndexOfValueInArrayVar = {
    type: 'v2GetIndexOfValueInArrayVar',
    var: string,
    value: string,
    valueType: 'var'|'value',
    outputVar: string,
    indent: number
}

export type triggerV2RemoveIndexFromArrayVar = {
    type: 'v2RemoveIndexFromArrayVar',
    var: string,
    index: string,
    indexType: 'var'|'value',
    indent: number
}

export type triggerV2ConcatString = {
    type: 'v2ConcatString',
    source1: string,
    source1Type: 'var'|'value',
    source2: string,
    source2Type: 'var'|'value',
    outputVar: string,
    indent: number
}

export type triggerV2GetLastUserMessage = {
    type: 'v2GetLastUserMessage',
    outputVar: string,
    indent: number
}

export type triggerV2GetLastCharMessage = {
    type: 'v2GetLastCharMessage',
    outputVar: string,
    indent: number
}

export type triggerV2GetFirstMessage = {
    type: 'v2GetFirstMessage',
    outputVar: string,
    indent: number
}

export type triggerV2GetAlertInput = {
    type: 'v2GetAlertInput',
    display: string,
    displayType: 'var'|'value',
    outputVar: string,
    indent: number
}

export type triggerV2GetDisplayState = {
    type: 'v2GetDisplayState',
    outputVar: string,
    indent: number
}

export type triggerV2SetDisplayState = {
    type: 'v2SetDisplayState',
    value: string,
    valueType: 'var'|'value',
    indent: number
}

export type triggerV2GetRequestState = {
    type: 'v2GetRequestState',
    outputVar: string,
    index: string,
    indexType: 'var'|'value',
    indent: number
}

export type triggerV2GetRequestStateRole = {
    type: 'v2GetRequestStateRole',
    outputVar: string,
    index: string,
    indexType: 'var'|'value',
    indent: number
}

export type triggerV2SetRequestState = {
    type: 'v2SetRequestState',
    value: string,
    valueType: 'var'|'value',
    index: string,
    indexType: 'var'|'value',
    indent: number
}

export type triggerV2SetRequestStateRole = {
    type: 'v2SetRequestStateRole',
    value: string,
    valueType: 'var'|'value',
    index: string,
    indexType: 'var'|'value',
    indent: number
}

export type triggerV2GetRequestStateLength = {
    type: 'v2GetRequestStateLength',
    outputVar: string,
    indent: number
}

export type triggerV2UpdateGUI = {
    type: 'v2UpdateGUI',
    indent: number
}

export type triggerV2UpdateChatAt = {
    type: 'v2UpdateChatAt',
    index: string,
    indent: number
}

export type triggerV2Wait = {
    type: 'v2Wait',
    value: string,
    valueType: 'var'|'value',
    indent: number
}

export type triggerV2IfAdvanced = {
    type: 'v2IfAdvanced',
    condition: '='|'!='|'>'|'<'|'>='|'<='|'≒'|'∋'|'∈'|'∌'|'∉'|'≡'
    targetType: 'var'|'value',
    target: string,
    sourceType: 'var'|'value',
    source: string,
    indent: number
}

export type triggerV2QuickSearchChat = {
    type: 'v2QuickSearchChat',
    value: string,
    valueType: 'var'|'value',
    condition: 'loose'|'strict'|'regex',
    depth: string,
    depthType: 'var'|'value',
    outputVar: string,
    indent: number
}

export type triggerV2StopPromptSending = {
    type: 'v2StopPromptSending',
    indent: number
}

export type triggerV2Tokenize = {
    type: 'v2Tokenize',
    indent: number,
    value: string
    valueType: "var"|"value"
    outputVar:string
}

export type triggerV2GetAllLorebooks = {
    type: 'v2GetAllLorebooks',
    outputVar: string,
    indent: number
}
export type triggerV2RegexTest = {
    type: 'v2RegexTest',
    value: string,
    valueType: 'var'|'value',
    regex: string,
    regexType: 'var'|'value',
    flags: string,
    flagsType: 'var'|'value',
    outputVar: string,
    indent: number
}

export type triggerV2GetLorebookByName = {
    type: 'v2GetLorebookByName',
    name: string,
    nameType: 'var'|'value',
    outputVar: string,
    indent: number
}

export type triggerV2GetLorebookByIndex = {
    type: 'v2GetLorebookByIndex',
    index: string,
    indexType: 'var'|'value',
    outputVar: string,
    indent: number
}

export type triggerV2CreateLorebook = {
    type: 'v2CreateLorebook',
    name: string,
    nameType: 'var'|'value',
    key: string,
    keyType: 'var'|'value',
    content: string,
    contentType: 'var'|'value',
    insertOrder: string,
    insertOrderType: 'var'|'value',
    indent: number
}

export type triggerV2ModifyLorebookByIndex = {
    type: 'v2ModifyLorebookByIndex',
    index: string,
    indexType: 'var'|'value',
    name: string,
    nameType: 'var'|'value',
    key: string,
    keyType: 'var'|'value',
    content: string,
    contentType: 'var'|'value',
    insertOrder: string,
    insertOrderType: 'var'|'value',
    indent: number
}

export type triggerV2DeleteLorebookByIndex = {
    type: 'v2DeleteLorebookByIndex',
    index: string,
    indexType: 'var'|'value',
    indent: number
}

export type triggerV2GetLorebookCountNew = {
    type: 'v2GetLorebookCountNew',
    outputVar: string,
    indent: number
}

export type triggerV2SetLorebookAlwaysActive = {
    type: 'v2SetLorebookAlwaysActive',
    index: string,
    indexType: 'var'|'value',
    value: boolean,
    indent: number
}

export type triggerV2GetAlertSelect = {
    type: 'v2GetAlertSelect',
    display: string,
    displayType: 'var'|'value',
    value: string,
    valueType: 'var'|'value',
    outputVar: string,
    indent: number
}

export type triggerV2GetReplaceGlobalNote = {
    type: 'v2GetReplaceGlobalNote',
    outputVar: string,
    indent: number
}

export type triggerV2SetReplaceGlobalNote = {
    type: 'v2SetReplaceGlobalNote',
    value: string,
    valueType: 'var'|'value',
    indent: number
}

export type triggerV2GetAuthorNote = {
    type: 'v2GetAuthorNote',
    outputVar: string,
    indent: number
}

export type triggerV2SetAuthorNote = {
    type: 'v2SetAuthorNote',
    value: string,
    valueType: 'var'|'value',
    indent: number
}

export type triggerV2MakeDictVar = {
    type: 'v2MakeDictVar',
    var: string,
    indent: number
}

export type triggerV2GetDictVar = {
    type: 'v2GetDictVar',
    var: string,
    varType: 'var'|'value',
    key: string,
    keyType: 'var'|'value',
    outputVar: string,
    indent: number
}

export type triggerV2SetDictVar = {
    type: 'v2SetDictVar',
    var: string,
    varType: 'var'|'value',
    key: string,
    keyType: 'var'|'value',
    value: string,
    valueType: 'var'|'value',
    indent: number
}

export type triggerV2DeleteDictKey = {
    type: 'v2DeleteDictKey',
    var: string,
    varType: 'var'|'value',
    key: string,
    keyType: 'var'|'value',
    indent: number
}

export type triggerV2HasDictKey = {
    type: 'v2HasDictKey',
    var: string,
    varType: 'var'|'value',
    key: string,
    keyType: 'var'|'value',
    outputVar: string,
    indent: number
}

export type triggerV2ClearDict = {
    type: 'v2ClearDict',
    var: string,
    indent: number
}

export type triggerV2GetDictSize = {
    type: 'v2GetDictSize',
    var: string,
    varType: 'var'|'value',
    outputVar: string,
    indent: number
}

export type triggerV2GetDictKeys = {
    type: 'v2GetDictKeys',
    var: string,
    varType: 'var'|'value',
    outputVar: string,
    indent: number
}

export type triggerV2GetDictValues = {
    type: 'v2GetDictValues',
    var: string,
    varType: 'var'|'value',
    outputVar: string,
    indent: number
}

export type triggerV2Calculate = {
    type: 'v2Calculate',
    expression: string,
    expressionType: 'var'|'value',
    outputVar: string,
    indent: number
}

export type triggerV2ReplaceString = {
    type: 'v2ReplaceString',
    source: string,
    sourceType: 'var'|'value',
    regex: string,
    regexType: 'var'|'value',
    result: string,
    resultType: 'var'|'value',
    replacement: string,
    replacementType: 'var'|'value',
    flags: string,
    flagsType: 'var'|'value',
    outputVar: string,
    indent: number
}

export type triggerV2Comment = {
    type: 'v2Comment',
    value: string,
    indent: number
}

export type triggerV2DeclareLocalVar = {
    type: 'v2DeclareLocalVar',
    var: string,
    value: string,
    valueType: 'var'|'value',
    indent: number
}

const safeSubset = [
    'v2SetVar',
    'v2If',
    'v2IfAdvanced',
    'v2Else',
    'v2EndIndent',
    'v2LoopNTimes',
    'v2BreakLoop',
    'v2ConsoleLog',
    'v2StopTrigger',
    'v2Random',
    'v2ExtractRegex',
    'v2RegexTest',
    'v2GetCharAt',
    'v2GetCharCount',
    'v2ToLowerCase',
    'v2ToUpperCase',
    'v2SetCharAt',
    'v2SplitString',
    'v2JoinArrayVar',
    'v2ConcatString',
    'v2MakeArrayVar',
    'v2GetArrayVarLength',
    'v2GetArrayVar',
    'v2SetArrayVar',
    'v2PushArrayVar',
    'v2PopArrayVar',
    'v2ShiftArrayVar',
    'v2UnshiftArrayVar',
    'v2SpliceArrayVar',
    'v2SliceArrayVar',
    'v2GetIndexOfValueInArrayVar',
    'v2RemoveIndexFromArrayVar',
    'v2Calculate',
    'v2Comment',
    'v2DeclareLocalVar'
]

export const displayAllowList = [
    'v2GetDisplayState',
    'v2SetDisplayState',
    ...safeSubset
]

export const requestAllowList = [
    'v2GetRequestState',
    'v2SetRequestState',
    'v2GetRequestStateRole',
    'v2SetRequestStateRole',
    'v2GetRequestStateLength',
    ...safeSubset
]

export async function runTrigger(char:character,mode:triggerMode, arg:{
    chat: Chat,
    recursiveCount?: number
    additonalSysPrompt?: additonalSysPrompt
    stopSending?: boolean
    manualName?: string
    triggerId?: string
    displayMode?: boolean
    displayData?: string
    tempVars?: Record<string, string>
}){
    arg.recursiveCount ??= 0
    char = arg.displayMode ? char : safeStructuredClone(char)
    let varChanged = false
    let stopSending = arg.stopSending ?? false
    const CharacterlowLevelAccess = char.lowLevelAccess ?? false
    let sendAIprompt = false
    const currentChat = getCurrentChat()
    let additonalSysPrompt:additonalSysPrompt = arg.additonalSysPrompt ?? {
        start:'',
        historyend: '',
        promptend: ''
    }
    const triggers = char.triggerscript.map((v) => {
        v.lowLevelAccess = CharacterlowLevelAccess
        return v
    }).concat(getModuleTriggers())
    const db = getDatabase()
    const defaultVariables = parseKeyValue(char.defaultVariables).concat(parseKeyValue(db.templateDefaultVariables))
    let chat = arg.displayMode ? arg.chat : safeStructuredClone(arg.chat ?? char.chats[char.chatPage])
    
    const previousTriggerId = get(CurrentTriggerIdStore)
    const shouldSetTriggerId = !arg.displayMode && mode !== 'display'
    if (shouldSetTriggerId) {
        CurrentTriggerIdStore.set(arg.triggerId || null)
    }
    
    if((!triggers) || (triggers.length === 0)){
        if (shouldSetTriggerId) {
            CurrentTriggerIdStore.set(previousTriggerId)
        }
        return null
    }

    let tempVars:Record<string, string> = arg.tempVars ?? {}
    
    let localVarScopes: Record<number, Record<string, string>>[] = [{}]
    let currentIndent = 0
    

    function getLocalVar(key: string): string | null {
        if (!localVarScopes || localVarScopes.length === 0) {
            return null
        }
        const currentScope = localVarScopes[localVarScopes.length - 1]
        if (!currentScope) {
            return null
        }
        for (let indent = currentIndent; indent >= 0; indent--) {
            if (currentScope[indent] && currentScope[indent][key] !== undefined) {
                const value = currentScope[indent][key]
                return value
            }
        }
        return null
    }
    
    function setLocalVar(key: string, value: string, indent: number) {
        if (!localVarScopes || localVarScopes.length === 0) {
            localVarScopes = [{}]
        }
        const currentScope = localVarScopes[localVarScopes.length - 1]
        if (!currentScope) {
            return
        }
        
        const finalValue = (value === null || value === undefined) ? 'null' : value
        
        let foundIndent = -1
        for (let i = indent; i >= 0; i--) {
            if (currentScope[i] && currentScope[i][key] !== undefined) {
                foundIndent = i
                break
            }
        }
        
        const targetIndent = foundIndent !== -1 ? foundIndent : indent
        
        if (!currentScope[targetIndent]) {
            currentScope[targetIndent] = {}
        }
        
        currentScope[targetIndent][key] = finalValue
    }
    
    function declareLocalVar(key: string, value: string, indent: number) {
        const currentScope = localVarScopes.at(-1) ?? (localVarScopes[0] = {})
        currentScope[indent] ??= {}
        currentScope[indent][key] = value ?? 'null'
    }
    
    function clearLocalVarsAtIndent(indent: number) {
        if (!localVarScopes || localVarScopes.length === 0) {
            return
        }
        const currentScope = localVarScopes[localVarScopes.length - 1]
        if (!currentScope) {
            return
        }
        const indentsToDelete: string[] = []
        for (const scopeIndent in currentScope) {
            if (Number(scopeIndent) >= indent) {
                indentsToDelete.push(scopeIndent)
            }
        }
        indentsToDelete.forEach(indentKey => {
            delete currentScope[indentKey]
        })
    }

    function getVar(key:string){
        const localVar = getLocalVar(key)
        if(localVar !== null){
            return localVar
        }
        
        const state = chat.scriptstate?.['$' + key]
        if(state === undefined || state === null){
            const findResult = defaultVariables.find((f) => {
                return f[0] === key
            })
            if(findResult){
                return findResult[1]
            }
            if(arg.displayMode){
                return tempVars[key] ?? 'null'
            }
            return 'null'
        }
        return state.toString()
    }

    function setVar(key:string, value:string){
        if(arg.displayMode){
            tempVars[key] = value
            return
        }
        
        const localVar = getLocalVar(key)
        if(localVar !== null){
            setLocalVar(key, value, currentIndent)
            return
        }
        
        const selectedCharId = get(selectedCharID)
        const currentCharacter = getCurrentCharacter()
        const db = getDatabase()
        varChanged = true
        chat.scriptstate ??= {}
        chat.scriptstate['$' + key] = value
        currentChat.scriptstate = chat.scriptstate
        currentCharacter.chats[currentCharacter.chatPage].scriptstate = chat.scriptstate
        db.characters[selectedCharId].chats[currentCharacter.chatPage].scriptstate = chat.scriptstate
    }
    
    
    for(const trigger of triggers){
        if(trigger.effect[0]?.type === 'triggercode' || trigger.effect[0]?.type === 'triggerlua'){
            //
        }
        else if(arg.manualName){
            if(trigger.comment !== arg.manualName){
                continue
            }
        }
        else if(mode !== trigger.type){
            continue
        }

        const pass = evaluateTriggerConditions({
            conditions: trigger.conditions as unknown as TriggerConditionLike[],
            getVar,
            render: value => risuChatParser(String(value ?? ''), { chara: char }),
            messages: chat.message,
        })
        if(!pass){
            continue
        }

        const coreChat = {
            get id() { return chat.id },
            get fmIndex() { return chat.fmIndex },
            get note() { return chat.note },
            set note(value: string | undefined) { chat.note = value },
            get message() { return chat.message },
            set message(value) { chat.message = value as Chat['message'] },
        }
        const databaseDraft = safeStructuredClone(db)
        const v2Core = createTriggerV2Core({
            effects: trigger.effect as unknown as TriggerV2Effect[],
            render: value => risuChatParser(String(value ?? ''), { chara: char }),
            getVar,
            setVar,
            declareLocal: declareLocalVar,
            clearLocals: clearLocalVarsAtIndent,
            chat: coreChat,
            character: char,
            database: databaseDraft,
            globalVar: key => databaseDraft.globalChatVariables?.[key] ?? 'null',
        })
        let loopIterations = 0

        for(let index = 0; index < trigger.effect.length; index++){
            const effect = trigger.effect[index]
            if(mode === 'display' && !displayAllowList.includes(effect.type)){
                continue
            }
            if(mode === 'request' && !requestAllowList.includes(effect.type)){
                continue
            }
            
            if(effect && 'indent' in effect && typeof effect.indent === 'number' && effect.indent >= 0){
                currentIndent = effect.indent
            } else if(!effect || !('indent' in effect)) {
                currentIndent = 0
            }

            const coreStep = v2Core.step(index)
            if(coreStep.handled){
                index = coreStep.nextIndex
                if(coreStep.mutations && !arg.displayMode){
                    const selectedCharacter = get(selectedCharID)
                    if(coreStep.mutations.character && db.characters[selectedCharacter]){
                        Object.assign(db.characters[selectedCharacter], safeStructuredClone(coreStep.mutations.character))
                        setCurrentCharacter(char)
                    }
                    if(coreStep.mutations.database){
                        Object.assign(db, safeStructuredClone(coreStep.mutations.database))
                    }
                }
                if(coreStep.looped && ++loopIterations > 100){
                    await sleep(1)
                    loopIterations = 0
                }
                if(coreStep.stop){
                    break
                }
                continue
            }
            
            // Browser effect adapter: the shared core has already consumed every
            // environment-independent v2 effect before this dispatch.
            switch(effect.type){
                case'setvar': {
                    const effectValue = risuChatParser(effect.value,{chara:char})
                    const varKey  = risuChatParser(effect.var,{chara:char})
                    let originalVar = Number(getVar(varKey))
                    if(Number.isNaN(originalVar)){
                        originalVar = 0
                    }
                    let resultValue = ''
                    switch(effect.operator){
                        case '=':{
                            resultValue = effectValue
                            break
                        }
                        case '+=':{
                            resultValue = (originalVar + Number(effectValue)).toString()
                            break
                        }
                        case '-=':{
                            resultValue = (originalVar - Number(effectValue)).toString()
                            break
                        }
                        case '*=':{
                            resultValue = (originalVar * Number(effectValue)).toString()
                            break
                        }
                        case '/=':{
                            resultValue = (originalVar / Number(effectValue)).toString()
                            break
                        }
                    }
                    setVar(varKey, resultValue)
                    break
                }
                case 'systemprompt':{
                    const effectValue = risuChatParser(effect.value,{chara:char})
                    additonalSysPrompt[effect.location] += effectValue + "\n\n"
                    break
                }
                case 'impersonate':{
                    const effectValue = risuChatParser(effect.value,{chara:char})
                    if(effect.role === 'user'){
                        chat.message.push({role: 'user', data: effectValue})
                    }
                    else if(effect.role === 'char'){
                        chat.message.push({role: 'char', data: effectValue})
                    }
                    break
                }
                case 'command':{
                    const effectValue = risuChatParser(effect.value,{chara:char})
                    await processMultiCommand(effectValue)
                    break
                }
                case 'stop':
                case 'v2StopPromptSending':{
                    stopSending = true
                    break
                }
                case 'runtrigger':{
                    if(arg.recursiveCount < 10 || trigger.lowLevelAccess){
                        arg.recursiveCount++
                        const r = await runTrigger(char,'manual',{
                            chat,
                            recursiveCount: arg.recursiveCount,
                            additonalSysPrompt,
                            stopSending,
                            manualName: effect.value
                        })
                        if(r){
                            additonalSysPrompt = r.additonalSysPrompt
                            chat = r.chat
                            stopSending = r.stopSending
                        }
                    }
                    break
                }
                case 'cutchat':{
                    const start = Number(risuChatParser(effect.start,{chara:char}))
                    const end = Number(risuChatParser(effect.end,{chara:char}))
                    chat.message = chat.message.slice(start,end)
                    break
                }
                case 'modifychat':{
                    const index = Number(risuChatParser(effect.index,{chara:char}))
                    const value = risuChatParser(effect.value,{chara:char})
                    if(chat.message[index]){
                        chat.message[index].data = value
                    }
                    break
                }

                // low level access only
                case 'showAlert':{
                    if(!trigger.lowLevelAccess){
                        break
                    }

                    if(arg.displayMode){
                        return
                    }

                    const effectValue = risuChatParser(effect.value,{chara:char})
                    const inputVar = risuChatParser(effect.inputVar,{chara:char})

                    switch(effect.alertType){
                        case 'normal':{
                            alertNormal(effectValue)
                            break
                        }
                        case 'error':{
                            alertError(effectValue)
                            break
                        }
                        case 'input':{
                            const val = await alertInput(effectValue)
                            setVar(inputVar, val)
                            break;
                        }
                        case 'select':{
                            const val = await alertSelect(effectValue.split('§'))
                            setVar(inputVar, val)
                        }
                    }
                    break
                }

                case 'sendAIprompt':{
                    if(!trigger.lowLevelAccess){
                        break
                    }
                    sendAIprompt = true
                    break
                }

                case 'runLLM':{
                    if(!trigger.lowLevelAccess){
                        break
                    }
                    const effectValue = risuChatParser(effect.value,{chara:char})
                    const varName = effect.inputVar
                    let promptbody:OpenAIChat[] = parseChatML(effectValue)
                    if(!promptbody){
                        promptbody = [{role:'user', content:effectValue}]
                    }
                    const result = await requestChatData({
                        formated: promptbody,
                        bias: {},
                        currentChar: char,
                        useStreaming: false,
                        noMultiGen: true,
                    }, 'model')

                    if(result.type === 'fail' || result.type === 'streaming' || result.type === 'multiline'){
                        setVar(varName, 'Error: ' + result.result)
                    }
                    else{
                        setVar(varName, result.result)
                    }

                    break
                }

                case 'checkSimilarity':{
                    if(!trigger.lowLevelAccess){
                        break
                    }

                    const processer = new HypaProcesser()
                    const effectValue = risuChatParser(effect.value,{chara:char})
                    const source = risuChatParser(effect.source,{chara:char})
                    await processer.addText(effectValue.split('§'))
                    const val = await processer.similaritySearch(source)
                    setVar(effect.inputVar, val.join('§'))
                    break
                }

                case 'extractRegex':{
                    if(!trigger.lowLevelAccess){
                        break
                    }

                    const effectValue = risuChatParser(effect.value,{chara:char})
                    const regex = new RegExp(effect.regex, effect.flags)
                    const regexResult = regex.exec(effectValue)
                    const result = effect.result.replace(/\$[0-9]+/g, (match) => {
                        const index = Number(match.slice(1))
                        return regexResult[index]
                    }).replace(/\$&/g, regexResult[0]).replace(/\$\$/g, '$')

                    setVar(effect.inputVar, result)
                    break
                }

                case 'runImgGen':{
                    if(!trigger.lowLevelAccess){
                        break
                    }

                    const effectValue = risuChatParser(effect.value,{chara:char})
                    const negValue = risuChatParser(effect.negValue,{chara:char})
                    const gen = await generateAIImage(effectValue, char, negValue, 'inlay')
                    if(!gen){
                        setVar(effect.inputVar, 'Error: Image generation failed')
                        break
                    }
                    const imgHTML = new Image()
                    imgHTML.src = gen
                    const inlay = await writeInlayImage(imgHTML)
                    const res = `{{inlay::${inlay}}}`
                    setVar(effect.inputVar, res)
                    break
                }

                case 'triggerlua':{
                    const triggerCodeResult = await runScripted(effect.code,{
                        lowLevelAccess: trigger.lowLevelAccess,
                        mode: mode === 'manual' ? arg.manualName : mode,
                        setVar: setVar,
                        getVar: getVar,
                        char: char,
                        chat: chat,
                    })

                    if(triggerCodeResult.stopSending){
                        stopSending = true
                    }
                    chat = triggerCodeResult.chat
                    break
                }

                //V2 triggers
                case 'v2RunTrigger':{
                    if(arg.recursiveCount < 10 || trigger.lowLevelAccess){
                        arg.recursiveCount++
                        const r = await runTrigger(char,'manual',{
                            chat,
                            recursiveCount: arg.recursiveCount,
                            additonalSysPrompt,
                            stopSending,
                            manualName: effect.target
                        })
                        if(r){
                            additonalSysPrompt = r.additonalSysPrompt
                            chat = r.chat
                            stopSending = r.stopSending
                        }
                    }
                    break
                }
                case 'v2ConsoleLog':{
                    const sourceValue = effect.sourceType === 'value' ? risuChatParser(effect.source,{chara:char}) : getVar(risuChatParser(effect.source,{chara:char}))
                    console.log(sourceValue)
                    break
                }
                case 'v2SystemPrompt':{
                    let value = effect.valueType === 'value' ? risuChatParser(effect.value,{chara:char}) : getVar(risuChatParser(effect.value,{chara:char}))
                    additonalSysPrompt[effect.location] += value + "\n\n"
                    break
                }
                case 'v2Command':{
                    let value = effect.valueType === 'value' ? risuChatParser(effect.value,{chara:char}) : getVar(risuChatParser(effect.value,{chara:char}))
                    await processMultiCommand(value)
                    break
                }
                case 'v2SendAIprompt':{
                    if(!trigger.lowLevelAccess){
                        break
                    }
                    sendAIprompt = true
                    break
                }
                case 'v2ImgGen':{
                    if(!trigger.lowLevelAccess){
                        break
                    }
                    let value = effect.valueType === 'value' ? risuChatParser(effect.value,{chara:char}) : getVar(risuChatParser(effect.value,{chara:char}))
                    let negValue = effect.negValueType === 'value' ? risuChatParser(effect.negValue,{chara:char}) : getVar(risuChatParser(effect.negValue,{chara:char}))
                    let gen = await generateAIImage(value, char, negValue, 'inlay')
                    if(!gen){
                        setVar(risuChatParser(effect.outputVar, {chara:char}), 'null')
                        break
                    }
                    let imgHTML = new Image()
                    imgHTML.src = gen
                    let inlay = await writeInlayImage(imgHTML)
                    let res = `{{inlay::${inlay}}}`
                    setVar(risuChatParser(effect.outputVar, {chara:char}), res)
                    break

                }
                case 'v2CheckSimilarity':{
                    if(!trigger.lowLevelAccess){
                        break
                    }
                    let source = effect.sourceType === 'value' ? risuChatParser(effect.source,{chara:char}) : getVar(risuChatParser(effect.source,{chara:char}))
                    let value = effect.valueType === 'value' ? risuChatParser(effect.value,{chara:char}) : getVar(risuChatParser(effect.value,{chara:char}))
                    let processer = new HypaProcesser()
                    await processer.addText(value.split('§'))
                    let val = await processer.similaritySearch(source)
                    setVar(risuChatParser(effect.outputVar, {chara:char}), val.join('§'))
                    break
                }
                case 'v2RunLLM':{
                    if(!trigger.lowLevelAccess){
                        break
                    }
                    let value = effect.valueType === 'value' ? risuChatParser(effect.value,{chara:char}) : getVar(risuChatParser(effect.value,{chara:char}))
                    let promptbody = parseChatML(value)
                    if(!promptbody){
                        promptbody = [{role:'user', content:value}]
                    }
                    let result = await requestChatData({
                        formated: promptbody,
                        bias: {},
                        currentChar: char,
                        useStreaming: effect.streaming ?? false,
                        noMultiGen: true,
                    }, effect.model)

                    if(result.type === 'fail' || result.type === 'multiline'){
                        setVar(risuChatParser(effect.outputVar, {chara:char}), 'null')
                    }
                    else if(result.type === 'streaming'){
                        const text = await collectStreamingText(result.result)
                        setVar(risuChatParser(effect.outputVar, {chara:char}), text)
                    }
                    else{
                        setVar(risuChatParser(effect.outputVar, {chara:char}), result.result)
                    }
                    break
                }
                case 'v2ShowAlert':{
                    if(arg.displayMode){
                        return
                    }
                    let value = effect.valueType === 'value' ? risuChatParser(effect.value,{chara:char}) : getVar(risuChatParser(effect.value,{chara:char}))
                    alertNormal(value)
                    break
                }
                case 'v2GetAlertInput':{
                    if(arg.displayMode){
                        return
                    }
                    let value = await alertInput(
                        effect.displayType === 'value' ? risuChatParser(effect.display,{chara:char}) : getVar(risuChatParser(effect.display,{chara:char}))
                    )
                    setVar(risuChatParser(effect.outputVar, {chara:char}), value)
                    break
                }
                case 'v2GetAlertSelect':{
                    if(arg.displayMode){
                        return
                    }
                    const display = effect.displayType === 'value' ? risuChatParser(effect.display,{chara:char}) : getVar(risuChatParser(effect.display,{chara:char}))
                    const value = effect.valueType === 'value' ? risuChatParser(effect.value,{chara:char}) : getVar(risuChatParser(effect.value,{chara:char}))
                    const options = value.split('|')
                    let result = await alertSelect(options, display)
                    setVar(risuChatParser(effect.outputVar, {chara:char}), result)
                    break
                }
                case 'v2GetDisplayState':{
                    if(!arg.displayMode){
                        return
                    }
                    
                    setVar(risuChatParser(effect.outputVar, {chara:char}), arg.displayData ?? 'null')
                    break
                }
                case 'v2SetDisplayState':{
                    if(!arg.displayMode){
                        return
                    }
                    arg.displayData = effect.valueType === 'value' ? risuChatParser(effect.value,{chara:char}) : getVar(risuChatParser(effect.value,{chara:char}))
                    break
                }
                case 'v2UpdateGUI':{
                    ReloadGUIPointer.set(get(ReloadGUIPointer) + 1)
                    break
                }
                case 'v2UpdateChatAt':{
                    ReloadChatPointer.update((v) => {
                        v[effect.index] = (v[effect.index] ?? 0) + 1
                        return v
                    })
                    break
                }
                case 'v2Wait':{
                    let value = effect.valueType === 'value' ? Number(risuChatParser(effect.value,{chara:char})) : Number(getVar(risuChatParser(effect.value,{chara:char})))
                    await sleep(value * 1000)
                    break
                }
                case 'v2GetRequestState':{
                    if(!arg.displayMode){
                        return
                    }
                    const json = JSON.parse(arg.displayData) as OpenAIChat[]
                    const index = effect.indexType === 'value' ? Number(risuChatParser(effect.index,{chara:char})) : Number(getVar(risuChatParser(effect.index,{chara:char})))
                    const content = json?.[index]?.content ?? 'null'
                    setVar(risuChatParser(effect.outputVar, {chara:char}), content)
                    break
                }
                case 'v2SetRequestState':{
                    if(!arg.displayMode){
                        return
                    }
                    const json = JSON.parse(arg.displayData) as OpenAIChat[]
                    const index = effect.indexType === 'value' ? Number(risuChatParser(effect.index,{chara:char})) : Number(getVar(risuChatParser(effect.index,{chara:char})))
                    const value = effect.valueType === 'value' ? risuChatParser(effect.value,{chara:char}) : getVar(risuChatParser(effect.value,{chara:char}))
                    json[index].content = value
                    arg.displayData = JSON.stringify(json)
                    break
                }
                case 'v2GetRequestStateRole':{
                    if(!arg.displayMode){
                        return
                    }
                    const json = JSON.parse(arg.displayData) as OpenAIChat[]
                    const index = effect.indexType === 'value' ? Number(risuChatParser(effect.index,{chara:char})) : Number(getVar(risuChatParser(effect.index,{chara:char})))
                    const content = json?.[index]?.role ?? 'null'
                    setVar(risuChatParser(effect.outputVar, {chara:char}), content)
                    break
                }
                case 'v2SetRequestStateRole':{
                    if(!arg.displayMode){
                        return
                    }
                    const json = JSON.parse(arg.displayData) as OpenAIChat[]
                    const index = effect.indexType === 'value' ? Number(risuChatParser(effect.index,{chara:char})) : Number(getVar(risuChatParser(effect.index,{chara:char})))
                    const value = effect.valueType === 'value' ? risuChatParser(effect.value,{chara:char}) : getVar(risuChatParser(effect.value,{chara:char}))
                    if(value === 'user' || value === 'assistant' || value === 'system'){
                        json[index].role = value
                    }
                    arg.displayData = JSON.stringify(json)
                    break
                }

                case 'v2GetRequestStateLength':{
                    if(!arg.displayMode){
                        return
                    }
                    const json = JSON.parse(arg.displayData) as OpenAIChat[]
                    setVar(risuChatParser(effect.outputVar, {chara:char}), json.length.toString())
                    break
                }
                case 'v2Tokenize':{
                    const value = effect.valueType === 'value' ? risuChatParser(effect.value,{chara:char}) : getVar(risuChatParser(effect.value,{chara:char}))
                    setVar(risuChatParser(effect.outputVar, {chara:char}), (await tokenize(value)).toString())
                    break
                }
            }
        }
    }
    
    let caculatedTokens = 0
    if(additonalSysPrompt.start){
        caculatedTokens += await tokenize(additonalSysPrompt.start)
    }
    if(additonalSysPrompt.historyend){
        caculatedTokens += await tokenize(additonalSysPrompt.historyend)
    }
    if(additonalSysPrompt.promptend){
        caculatedTokens += await tokenize(additonalSysPrompt.promptend)
    }
    if(varChanged){
        const currentChat = getCurrentChat()
        currentChat.scriptstate = chat.scriptstate
        ReloadGUIPointer.set(get(ReloadGUIPointer) + 1)
    }

    if (shouldSetTriggerId && mode !== 'manual') {
        CurrentTriggerIdStore.set(previousTriggerId)
    }
    
    return {additonalSysPrompt, chat, tokens:caculatedTokens, stopSending, sendAIprompt, displayData: arg.displayData, tempVars: arg.tempVars}

}
