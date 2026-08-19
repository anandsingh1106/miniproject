"""Tests for the Reconstruction Priority Index.

The scoring engine is the part of this system that a road authority would act
on, and it is pure functions over plain data — which makes it both the most
consequential thing to get right and the easiest thing to test properly.

These assert *behaviour an engineer would recognise*, not implementation
details: that a busy road outranks a quiet one with identical damage, that a
hazard cannot be averaged away, that the score is monotonic in damage. A test
that just pins the current number to four decimal places would pass forever and
catch nothing.
"""
from __future__ import annotations

import pytest

from backend import config
from backend.priority import (
    SegmentContext,
    compute_rpi,
    distress_component,
    environment_component,
    growth_multiplier,
    network_component,
    pci_label,
    safety_component,
    traffic_component,
)


# ----------------------------------------------------------------------
# Helpers
# ----------------------------------------------------------------------
def det(code="D40", severity="high", area=0.05, conf=0.9):
    return {"code": code, "severity": severity, "area_ratio": area, "confidence": conf}


QUIET_LANE = dict(road_class="LOC", aadt=800, commercial_pct=5, length_m=500,
                  last_resurfaced_years=3, drainage_quality="good",
                  monsoon_exposure="low")
BUSY_HIGHWAY = dict(road_class="NH", aadt=38000, commercial_pct=32, length_m=500,
                    last_resurfaced_years=3, drainage_quality="good",
                    monsoon_exposure="low")


# ======================================================================
# Weights and configuration
# ======================================================================
def test_component_weights_sum_to_one():
    """If these drift the score silently stops being a 0-100 scale."""
    assert sum(config.RPI_WEIGHTS.values()) == pytest.approx(1.0)


def test_priority_bands_are_ordered_and_cover_the_range():
    lows = [b[0] for b in config.PRIORITY_BANDS]
    assert lows == sorted(lows, reverse=True), "bands must descend"
    assert lows[-1] == 0.0, "the lowest band must catch every remaining score"


def test_every_damage_type_has_a_display_slot():
    assert set(config.DAMAGE_ORDER) == set(config.DAMAGE_TYPES)


# ======================================================================
# Component behaviour
# ======================================================================
class TestDistress:
    def test_no_damage_is_a_perfect_pavement(self):
        score, pci, density, dominant, _ = distress_component([])
        assert score == 0.0
        assert pci == 100.0
        assert density == 0.0
        assert dominant is None

    def test_more_damage_never_lowers_the_score(self):
        prev = -1.0
        for n in range(0, 6):
            score, *_ = distress_component([det() for _ in range(n)])
            assert score >= prev
            prev = score

    def test_score_stays_bounded_on_absurd_input(self):
        """Degenerate input must clamp rather than run off the scale."""
        score, pci, *_ = distress_component([det(area=0.9) for _ in range(50)])
        assert 0.0 <= score <= 1.0
        assert 0.0 <= pci <= 100.0

    def test_realistic_damage_does_not_saturate(self):
        """The property that actually matters: across the range of conditions a
        real survey produces, the curve must still discriminate. If a merely bad
        road already pins the scale, every worse road looks identical to it and
        the ranking stops working exactly where it is needed most."""
        bad, bad_pci, *_ = distress_component(
            [det("D20", "high", 0.06), det("D40", "high", 0.05),
             det("RUT", "medium", 0.04)])
        worse, worse_pci, *_ = distress_component(
            [det("D20", "high", 0.09) for _ in range(4)]
            + [det("D40", "high", 0.07) for _ in range(3)])
        assert bad < worse < 1.0
        assert worse_pci < bad_pci
        assert worse - bad > 0.02, "worse conditions must remain distinguishable"

    def test_structural_damage_outweighs_cosmetic(self):
        alligator, *_ = distress_component([det("D20", area=0.04)])
        faded, *_ = distress_component([det("D43", area=0.04)])
        assert alligator > faded * 3

    def test_area_contributes_sublinearly(self):
        """Square-rooted area: the second square metre of cracking says much
        less than the first, so doubling area must add less than double."""
        one, *_ = distress_component([det(area=0.02)])
        four, *_ = distress_component([det(area=0.08)])
        assert four < one * 4

    def test_low_confidence_detections_count_for_less(self):
        sure, *_ = distress_component([det(conf=0.95)])
        unsure, *_ = distress_component([det(conf=0.30)])
        assert unsure < sure

    def test_pavement_fraction_normalises_density(self):
        """Half the frame being sky must not halve the apparent damage."""
        full, *_ = distress_component([det()], pavement_fraction=1.0)
        half, *_ = distress_component([det()], pavement_fraction=0.5)
        assert half > full

    def test_dominant_damage_is_the_biggest_contributor(self):
        _, _, _, dominant, _ = distress_component(
            [det("D00", "low", 0.005), det("D20", "high", 0.09)])
        assert dominant == "D20"

    def test_unknown_codes_are_ignored_not_crashed_on(self):
        score, *_ = distress_component([{"code": "NOPE", "severity": "high",
                                         "area_ratio": 0.5, "confidence": 1.0}])
        assert score == 0.0


