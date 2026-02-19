import React from 'react';

interface ProgressBarProps {
  currentEpoch: number;
  totalEpochs: number;
}

export const ProgressBar: React.FC<ProgressBarProps> = ({
  currentEpoch,
  totalEpochs,
}) => {
  const epochPct = totalEpochs > 0 ? Math.min(Math.round((currentEpoch / totalEpochs) * 100), 100) : 0;

  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-gray-500 text-right">Epoch {currentEpoch + 1}/{totalEpochs}</span>
      <div className="w-28 h-1.5 bg-gray-200 rounded-full overflow-hidden">
        <div
          className="h-full bg-blue-500 rounded-full transition-all duration-300"
          style={{ width: `${epochPct}%` }}
        />
      </div>
      <span className="text-xs font-semibold text-gray-700 w-8">{epochPct}%</span>
    </div>
  );
};
