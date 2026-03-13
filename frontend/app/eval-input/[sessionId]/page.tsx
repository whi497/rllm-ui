"use client";

import { Suspense, use } from "react";
import { EvalExplorerDetail } from "../../../src/components/EvalExplorerDetail";
import { Spinner } from "../../../src/components/ui";

function DetailContent({ sessionId }: { sessionId: string }) {
  return <EvalExplorerDetail sessionId={sessionId} />;
}

export default function EvalExplorerDetailPage({
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
      <DetailContent sessionId={sessionId} />
    </Suspense>
  );
}
