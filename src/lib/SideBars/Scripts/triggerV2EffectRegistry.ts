import type { triggerEffectV2 } from "src/ts/process/triggers";

export const effectCategories = {
        'Special': [
            'v2GetDisplayState',
            'v2SetDisplayState',
            'v2GetRequestState',
            'v2SetRequestState',
            'v2GetRequestStateRole',
            'v2SetRequestStateRole',
            'v2GetRequestStateLength'
        ],
        'Control': [
            'v2SetVar',
            'v2DeclareLocalVar',
            'v2Calculate',
            'v2IfAdvanced',
            'v2LoopNTimes',
            'v2Loop',
            'v2BreakLoop',
            'v2Command',
            'v2ConsoleLog',
            'v2RunTrigger',
            'v2StopTrigger',
            'v2Comment'
        ],
        'Chat': [
            'v2CutChat',
            'v2ModifyChat',
            'v2Impersonate',
            'v2GetLastMessage',
            'v2GetLastUserMessage',
            'v2GetLastCharMessage',
            'v2GetMessageAtIndex',
            'v2GetMessageCount',
            'v2GetFirstMessage',
            'v2QuickSearchChat'
        ],
        'Low Level': [
            'v2SendAIprompt',
            'v2ImgGen',
            'v2CheckSimilarity',
            'v2RunLLM'
        ],
        'Alert': [
            'v2ShowAlert',
            'v2GetAlertInput',
            'v2GetAlertSelect'
        ],
        'Lorebook V2': [
            'v2GetAllLorebooks',
            'v2GetLorebookByName',
            'v2GetLorebookByIndex',
            'v2CreateLorebook',
            'v2ModifyLorebookByIndex',
            'v2DeleteLorebookByIndex',
            'v2GetLorebookCountNew',
            'v2SetLorebookAlwaysActive'
        ],
        'String': [
            'v2RegexTest',
            'v2ExtractRegex',
            'v2GetCharAt',
            'v2GetCharCount',
            'v2ToLowerCase',
            'v2ToUpperCase',
            'v2SetCharAt',
            'v2SplitString',
            'v2ConcatString',
            'v2ReplaceString'
        ],
        'Data': [
            'v2GetCharacterDesc',
            'v2SetCharacterDesc',
            'v2GetPersonaDesc',
            'v2SetPersonaDesc',
            'v2GetReplaceGlobalNote',
            'v2SetReplaceGlobalNote',
            'v2GetAuthorNote',
            'v2SetAuthorNote'
        ],
        'Array': [
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
            'v2JoinArrayVar'
        ],
        'Dictionary': [
            'v2MakeDictVar',
            'v2GetDictVar',
            'v2SetDictVar',
            'v2DeleteDictKey',
            'v2HasDictKey',
            'v2ClearDict',
            'v2GetDictSize',
            'v2GetDictKeys',
            'v2GetDictValues'
        ],
        'Others': [
            'v2Random',
            'v2UpdateGUI',
            'v2SystemPrompt',
            'v2UpdateChatAt',
            'v2Wait',
            'v2StopPromptSending',
            'v2Tokenize'
        ],
        'Deprecated': [
            'v2If',
            'v2ModifyLorebook',
            'v2GetLorebook',
            'v2GetLorebookCount',
            'v2GetLorebookEntry',
            'v2SetLorebookActivation',
            'v2GetLorebookIndexViaName'
        ]
    }

