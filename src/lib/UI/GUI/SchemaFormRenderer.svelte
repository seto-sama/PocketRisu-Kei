<script lang="ts">
    import type {
        ModelPreset,
        RegistryFieldSchema,
        RegistryUiField,
        RegistryUiGroup,
        RegistryUiSchema,
        RegistryWidget,
        UiVisibility,
    } from "src/ts/preset/types";
    import { localizeGroupLabel } from "src/ts/preset/registry/i18n";
    import { language } from "src/lang";
    import SchemaFieldRenderer from "./SchemaFieldRenderer.svelte";

    interface Props {
        schema: RegistryFieldSchema[];
        uiSchema: RegistryUiSchema;
        userValues: Record<string, unknown>;
        visibility: UiVisibility;
        // Passed through to auth fields so they can render the saved-key picker.
        preset?: ModelPreset;
        // Preset-editor-owned controls that should share a registry UI group
        // without becoming provider body mappings.
        extraSchema?: RegistryFieldSchema[];
        extraUiGroups?: RegistryUiGroup[];
        extraUiFields?: RegistryUiField[];
        extraValues?: object;
        showGroupLabels?: boolean;
    }

    let {
        schema,
        uiSchema,
        userValues = $bindable(),
        visibility,
        preset,
        extraSchema = [],
        extraUiGroups = [],
        extraUiFields = [],
        extraValues,
        showGroupLabels = true,
    }: Props = $props();

    // Profile defaults are seeded when a preset is created or updated. Do not
    // re-seed them while rendering: a disableable slider writes `undefined`
    // when dragged to its leftmost "off" stop, and render-time seeding would
    // immediately turn it back on.

    type RenderEntry = {
        schemaField: RegistryFieldSchema;
        uiField: RegistryUiField;
        values: Record<string, unknown>;
    };

    // Default widget for a schema field when its uiField is missing (degenerate
    // snapshot fallback below). Auth fields ignore this — SchemaFieldRenderer
    // routes `mapsTo.target === 'auth'` to the credential picker regardless.
    function fieldToWidget(f: RegistryFieldSchema): RegistryWidget {
        if (f.secret) return 'secret';
        if (f.enum && f.enum.length > 0) return 'select';
        switch (f.type) {
            case 'number':
            case 'integer': return 'number-input';
            case 'boolean': return 'toggle';
            case 'json': return 'json';
            case 'stringArray': return 'string-array';
            case 'keyValue': return 'key-value';
            default: return 'text';
        }
    }

    function visibleEntries(): RenderEntry[] {
        const out: RenderEntry[] = [];
        const allSchema = [...schema, ...extraSchema];
        for (const uiField of [...uiSchema.fields, ...extraUiFields]) {
            // Tolerate null/undefined elements from a malformed/persisted snapshot
            // so a single bad entry can't crash rendering (reading `.visibility` of null).
            if (!uiField) continue;
            if (uiField.visibility !== visibility) continue;
            if (!evalShowIf(uiField)) continue;
            const schemaField = allSchema.find((f) => f?.key === uiField.key);
            if (!schemaField) continue;
            const isExtra = extraSchema.some((field) => field?.key === uiField.key);
            out.push({
                schemaField,
                uiField,
                values: isExtra && extraValues
                    ? extraValues as Record<string, unknown>
                    : userValues,
            });
        }
        // Degenerate-snapshot fallback: schema fields exist but uiSchema carries no
        // usable field, which would render a blank form and hide the API key (see
        // heal-on-load in dbDefaults). Surface every schema field with a default
        // widget, all under the 'basic' tab so nothing is lost. Gated on an empty
        // uiSchema so healthy/partial snapshots are never touched.
        if (visibility === 'basic' && !uiSchema.fields.some(Boolean)) {
            for (const f of schema) {
                if (!f) continue;
                out.push({
                    schemaField: f,
                    uiField: { key: f.key, widget: fieldToWidget(f), visibility: 'basic' },
                    values: userValues,
                });
            }
        }
        return out;
    }

    function evalShowIf(uiField: RegistryUiField): boolean {
        const cond = uiField.showIf;
        if (!cond) return true;
        const schemaDefault = schema.find((field) => field?.key === cond.key)?.default;
        const v = userValues[cond.key] ?? schemaDefault;
        if (cond.equals !== undefined) return v === cond.equals;
        if (cond.notEquals !== undefined) return v !== cond.notEquals;
        return true;
    }

    const entries = $derived(visibleEntries());

    const groupedRendered = $derived.by(() => {
        // Tolerate null/undefined group elements from a malformed/persisted
        // snapshot so a bad entry can't crash the sort (reading `.order` of null).
        // Extra editor-owned controls can join an existing registry group. The
        // last definition wins so the editor can also supply a missing group
        // without rendering a duplicate bucket.
        const groupsById = new Map<string, RegistryUiGroup>();
        for (const group of [...uiSchema.groups, ...extraUiGroups]) {
            if (group) groupsById.set(group.id, group);
        }
        const groupOrder = [...groupsById.values()]
            .sort((a, b) => (a.order ?? 999) - (b.order ?? 999));

        // entries grouped by group id (or '' for un-grouped)
        const buckets = new Map<string, RenderEntry[]>();
        for (const entry of entries) {
            const key = entry.uiField.group ?? '';
            const arr = buckets.get(key) ?? [];
            arr.push(entry);
            buckets.set(key, arr);
        }
        for (const arr of buckets.values()) {
            arr.sort((a, b) => (a.uiField.order ?? 999) - (b.uiField.order ?? 999));
        }

        const out: { label: string | null; items: RenderEntry[] }[] = [];
        for (const group of groupOrder) {
            const items = buckets.get(group.id);
            if (items && items.length > 0) {
                out.push({ label: localizeGroupLabel(group), items });
            }
        }
        const ungrouped = buckets.get('');
        if (ungrouped && ungrouped.length > 0) {
            out.push({ label: null, items: ungrouped });
        }
        return out;
    });

    function segmentEntries(items: RenderEntry[]): Array<{ row: boolean; items: RenderEntry[] }> {
        const segments: Array<{ row: boolean; items: RenderEntry[] }> = [];
        for (const item of items) {
            // Slider rows and ShSwitch rows already own their py-3 spacing and
            // top divider. Treat both as contiguous setting rows; adding the
            // form's ordinary gap-3 between them puts extra space above each
            // divider and makes the text look vertically top-heavy.
            const row = item.uiField.layout === 'row'
                || item.uiField.widget === 'toggle'
                || item.schemaField.mapsTo?.target === 'auth';
            const last = segments.at(-1);
            if (last?.row === row) {
                last.items.push(item);
            } else {
                segments.push({ row, items: [item] });
            }
        }
        return segments;
    }
