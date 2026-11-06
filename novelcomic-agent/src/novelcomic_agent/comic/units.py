"""Frame clock and the single RMB-to-fen conversion."""

from __future__ import annotations

import math
from decimal import ROUND_HALF_UP, Decimal

FPS = 30
MIN_PROJECT_FRAMES = 5 * FPS
FEN_QUANTUM = Decimal("0.01")


def rmb_to_fen(amount: Decimal) -> int:
    """Convert a product RMB amount to integer fen once, at the ledger boundary."""

    if not isinstance(amount, Decimal) or not amount.is_finite() or amount < 0:
        raise ValueError("RMB amount must be a non-negative finite Decimal")
    quantized = amount.quantize(FEN_QUANTUM, rounding=ROUND_HALF_UP)
    return int(quantized * 100)


def fen_to_rmb(amount_fen: int) -> Decimal:
    """Format ledger fen for display. This does not write a second amount."""

    if not isinstance(amount_fen, int) or isinstance(amount_fen, bool) or amount_fen < 0:
        raise ValueError("fen amount must be a non-negative integer")
    return (Decimal(amount_fen) / Decimal(100)).quantize(FEN_QUANTUM)


def frames_from_ms(duration_ms: int) -> int:
    """Ceil provider milliseconds onto the 30fps frame clock."""

    if not isinstance(duration_ms, int) or isinstance(duration_ms, bool) or duration_ms < 0:
        raise ValueError("duration_ms must be a non-negative integer")
    return math.ceil(duration_ms * FPS / 1000)


def absolute_from_frame(shot_from: int, relative_from: int) -> int:
    """Place a shot-relative dialogue frame on the committed project timeline."""

    if (
        not isinstance(shot_from, int)
        or isinstance(shot_from, bool)
        or shot_from < 0
        or not isinstance(relative_from, int)
        or isinstance(relative_from, bool)
        or relative_from < 0
    ):
        raise ValueError("frame positions must be non-negative integers")
    return shot_from + relative_from