class TestTraffic:
    def test_rises_with_volume(self):
        quiet = traffic_component(SegmentContext(aadt=500))
        busy = traffic_component(SegmentContext(aadt=40000))
        assert busy > quiet

    def test_growth_is_sublinear(self):
        """Log curve: the jump from 500 to 5,000 must matter more than
        30,000 to 35,000."""
        low_step = (traffic_component(SegmentContext(aadt=5000))
                    - traffic_component(SegmentContext(aadt=500)))
        high_step = (traffic_component(SegmentContext(aadt=35000))
                     - traffic_component(SegmentContext(aadt=30000)))
        assert low_step > high_step

    def test_heavy_vehicles_raise_exposure(self):
        cars = traffic_component(SegmentContext(aadt=10000, commercial_pct=2))
        trucks = traffic_component(SegmentContext(aadt=10000, commercial_pct=40))
        assert trucks > cars

    @pytest.mark.parametrize("aadt", [0, 1, 10_000, 500_000])
    def test_stays_normalised(self, aadt):
        assert 0.0 <= traffic_component(SegmentContext(aadt=aadt)) <= 1.0


class TestNetwork:
    def test_highway_outranks_village_road(self):
        assert (network_component(SegmentContext(road_class="NH"))
                > network_component(SegmentContext(road_class="LOC")))

    def test_emergency_route_raises_criticality(self):
        plain = network_component(SegmentContext(road_class="MDR"))
        emergency = network_component(SegmentContext(road_class="MDR",
                                                     is_emergency_route=True))
        assert emergency > plain

    def test_unknown_class_falls_back_without_crashing(self):
        assert 0.0 <= network_component(SegmentContext(road_class="???")) <= 1.0


class TestSafety:
    def test_potholes_are_more_hazardous_than_faded_paint(self):
        ctx = SegmentContext()
        assert (safety_component([det("D40")], ctx)
                > safety_component([det("D44")], ctx))

    def test_crash_history_is_normalised_per_km(self):
        """Ten crashes on 200 m is far worse than ten on 5 km. Without the
        normalisation, long segments are flattered by their own length."""
        short = safety_component([], SegmentContext(accidents_3yr=10, length_m=200))
        long = safety_component([], SegmentContext(accidents_3yr=10, length_m=5000))
        assert short > long

    def test_complaints_raise_the_score(self):
        assert (safety_component([], SegmentContext(public_reports=60))
                > safety_component([], SegmentContext(public_reports=0)))


class TestEnvironment:
    def test_poor_drainage_and_monsoon_raise_risk(self):
        dry = environment_component(SegmentContext(drainage_quality="good",
                                                   monsoon_exposure="low"))
        wet = environment_component(SegmentContext(drainage_quality="poor",
                                                   monsoon_exposure="high"))
        assert wet > dry

    def test_ageing_past_design_life_raises_risk(self):
        new = environment_component(SegmentContext(road_class="NH",
                                                   last_resurfaced_years=1))
        old = environment_component(SegmentContext(road_class="NH",
                                                   last_resurfaced_years=20))
        assert old > new


class TestGrowth:
    def test_no_damage_means_no_escalation(self):
        mult, note = growth_multiplier([], SegmentContext())
        assert mult == 1.0
        assert note is None

    def test_fast_growing_distress_escalates_more(self):
        pothole, _ = growth_multiplier([det("D40")], SegmentContext())
        crack, _ = growth_multiplier([det("D00")], SegmentContext())
        assert pothole > crack

    def test_measured_deterioration_overrides_the_model(self):
        """An observed rate of change beats an assumed one — and says so."""
        ctx = SegmentContext(prev_distress_score=0.05, days_since_prev=180)
        mult, note = growth_multiplier([det(area=0.4)], ctx)
        assert mult > 1.0
        assert note and "measured" in note.lower()

    def test_improving_condition_is_not_escalated(self):
        ctx = SegmentContext(prev_distress_score=0.9, days_since_prev=180)
        mult, note = growth_multiplier([det("D00", "low", 0.001)], ctx)
        assert mult <= 1.05
        assert note and "improved" in note.lower()

    def test_multiplier_is_capped(self):
        """A modelling assumption must never outvote observed condition."""
        ctx = SegmentContext(prev_distress_score=0.0, days_since_prev=1)
        mult, _ = growth_multiplier([det(area=0.99) for _ in range(20)], ctx)
        assert mult <= 1.35