</script>

{#if groupedRendered.length === 0}
    {#if visibility === 'basic' && !schema.some(Boolean)}
        <!-- Fully degenerate snapshot (no schema fields to even fall back to) that
             heal couldn't repair. Don't dead-end on a blank/"no items" form —
             point the user at re-download / replace. -->
        <p class="text-textcolor2 text-sm py-4">{language.modelPresetSnapshotEmpty}</p>
    {:else if visibility !== 'info'}
        <p class="text-textcolor2 text-sm py-4">표시할 항목이 없습니다.</p>
    {/if}
{:else}
    <div class="flex flex-col gap-6">
        {#each groupedRendered as group}
            <div class="flex flex-col">
                {#if group.label && showGroupLabels}
                    <h3 class="text-base font-bold mb-1 text-textcolor">{group.label}</h3>
                {/if}
                {#each segmentEntries(group.items) as segment}
                    <div class={segment.row
                        ? "[&>*:first-child]:border-t-0"
                        : "flex flex-col gap-3 [&>*:first-child]:border-t-0"}>
                        {#each segment.items as { schemaField, uiField, values } (uiField.key)}
                            <SchemaFieldRenderer {schemaField} {uiField} userValues={values} {preset} />
                        {/each}
                    </div>
                {/each}
            </div>
        {/each}
    </div>
{/if}
