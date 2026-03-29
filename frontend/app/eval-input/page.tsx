"use client";

import { Suspense } from "react";
import { EvalInputPage } from "../../src/components/EvalInputPage";
import { Spinner } from "../../src/components/ui";

export default function EvalInputRoute() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center h-full">
          <Spinner />
        </div>
      }
    >
      <EvalInputPage />
    </Suspense>
  );
}
