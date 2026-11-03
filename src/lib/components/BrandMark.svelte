<script lang="ts">
  import { asset } from '$app/paths';
</script>

<!-- kit.js の brandMark と同じ画像。読み上げ名は呼び出し元が受け持つ -->
<span class="brand-art" aria-hidden="true">
  <img
    class="brand-name"
    src={asset('brand/header/logo-transparent-600.png')}
    srcset={`${asset('brand/header/logo-transparent-600.png')} 600w, ${asset('brand/header/logo-transparent-1200.png')} 1200w`}
    sizes="240px"
    width="600"
    height="200"
    alt=""
  />
  <img class="brand-mark" src={asset('brand/master/symbol.png')} width="629" height="678" alt="" />
</span>
