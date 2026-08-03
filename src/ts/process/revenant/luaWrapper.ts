export function wrapRevenantLua(code: string): string {
    return `
json = require 'json'

function getChat(id, index)
    return json.decode(getChatMain(id, index))
end

function getFullChat(id)
    return json.decode(getFullChatMain(id))
end

function setFullChat(id, value)
    setFullChatMain(id, json.encode(value))
end

function log(value)
    logMain(json.encode(value))
end

function getLoreBooks(id, search)
    return json.decode(getLoreBooksMain(id, search))
end

function loadLoreBooks(id)
    return json.decode(loadLoreBooksMain(id):await())
end

function LLM(id, prompt, useMultimodal, options)
    useMultimodal = useMultimodal or false
    options = options or {}
    return json.decode(LLMMain(id, json.encode(prompt), useMultimodal, json.encode(options)):await())
end

function axLLM(id, prompt, useMultimodal, options)
    useMultimodal = useMultimodal or false
    options = options or {}
    return json.decode(axLLMMain(id, json.encode(prompt), useMultimodal, json.encode(options)):await())
end

function getCharacterImage(id)
    return getCharacterImageMain(id):await()
end

function getPersonaImage(id)
    return getPersonaImageMain(id):await()
end

local editRequestFuncs = {}
local editDisplayFuncs = {}
local editInputFuncs = {}
local editOutputFuncs = {}

function listenEdit(type, func)
    if type == 'editRequest' then editRequestFuncs[#editRequestFuncs + 1] = func return end
    if type == 'editDisplay' then editDisplayFuncs[#editDisplayFuncs + 1] = func return end
    if type == 'editInput' then editInputFuncs[#editInputFuncs + 1] = func return end
    if type == 'editOutput' then editOutputFuncs[#editOutputFuncs + 1] = func return end
    error('Invalid edit listener type')
end

function hasEditListener(type)
    local funcs = type == 'editRequest' and editRequestFuncs
        or type == 'editDisplay' and editDisplayFuncs
        or type == 'editInput' and editInputFuncs
        or type == 'editOutput' and editOutputFuncs
        or {}
    return #funcs > 0
end

function getState(id, name)
    return json.decode(getChatVar(id, '__'..name))
end

function setState(id, name, value)
    setChatVar(id, '__'..name, json.encode(value))
end

function async(callback)
    return function(...)
        local co = coroutine.create(callback)
        local safe, result = coroutine.resume(co, ...)
        return Promise.create(function(resolve, reject)
            local checkresult
            local step = function()
                if coroutine.status(co) == 'dead' then
                    local send = safe and resolve or reject
                    return send(result)
                end
                safe, result = coroutine.resume(co)
                checkresult()
            end
            checkresult = function()
                if safe and result == Promise.resolve(result) then result:finally(step)
                else step() end
            end
            checkresult()
        end)
    end
end

callListenMain = async(function(type, id, value, meta)
    local realValue = json.decode(value)
    local realMeta = json.decode(meta)
    local funcs = type == 'editRequest' and editRequestFuncs
        or type == 'editDisplay' and editDisplayFuncs
        or type == 'editInput' and editInputFuncs
        or type == 'editOutput' and editOutputFuncs
        or {}
    for _, func in ipairs(funcs) do realValue = func(id, realValue, realMeta) end
    return json.encode(realValue)
end)

${code}
`
}
