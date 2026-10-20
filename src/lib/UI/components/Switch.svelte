<script lang="ts">
    import { Switch as SwitchPrimitive } from 'bits-ui';
    import { cn } from 'src/lib/utils';

    interface Props {
        ref?: HTMLButtonElement | null;
        checked?: boolean;
        reverse?: boolean; // Invert the display while keeping bound values and callbacks unchanged.
        size?: 'default' | 'sm';
        disabled?: boolean;
        name?: string;
        value?: string;
        required?: boolean;
        ariaLabel?: string;
        className?: string;
        onCheckedChange?: (checked: boolean) => void;
    }

    let {
        ref = $bindable(null),
        checked = $bindable(),
        reverse = false,
        size = 'default',
        disabled = false,
        name,
        value,
        required,
        ariaLabel,
        className = '',
        onCheckedChange,
    }: Props = $props();
</script>

<SwitchPrimitive.Root
    bind:ref
    checked={reverse ? !checked : !!checked}
    {disabled}
    {name}
    {value}
    {required}
    aria-label={ariaLabel}
    onCheckedChange={(value) => {
        checked = reverse ? !value : value;
        onCheckedChange?.(checked);
    }}
    data-slot="switch"
    data-size={size}
    class={cn(
        'peer group/switch relative inline-flex items-center transition-all ' +
        'after:absolute after:-inset-x-3 after:-inset-y-2 ' +
        'data-disabled:cursor-not-allowed data-disabled:opacity-50 ' +
        'data-[state=checked]:bg-primary data-[state=unchecked]:bg-button ' +
        'hover:brightness-110 ' +
        'aria-invalid:ring-danger/20 aria-invalid:border-danger ' +
        'shrink-0 rounded-full border border-transparent shadow-xs ' +
        'aria-invalid:ring-3 ' +
        'data-[size=default]:h-[18px] data-[size=default]:w-[32px] ' +
        'data-[size=sm]:h-[14px] data-[size=sm]:w-[24px]',
        className
    )}
>
    <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        class={
            'pointer-events-none block ring-0 transition-transform ' +
            'rtl:data-[state=checked]:translate-x-[calc(-100%)] ' +
            'bg-themewhite rounded-full ' +
            'group-data-[size=default]/switch:size-4 group-data-[size=sm]/switch:size-3 ' +
            'group-data-[size=default]/switch:data-[state=checked]:translate-x-[calc(100%-2px)] ' +
            'group-data-[size=sm]/switch:data-[state=checked]:translate-x-[calc(100%-2px)] ' +
            'group-data-[size=default]/switch:data-[state=unchecked]:translate-x-0 ' +
            'group-data-[size=sm]/switch:data-[state=unchecked]:translate-x-0'
        }
    />
</SwitchPrimitive.Root>
