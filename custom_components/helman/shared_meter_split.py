"""How a meter's own power is shared among the devices drawing from it.

A metered parent's meterless children have no meter of their own, only a
running signal, so their power is a share of the parent's *own* power. The
share follows each child's learned power: :func:`fit_member_weights` learns it
from history, and :func:`split_own_power` hands out own power in its ratio.
The live share sensors and the training estimate both call the split with the
same stored weights, so a child's forecast figure means what its live share
means.

Pure and Home Assistant free: the coordinator's live path uses it as much as
training does.
"""

from __future__ import annotations

from collections.abc import Collection, Iterable, Mapping, Sequence

#: The ridge term, relative to the trace of the normal equations. Small enough
#: not to bias a well-determined fit; large enough that members which always
#: run together get equal weights, and near-identical ones stable weights.
_RIDGE = 1e-6


def fit_member_weights(
    segments: Iterable[tuple[Collection[str], float, float]],
    *,
    min_running_hours: float = 1.0,
) -> dict[str, float | None]:
    """Each member's learned power in kW, from segments of one meter's history.

    Each segment is ``(running ids, duration_h, own_kwh)``: a stretch with a
    constant set of running members, and the own energy the meter measured over
    it. Segments where nobody runs, the window's edges included, set the
    baseline: the duration-weighted mean power then, or 0 without such time.
    It only keeps standby out of the weights and is not returned.

    Every other segment asks ``own_kwh / duration_h - baseline`` to be the sum
    of its running members' powers, weighted by its duration. That is a
    non-negative least-squares fit, solved on the accumulated normal equations
    with a small ridge term. A member that ran less than ``min_running_hours``
    stays in the fit, so its energy is not pushed onto its siblings, but its
    answer is ``None``: too little history to say.
    """
    segments = list(segments)
    idle_hours = sum(hours for running, hours, _ in segments if not running)
    idle_kwh = sum(kwh for running, _, kwh in segments if not running)
    baseline_kw = idle_kwh / idle_hours if idle_hours > 0 else 0.0

    ids = sorted({member for running, _, _ in segments for member in running})
    index = {member: position for position, member in enumerate(ids)}
    gram = [[0.0] * len(ids) for _ in ids]
    rhs = [0.0] * len(ids)
    for running, hours, kwh in segments:
        if not running or hours <= 0:
            continue
        target_kw = kwh / hours - baseline_kw
        columns = {index[member] for member in running}
        for row in columns:
            rhs[row] += hours * target_kw
            for column in columns:
                gram[row][column] += hours

    # Before the ridge, the diagonal is each member's running hours.
    running_hours = [gram[row][row] for row in range(len(ids))]
    ridge = _RIDGE * sum(running_hours)
    for row in range(len(ids)):
        gram[row][row] += ridge

    powers = _non_negative_least_squares(gram, rhs)
    return {
        member: powers[index[member]]
        if running_hours[index[member]] >= min_running_hours
        else None
        for member in ids
    }


def split_own_power(
    own_w: float,
    running: Sequence[str],
    weights_kw: Mapping[str, float | None],
    *,
    tolerance: float | None,
) -> dict[str, float]:
    """``own_w`` shared among the ``running`` members, in W, by their weights.

    A member without a learned weight takes the mean of the running members
    that have one, or 1 when none does, so the all-unknown case is the even
    split. With ``tolerance`` ``None`` all of ``own_w`` is handed out, in the
    ratio of the weights. Otherwise each member with a learned weight is capped
    at that power plus ``tolerance`` (a fraction; weights are kW, ``own_w`` is
    W), and a member without one is never capped. The caps scale with the
    weights, so every capped member reaches its cap at the same point and
    there is nothing to redistribute: the excess is simply not handed out.
    """
    if not running:
        return {}
    learned = {
        member: weight
        for member in running
        if (weight := weights_kw.get(member)) is not None
    }
    fallback = sum(learned.values()) / len(learned) if learned else 1.0
    weights = {member: learned.get(member, fallback) for member in running}
    total = sum(weights.values())
    shares = {
        # Every running member learned 0 kW: nothing to weigh by, so the even
        # split, as before any weight existed.
        member: own_w * weight / total if total > 0 else own_w / len(running)
        for member, weight in weights.items()
    }
    if tolerance is None:
        return shares
    return {
        member: min(share, learned[member] * 1000 * (1 + tolerance))
        if member in learned
        else share
        for member, share in shares.items()
    }


def _non_negative_least_squares(
    gram: list[list[float]], rhs: list[float]
) -> list[float]:
    """Minimise ``x·G·x/2 - b·x`` subject to ``x >= 0``, for a positive definite ``G``.

    Lawson and Hanson's active-set method on the normal equations. Coordinate
    descent would reach the same unique minimum in theory, but on members that
    always run together it creeps towards it by the ridge's factor per sweep,
    so it would stop far from equal weights. The active set solves each
    candidate set exactly instead, which with a handful of unknowns is a few
    small eliminations.
    """
    size = len(rhs)
    solution = [0.0] * size
    passive: set[int] = set()
    tolerance = 1e-12 * max((abs(value) for value in rhs), default=0.0)
    # Each pass adds one member; the cap only guards against float noise
    # re-adding one the inner loop just dropped.
    for _ in range(3 * size + 1):
        gradient = [
            rhs[row] - sum(gram[row][column] * solution[column] for column in range(size))
            for row in range(size)
        ]
        candidates = [
            row for row in range(size) if row not in passive and gradient[row] > tolerance
        ]
        if not candidates:
            break
        passive.add(max(candidates, key=gradient.__getitem__))
        while True:
            trial = _solve_on(gram, rhs, passive)
            if all(trial[row] > 0 for row in passive):
                break
            # Step from the current solution towards the trial as far as stays
            # feasible, then drop whichever members that step zeroes.
            step = min(
                solution[row] / (solution[row] - trial[row])
                if solution[row] > trial[row]
                else 0.0
                for row in passive
                if trial[row] <= 0
            )
            solution = [
                value + step * (trial[row] - value) for row, value in enumerate(solution)
            ]
            passive = {row for row in passive if solution[row] > 0}
            if not passive:
                trial = [0.0] * size
                break
        solution = trial
    return solution


def _solve_on(
    gram: list[list[float]], rhs: list[float], rows: set[int]
) -> list[float]:
    """``G·x = b`` restricted to ``rows``, zero elsewhere, by Gaussian elimination.

    ``G`` is positive definite (the ridge sees to that), so every pivot is
    positive and no pivoting is needed.
    """
    order = sorted(rows)
    matrix = [[gram[row][column] for column in order] + [rhs[row]] for row in order]
    size = len(order)
    for pivot in range(size):
        for below in range(pivot + 1, size):
            factor = matrix[below][pivot] / matrix[pivot][pivot]
            for column in range(pivot, size + 1):
                matrix[below][column] -= factor * matrix[pivot][column]
    values = [0.0] * size
    for pivot in reversed(range(size)):
        values[pivot] = (
            matrix[pivot][size]
            - sum(matrix[pivot][column] * values[column] for column in range(pivot + 1, size))
        ) / matrix[pivot][pivot]
    result = [0.0] * len(rhs)
    for position, row in enumerate(order):
        result[row] = values[position]
    return result
