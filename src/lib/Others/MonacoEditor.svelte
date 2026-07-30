<script lang="ts">
    import { onMount, onDestroy } from 'svelte';
    import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js';
    import 'monaco-editor/esm/vs/basic-languages/css/css.contribution.js';
    import 'monaco-editor/esm/vs/basic-languages/html/html.contribution.js';
    import 'monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution.js';
    import 'monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution.js';
    import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
    // Syntax highlighting runs on the main thread. A single base worker is
    // enough because this editor does not need language-service features such
    // as validation, IntelliSense, or type analysis.
    if (!('MonacoEnvironment' in self)) {
        (self as any).MonacoEnvironment = {
            getWorker() {
                return new EditorWorker();
            }
        };
    }

    interface Props {
        value: string;
        language?: string;
        theme?: string;
        readonly?: boolean;
        onchange?: (value: string) => void;
    }

    let {
        value = $bindable(''),
        language = 'markdown',
        theme = 'vs-dark',
        readonly = false,
        onchange,
    }: Props = $props();

    let container: HTMLDivElement;
    let editor: monaco.editor.IStandaloneCodeEditor;

    onMount(() => {
        editor = monaco.editor.create(container, {
            value,
            language,
            theme,
            readOnly: readonly,
            // Avoid Chrome EditContext modifier-state and global hotkey conflicts.
            editContext: false,
            automaticLayout: true,
            minimap: { enabled: false },
            wordWrap: 'on',
            lineNumbers: 'on',
            scrollBeyondLastLine: false,
            fontSize: 14,
            fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
            padding: { top: 8, bottom: 8 },
            renderLineHighlight: 'gutter',
            overviewRulerBorder: false,
            scrollbar: {
                verticalScrollbarSize: 6,
                horizontalScrollbarSize: 6,
            },
        });

        editor.onDidChangeModelContent(() => {
            const newValue = editor.getValue();
            value = newValue;
            onchange?.(newValue);
        });

        return () => {
            editor?.dispose();
        };
    });

    onDestroy(() => {
        editor?.dispose();
    });

    $effect(() => {
        if (editor && value !== editor.getValue()) {
            editor.setValue(value);
        }
    });
</script>

<div bind:this={container} class="w-full h-full"></div>
