import type { SettingItem } from './types'

export const hotkeyChatScreenItems: SettingItem[] = [
    {
        id: 'hotkey.sendKeyPC',
        type: 'radio',
        labelKey: 'sendKeyPC',
        bindKey: 'sendKeyPC',
        helpKey: 'sendKeyPC',
        options: {
            selectOptions: [
                { value: 'enter', labelKey: 'sendKeyEnter' },
                { value: 'ctrl-enter', labelKey: 'sendKeyCtrlEnter' },
                { value: 'shift-enter', labelKey: 'sendKeyShiftEnter' },
                { value: 'button', labelKey: 'sendKeyButton' },
            ],
        },
        keywords: ['send', 'enter', 'keyboard', 'submit', 'pc', 'desktop'],
    },
    {
        id: 'hotkey.sendKeyMobile',
        type: 'radio',
        labelKey: 'sendKeyMobile',
        bindKey: 'sendKeyMobile',
        helpKey: 'sendKeyMobile',
        options: {
            selectOptions: [
                { value: 'enter', labelKey: 'sendKeyEnter' },
                { value: 'ctrl-enter', labelKey: 'sendKeyCtrlEnter' },
                { value: 'shift-enter', labelKey: 'sendKeyShiftEnter' },
                { value: 'button', labelKey: 'sendKeyButton' },
            ],
        },
        keywords: ['send', 'enter', 'keyboard', 'submit', 'mobile'],
    },
]