export const triggerV2EffectFactories: Record<string, () => triggerEffectV2> = {
    "v2SetVar": () => ({
            type: 'v2SetVar',
            operator: '=',
            var: '',
            value: '',
            valueType: 'value',
            indent: 0
        }),
    "v2If": () => ({
            type: 'v2If',
            indent: 0,
            condition: '=',
            targetType: 'value',
            target: '',
            source: ''
        }),
    "v2IfAdvanced": () => ({
            type: 'v2IfAdvanced',
            indent: 0,
            condition: '=',
            targetType: 'value',
            target: '',
            sourceType: 'value',
            source: '',
        }),
    "v2Else": () => ({
            type: 'v2Else',
            indent: 0
        }),
    "v2Loop": () => ({
            type: 'v2Loop',
            indent: 0,
        }),
    "v2LoopNTimes": () => ({
            type: 'v2LoopNTimes',
            indent: 0,
            value: '',
            valueType: 'value'
        }),
    "v2BreakLoop": () => ({
            type: 'v2BreakLoop',
            indent: 0
        }),
    "v2RunTrigger": () => ({
            type: 'v2RunTrigger',
            indent: 0,
            target: ''
        }),
    "v2ConsoleLog": () => ({
            type: 'v2ConsoleLog',
            indent: 0,
            sourceType: 'value',
            source: ''
        }),
    "v2StopTrigger": () => ({
            type: 'v2StopTrigger',
            indent: 0
        }),
    "v2CutChat": () => ({
            type: 'v2CutChat',
            indent: 0,
            start: '0',
            end: '0',
            startType: 'value',
            endType: 'value'
        }),
    "v2ModifyChat": () => ({
            type: 'v2ModifyChat',
            index: '',
            indexType: 'value',
            value: '',
            valueType: 'value',
            indent: 0
        }),
    "v2SystemPrompt": () => ({
            type: 'v2SystemPrompt',
            location: 'start',
            value: '',
            valueType: 'value',
            indent: 0
        }),
    "v2Impersonate": () => ({
            type: 'v2Impersonate',
            role: 'user',
            value: '',
            valueType: 'value',
            indent: 0
        }),
    "v2Command": () => ({
            type: 'v2Command',
            value: '',
            valueType: 'value',
            indent: 0
        }),
    "v2SendAIprompt": () => ({
            type: 'v2SendAIprompt',
            indent: 0
        }),
    "v2ImgGen": () => ({
            type: 'v2ImgGen',
            value: '',
            valueType: 'value',
            negValue: '',
            negValueType: 'value',
            outputVar: '',
            indent: 0
        }),
    "v2CheckSimilarity": () => ({
            type: 'v2CheckSimilarity',
            source: '',
            sourceType: 'value',
            value: '',
            valueType: 'value',
            outputVar: '',
            indent: 0
        }),
    "v2RunLLM": () => ({
            type: 'v2RunLLM',
            value: '',
            valueType: 'value',
            outputVar: '',
            indent: 0,
            model: 'model',
            streaming: false
        }),
    "v2ShowAlert": () => ({
            type: 'v2ShowAlert',
            value: '',
            valueType: 'value',
            indent: 0
        }),
    "v2ExtractRegex": () => ({
            type: 'v2ExtractRegex',
            value: '',
            valueType: 'value',
            regex: '',
            regexType: 'value',
            flags: '',
            flagsType: 'value',
            result: '',
            resultType: 'value',
            outputVar: '',
            indent: 0
        }),
    "v2GetLastMessage": () => ({
            type: 'v2GetLastMessage',
            outputVar: '',
            indent: 0
        }),
    "v2GetMessageAtIndex": () => ({
            type: 'v2GetMessageAtIndex',
            index: '',
            indexType: 'value',
            outputVar: '',
            indent: 0
        }),
    "v2GetMessageCount": () => ({
            type: 'v2GetMessageCount',
            outputVar: '',
            indent: 0
        }),
    "v2ModifyLorebook": () => ({
            type: 'v2ModifyLorebook',
            target: '',
            targetType: 'value',
            value: '',
            valueType: 'value',
            indent: 0
        }),
    "v2GetLorebook": () => ({
            type: 'v2GetLorebook',
            target: '',
            targetType: 'value',
            outputVar: '',
            indent: 0
        }),
    "v2GetLorebookCount": () => ({
            type: 'v2GetLorebookCount',
            outputVar: '',
            indent: 0
        }),
    "v2GetLorebookEntry": () => ({
            type: 'v2GetLorebookEntry',
            index: '',
            indexType: 'value',
            outputVar: '',
            indent: 0
        }),
    "v2SetLorebookActivation": () => ({
            type: 'v2SetLorebookActivation',
            index: '',
            indexType: 'value',
            value: true,
            indent: 0
        }),
    "v2GetLorebookIndexViaName": () => ({
            type: 'v2GetLorebookIndexViaName',
            name: '',
            nameType: 'value',
            outputVar: '',
            indent: 0
        }),
    "v2Random": () => ({
            type: 'v2Random',
            outputVar: '',
            min: '0',
            max: '100',
            minType: 'value',
            maxType: 'value',
            indent: 0
        }),
    "v2GetCharAt": () => ({
            type: 'v2GetCharAt',
            source: '',
            sourceType: 'value',
            index: '',
            indexType: 'value',
            outputVar: '',
            indent: 0
        }),
    "v2GetCharCount": () => ({
            type: 'v2GetCharCount',
            source: '',
            sourceType: 'value',
            outputVar: '',
            indent: 0
        }),
    "v2ToLowerCase": () => ({
            type: 'v2ToLowerCase',
            source: '',
            sourceType: 'value',
            outputVar: '',
            indent: 0
        }),
    "v2ToUpperCase": () => ({
            type: 'v2ToUpperCase',
            source: '',
            sourceType: 'value',
            outputVar: '',
            indent: 0
        }),
    "v2SetCharAt": () => ({
            type: 'v2SetCharAt',
            source: '',
            sourceType: 'value',
            index: '',
            indexType: 'value',
            value: '',
            valueType: 'value',
            outputVar: '',
            indent: 0
        }),
    "v2SplitString": () => ({
            type: 'v2SplitString',
            source: '',
            sourceType: 'value',
            delimiter: '',
            delimiterType: 'value',
            outputVar: '',
            indent: 0
        }),
    "v2JoinArrayVar": () => ({
            type: 'v2JoinArrayVar',
            var: '',
            varType: 'value',
            delimiter: '',
            delimiterType: 'value',
            outputVar: '',
            indent: 0
        }),
    "v2GetCharacterDesc": () => ({
            type: 'v2GetCharacterDesc',
            outputVar: '',
            indent: 0
        }),
    "v2SetCharacterDesc": () => ({
            type: 'v2SetCharacterDesc',
            value: '',
            valueType: 'value',
            indent: 0
        }),
    "v2GetPersonaDesc": () => ({
            type: 'v2GetPersonaDesc',
            outputVar: '',
            indent: 0
        }),
    "v2SetPersonaDesc": () => ({
            type: 'v2SetPersonaDesc',
            value: '',
            valueType: 'value',
            indent: 0
        }),
    "v2MakeArrayVar": () => ({
            type: 'v2MakeArrayVar',
            var: '',
            indent: 0
        }),
    "v2GetArrayVarLength": () => ({
            type: 'v2GetArrayVarLength',
            var: '',
            outputVar: '',
            indent: 0
        }),
    "v2GetArrayVar": () => ({
            type: 'v2GetArrayVar',
            var: '',
            index: '',
            indexType: 'value',
            outputVar: '',
            indent: 0
        }),
    "v2SetArrayVar": () => ({
            type: 'v2SetArrayVar',
            var: '',
            index: '',
            indexType: 'value',
            value: '',
            valueType: 'value',
            indent: 0
        }),
    "v2Tokenize": () => ({
            type: 'v2Tokenize',
            value: '',
            valueType: 'value',
            indent: 0,
            outputVar: ""
        }),
    "v2PushArrayVar": () => ({
            type: 'v2PushArrayVar',
            var: '',
            value: '',
            valueType: 'value',
            indent: 0
        }),
    "v2PopArrayVar": () => ({
            type: 'v2PopArrayVar',
            var: '',
            outputVar: '',
            indent: 0
        }),
    "v2ShiftArrayVar": () => ({
            type: 'v2ShiftArrayVar',
            var: '',
            outputVar: '',
            indent: 0
        }),
    "v2UnshiftArrayVar": () => ({
            type: 'v2UnshiftArrayVar',
            var: '',
            value: '',
            valueType: 'value',
            indent: 0
        }),
    "v2SpliceArrayVar": () => ({
            type: 'v2SpliceArrayVar',
            var: '',
            start: '',
            startType: 'value',
            item: '',
            itemType: 'value',
            indent: 0
        }),
    "v2SliceArrayVar": () => ({
            type: 'v2SliceArrayVar',
            var: '',
            start: '',
            startType: 'value',
            end: '',
            endType: 'value',
            outputVar: '',
            indent: 0
        }),
    "v2GetIndexOfValueInArrayVar": () => ({
            type: 'v2GetIndexOfValueInArrayVar',
            var: '',
            value: '',
            valueType: 'value',
            outputVar: '',
            indent: 0
        }),
    "v2RemoveIndexFromArrayVar": () => ({
            type: 'v2RemoveIndexFromArrayVar',
            var: '',
            index: '',
            indexType: 'value',
            indent: 0
        }),
    "v2ConcatString": () => ({
            type: 'v2ConcatString',
            source1: '',
            source1Type: 'value',
            source2: '',
            source2Type: 'value',
            outputVar: '',
            indent: 0
        }),
    "v2GetLastUserMessage": () => ({
            type: 'v2GetLastUserMessage',
            outputVar: '',
            indent: 0
        }),
    "v2GetLastCharMessage": () => ({
            type: 'v2GetLastCharMessage',
            outputVar: '',
            indent: 0
        }),
    "v2GetFirstMessage": () => ({
            type: 'v2GetFirstMessage',
            outputVar: '',
            indent: 0
        }),
    "v2GetAlertInput": () => ({
            type: 'v2GetAlertInput',
            outputVar: '',
            indent: 0,
            display: '',
            displayType: 'value'
        }),
    "v2GetAlertSelect": () => ({
            type: 'v2GetAlertSelect',
            display: '',
            displayType: 'value',
            value: '',
            valueType: 'value',
            outputVar: '',
            indent: 0
        }),
    "v2GetDisplayState": () => ({
            type: 'v2GetDisplayState',
            outputVar: '',
            indent: 0
        }),
    "v2SetDisplayState": () => ({
            type: 'v2SetDisplayState',
            value: '',
            valueType: 'value',
            indent: 0
        }),
    "v2UpdateGUI": () => ({
            type: 'v2UpdateGUI',
            indent: 0
        }),
    "v2UpdateChatAt": () => ({
            type: 'v2UpdateChatAt',
            index: '0',
            indent: 0
        }),
    "v2Wait": () => ({
            type: 'v2Wait',
            value: '1',
            valueType: 'value',
            indent: 0
        }),
    "v2GetRequestState": () => ({
            type: 'v2GetRequestState',
            outputVar: '',
            index: '',
            indexType: 'value',
            indent: 0
        }),
    "v2SetRequestState": () => ({
            type: 'v2SetRequestState',
            value: '',
            valueType: 'value',
            index: '',
            indexType: 'value',
            indent: 0
        }),
    "v2GetRequestStateRole": () => ({
            type: 'v2GetRequestStateRole',
            outputVar: '',
            index: '',
            indexType: 'value',
            indent: 0
        }),
    "v2SetRequestStateRole": () => ({
            type: 'v2SetRequestStateRole',
            value: '',
            valueType: 'value',
            index: '',
            indexType: 'value',
            indent: 0
        }),
    "v2GetRequestStateLength": () => ({
            type: 'v2GetRequestStateLength',
            outputVar: '',
            indent: 0
        }),
    "v2StopPromptSending": () => ({
            type: 'v2StopPromptSending',
            indent: 0
        }),
    "v2QuickSearchChat": () => ({
            type: 'v2QuickSearchChat',
            value: '',
            valueType: 'value',
            indent: 0,
            condition: 'loose',
            depth: '3',
            depthType: 'value',
            outputVar: ''
        }),
    "v2GetAllLorebooks": () => ({
            type: 'v2GetAllLorebooks',
            outputVar: '',
            indent: 0
        }),
    "v2RegexTest": () => ({
            type: 'v2RegexTest',
            value: '',
            valueType: 'value',
            regex: '',
            regexType: 'value',
            flags: '',
            flagsType: 'value',
            outputVar: '',
            indent: 0
        }),
    "v2GetLorebookByName": () => ({
            type: 'v2GetLorebookByName',
            name: '',
            nameType: 'value',
            outputVar: '',
            indent: 0
        }),
    "v2GetLorebookByIndex": () => ({
            type: 'v2GetLorebookByIndex',
            index: '',
            indexType: 'value',
            outputVar: '',
            indent: 0
        }),
    "v2CreateLorebook": () => ({
            type: 'v2CreateLorebook',
            name: '',
            nameType: 'value',
            key: '',
            keyType: 'value',
            content: '',
            contentType: 'value',
            insertOrder: '100',
            insertOrderType: 'value',
            indent: 0
        }),
    "v2ModifyLorebookByIndex": () => ({
            type: 'v2ModifyLorebookByIndex',
            index: '',
            indexType: 'value',
            name: '{{slot}}',
            nameType: 'value',
            key: '{{slot}}',
            keyType: 'value',
            content: '{{slot}}',
            contentType: 'value',
            insertOrder: '{{slot}}',
            insertOrderType: 'value',
            indent: 0
        }),
    "v2DeleteLorebookByIndex": () => ({
            type: 'v2DeleteLorebookByIndex',
            index: '',
            indexType: 'value',
            indent: 0
        }),
    "v2GetLorebookCountNew": () => ({
            type: 'v2GetLorebookCountNew',
            outputVar: '',
            indent: 0
        }),
    "v2SetLorebookAlwaysActive": () => ({
            type: 'v2SetLorebookAlwaysActive',
            index: '',
            indexType: 'value',
            value: true,
            indent: 0
        }),
    "v2GetReplaceGlobalNote": () => ({
            type: 'v2GetReplaceGlobalNote',
            outputVar: '',
            indent: 0
        }),
    "v2SetReplaceGlobalNote": () => ({
            type: 'v2SetReplaceGlobalNote',
            value: '',
            valueType: 'value',
            indent: 0
        }),
    "v2GetAuthorNote": () => ({
            type: 'v2GetAuthorNote',
            outputVar: '',
            indent: 0
        }),
    "v2SetAuthorNote": () => ({
            type: 'v2SetAuthorNote',
            value: '',
            valueType: 'value',
            indent: 0
        }),
    "v2MakeDictVar": () => ({
            type: 'v2MakeDictVar',
            var: '',
            indent: 0
        }),
    "v2GetDictVar": () => ({
            type: 'v2GetDictVar',
            var: '',
            varType: 'value',
            key: '',
            keyType: 'value',
            outputVar: '',
            indent: 0
        }),
    "v2SetDictVar": () => ({
            type: 'v2SetDictVar',
            var: '',
            varType: 'value',
            key: '',
            keyType: 'value',
            value: '',
            valueType: 'value',
            indent: 0
        }),
    "v2DeleteDictKey": () => ({
            type: 'v2DeleteDictKey',
            var: '',
            varType: 'value',
            key: '',
            keyType: 'value',
            indent: 0
        }),
    "v2HasDictKey": () => ({
            type: 'v2HasDictKey',
            var: '',
            varType: 'value',
            key: '',
            keyType: 'value',
            outputVar: '',
            indent: 0
        }),
    "v2ClearDict": () => ({
            type: 'v2ClearDict',
            var: '',
            indent: 0
        }),
    "v2GetDictSize": () => ({
            type: 'v2GetDictSize',
            var: '',
            varType: 'value',
            outputVar: '',
            indent: 0
        }),
    "v2GetDictKeys": () => ({
            type: 'v2GetDictKeys',
            var: '',
            varType: 'value',
            outputVar: '',
            indent: 0
        }),
    "v2GetDictValues": () => ({
            type: 'v2GetDictValues',
            var: '',
            varType: 'value',
            outputVar: '',
            indent: 0
        }),
    "v2Calculate": () => ({
            type: 'v2Calculate',
            expression: '',
            expressionType: 'value',
            outputVar: '',
            indent: 0
        }),
    "v2ReplaceString": () => ({
            type: 'v2ReplaceString',
            source: '',
            sourceType: 'value',
            regex: '',
            regexType: 'value',
            result: '',
            resultType: 'value',
            replacement: '',
            replacementType: 'value',
            flags: '',
            flagsType: 'value',
            outputVar: '',
            indent: 0
        }),
    "v2Comment": () => ({
            type: 'v2Comment',
            value: '',
            indent: 0
        }),
    "v2DeclareLocalVar": () => ({
            type: 'v2DeclareLocalVar',
            var: '',
            value: '',
            valueType: 'value',
            indent: 0
        }),
}

export function createTriggerV2Effect(type: string): triggerEffectV2 | null {
    return triggerV2EffectFactories[type]?.() ?? null
}
