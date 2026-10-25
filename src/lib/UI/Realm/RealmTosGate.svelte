<script lang="ts">
    import { language } from "src/lang";
    import { alertTOS } from "src/ts/alert";
    import Button from "../components/Button.svelte";
</script>

<div class="flex w-full flex-col items-center gap-3 p-6 text-center">
    <p class="text-subtext">{language.risuTosGate}</p>
    <Button variant="outline" onclick={() => alertTOS()}>{language.risuTosGateButton}</Button>
</div>
