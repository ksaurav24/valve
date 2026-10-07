'use client';

import { useState } from 'react';

export function SharedBudget() {
  const [workers, setWorkers] = useState(6);
  return (
    <section
      className="budget-demo not-prose"
      aria-label="Shared budget illustration"
    >
      <div className="budget-control">
        <label htmlFor="worker-count">Workers sharing this valve</label>
        <output htmlFor="worker-count">{workers}</output>
      </div>
      <input
        id="worker-count"
        type="range"
        min={1}
        max={8}
        value={workers}
        onChange={(event) => setWorkers(Number(event.target.value))}
      />
      <div className="budget-flow">
        <div className="budget-workers" aria-hidden="true">
          {Array.from({ length: workers }, (_, index) => (
            <span key={index}>
              <i />
              Worker {index + 1}
            </span>
          ))}
        </div>
        <div className="budget-junction" aria-hidden="true">
          <span />
        </div>
        <div className="budget-reservoir">
          <span>One shared budget</span>
          <strong>
            100<span> / second</span>
          </strong>
          <div className="budget-meter" aria-hidden="true">
            {Array.from({ length: 16 }, (_, index) => (
              <i key={index} />
            ))}
          </div>
          <span>Cost units, across every worker</span>
        </div>
        <div className="budget-connection" aria-hidden="true" />
        <div className="budget-provider">
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <rect x="4" y="3" width="16" height="7" rx="2" />
            <rect x="4" y="14" width="16" height="7" rx="2" />
            <path d="M8 6.5h.01M8 17.5h.01M12 6.5h4M12 17.5h4" />
          </svg>
          <strong>Provider API</strong>
        </div>
      </div>
      <p aria-live="polite" id="budget-result">
        {workers} {workers === 1 ? 'worker' : 'workers'}. The total budget stays
        at 100 units per second.
      </p>
      <p className="budget-note">
        Each worker queues locally. Redis grants starts atomically.
        Cross-process fairness is not guaranteed.
      </p>
    </section>
  );
}
