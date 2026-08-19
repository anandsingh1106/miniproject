"""Tests for treatment selection, costing and budget allocation.

The treatment ladder encodes real pavement-engineering rules, and two of them
were wrong in the first implementation. Both are pinned here, because both are
the kind of mistake that looks entirely reasonable in code review and produces
a wildly wrong number in a budget document.
"""
from __future__ import annotations

import pytest

from backend import config
from backend.costing import allocate_budget, estimate_cost, recommend_treatment
from backend.priority import SegmentContext


def det(code, severity="high", area=0.05, conf=0.9):
    return {"code": code, "severity": severity, "area_ratio": area, "confidence": conf}


CTX = SegmentContext(road_class="URB", aadt=15000, length_m=1000)


# ======================================================================
# Treatment selection
# ======================================================================
class TestTreatmentLadder:
    def test_sound_pavement_is_left_alone(self):
        assert recommend_treatment(96.0, [], CTX)[0] == "monitor"

    def test_isolated_cracking_gets_sealed(self):
        assert recommend_treatment(88.0, [det("D00", "low", 0.004)], CTX)[0] == "crack_seal"

    def test_failed_base_gets_reconstruction(self):
        code, why = recommend_treatment(32.0, [det("D20"), det("RUT")], CTX)
        assert code == "reconstruct"
        assert "base" in why.lower()

    def test_widespread_fatigue_forces_reconstruction_even_at_fair_pci(self):
        """Surface treatments cannot fix a structural failure — an overlay over
        a failed base reflects the same cracking back through in one season."""
        dets = [det("D20", "high", 0.05) for _ in range(4)]
        assert recommend_treatment(62.0, dets, CTX)[0] == "reconstruct"

    def test_early_fatigue_is_not_merely_sealed(self):
        """Alligator cracking, however light, means fatigue has begun. Sealing
        it treats the symptom and leaves the cause."""
        code, _ = recommend_treatment(70.0, [det("D20", "medium", 0.02),
                                             det("D00", "medium", 0.02)], CTX)
        assert code in ("micro", "overlay", "reconstruct")
        assert code != "crack_seal"

    def test_discrete_potholes_are_patched_not_milled(self):
        """The expensive mistake: a condition index dragged down by three
        potholes triggering a mill-and-overlay of the entire segment."""
        dets = [det("D40", "high", 0.05) for _ in range(3)]
        assert recommend_treatment(50.0, dets, CTX)[0] == "patch"

    def test_potholes_with_structural_cracking_are_not_just_patched(self):
        dets = [det("D40", "high", 0.05), det("D20", "high", 0.06)]
        assert recommend_treatment(50.0, dets, CTX)[0] in ("overlay", "reconstruct")

    def test_every_recommendation_is_a_known_treatment(self):
        for pci in (0, 25, 42, 55, 65, 78, 92, 100):
            for dets in ([], [det("D00")], [det("D40")], [det("D20"), det("RUT")]):
                code, why = recommend_treatment(pci, dets, CTX)
                assert code in config.TREATMENTS
                assert why.strip()


# ======================================================================
# Costing
# ======================================================================
class TestCosting:
    def test_monitoring_is_free(self):
        assert estimate_cost("monitor", CTX, [], 95.0).total_cost == 0.0

    def test_reconstruction_prices_the_whole_carriageway(self):
        est = estimate_cost("reconstruct", CTX, [det("D20")], 30.0)
        width = config.ROAD_CLASSES["URB"]["width_m"]
        assert est.area_sqm == pytest.approx(CTX.length_m * width)

    def test_localised_repairs_price_only_the_affected_area(self):
        """Pricing a pothole repair as if it covered the full carriageway
        overstates it by two orders of magnitude and wrecks the allocation."""
        patch = estimate_cost("patch", CTX, [det("D40", area=0.02)], 55.0)
        overlay = estimate_cost("overlay", CTX, [det("D40", area=0.02)], 55.0)
        assert patch.area_sqm < overlay.area_sqm / 5
        assert patch.total_cost < overlay.total_cost

    def test_localised_cost_has_a_floor(self):
        """A real defect must never be costed at zero."""
        est = estimate_cost("patch", CTX, [], 60.0)
        assert est.total_cost > 0

    def test_busier_roads_cost_more_in_traffic_management(self):
        quiet = estimate_cost("overlay", SegmentContext(aadt=2000, length_m=1000), [], 50.0)
        busy = estimate_cost("overlay", SegmentContext(aadt=40000, length_m=1000), [], 50.0)
        assert busy.total_cost > quiet.total_cost

    def test_cost_per_year_reflects_design_life(self):
        est = estimate_cost("reconstruct", CTX, [], 30.0)
        assert est.cost_per_year == pytest.approx(est.total_cost / est.life_years)

    def test_reconstruction_costs_more_per_sqm_than_sealing(self):
        assert (config.TREATMENTS["reconstruct"]["rate_per_sqm"]
                > config.TREATMENTS["crack_seal"]["rate_per_sqm"] * 10)


