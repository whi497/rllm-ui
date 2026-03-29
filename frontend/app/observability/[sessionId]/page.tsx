"use client";

import { Suspense, use } from "react";
import { ObservabilitySessionDetail } from "../../../src/components/ObservabilitySessionDetail";
import { Spinner } from "../../../src/components/ui";

function SessionContent({ sessionId }: { sessionId: string }) {
  return <ObservabilitySessionDetail sessionId={sessionId} />;
}

export default function ObservabilitySession({
  params,
}: {
  params: Promise<{ sessionId: string }>;
}) {
  const { sessionId } = use(params);
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center h-full">
          <Spinner />
        </div>
      }
    >
      <SessionContent sessionId={sessionId} />
    </Suspense>
  );
}
