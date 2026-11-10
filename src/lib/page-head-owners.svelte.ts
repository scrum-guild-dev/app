// 同じ画面の読み込み失敗などで複数の見出しがあるときも、入口を1組に保つ。
export class PageHeadOwners {
  #heads = $state<symbol[]>([]);

  get empty(): boolean {
    return this.#heads.length === 0;
  }

  owns(id: symbol): boolean {
    return this.#heads[0] === id;
  }

  register(id: symbol): () => void {
    this.#heads = [...this.#heads, id];
    return () => {
      this.#heads = this.#heads.filter((head) => head !== id);
    };
  }
}
