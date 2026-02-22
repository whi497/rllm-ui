import React from "react";

const sizeMap = {
  sm: "w-5 h-5 border-2",
  md: "w-6 h-6 border-2",
  lg: "w-8 h-8 border-4",
} as const;

const variantMap = {
  blue: "border-gray-300 border-t-accent-500",
  black: "border-gray-200 border-t-black",
} as const;

interface SpinnerProps {
  size?: "sm" | "md" | "lg";
  variant?: "blue" | "black";
  label?: string;
  className?: string;
}

export const Spinner: React.FC<SpinnerProps> = ({
  size = "md",
  variant = "blue",
  label,
  className = "",
}) => (
  <div className={`flex flex-col items-center gap-${size === "lg" ? "4" : label ? "2" : "2"} ${className}`}>
    <div className={`${sizeMap[size]} ${variantMap[variant]} rounded-full animate-spin`} />
    {label && <p className="text-sm text-gray-500">{label}</p>}
  </div>
);
