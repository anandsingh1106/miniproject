"""Central configuration and the domain constants the scoring engine is built on.

Everything a civil engineer might want to re-tune lives here rather than being
scattered through the code.
"""
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
UPLOAD_DIR = DATA_DIR / "uploads"
MODEL_DIR = DATA_DIR / "models"
FRONTEND_DIR = ROOT / "frontend"
DB_PATH = DATA_DIR / "roadai.db"

for _d in (DATA_DIR, UPLOAD_DIR, MODEL_DIR):
    _d.mkdir(parents=True, exist_ok=True)

# Path checked for a trained detector. Drop a YOLO .pt here to switch engines.
YOLO_WEIGHTS = MODEL_DIR / "road_damage.pt"

MAX_UPLOAD_BYTES = 12 * 1024 * 1024
ALLOWED_MIME = {"image/jpeg", "image/png", "image/webp", "image/bmp"}


# --------------------------------------------------------------------------
# Damage taxonomy
# --------------------------------------------------------------------------
# Codes follow the RDD2022 / Japan Road Association convention used by the
# public Road Damage Detection benchmark, extended with three distress types
# that matter for reconstruction decisions but are absent from that label set.
#
#   structural_weight : how much this distress implies base/sub-base failure
#                       rather than a surface-only defect. Drives the treatment
#                       decision (seal vs. overlay vs. full reconstruction).
#   safety_weight     : immediate hazard to a road user (loss of control,
#                       tyre or rim damage, two-wheeler risk).
#   growth_rate       : relative speed at which the defect worsens per month
#                       if left untreated, under normal loading.
DAMAGE_TYPES = {
    "D00": {
        "name": "Longitudinal Crack",
        "short": "Long. crack",
        "structural_weight": 0.35,
        "safety_weight": 0.15,
        "growth_rate": 0.055,
        "description": "Crack parallel to the centreline, usually along a wheel path or a paving joint.",
    },
    "D10": {
        "name": "Transverse Crack",
        "short": "Trans. crack",
        "structural_weight": 0.40,
        "safety_weight": 0.20,
        "growth_rate": 0.050,
        "description": "Crack roughly perpendicular to the centreline, typically thermal or reflective.",
    },
    "D20": {
        "name": "Alligator Crack",
        "short": "Alligator",
        "structural_weight": 0.85,
        "safety_weight": 0.45,
        "growth_rate": 0.110,
        "description": "Interconnected fatigue cracking. A direct indicator that the base layer is failing.",
    },
    "D40": {
        "name": "Pothole",
        "short": "Pothole",
        "structural_weight": 0.80,
        "safety_weight": 1.00,
        "growth_rate": 0.150,
        "description": "Bowl-shaped cavity through the surface course. The dominant safety hazard.",
    },
    "D43": {
        "name": "Faded Crosswalk",
        "short": "Faded crosswalk",
        "structural_weight": 0.05,
        "safety_weight": 0.35,
        "growth_rate": 0.030,
        "description": "Worn thermoplastic marking. No structural meaning, but a real safety defect.",
    },
    "D44": {
        "name": "Faded Lane Line",
        "short": "Faded line",
        "structural_weight": 0.05,
        "safety_weight": 0.30,
        "growth_rate": 0.030,
        "description": "Worn lane demarcation, dangerous at night and in rain.",
    },
    "RAV": {
        "name": "Ravelling",
        "short": "Ravelling",
        "structural_weight": 0.45,
        "safety_weight": 0.35,
        "growth_rate": 0.070,
        "description": "Loss of aggregate from the surface course. Skid resistance drops and water gets in.",
    },
    "RUT": {
        "name": "Rutting",
        "short": "Rutting",
        "structural_weight": 0.75,
        "safety_weight": 0.60,
        "growth_rate": 0.080,
        "description": "Longitudinal depression in the wheel path. Holds water and causes aquaplaning.",
    },
    "EDG": {
        "name": "Edge Break",
        "short": "Edge break",
        "structural_weight": 0.50,
        "safety_weight": 0.40,
        "growth_rate": 0.075,
        "description": "Crumbling pavement edge, usually from poor shoulder support or drainage.",
    },
}

