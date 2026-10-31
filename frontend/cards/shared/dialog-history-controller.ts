import type { ReactiveController, ReactiveControllerHost } from "lit";

let nextHistoryEntryId = 0;
const activeControllers = new Set<DialogHistoryController>();

/** Each dialog owns one key, retaining the keys of dialogs underneath it. */
export class DialogHistoryController implements ReactiveController {
    private _entryIds: number[] = [];
    private _ignoreNextPopstate = false;

    constructor(
        host: ReactiveControllerHost,
        private readonly _key: string,
        private readonly _options: {
            onBack?: () => boolean;
            onReturn?: (index: number) => void;
            close: () => void;
        },
    ) {
        host.addController(this);
    }

    get active(): boolean {
        return this._entryIds.length > 0;
    }

    hostConnected(): void {
        activeControllers.add(this);
        window.addEventListener("popstate", this._handlePopState);
    }

    hostDisconnected(): void {
        activeControllers.delete(this);
        window.removeEventListener("popstate", this._handlePopState);
        this._entryIds = [];
        this._ignoreNextPopstate = false;
    }

    push(): void {
        if (this.active) return;
        const state = window.history.state;
        const nextState = state !== null && typeof state === "object" ? { ...state } : {};
        const id = ++nextHistoryEntryId;
        this._entryIds = [id];
        nextState[this._key] = id;
        window.history.pushState(nextState, "");
        this._ignoreNextPopstate = false;
    }

    advance(): void {
        if (!this.active) return;
        const state = window.history.state;
        const nextState = state !== null && typeof state === "object" ? { ...state } : {};
        const id = ++nextHistoryEntryId;
        this._entryIds.push(id);
        nextState[this._key] = id;
        window.history.pushState(nextState, "");
        this._ignoreNextPopstate = false;
    }

    /** Whether it stepped Back off the dialog's entry: that `popstate` lands later. */
    closed(): boolean {
        const i = this._indexOf(window.history.state);
        const consume = this.active && i >= 0;
        this._entryIds = [];
        if (consume) {
            this._ignoreNextPopstate = true;
            window.history.go(-(i + 1));
        }
        return consume;
    }

    async release(): Promise<void> {
        const i = this._indexOf(window.history.state);
        const consume = this.active && i >= 0;
        this._entryIds = [];
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
            window.history.go(-(i + 1));
        });
        window.history.replaceState(retainedState, "");
    }

    private _stateId(state: unknown): number | null {
        if (state === null || typeof state !== "object") return null;
        const val = (state as Record<string, unknown>)[this._key];
        return typeof val === "number" ? val : null;
    }

    private _indexOf(state: unknown): number {
        const id = this._stateId(state);
        return id !== null ? this._entryIds.indexOf(id) : -1;
    }

    private readonly _handlePopState = (event: PopStateEvent): void => {
        if (!this.active) return;
        if (this._ignoreNextPopstate) {
            this._ignoreNextPopstate = false;
            return;
        }
        const stateId = this._stateId(event.state);
        if (stateId !== null) {
            const i = this._entryIds.indexOf(stateId);
            if (i === this._entryIds.length - 1) {
                return;
            }
            if (i >= 0) {
                this._entryIds.length = i + 1;
                if (this._options.onBack?.()) {
                    this.advance();
                } else {
                    this._options.onReturn?.(i);
                }
                return;
            }
            this._ignoreNextPopstate = true;
            window.history.back();
            return;
        }
        this._entryIds = [];
        if (this._options.onBack?.()) {
            this.push();
        } else {
            this._options.close();
        }
    };
}
