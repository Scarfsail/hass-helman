export function describeError(error: unknown): string {
    if (typeof error === "object" && error !== null && "message" in error) {
        return String((error as { message: unknown }).message);
    }
    return String(error);
}
