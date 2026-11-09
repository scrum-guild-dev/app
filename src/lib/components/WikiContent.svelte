<script lang="ts">
  import { parseWikiFrontmatter } from '../../shared/wiki.ts';
  import { t } from '../vocabulary.svelte.ts';
  import Markdown from './Markdown.svelte';

  let { source, internalLinkPrefix }: { source: string; internalLinkPrefix?: string } = $props();
  const frontmatter = $derived(parseWikiFrontmatter(source));
</script>

{#if frontmatter.invalid}
  <p class="callout is-warn">{t('wikiFrontmatterInvalid')}</p>
{:else if frontmatter.properties.length}
  <div class="table-wrap">
    <table class="table is-properties">
      <caption class="visually-hidden">{t('wikiProperties')}</caption>
      <thead><tr><th scope="col">{t('wikiPropertyKey')}</th><th scope="col">{t('wikiPropertyValue')}</th></tr></thead>
      <tbody>
        {#each frontmatter.properties as property (property.key)}
          <tr
            ><th scope="row">{property.key}</th><td class="mono"
              >{#if property.value === ''}<span class="props-note">{t('wikiPropertyEmpty')}</span
                >{:else}{property.value}{/if}</td
            ></tr
          >
        {/each}
      </tbody>
    </table>
  </div>
{/if}
<Markdown source={frontmatter.body} {internalLinkPrefix} />
