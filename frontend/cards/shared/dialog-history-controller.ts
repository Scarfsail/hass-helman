import type { ReactiveController, ReactiveControllerHost } from "lit";

let nextHistoryEntryId = 0;

/** Each dialog owns one key, retaining the keys of dialogs underneath it. */
export class DialogHistoryController implements ReactiveController {
    private _entryId: number | null = null;
    private _ignoreNextPopstate = false;

    constructor(
        host: ReactiveControllerHost,
        private readonly _key: string,
        private readonly _options: { onBack?: () => boolean; close: () => void },
    ) {
        host.addController(this);
    }

    get active(): boolean {
        return this._entryId !== null;
    }

    hostConnected(): void {
        window.addEventListener("popstate", this._handlePopState);
    }

    hostDisconnected(): void {
        window.removeEventListener("popstate", this._handlePopState);
        this._entryId = null;
        this._ignoreNextPopstate = false;
    }

    push(): void {
        if (this.active) return;
        const state = window.history.state;
        const nextState = state !== null && typeof state === "object" ? { ...state } : {};
        this._entryId = ++nextHistoryEntryId;
        nextState[this._key] = this._entryId;
        window.history.pushState(nextState, "");
        this._ignoreNextPopstate = false;
    }

    closed(): void {
        const consume = this.active && this._isCurrent(window.history.state);
        this._entryId = null;
        if (consume) {
            this._ignoreNextPopstate = true;
            window.history.back();
        }
    }

    private _isCurrent(state: unknown): boolean {
        return state !== null && typeof state === "object"
            && (state as Record<string, unknown>)[this._key] === this._entryId;
    }

    private readonly _handlePopState = (event: PopStateEvent): void => {
        if (!this.active) return;
        if (this._ignoreNextPopstate) {
            this._ignoreNextPopstate = false;
            return;
        }
        if (this._isCurrent(event.state)) return;
        this._entryId = null;
        if (this._options.onBack?.()) {
            this.push();
        } else {
            this._options.close();
        }
    };
}
