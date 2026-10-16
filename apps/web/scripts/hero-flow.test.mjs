import assert from 'node:assert/strict';
import { test } from 'node:test';
import { vfAt, vfBuild } from '../components/marketing/valve-flow/geometry.ts';
import { vfCreateSim } from '../components/marketing/valve-flow/simulation.ts';

for (const mode of ['wide', 'compact']) {
  test(`${mode} flow keeps admitting requests for ten minutes without exceeding its capacity`, () => {
    const geometry = vfBuild(mode);
    const sim = vfCreateSim(geometry, 2);
    let releases = 0;
    let sawBackpressure = false;
    let latestAdmission = 0;

    for (let frame = 0; frame < 600 * 120; frame++) {
      const previousAdmission = sim.lastRel;
      sim.step(1 / 120);
      assert.ok(sim.lane.length + sim.file.length <= geometry.CAP);
      assert.ok(sim.lane.length + sim.file.length + sim.out.length <= 40);
      sawBackpressure ||= sim.full;
      if (sim.lastRel !== previousAdmission) {
        assert.ok(sim.lastRel - previousAdmission >= 0.5);
        latestAdmission = sim.lastRel;
        releases++;
      }
      for (const particle of [...sim.lane, ...sim.file, ...sim.out]) {
        assert.ok(Number.isFinite(particle.s) && Number.isFinite(particle.v));
        assert.ok(particle.s >= 0);
      }
    }

    assert.ok(releases > 300, 'the animation must keep producing output');
    assert.ok(
      latestAdmission > 590,
      'the flow must not stall after several loops',
    );
    assert.ok(sawBackpressure, 'bursts should demonstrate a full queue');
  });

  test(`${mode} flow paths join the queue and outlet without coordinate jumps`, () => {
    const geometry = vfBuild(mode);
    for (const lane of geometry.lanes) {
      const end = vfAt(lane.path, lane.path.len);
      assert.ok(Math.hypot(end[0] - geometry.TX, end[1] - geometry.cy) < 1.1);
    }
    assert.deepEqual(vfAt(geometry.outPath, 0), [geometry.GX - 8, geometry.cy]);
  });
}
