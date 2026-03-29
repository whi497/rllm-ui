"use client";

import { Suspense } from "react";
import { ObservabilityPage } from "../../src/components/ObservabilityPage";
import { Spinner } from "../../src/components/ui";

export default function Observability() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center h-full">
          <Spinner />
        </div>
      }
    >
      <ObservabilityPage />
    </Suspense>
  );
}