# ======================================================================
# Budget allocation
# ======================================================================
def seg(id_, rpi, cost, life=10, band="P3"):
    return {"id": id_, "rpi": rpi, "total_cost": cost,
            "life_years": life, "band_code": band}


class TestBudget:
    def test_empty_network_is_handled(self):
        plan = allocate_budget([], 1_000_000)
        assert plan["funded_count"] == 0
        assert plan["shortfall"] == 0

    def test_never_overspends(self):
        rows = [seg(f"s{i}", 60, 1_000_000) for i in range(20)]
        plan = allocate_budget(rows, 5_500_000)
        assert plan["allocated"] <= 5_500_000

    def test_ample_budget_funds_everything(self):
        rows = [seg(f"s{i}", 60, 1_000_000) for i in range(5)]
        plan = allocate_budget(rows, 100_000_000)
        assert plan["deferred_count"] == 0
        assert plan["shortfall"] == 0
        assert plan["coverage_pct"] == pytest.approx(100.0)

    def test_critical_work_is_funded_before_better_value_work(self):
        """A hazard is not something a cost-benefit ratio gets to veto."""
        rows = [
            seg("hazard", 80, 4_000_000, life=10, band="P1"),
            *[seg(f"cheap{i}", 40, 100_000, life=10, band="P3") for i in range(30)],
        ]
        plan = allocate_budget(rows, 4_200_000)
        assert "hazard" in plan["funded_ids"]

    def test_cheap_preventive_work_beats_expensive_work_on_value(self):
        """Ranking by RPI alone spends everything on one reconstruction. The
        allocator must prefer many cheap, long-lived repairs."""
        rows = [
            seg("big", 70, 10_000_000, life=15, band="P2"),
            *[seg(f"seal{i}", 45, 200_000, life=6, band="P3") for i in range(20)],
        ]
        plan = allocate_budget(rows, 4_000_000)
        assert "big" not in plan["funded_ids"]
        assert plan["funded_count"] >= 15

    def test_zero_cost_segments_are_excluded(self):
        rows = [seg("none", 20, 0), seg("real", 60, 500_000)]
        plan = allocate_budget(rows, 10_000_000)
        assert "none" not in plan["funded_ids"]
        assert "none" not in plan["deferred_ids"]

    def test_funded_and_deferred_partition_the_network(self):
        rows = [seg(f"s{i}", 50 + i, 1_000_000) for i in range(10)]
        plan = allocate_budget(rows, 4_000_000)
        assert plan["funded_count"] + plan["deferred_count"] == 10
        assert not set(plan["funded_ids"]) & set(plan["deferred_ids"])

    def test_unfunded_critical_is_reported(self):
        # Four P1 jobs at 10M each; a 25M budget covers exactly two of them.
        rows = [seg(f"c{i}", 90, 10_000_000, band="P1") for i in range(4)]
        plan = allocate_budget(rows, 25_000_000)
        assert plan["funded_count"] == 2
        assert plan["unfunded_critical"] == 2
        # 40M of work against a 25M budget: 15M more is needed to clear it.
        # The deferred work itself costs 20M — the 5M gap is budget left
        # unspent because no remaining job fits in it.
        assert plan["shortfall"] == pytest.approx(15_000_000)
        assert plan["deferred_cost"] == pytest.approx(20_000_000)

    def test_more_budget_never_funds_less(self):
        rows = [seg(f"s{i}", 40 + i * 2, 400_000 * (i + 1)) for i in range(15)]
        prev = -1
        for budget in (1_000_000, 3_000_000, 8_000_000, 40_000_000):
            n = allocate_budget(rows, budget)["funded_count"]
            assert n >= prev
            prev = n
