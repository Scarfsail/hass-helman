/**
 * Remember a pure function's last answer.
 *
 * The arguments are the key, compared one by one by identity -- the "Card
 * rendering discipline" rule in `../README.md` -- so every argument must itself
 * be identity-stable, and the function must read nothing but its arguments.
 */
export function memoOne<A extends readonly unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  let last: { args: A; result: R } | null = null;
  return (...args: A): R => {
    if (last === null || args.some((arg, index) => arg !== last!.args[index])) {
      last = { args, result: fn(...args) };
    }
    return last.result;
  };
}
