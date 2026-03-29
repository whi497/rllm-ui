"use client";

import { use } from "react";
import { SkillDetail } from "../../../src/components/SkillDetail";

export default function SkillDetailPage({
  params,
}: {
  params: Promise<{ skillId: string }>;
}) {
  const { skillId } = use(params);
  return <SkillDetail skillId={skillId} />;
}
