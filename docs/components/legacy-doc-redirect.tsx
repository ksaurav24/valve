'use client';

import Link from 'next/link';
import { useEffect } from 'react';

export function LegacyDocRedirect({ url }: { url: string }) {
  useEffect(() => {
    window.location.replace(
      url + window.location.search + window.location.hash,
    );
  }, [url]);

  return (
    <main className="mx-auto max-w-xl p-8">
      <h1>Documentation has moved.</h1>
      <p>
        <Link href={url}>Continue to this page in /docs.</Link>
      </p>
    </main>
  );
}
