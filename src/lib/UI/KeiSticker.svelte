<script lang="ts">
    import { PRODUCT_EDITION_NAME } from 'src/ts/branding'
</script>

<span class="kei-sticker" aria-hidden="true">
    <span class="kei-sticker-text">{PRODUCT_EDITION_NAME}</span>
</span>

<style>
    @font-face {
        font-family: "GeuriunXKukhanbakTture";
        src: url("https://cdn.jsdelivr.net/gh/Project-Noonnu/2607161334@x-7/x/GriunXHangeulDDURAE-Regular.woff2") format("woff2");
        font-weight: 400;
        font-display: swap;
    }

    .kei-sticker {
        position: relative;
        z-index: 1;
        display: inline-flex;
        align-items: center;
        margin-left: -0.185em;
        padding: 0.079em 0.273em 0.088em;
        clip-path: polygon(
            5% 0,
            95% 0,
            100% 10%,
            95% 20%,
            100% 30%,
            95% 40%,
            100% 50%,
            95% 60%,
            100% 70%,
            95% 80%,
            100% 90%,
            95% 100%,
            5% 100%,
            0 90%,
            5% 80%,
            0 70%,
            5% 60%,
            0 50%,
            5% 40%,
            0 30%,
            5% 20%,
            0 10%
        );
        filter: drop-shadow(0 0.035em 0.044em rgb(0 0 0 / 20%));
        transform: translate(0.035em, -0.255em) rotate(15deg);
        vertical-align: middle;
    }

    .kei-sticker-text {
        position: relative;
        z-index: 2;
        color: rgb(255 255 255 / 95%);
        font-family: "GeuriunXKukhanbakTture", system-ui, sans-serif;
        font-size: 0.44em;
        font-weight: 400;
        line-height: 1;
        letter-spacing: 0.06em;
    }

    .kei-sticker::after {
        position: absolute;
        inset: 0;
        z-index: 1;
        background:
            repeating-linear-gradient(
                94deg,
                rgb(255 255 255 / 4%) 0,
                rgb(255 255 255 / 4%) 0.035em,
                transparent 0.035em,
                transparent 0.106em
            ),
            rgb(245 135 185 / 60%);
        content: "";
        pointer-events: none;
    }
</style>
