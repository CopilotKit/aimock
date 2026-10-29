interface Occurrence {
  ordinal: number;
  history: ReadonlyMap<CausalOccurrences, number>;
}

export interface CausalSelection {
  occurrences: readonly Occurrence[];
  history: ReadonlyMap<CausalOccurrences, number>;
}

export class CausalOccurrences {
  private completed = new Map<string, Occurrence[]>();
  private claimed = new Set<Occurrence>();

  reserve(predecessors: readonly CausalOccurrences[], key: string): CausalSelection | undefined {
    const choices = predecessors.map((predecessor) =>
      (predecessor.completed.get(key) ?? []).filter((item) => !this.claimed.has(item)),
    );
    const positions = choices.map(() => 0);
    const histories: Map<CausalOccurrences, number>[] = [new Map()];
    const selected: Occurrence[] = [];
    let depth = 0;
    while (depth >= 0) {
      if (depth === choices.length) {
        for (const item of selected) this.claimed.add(item);
        return { occurrences: [...selected], history: histories[depth] };
      }
      const item = choices[depth][positions[depth]++];
      if (!item) {
        positions[depth] = 0;
        selected.length = depth;
        depth--;
        continue;
      }
      const history = histories[depth];
      if (
        [...item.history].some(
          ([source, ordinal]) => history.has(source) && history.get(source) !== ordinal,
        )
      ) {
        continue;
      }
      histories[depth + 1] = new Map([...history, ...item.history]);
      selected[depth] = item;
      depth++;
    }
    return undefined;
  }

  finish(key: string, ordinal: number, selection: CausalSelection): void {
    const history = new Map(selection.history);
    history.set(this, ordinal);
    const pool = this.completed.get(key) ?? [];
    pool.push({ ordinal, history });
    pool.sort((left, right) => left.ordinal - right.ordinal);
    this.completed.set(key, pool);
  }

  release(selection: CausalSelection): void {
    for (const item of selection.occurrences) this.claimed.delete(item);
  }
}
