/** A request owns its answer only until a newer key is started or reset. */
export class LatestRequest<K> {
    private _current: { key: K } | null = null;

    begin(key: K): { key: K } | null {
        if (this._current?.key === key) return null;
        return this._current = { key };
    }

    isCurrent(token: { key: K }): boolean {
        return this._current === token;
    }

    reset(): void {
        this._current = null;
    }
}