# ======================================================================
# The composed score
# ======================================================================
class TestRPI:
    def test_pristine_quiet_road_is_routine(self):
        r = compute_rpi([], SegmentContext(**QUIET_LANE))
        assert r.band_code == "P4"
        assert r.pci == 100.0

    def test_identical_damage_ranks_higher_on_the_busier_road(self):
        """The whole reason this tool exists: damage alone does not decide
        priority. Same defects, different road, different answer."""
        dets = [det("D20", "medium", 0.03), det("D00", "low", 0.01)]
        quiet = compute_rpi(dets, SegmentContext(**QUIET_LANE))
        busy = compute_rpi(dets, SegmentContext(**BUSY_HIGHWAY))
        assert busy.rpi > quiet.rpi
        assert busy.pci == pytest.approx(quiet.pci), "condition must not depend on traffic"

    def test_score_is_monotonic_in_damage(self):
        ctx = SegmentContext(**BUSY_HIGHWAY)
        prev = -1.0
        for n in range(0, 5):
            r = compute_rpi([det("D20", "medium", 0.02) for _ in range(n)], ctx)
            assert r.rpi >= prev
            prev = r.rpi

    @pytest.mark.parametrize("aadt", [0, 100, 20_000, 100_000])
    @pytest.mark.parametrize("n", [0, 1, 12])
    def test_always_within_range(self, aadt, n):
        r = compute_rpi([det(area=0.3) for _ in range(n)],
                        SegmentContext(aadt=aadt, road_class="NH",
                                       drainage_quality="poor",
                                       monsoon_exposure="high",
                                       is_emergency_route=True))
        assert 0.0 <= r.rpi <= 100.0
        assert 0.0 <= r.pci <= 100.0

    def test_band_matches_the_score(self):
        for n in range(0, 10):
            r = compute_rpi([det("D20", "medium", 0.02) for _ in range(n)],
                            SegmentContext(**BUSY_HIGHWAY))
            expected = next(b for b in config.PRIORITY_BANDS if r.rpi >= b[0])
            assert r.band_code == expected[1]

    def test_weighted_components_reconstruct_the_base_score(self):
        r = compute_rpi([det("D20", "medium", 0.03)], SegmentContext(**BUSY_HIGHWAY))
        base = sum(r.weighted.values())
        # Overrides can floor the score above the arithmetic; ignore that case.
        if not r.overrides:
            assert r.rpi == pytest.approx(100 * base * r.growth_multiplier, abs=1e-6)

    def test_every_score_explains_itself(self):
        r = compute_rpi([det("D40")], SegmentContext(**BUSY_HIGHWAY))
        assert r.rationale, "a score an engineer cannot interrogate will not be acted on"
        assert any("P1" in line or "P2" in line for line in r.rationale)


class TestOverrides:
    def test_hazard_on_a_busy_road_cannot_be_averaged_away(self):
        """A single severe pothole on a major artery is an immediate risk. A
        weighted mean will happily dilute it; the override exists to stop that."""
        ctx = SegmentContext(road_class="NH", aadt=30000, commercial_pct=10,
                             last_resurfaced_years=1, drainage_quality="good",
                             monsoon_exposure="low")
        r = compute_rpi([det("D40", "high", 0.06)], ctx)
        assert r.band_code == "P1"
        assert r.overrides

    def test_same_hazard_on_a_quiet_lane_is_not_escalated(self):
        """The override is about exposure, not about potholes being scary."""
        r = compute_rpi([det("D40", "high", 0.06)], SegmentContext(**QUIET_LANE))
        assert not any("Escalated to P1" in o for o in r.overrides)

    def test_moderate_traffic_gets_the_lower_escalation(self):
        ctx = SegmentContext(road_class="MDR", aadt=12000, last_resurfaced_years=1,
                             drainage_quality="good", monsoon_exposure="low")
        r = compute_rpi([det("D40", "high", 0.06)], ctx)
        assert r.rpi >= 55.0

    def test_failing_emergency_route_is_escalated(self):
        ctx = SegmentContext(road_class="COL", aadt=4000, is_emergency_route=True,
                             last_resurfaced_years=2, drainage_quality="good",
                             monsoon_exposure="low")
        r = compute_rpi([det("D20", "high", 0.10), det("D20", "high", 0.10)], ctx)
        assert r.pci < 50
        assert r.rpi >= 55.0

    def test_overrides_never_push_past_the_scale(self):
        ctx = SegmentContext(road_class="NH", aadt=90000, is_emergency_route=True,
                             drainage_quality="poor", monsoon_exposure="high",
                             accidents_3yr=99, public_reports=999)
        r = compute_rpi([det(area=0.5) for _ in range(20)], ctx)
        assert r.rpi <= 100.0


class TestPCI:
    @pytest.mark.parametrize("pci,expected", [
        (100, "Good"), (90, "Good"), (75, "Satisfactory"),
        (60, "Fair"), (45, "Poor"), (30, "Very Poor"), (5, "Failed"),
    ])
    def test_labels(self, pci, expected):
        assert pci_label(pci) == expected

    def test_pci_falls_as_damage_rises(self):
        prev = 101.0
        for n in range(0, 6):
            _, pci, *_ = distress_component([det("D20", "high", 0.05) for _ in range(n)])
            assert pci <= prev
            prev = pci