# Display order: most consequential distress first.
DAMAGE_ORDER = ["D40", "D20", "RUT", "EDG", "RAV", "D10", "D00", "D43", "D44"]

# --------------------------------------------------------------------------
# Road network classification
# --------------------------------------------------------------------------
#   importance  : network criticality, 0..1 (detour cost if this link fails)
#   design_life : years between planned major interventions
#   width_m     : assumed carriageway width for area and cost estimation
ROAD_CLASSES = {
    "NH": {"name": "National Highway", "importance": 1.00, "design_life": 15, "width_m": 14.0},
    "SH": {"name": "State Highway", "importance": 0.85, "design_life": 15, "width_m": 10.0},
    "URB": {"name": "Urban Arterial", "importance": 0.75, "design_life": 10, "width_m": 11.0},
    "MDR": {"name": "Major District Road", "importance": 0.65, "design_life": 12, "width_m": 7.0},
    "COL": {"name": "Urban Collector", "importance": 0.50, "design_life": 10, "width_m": 7.5},
    "LOC": {"name": "Local / Village Road", "importance": 0.30, "design_life": 8, "width_m": 5.5},
}

SURFACE_TYPES = {
    "BC": "Bituminous Concrete",
    "DBM": "Dense Bituminous Macadam",
    "SD": "Surface Dressing",
    "WBM": "Water Bound Macadam",
    "CC": "Cement Concrete",
}

# --------------------------------------------------------------------------
# Priority banding
# --------------------------------------------------------------------------
# (lower_bound_inclusive, code, label, response window, status token).
# Status tokens map to the reserved status palette in the UI.
PRIORITY_BANDS = [
    (75.0, "P1", "Critical", "Immediate — within 30 days", "critical"),
    (55.0, "P2", "High", "Within 90 days", "serious"),
    (35.0, "P3", "Medium", "Within the current financial year", "warning"),
    (0.0, "P4", "Routine", "Monitor at next inspection cycle", "good"),
]

# Weights of the five RPI components. Must sum to 1.0.
RPI_WEIGHTS = {
    "distress": 0.40,
    "traffic": 0.22,
    "network": 0.18,
    "safety": 0.12,
    "environment": 0.08,
}

# Traffic volume (AADT) treated as full exposure. The term saturates above this.
AADT_SATURATION = 40000.0

# --------------------------------------------------------------------------
# Unit costs (INR per square metre of carriageway), typical 2024-25 schedule
# of rates. Swap for the local SoR and nothing else needs to change.
# --------------------------------------------------------------------------
TREATMENTS = {
    "monitor": {
        "name": "Routine Monitoring",
        "rate_per_sqm": 0.0,
        "life_years": 0,
        "description": "No intervention warranted. Re-inspect at the next cycle.",
    },
    "crack_seal": {
        "name": "Crack Sealing",
        "rate_per_sqm": 95.0,
        "life_years": 3,
        "description": "Route and seal working cracks to keep water out of the base.",
    },
    "patch": {
        "name": "Pothole Patching",
        "rate_per_sqm": 420.0,
        "life_years": 2,
        "description": "Full-depth cut, tack and hot-mix patch of individual potholes.",
    },
    "micro": {
        "name": "Micro-surfacing",
        "rate_per_sqm": 340.0,
        "life_years": 6,
        "description": "Thin polymer-modified surface to restore texture and seal the wearing course.",
    },
    "overlay": {
        "name": "Mill and Overlay",
        "rate_per_sqm": 980.0,
        "life_years": 10,
        "description": "Mill 40 mm and relay bituminous concrete. Restores the surface course only.",
    },
    "reconstruct": {
        "name": "Full-depth Reconstruction",
        "rate_per_sqm": 2650.0,
        "life_years": 15,
        "description": "Rebuild base and sub-base. The only fix when the failure is structural.",
    },
}

CURRENCY = "INR"
