<script lang="ts">
  import type { DesktopStatus } from '@chatsplice/protocol';
  import type { Translate } from './appearance.js';
  import { runtimeConnectionState } from './connection-status.js';

  export let status: DesktopStatus | null;
  export let t: Translate;
  $: runtimeState = runtimeConnectionState(status);
</script>

<!-- Build identifiers stay out of the UI; only a mismatch that needs a restart is surfaced. -->
{#if runtimeState === 'changed' || runtimeState === 'incompatible'}
  <p class="runtime-guidance" role="status">{t('runtimeRestartGuidance')}</p>
{/if}

<style>
  .runtime-guidance {
    margin: 0 0 12px;
    border: 1px solid var(--color-warn);
    border-radius: var(--radius-md);
    padding: 8px 10px;
    color: var(--color-text);
    font-size: 12px;
    line-height: 1.5;
  }
</style>
