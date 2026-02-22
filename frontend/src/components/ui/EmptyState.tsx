import React from "react";

const iconSizeMap = {
  sm: "w-10 h-10",
  md: "w-12 h-12",
  lg: "w-16 h-16",
} as const;

interface EmptyStateProps {
  icon: React.ReactNode;
  title: string;
  description?: string;
  iconSize?: "sm" | "md" | "lg";
  iconBg?: string;
  className?: string;
  children?: React.ReactNode;
}

export const EmptyState: React.FC<EmptyStateProps> = ({
  icon,
  title,
  description,
  iconSize = "md",
  iconBg = "bg-layer-2",
  className = "",
  children,
}) => (
  <div className={`flex flex-col items-center justify-center ${className}`}>
    <div className={`${iconSizeMap[iconSize]} rounded-full ${iconBg} flex items-center justify-center mb-3`}>
      {icon}
    </div>
    <p className="text-sm font-medium text-gray-900">{title}</p>
    {description && <p className="text-sm text-gray-500 mt-1">{description}</p>}
    {children}
  </div>
);
