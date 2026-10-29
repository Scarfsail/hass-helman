import type { ReactiveController, ReactiveControllerHost } from "lit";

let nextHistoryEntryId = 0;
const activeControllers = new Set<DialogHistoryController>();

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
        activeControllers.add(this);
        window.addEventListener("popstate", this._handlePopState);
    }

    hostDisconnected(): void {
        activeControllers.delete(this);
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

    /** Whether it stepped Back off the dialog's entry: that `popstate` lands later. */
    closed(): boolean {
        const consume = this.active && this._isCurrent(window.history.state);
        this._entryId = null;
        if (consume) {
            this._ignoreNextPopstate = true;
            window.history.back();
        }
        return consume;
    }

    async release(): Promise<void> {
        const consume = this.active && this._isCurrent(window.history.state);
        this._entryId = null;
        if (!consume) return;
        const retainedState = { ...(window.history.state as Record<string, unknown>) };
        delete retainedState[this._key];
        for (const controller of activeControllers) {
            if (controller !== this && controller.active) {
                controller._ignoreNextPopstate = true;
            }
        }
        await new Promise<void>((resolve) => {
            window.addEventListener("popstate", () => resolve(), { once: true });
            window.history.back();
        });
        window.history.replaceState(retainedState, "");
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
