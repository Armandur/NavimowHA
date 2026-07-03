"""Local mower meters -> GPS via 2-point calibration (fork addition).

The mower reports positions in a local Cartesian grid (meters, origin at the
RTK/mapping reference, unknown rotation). Two reference points whose local
(x, y) AND lat/lon are both known determine a similarity transform (rotation
+ scale + translation, orientation-preserving): local -> ENU meter plane
around reference 1 -> lat/lon. The planar approximation is accurate to well
under a meter at yard scale.

Same math as the map card's image calibration, via complex arithmetic:
a = d_enu / d_local, b = -a * local1, so enu = a * local + b.
"""
from __future__ import annotations

import math

# Meters per degree of latitude (spherical approximation).
M_PER_DEG_LAT = 111_320.0


def solve_gps_calibration(
    ref1: tuple[float, float, float, float],
    ref2: tuple[float, float, float, float],
) -> dict[str, float] | None:
    """Solve the transform from two (x, y, lat, lon) reference points.

    Returns {ar, ai, br, bi, lat0, lon0, scale}, or None when the references
    are degenerate (coincident points). scale should be ~1.0 since both
    frames are in meters; a large deviation means bad reference data.
    """
    x1, y1, lat1, lon1 = ref1
    x2, y2, lat2, lon2 = ref2
    if not all(map(math.isfinite, ref1 + ref2)):
        return None
    m_per_deg_lon = M_PER_DEG_LAT * math.cos(math.radians(lat1))
    # ENU meters of ref2 relative to ref1
    e2 = (lon2 - lon1) * m_per_deg_lon
    n2 = (lat2 - lat1) * M_PER_DEG_LAT
    dx, dy = x2 - x1, y2 - y1
    den = dx * dx + dy * dy
    if den < 1e-9 or (e2 * e2 + n2 * n2) < 1e-9:
        return None
    # a = d_enu / d_local (complex division)
    ar = (e2 * dx + n2 * dy) / den
    ai = (n2 * dx - e2 * dy) / den
    # b = enu1 - a * local1, with enu origin at ref1
    br = -(ar * x1 - ai * y1)
    bi = -(ai * x1 + ar * y1)
    return {
        "ar": ar,
        "ai": ai,
        "br": br,
        "bi": bi,
        "lat0": lat1,
        "lon0": lon1,
        "scale": math.hypot(ar, ai),
    }


def local_to_gps(cal: dict[str, float], x: float, y: float) -> tuple[float, float]:
    """Transform local meters to (lat, lon) using a solved calibration."""
    # complex multiply: (ar + i*ai) * (x + i*y) + (br + i*bi)
    east = cal["ar"] * x - cal["ai"] * y + cal["br"]
    north = cal["ai"] * x + cal["ar"] * y + cal["bi"]
    lat = cal["lat0"] + north / M_PER_DEG_LAT
    lon = cal["lon0"] + east / (
        M_PER_DEG_LAT * math.cos(math.radians(cal["lat0"]))
    )
    return lat, lon
