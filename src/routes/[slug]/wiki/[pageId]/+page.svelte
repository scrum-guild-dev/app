<script lang="ts">
  import WikiScreen from '../../../../lib/components/WikiScreen.svelte';
  import type { PageProps } from './$types';
  let { data }: PageProps = $props();
</script>

<WikiScreen {data} />
