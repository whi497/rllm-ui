"use client";

import { Suspense, use } from "react";
import { ClusterDetail } from "../../../src/components/ClusterDetail";
import { Spinner } from "../../../src/components/ui";

function ClusterContent({ clusterId }: { clusterId: string }) {
  return <ClusterDetail clusterId={clusterId} />;
}

export default function ClusterDetailRoute({
  params,
}: {
  params: Promise<{ clusterId: string }>;
}) {
  const { clusterId } = use(params);
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center h-full">
          <Spinner />
        </div>
      }
    >
      <ClusterContent clusterId={clusterId} />
    </Suspense>
  );
}
